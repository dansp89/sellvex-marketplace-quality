import { test, expect, type Page, type Locator } from "@playwright/test"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ensureOwed, owed } from "./fixtures"

/* Relatórios, repasses e endereço de retirada (core 8c3976e), de ponta a
 * ponta entre o painel da CDL (app-admin) e o do lojista (app-seller):
 *
 * 1. o lojista grava o endereço de retirada numa página própria e o vê em
 *    «Minha loja»; a API devolve o mesmo endereço;
 * 2. a CDL vê no menu as telas que as permissões dela abrem, abre o
 *    relatório de entregas com filtros no endereço e a contagem por
 *    situação, e o de corridas e ganhos;
 * 3. a CDL registra um repasse ao entregador e o vê na lista; a API
 *    devolve o mesmo repasse.
 *
 * Pré-requisito: `bun run prepare-stack && bun run prepare-logistics`. */

const tmp = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp")
const file = join(tmp, "logistics.json")
if (!existsSync(file)) throw new Error("rode antes: bun run prepare-logistics")
const L = JSON.parse(readFileSync(file, "utf8")) as {
  storeId: string; orgId: string; orderId: string; courierId: string
  cdl: { client: string; secret: string }; courier: { name: string }
}
const S = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8")) as { seller: { client: string; secret: string } }

const ADMIN = process.env.E2E_ADMIN_URL || "http://localhost:5300"
const SELLER = process.env.E2E_SELLER_URL || "http://localhost:5301"
const IDP = process.env.E2E_IDP || "http://localhost:9000"
const TRANSACTION = process.env.E2E_TRANSACTION || "http://localhost:8083"
const CONTROL = process.env.E2E_CONTROL_PLANE || "http://localhost:8080"
const stamp = Date.now().toString(36)

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
async function token(client: string, secret: string): Promise<string> {
  const r = await fetch(`${IDP}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: client, client_secret: secret, audience: "sellvex-api" }) })
  return ((await r.json()) as { access_token: string }).access_token
}

test.describe.configure({ mode: "serial" })

test("lojista grava o endereço de retirada", async ({ page }) => {
  const number = String(100 + (Date.now() % 800))
  await signIn(page, SELLER, S.seller.client, S.seller.secret)
  await page.goto(`${SELLER}/store`)
  await expect(page.getByText("Endereço de retirada").first()).toBeVisible()
  await page.getByRole("link", { name: /Cadastrar endereço|Alterar endereço/ }).click()
  await expect(page).toHaveURL(/\/store\/pickup-address$/)
  await expect(page.getByRole("heading", { name: "Endereço de retirada" })).toBeVisible()
  const box = page.locator(".sx-address")
  await box.getByLabel("CEP").fill("69005010")
  await box.getByRole("button", { name: "Buscar" }).click()
  await expect(box.getByLabel("Cidade")).toHaveValue("Manaus")
  await box.getByLabel("Número").fill(number)
  await page.getByLabel("Quem entrega o pacote").fill("Balcão E2E")
  await shot(page, "r01-retirada-form")
  await page.getByRole("button", { name: "Gravar endereço" }).click()
  await expect(page.getByText("Endereço de retirada gravado.")).toBeVisible()
  await expect(page).toHaveURL(/\/store$/)
  await expect(page.getByText(new RegExp(`, ${number} · .*Manaus/AM`))).toBeVisible()
  await shot(page, "r02-minha-loja")

  const r = await fetch(`${CONTROL}/v1/stores/${L.storeId}/pickup-address`, { headers: { authorization: `Bearer ${await token(S.seller.client, S.seller.secret)}` } })
  expect(r.status).toBe(200)
  const a = (await r.json()) as { line1: string; locality: string; postal_code: string; recipient?: string }
  expect(a.line1).toMatch(new RegExp(`, ${number}$`))
  expect(a.locality).toBe("Manaus")
  expect(a.postal_code).toBe("69005010")
  expect(a.recipient).toBe("Balcão E2E")
})

test("CDL vê o menu pelas permissões e abre o relatório de entregas", async ({ page }) => {
  await signIn(page, ADMIN, L.cdl.client, L.cdl.secret)
  await page.goto(`${ADMIN}/logistics/reports`)
  await expect(page.getByRole("heading", { name: "Relatório de entregas" })).toBeVisible()
  const nav = page.getByRole("navigation").first()
  for (const item of ["Monitor de despacho", "Entregadores", "Relatório de entregas", "Corridas e ganhos", "Repasses aos entregadores"])
    await expect(nav.getByText(item, { exact: true }).first()).toBeAttached()
  await expect(page.getByText("Tarefas no período")).toBeVisible()

  /* A contagem da tela é a do core, para o período padrão (30 dias). */
  const tok = await token(L.cdl.client, L.cdl.secret)
  const api = await fetch(`${TRANSACTION}/v1/organizations/${L.orgId}/delivery-reports/tasks?limit=1`, { headers: { authorization: `Bearer ${tok}` } })
  expect(api.status).toBe(200)
  const body = (await api.json()) as { by_status: { status: string; tasks: number }[] }
  const total = body.by_status.reduce((n, s) => n + s.tasks, 0)
  await expect(page.getByText(new RegExp(`^${total.toLocaleString("pt-BR")} tarefas?$`))).toBeVisible()
  if (total > 0) await expect(page.getByRole("row").nth(1)).toBeVisible()
  await shot(page, "r03-relatorio")

  /* Filtro de situação no endereço: F5 abre o mesmo recorte. */
  await choose(page, page.getByRole("combobox").filter({ hasText: /situações|Situação/ }).first(), "Cancelada")
  await expect(page).toHaveURL(/status=cancelled/)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Relatório de entregas" })).toBeVisible()
  await expect(page.getByRole("combobox").filter({ hasText: "Cancelada" }).first()).toBeVisible()
  await shot(page, "r04-relatorio-filtro")

  await page.goto(`${ADMIN}/logistics/rides?from=2026-01-01`)
  await expect(page.getByRole("heading", { name: "Corridas e ganhos" })).toBeVisible()
  await expect(page.getByText("Líquido dos entregadores")).toBeVisible()
  await expect(page.getByText(/corridas? no período/)).toBeVisible()
  await shot(page, "r05-corridas")
})

test("CDL não registra repasse acima do que a rede deve", async ({ page }) => {
  /* O core recusa (422 payouts.payout_exceeds_owed) um pagamento que passe
     do devido: corridas e períodos fechados menos o já pago. */
  const due = owed(L.orgId, L.courierId)
  const above = Math.max(due, 0) + 100_000
  await signIn(page, ADMIN, L.cdl.client, L.cdl.secret)
  await page.goto(`${ADMIN}/logistics/payouts/new`)
  await expect(page.getByRole("heading", { name: "Registrar repasse" })).toBeVisible()
  await choose(page, page.getByLabel("Entregador"), new RegExp(L.courier.name))
  await page.getByLabel("Valor").fill((above / 100).toFixed(2).replace(".", ","))
  await page.getByLabel("Referência").fill(`E2E-ACIMA-${stamp}`)
  await page.getByRole("button", { name: "Registrar repasse" }).click()
  await expect(page.getByTestId("payout-rejected")).toContainText("passa do que a rede deve")
  await expect(page).toHaveURL(/\/logistics\/payouts\/new/)
  await shot(page, "r06a-repasse-acima")

  const tok = await token(L.cdl.client, L.cdl.secret)
  const api = await fetch(`${TRANSACTION}/v1/organizations/${L.orgId}/courier-payouts?courier_id=${L.courierId}&limit=200`, { headers: { authorization: `Bearer ${tok}` } })
  const list = (await api.json()) as { items: { reference: string }[] }
  expect(list.items.some((p) => p.reference === `E2E-ACIMA-${stamp}`)).toBe(false)
})

test("CDL registra um repasse ao entregador", async ({ page }) => {
  const reference = `E2E-PIX-${stamp}`
  /* Cada rodada paga R$ 123,45: o saldo devido tem de cobrir. */
  ensureOwed(L.orgId, L.courierId, 12345)
  await signIn(page, ADMIN, L.cdl.client, L.cdl.secret)
  await page.goto(`${ADMIN}/logistics/payouts`)
  await expect(page.getByRole("heading", { name: "Repasses aos entregadores" })).toBeVisible()
  await page.getByRole("button", { name: "Registrar repasse" }).first().click()
  await expect(page).toHaveURL(/\/logistics\/payouts\/new/)
  await expect(page.getByRole("heading", { name: "Registrar repasse" })).toBeVisible()
  await choose(page, page.getByLabel("Entregador"), new RegExp(L.courier.name))
  await page.getByLabel("Valor").fill("123,45")
  await page.getByLabel("Referência").fill(reference)
  await shot(page, "r06-repasse-form")
  await page.getByRole("button", { name: "Registrar repasse" }).click()
  await expect(page.getByText(/Repasse de R\$\s?123,45 registrado/)).toBeVisible()
  await expect(page).toHaveURL(/\/logistics\/payouts$/)
  await expect(page.getByRole("row").filter({ hasText: L.courier.name }).filter({ hasText: /123,45/ }).first()).toBeVisible()
  await shot(page, "r07-repasses")

  const tok = await token(L.cdl.client, L.cdl.secret)
  const api = await fetch(`${TRANSACTION}/v1/organizations/${L.orgId}/courier-payouts?courier_id=${L.courierId}&limit=200`, { headers: { authorization: `Bearer ${tok}` } })
  expect(api.status).toBe(200)
  const list = (await api.json()) as { items: { reference: string; amount: number; currency: string }[] }
  expect(list.items.find((p) => p.reference === reference)).toMatchObject({ amount: 12345, currency: "BRL" })
})
