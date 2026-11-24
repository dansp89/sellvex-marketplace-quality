import { test, expect, type Page, type Locator } from "@playwright/test"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { paidOrder, courierPending } from "./fixtures"

/* Entrega local da CDL, de ponta a ponta entre o painel da plataforma, o
 * da CDL (app-admin) e o do lojista (app-seller):
 *
 * 1. a plataforma grava um regime de trabalho;
 * 2. a CDL cria uma frota com ele; o entregador pede entrada pelo app
 *    (aqui, pela API do app); a CDL aprova o cadastro e aceita o pedido;
 * 3. o lojista liga a entrega local, prepara o pedido, reserva a entrega
 *    local, marca pronto e baixa as etiquetas;
 * 4. a CDL vê a entrega no monitor de despacho e abre a cadeia de custódia.
 *
 * Pré-requisito: `bun run prepare-stack && bun run prepare-logistics`.
 *
 * Re-executável contra o mesmo banco: cada rodada cria o seu pedido pago,
 * volta o entregador a pendente e usa regime e frota com nome novo. O
 * pedido de .tmp/logistics.json servia uma rodada só (depois de despachado
 * não há mais «Começar a preparar»). */

const tmp = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp")
const file = join(tmp, "logistics.json")
if (!existsSync(file)) throw new Error("rode antes: bun run prepare-logistics")
const L = JSON.parse(readFileSync(file, "utf8")) as {
  storeId: string; orgId: string; orderId: string; courierId: string
  cdl: { client: string; secret: string }; operator: { client: string; secret: string }; courier: { client: string; secret: string; name: string }
}
const S = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8")) as { seller: { client: string; secret: string } }

const ADMIN = process.env.E2E_ADMIN_URL || "http://localhost:5300"
const SELLER = process.env.E2E_SELLER_URL || "http://localhost:5301"
const IDP = process.env.E2E_IDP || "http://localhost:9000"
const TRANSACTION = process.env.E2E_TRANSACTION || "http://localhost:8083"
const stamp = Date.now().toString(36)
const regimeName = `Autônomo E2E ${stamp}`
const fleetName = `Frota E2E ${stamp}`

async function signIn(page: Page, base: string, client: string, secret: string) {
  await page.goto(`${base}/sign-in`)
  await page.getByLabel("Usuário").fill(client)
  await page.getByLabel("Senha").first().fill(secret)
  await page.getByRole("button", { name: /Entrar/ }).click()
  await expect(page).not.toHaveURL(/sign-in/)
}
async function choose(page: Page, field: Locator, option: string | RegExp) {
  await field.click()
  await page.getByRole("option", { name: option }).first().click()
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })
}
async function courierToken(): Promise<string> {
  const r = await fetch(`${IDP}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: L.courier.client, client_secret: L.courier.secret, audience: "sellvex-api" }) })
  return ((await r.json()) as { access_token: string }).access_token
}

test.describe.configure({ mode: "serial" })

let orderId = ""
test.beforeAll(async () => {
  orderId = await paidOrder(L.storeId, S.seller)
  courierPending(L.courierId)
})

test("plataforma grava um regime de trabalho", async ({ page }) => {
  await signIn(page, ADMIN, L.operator.client, L.operator.secret)
  await page.goto(`${ADMIN}/logistics/regimes/new`)
  await page.getByLabel("Nome").fill(regimeName)
  await expect(page.getByLabel("Identificador")).toHaveValue(/autonomo-e2e/)
  await shot(page, "01-regime-novo")
  await page.getByRole("button", { name: "Criar regime" }).click()
  await expect(page.getByRole("heading", { name: regimeName })).toBeVisible()
  await expect(page.getByText("versão 1").first()).toBeVisible()
  await expect(page.getByText("Histórico de versões")).toBeVisible()
  await shot(page, "02-regime")
})

let fleetId = ""
test("CDL cria a frota, aprova o entregador e aceita o pedido de entrada", async ({ page }) => {
  await signIn(page, ADMIN, L.cdl.client, L.cdl.secret)
  await page.goto(`${ADMIN}/logistics/fleets/new`)
  await page.getByLabel("Nome").fill(fleetName)
  await choose(page, page.getByLabel("Regime de trabalho"), new RegExp(regimeName))
  await shot(page, "03-frota-nova")
  await page.getByRole("button", { name: "Criar frota" }).click()
  await expect(page.getByRole("heading", { name: fleetName })).toBeVisible()
  fleetId = page.url().match(/fleets\/([0-9a-f-]{36})/)?.[1] ?? ""
  expect(fleetId).not.toBe("")

  /* O entregador pede entrada pelo app Sellvex Log. */
  const r = await fetch(`${TRANSACTION}/v1/courier/fleet-applications`, {
    method: "POST",
    headers: { authorization: `Bearer ${await courierToken()}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ fleet_id: fleetId }),
  })
  expect(r.status, await r.clone().text()).toBeLessThan(300)

  await page.goto(`${ADMIN}/logistics/couriers?status=pending`)
  await expect(page.getByRole("heading", { name: "Entregadores" })).toBeVisible()
  await page.getByText(L.courier.name, { exact: true }).first().click()
  await expect(page.getByRole("heading", { name: L.courier.name })).toBeVisible()
  await expect(page.getByText("Aguardando aprovação")).toBeVisible()
  await shot(page, "04-entregador-pendente")
  await page.getByRole("button", { name: "Aprovar" }).first().click()
  await page.getByRole("dialog").getByRole("button", { name: "Aprovar" }).click()
  await expect(page.getByText("Aprovado").first()).toBeVisible()

  /* O detalhe do entregador no core ainda não traz as frotas dele, então o
     pedido de entrada não aparece na aba; a CDL o aceita adicionando o
     entregador à frota (o mesmo PUT de membro). */
  await page.goto(`${ADMIN}/logistics/fleets/${fleetId}`)
  await page.getByRole("button", { name: "Adicionar entregador" }).click()
  await choose(page, page.getByLabel("Entregador"), new RegExp(L.courier.name))
  await shot(page, "05-frota-adicionar")
  await page.getByRole("button", { name: "Adicionar", exact: true }).click()
  await expect(page.getByText(/Entregador adicionado/)).toBeVisible()
  await page.goto(`${ADMIN}/logistics/fleets/${fleetId}`)
  await shot(page, "05-frota-membros")
})

test("lojista liga a entrega local, marca pronto e imprime a etiqueta", async ({ page }) => {
  await signIn(page, SELLER, S.seller.client, S.seller.secret)
  await page.goto(`${SELLER}/deliveries/settings`)
  await expect(page.getByRole("heading", { name: "Entrega local" })).toBeVisible()
  const sw = page.getByRole("switch", { name: "Entrega local" })
  await expect(sw).toBeEnabled()
  /* Só lê o estado depois que as políticas carregaram: lido antes, o
     switch ainda dizia «desligado» e o clique desligava a entrega local
     de uma loja que já a tinha (2ª rodada). */
  await expect(page.getByText("Ativo").first()).toBeVisible()
  /* O estado é a propriedade checked do input (role=switch); ele não
     escreve aria-checked, e ler o atributo dava sempre «desligado». */
  if (!(await sw.isChecked())) {
    await sw.click({ force: true })
    await expect(page.getByText(/Entrega local ligada/)).toBeVisible()
  }
  await page.getByRole("button", { name: "Salvar" }).click()
  await expect(page.getByText(/Entrega local salva/)).toBeVisible()
  await shot(page, "06-lojista-configurar")

  await page.goto(`${SELLER}/orders/${orderId}`)
  await page.getByRole("button", { name: "Começar a preparar" }).click()
  await expect(page.getByText("Pedido em preparação.")).toBeVisible()

  await page.getByRole("button", { name: "Reservar entrega local" }).click()
  await expect(page.getByRole("heading", { name: "Reservar entrega local" })).toBeVisible()
  /* O pedido do teste é comprado sem endereço: o lojista dá o destino. */
  await page.getByRole("switch", { name: "Entregar em outro endereço" }).click({ force: true })
  await expect(page.getByRole("heading", { name: "Entrega (o comprador)" })).toBeVisible()
  for (const [title, number] of [["Coleta (a loja)", "100"], ["Entrega (o comprador)", "250"]] as const) {
    const box = page.locator(".sx-address", { has: page.getByRole("heading", { name: title }) })
    await box.getByLabel("CEP").fill("69005010")
    await box.getByRole("button", { name: "Buscar" }).click()
    await expect(box.getByLabel("Cidade")).toHaveValue("Manaus")
    await box.getByLabel("Número").fill(number)
  }
  await page.getByLabel("Destinatário").fill("Comprador E2E")
  await shot(page, "07-reservar")
  /* A lista de transportadoras da loja é cacheada pelo core por até um
     minuto depois de ligada: cota de novo até a entrega local aparecer. */
  await expect(async () => {
    await page.getByRole("button", { name: "Cotar" }).click()
    await expect(page.getByText("Entrega local").first()).toBeVisible({ timeout: 3000 })
    await expect(page.getByRole("button", { name: "Reservar", exact: true })).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 90_000, intervals: [5000] })
  await page.getByRole("button", { name: "Reservar", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`))

  await page.getByRole("button", { name: "Marcar pronto para coleta" }).click()
  await expect(page.getByText(/Pronto para coleta/).first()).toBeVisible()
  await expect(async () => {
    await page.getByRole("button", { name: /Atualizar|Recarregar/ }).first().click()
    await expect(page.getByRole("button", { name: /Ver a entrega/ })).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 60_000, intervals: [3000] })
  await shot(page, "08-pedido-pronto")
  await page.getByRole("button", { name: /Ver a entrega/ }).click()
  await expect(page.getByRole("heading", { name: /Entrega LOC/ })).toBeVisible()

  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Baixar etiquetas" }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/\.pdf$/)
  await shot(page, "09-entrega")
})

test("a entrega aparece no monitor de despacho da CDL", async ({ page }) => {
  await signIn(page, ADMIN, L.cdl.client, L.cdl.secret)
  await page.goto(`${ADMIN}/logistics/dispatch?view=all`)
  await expect(page.getByRole("heading", { name: "Monitor de despacho" })).toBeVisible()
  const row = page.getByRole("row", { name: /Obra Certa|LOC/ }).filter({ hasText: "LOC" }).first()
  await expect(row).toBeVisible()
  await shot(page, "10-monitor")
  await row.click()
  await expect(page.getByRole("heading", { name: /Entrega LOC/ })).toBeVisible()
  await expect(page.getByText(/Volume 1 — responsável agora/)).toBeVisible()
  await shot(page, "11-monitor-entrega")
})
