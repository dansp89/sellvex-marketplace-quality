import { test, expect, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { state } from "./state"
import { token } from "./fixtures"
import { offlinePreviousRuns } from "../scripts/prepare-entregas"

/* Entregadores simulados (FR-COUR-005), com a stack de verdade:
 *
 *   recria o worker com SELLVEX_COURIER_SIMULATOR=on para a CDL da loja →
 *   /v1/health/config do worker diz ligado → um comprador compra com
 *   entrega local, a loja confirma o Pix, reserva a entrega e marca pronto
 *   (API) → sem ninguém tocar em nada, um entregador simulado aceita, coleta
 *   e entrega com o código → o painel da CDL mostra o selo do modo de teste
 *   e o entregador como «Simulado» → o worker volta a off e os simulados
 *   ficam offline.
 *
 * Pré-requisito: `bun run prepare-stack`, `bun run prepare-logistics` e
 * `bun run prepare-entregas`, e imagens do core com o simulador. */

const here = dirname(fileURLToPath(import.meta.url))
const tmp = join(here, "..", ".tmp")
const env = (k: string, d: string) => process.env[k] || d
const L = JSON.parse(readFileSync(join(tmp, "logistics.json"), "utf8")) as { orgId: string; cdl: { client: string; secret: string } }
const E = JSON.parse(readFileSync(join(tmp, "entregas.json"), "utf8")) as { store: string; org: string; variant: { id: string } }
const { seller } = state()
const COMMERCE = env("E2E_COMMERCE", "http://localhost:8082")
const TRANSACTION = env("E2E_TRANSACTION", "http://localhost:8083")
const ADMIN = env("E2E_ADMIN_URL", "http://localhost:5300")
const PROJECT = env("E2E_COMPOSE_PROJECT", "sellvex-minimal")
const CORE_COMPOSE = env("E2E_CORE_COMPOSE", resolve(here, "../../../sellvex-marketplace-core/deploy/compose/compose.yaml"))
const S = `/v1/stores/${E.store}`
const F = `/v1/storefronts/${E.store}`

/* A porta do worker no host, a mesma com que a stack subiu: recriar com
   outra mudaria o endereço (memória compose-needs-the-port-var). */
const workerPort = () => execFileSync("docker", ["port", `${PROJECT}-worker-1`, "8081/tcp"], { encoding: "utf8" }).trim().split("\n")[0].split(":").pop()!
let WORKER = ""

/** Recria só o worker com o simulador ligado ou desligado: é assim que se
    liga e desliga (trocar a variável e reiniciar). */
function worker(on: boolean, port: string) {
  execFileSync("docker", ["compose", "-p", PROJECT, "-f", CORE_COMPOSE, "up", "-d", "--no-build", "--no-deps", "--force-recreate", "worker"], {
    stdio: "inherit",
    env: {
      ...process.env,
      SELLVEX_POSTGRES_PORT: env("SELLVEX_POSTGRES_PORT", "55432"),
      SELLVEX_WORKER_PORT: port,
      SELLVEX_COURIER_SIMULATOR: on ? "on" : "off",
      SELLVEX_COURIER_SIMULATOR_ORG: on ? E.org : "",
      SELLVEX_COURIER_SIMULATOR_COUNT: "2",
      SELLVEX_COURIER_SIMULATOR_SPEED: "10",
      SELLVEX_COURIER_SIMULATOR_FAILURE_RATE: "0",
    },
  })
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error(`esperando ${what}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function api<T = any>(method: string, url: string, tok: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (tok) headers.authorization = `Bearer ${tok}`
  if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID()
  if (body !== undefined) headers["content-type"] = "application/json"
  const r = await fetch(url, { method, headers, body: body === undefined ? null : JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${url}: HTTP ${r.status} ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : null) as T
}

const simConfig = async () => (await api<{ courier_simulator: { on: boolean; organization_id?: string } }>("GET", `${WORKER}/v1/health/config`, "")).courier_simulator

const address = (recipient: string) => ({ country: "BR", postal_code: "37500-000", region: "MG", locality: "Itajubá", line1: "Rua Coronel Rennó, 10", recipient })
type Task = { id: string; seller_order_id: string; status: string; courier_id?: string }

/** Pedido pago com entrega local, pronto para coleta (mesmo caminho do
    entregas.spec, pela API REST). */
async function readyLocalOrder(sellerTok: string): Promise<Task> {
  const cart = await api<{ id: string }>("POST", `${COMMERCE}${F}/carts`, "", { currency: "BRL" })
  await api("PUT", `${COMMERCE}${F}/carts/${cart.id}/items/${E.variant.id}`, "", { quantity: 1 })
  const checkout = await api<{ id: string }>("POST", `${TRANSACTION}${F}/checkouts`, "", {
    cart_id: cart.id, payment_method_token: "manual:pix",
    delivery: { contact: { name: "Cliente Simulador", phone: "+5535988886666", email: `sim.${Date.now()}@sellvex.local` }, address: address("Cliente Simulador") },
  })
  await until("o checkout aguardar o Pix", async () => (await api<{ status: string }>("GET", `${TRANSACTION}${F}/checkouts/${checkout.id}`, "")).status === "payment_pending")
  const manual = await api<{ items: { payment_id: string; amount: number; status: string }[] }>("GET", `${TRANSACTION}${S}/manual-payments`, sellerTok)
  const pay = manual.items.filter((m) => m.status !== "confirmed").at(-1) ?? manual.items.at(-1)!
  await api("POST", `${TRANSACTION}${S}/payments/${pay.payment_id}/manual-confirmation`, sellerTok, { amount: pay.amount, reference: `PIX-SIM-${Date.now()}` })
  const done = await until("o checkout completar", async () => {
    const c = await api<{ status: string; order_id?: string }>("GET", `${TRANSACTION}${F}/checkouts/${checkout.id}`, "")
    return c.status === "completed" && c.order_id ? c : null
  })
  const order = await until("o pedido da loja", async () => {
    const page = await api<{ items: { id: string; marketplace_order_id: string; status: string }[] }>("GET", `${TRANSACTION}${S}/orders?limit=50`, sellerTok)
    return page.items.find((o) => o.marketplace_order_id === done.order_id && o.status === "placed")
  })
  const quote = await api<{ id: string; options: { carrier: string; service_code: string }[] }>("POST", `${TRANSACTION}${S}/shipping/quotes`, sellerTok, {
    currency: "BRL", origin: address("Loja"), destination: address("Cliente Simulador"),
    packages: [{ weight_grams: 1000, length_mm: 200, width_mm: 150, height_mm: 100 }],
  })
  const local = quote.options.find((o) => o.carrier === "local")
  expect(local, "a cotação oferece a entrega local").toBeTruthy()
  await api("POST", `${TRANSACTION}${S}/shipments`, sellerTok, { seller_order_id: order.id, quote_id: quote.id, carrier: "local", service_code: local!.service_code })
  const task = await until("a tarefa de entrega", async () => {
    const page = await api<{ items: Task[] }>("GET", `${TRANSACTION}${S}/delivery-tasks`, sellerTok)
    return page.items.find((t) => t.seller_order_id === order.id)
  })
  await api("POST", `${TRANSACTION}${S}/orders/${order.id}/fulfillment`, sellerTok, { status: "ready_for_pickup" })
  return task
}

async function signIn(page: Page, client: string, secret: string) {
  await page.goto(`${ADMIN}/sign-in`)
  await page.getByLabel("Usuário").fill(client)
  await page.getByLabel("Senha").first().fill(secret)
  await page.getByRole("button", { name: /Entrar/ }).click()
  await expect(page).not.toHaveURL(/sign-in/)
}

test.describe.configure({ mode: "serial" })

let port = ""
test.beforeAll(() => {
  port = workerPort()
  WORKER = `http://localhost:${port}`
})
/* Desliga sempre, mesmo com o teste a falhar: os outros specs contam com
   os seus entregadores reais recebendo as ofertas. */
test.afterAll(async () => {
  test.setTimeout(120_000)
  worker(false, port)
  await until("o worker desligado", async () => (await simConfig()).on === false, 90_000)
})

test("simulador ligado: pedido entregue sozinho, selo no painel da CDL, desliga e ficam offline", async ({ page }) => {
  test.setTimeout(300_000)
  // Entregadores de teste de rodadas anteriores fora da fila: a oferta vai
  // aos simulados. Só os de teste: quem testa à mão continua online.
  offlinePreviousRuns()

  await test.step("liga o simulador (variável + reiniciar o worker)", async () => {
    worker(true, port)
    const cfg = await until("o worker com o simulador", async () => { const c = await simConfig(); return c.on ? c : null }, 90_000)
    expect(cfg.organization_id).toBe(E.org)
  })

  const cdlTok = await token(L.cdl.client, L.cdl.secret)
  await test.step("os simulados ficam aprovados e online na rede", async () => {
    await until("dois simulados online", async () => {
      const r = await api<{ items: { simulated?: boolean; online: boolean; status: string }[] }>("GET", `${TRANSACTION}/v1/organizations/${E.org}/couriers`, cdlTok)
      return r.items.filter((c) => c.simulated && c.online && c.status === "approved").length >= 2
    })
  })

  const sellerTok = await token(seller.client, seller.secret)
  const task = await readyLocalOrder(sellerTok)
  const delivered = await test.step("ninguém toca em nada e o pedido é entregue", async () =>
    until("a entrega concluída pelo simulado", async () => {
      const t = await api<Task>("GET", `${TRANSACTION}${S}/delivery-tasks/${task.id}`, sellerTok)
      return t.status === "delivered" ? t : null
    }, 180_000))
  expect(delivered.courier_id).toBeTruthy()
  const who = await api<{ simulated: boolean }>("GET", `${TRANSACTION}/v1/organizations/${E.org}/couriers/${delivered.courier_id}`, cdlTok)
  expect(who.simulated, "quem entregou é um entregador simulado").toBe(true)

  await test.step("painel da CDL: selo do modo de teste e «Simulado»", async () => {
    await signIn(page, L.cdl.client, L.cdl.secret)
    await page.goto(`${ADMIN}/logistics/couriers`)
    await expect(page.getByTestId("simulator-notice")).toContainText("Modo de teste: entregadores simulados ligados")
    await expect(page.getByText("Simulado", { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: test.info().outputPath("simulador-painel.png"), fullPage: true })
  })

  await test.step("desliga: variável off, reinicia, simulados offline", async () => {
    worker(false, port)
    await until("o worker desligado", async () => (await simConfig()).on === false, 90_000)
    await until("simulados offline", async () => {
      const r = await api<{ items: { simulated?: boolean; online: boolean }[] }>("GET", `${TRANSACTION}/v1/organizations/${E.org}/couriers`, cdlTok)
      return !r.items.some((c) => c.simulated && c.online)
    })
  })
})
