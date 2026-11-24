import { test, expect, type Page, type Browser } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { psql, token } from "./fixtures"

/* Rastreio ao vivo da entrega local (FR-DISP-005), com a stack de verdade:
 *
 *   um entregador de teste (bicicleta) se cadastra, é aprovado pela rede e
 *   entra na frota própria da loja → o comprador de teste compra com destino
 *   geolocalizado → a loja reserva a entrega local e marca pronto → o
 *   entregador aceita e manda posições → o comprador (vitrine), o lojista e
 *   a rede (monitor de despacho e detalhe) veem o marcador do veículo andar
 *   → com os volumes na mão a etapa vira «Indo até você» → ao entregar, o
 *   entregador some do mapa.
 *
 * A oferta vai à frota própria da loja antes da rede: o entregador do
 * usuário (frota da rede) não recebe esta corrida. Só o entregador e o
 * convite criados aqui são apagados no fim; o pedido de teste fica, como os
 * do seed-test-orders.
 *
 * Pré-requisito: prepare-stack, prepare-logistics e prepare-entregas. */

const here = dirname(fileURLToPath(import.meta.url))
const tmp = join(here, "..", ".tmp")
const env = (k: string, d: string) => process.env[k] || d
const L = JSON.parse(readFileSync(join(tmp, "logistics.json"), "utf8")) as { orgId: string; cdl: { client: string; secret: string } }
const E = JSON.parse(readFileSync(join(tmp, "entregas.json"), "utf8")) as { store: string; org: string; fleetId: string; regime: string; variant: { id: string } }
const ST = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8")) as {
  buyer: { email: string; password: string; name: string }; seller: { client: string; secret: string }
}
const COMMERCE = env("E2E_COMMERCE", "http://localhost:8082")
const TRANSACTION = env("E2E_TRANSACTION", "http://localhost:8083")
const CONTROL = env("E2E_CONTROL", "http://localhost:8080")
const IDP = env("E2E_IDP", "http://localhost:9000")
const STORE = env("E2E_STORE_URL", "http://localhost:5190")
const SELLER = env("E2E_SELLER_URL", "http://localhost:5301")
const ADMIN = env("E2E_ADMIN_URL", "http://localhost:5300")
const S = `/v1/stores/${E.store}`
const F = `/v1/storefronts/${E.store}`
const stamp = Date.now().toString(36)
const courierName = `Rastreio Teste ${stamp}`
const courierEmail = `rastreio-${stamp}@example.test`
const courierPassword = "senha-rastreio-1"

/* Da loja (Av. BPS) ao destino (Rua Dr. Pereira), em Itajubá. */
const PICKUP = { latitude: -22.4130, longitude: -45.4497 }
const DEST = { latitude: -22.4260, longitude: -45.4530 }

async function call(method: string, url: string, tok: string | null, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {}
  if (tok) headers.authorization = `Bearer ${tok}`
  if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID()
  if (body !== undefined) headers["content-type"] = "application/json"
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, json: text ? JSON.parse(text) : null }
}
async function ok(method: string, url: string, tok: string | null, body?: unknown): Promise<any> {
  const r = await call(method, url, tok, body)
  if (r.status >= 300) throw new Error(`${method} ${url}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`)
  return r.json
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
async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${IDP}/token`, { method: "POST", headers: { authorization: "Basic " + btoa(`${email}:${password}`) },
    body: new URLSearchParams({ grant_type: "client_credentials", audience: "sellvex-api" }) })
  return ((await r.json()) as { access_token: string }).access_token
}
const shot = (page: Page, n: string) => page.screenshot({ path: test.info().outputPath(`${n}.png`), fullPage: true })

async function staffPage(browser: Browser, base: string, client: string, secret: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, locale: "pt-BR" })
  await page.goto(`${base}/sign-in`)
  await page.getByLabel("Usuário").fill(client)
  await page.getByLabel("Senha").first().fill(secret)
  await page.getByRole("button", { name: /Entrar/ }).click()
  await expect(page).not.toHaveURL(/sign-in/)
  return page
}

/* Onde o MapLibre pôs o marcador do entregador, e para onde o veículo aponta. */
async function marker(page: Page) {
  const m = page.locator(".sx-tmap__courier").first()
  await expect(m).toBeVisible()
  return {
    at: (await m.getAttribute("style")) ?? "",
    turn: (await m.locator(".sx-tmap__vehicle").getAttribute("style")) ?? "",
  }
}

/* Texto neutro (regra do produto): nenhuma tela fala em CDL. O nome da
   conta de teste, que veio do preparo, não é texto da tela. */
async function noCdl(page: Page) {
  const text = (await page.locator("body").innerText()).replace(/Equipe CDL[^\n]*/g, "")
  expect(text).not.toMatch(/\bCDLs?\b/)
}

test.describe.configure({ mode: "serial" })

let courierId = ""
let courierTok = ""
let sellerTok = ""
let buyerTok = ""
let orderId = ""
let taskId = ""
let deliveryCode = ""

test.afterAll(async () => {
  /* Uma rodada que caiu no meio deixa a corrida viva: termina-a, para o
     monitor não ficar com uma entrega de teste em rota para sempre. */
  if (taskId && courierTok) {
    const t = await call("GET", `${TRANSACTION}${S}/delivery-tasks/${taskId}`, sellerTok)
    if (t.json?.status === "assigned") for (const v of t.json.volumes ?? []) await call("POST", `${TRANSACTION}/v1/courier/scans`, courierTok, { qr: v.qr })
    if (["assigned", "in_route"].includes(t.json?.status)) await call("POST", `${TRANSACTION}/v1/courier/tasks/${taskId}/deliver`, courierTok, { code: t.json.delivery_code })
  }
  if (courierId) {
    psql(`delete from couriers.fleet_members where courier_id='${courierId}'; delete from couriers.documents where courier_id='${courierId}'; update couriers.invites set courier_id=null where courier_id='${courierId}'; update couriers.couriers set online=false, latitude=0, longitude=0, heading=null, last_seen_at=null where id='${courierId}'`)
    /* Sem corrida que aponte para ele, o entregador de teste sai inteiro. */
    psql(`delete from couriers.couriers c where id='${courierId}' and not exists (select 1 from dispatch.tasks where courier_id=c.id) and not exists (select 1 from dispatch.offers where courier_id=c.id)`)
  }
  psql(`delete from couriers.invites where full_name='${courierName}'`)
})

test("preparo: entregador de bicicleta na frota da loja e pedido com destino no mapa", async () => {
  sellerTok = await token(ST.seller.client, ST.seller.secret)
  const cdlTok = await token(L.cdl.client, L.cdl.secret)

  await ok("POST", `${CONTROL}/v1/couriers/signup`, null, { name: courierName, email: courierEmail, password: courierPassword, terms_version: "entregador-v1" })
  courierTok = await login(courierEmail, courierPassword)
  const me = await ok("PUT", `${TRANSACTION}/v1/courier/me`, courierTok, { name: courierName, phone: "+5535999990177", tax_id: "52998224725", vehicle: "bicycle" })
  courierId = me.id
  await ok("POST", `${TRANSACTION}/v1/courier/documents`, courierTok, { kind: "cnh", media_id: crypto.randomUUID(), expires_on: new Date(Date.now() + 365 * 864e5).toISOString() })
  await ok("PUT", `${TRANSACTION}${S}/courier-fleets/${E.fleetId}/members/${courierId}`, sellerTok, { regime_id: E.regime })
  const detail = await ok("GET", `${TRANSACTION}/v1/organizations/${E.org}/couriers/${courierId}`, cdlTok)
  for (const d of detail.documents ?? []) if (d.status === "pending") await ok("POST", `${TRANSACTION}/v1/organizations/${E.org}/courier-documents/${d.id}/review`, cdlTok, { decision: "approve" })
  await ok("POST", `${TRANSACTION}/v1/organizations/${E.org}/couriers/${courierId}/review`, cdlTok, { decision: "approved" })
  await ok("PUT", `${TRANSACTION}/v1/courier/presence`, courierTok, { online: true })
  await call("PUT", `${TRANSACTION}/v1/courier/location`, courierTok, { latitude: -22.4080, longitude: -45.4470 })

  buyerTok = await login(ST.buyer.email, ST.buyer.password)
  const cart = await ok("POST", `${COMMERCE}${F}/carts`, null, { currency: "BRL" })
  /* Uma variante com estoque: rodadas seguidas esgotam a do preparo. */
  const products = await ok("GET", `${COMMERCE}${F}/products?limit=50`, null)
  const variant = (products.items as { variants?: { id: string; available?: number }[] }[]).flatMap((p) => p.variants ?? []).find((v) => (v.available ?? 0) > 0)?.id ?? E.variant.id
  await ok("PUT", `${COMMERCE}${F}/carts/${cart.id}/items/${variant}`, null, { quantity: 1 })
  const address = { country: "BR", postal_code: "37500-123", region: "MG", locality: "Itajubá", line1: "Rua Dr. Pereira, 45", line2: "Centro", ...DEST }
  await ok("PUT", `${COMMERCE}${F}/carts/${cart.id}/delivery`, null, { address, contact: { name: "Teste Rastreio", email: `teste.rastreio.${stamp}@sellvex.local`, phone: "+5535999991234" } })
  await ok("POST", `${COMMERCE}${F}/carts/${cart.id}/claim`, buyerTok)
  const checkout = await ok("POST", `${TRANSACTION}${F}/checkouts`, buyerTok, { cart_id: cart.id, payment_method_token: "manual:pix" })
  await until("o Pix pendente", async () => (await ok("GET", `${TRANSACTION}${F}/checkouts/${checkout.id}`, null)).status === "payment_pending")
  const manual = await ok("GET", `${TRANSACTION}${S}/manual-payments`, sellerTok)
  const pay = (manual.items as { payment_id: string; amount: number; status: string; marketplace_order_id: string }[]).filter((m) => m.status !== "confirmed").at(-1)!
  await ok("POST", `${TRANSACTION}${S}/payments/${pay.payment_id}/manual-confirmation`, sellerTok, { amount: pay.amount, reference: `PIX-RASTREIO-${stamp}` })
  const done = await until("o checkout completar", async () => {
    const c = await ok("GET", `${TRANSACTION}${F}/checkouts/${checkout.id}`, null)
    return c.status === "completed" && c.order_id ? c : null
  })
  const order = await until("o pedido da loja", async () => {
    const page = await ok("GET", `${TRANSACTION}${S}/orders?limit=50`, sellerTok)
    return (page.items as { id: string; marketplace_order_id: string; status: string }[]).find((o) => o.marketplace_order_id === done.order_id && o.status === "placed")
  })
  orderId = order.id
  const quote = await ok("POST", `${TRANSACTION}${S}/shipping/quotes`, sellerTok, {
    currency: "BRL", seller_order_id: orderId, origin: { country: "BR", postal_code: "37500-014", region: "MG", locality: "Itajubá", line1: "Av. BPS, 1303", recipient: "Loja" },
    packages: [{ weight_grams: 500, length_mm: 200, width_mm: 150, height_mm: 100 }],
  })
  const local = (quote.options as { carrier: string; service_code: string }[]).find((o) => o.carrier === "local")!
  await ok("POST", `${TRANSACTION}${S}/shipments`, sellerTok, { seller_order_id: orderId, quote_id: quote.id, carrier: "local", service_code: local.service_code })
  const task = await until("a tarefa de entrega", async () => {
    const page = await ok("GET", `${TRANSACTION}${S}/delivery-tasks`, sellerTok)
    return (page.items as { id: string; seller_order_id: string }[]).find((t) => t.seller_order_id === orderId)
  })
  taskId = task.id
  await ok("POST", `${TRANSACTION}${S}/orders/${orderId}/fulfillment`, sellerTok, { status: "ready_for_pickup" })
  const offer = await until("a oferta ao entregador de teste", async () => {
    const r = await ok("GET", `${TRANSACTION}/v1/courier/offers`, courierTok)
    return (r.items as { offer: { id: string; task_id: string } }[] ?? []).find((o) => o.offer?.task_id === taskId)
  })
  await ok("POST", `${TRANSACTION}/v1/courier/offers/${offer.offer.id}/accept`, courierTok)
  deliveryCode = (await ok("GET", `${TRANSACTION}${S}/delivery-tasks/${taskId}`, sellerTok)).delivery_code
})

test("API: dono vê, lojista e rede veem, a outro não se mostra nada do entregador", async () => {
  const cdlTok = await token(L.cdl.client, L.cdl.secret)
  await ok("PUT", `${TRANSACTION}/v1/courier/location`, courierTok, { latitude: -22.4100, longitude: -45.4480 })
  for (const [url, tok] of [
    [`${TRANSACTION}/v1/my-purchases/${orderId}/tracking`, buyerTok],
    [`${TRANSACTION}${S}/delivery-tasks/${taskId}/tracking`, sellerTok],
    [`${TRANSACTION}/v1/organizations/${E.org}/delivery-tasks/${taskId}/tracking`, cdlTok],
  ] as const) {
    const r = await call("GET", url, tok)
    expect(r.status, url).toBe(200)
    expect(r.json.active).toBe(true)
    expect(r.json.stage).toBe("to_pickup")
    expect(r.json.courier.first_name).toBe("Rastreio")
    expect(r.json.courier.vehicle).toBe("bicycle")
    expect(r.json.courier.latitude).toBeCloseTo(-22.41, 3)
    expect(r.json.destination.latitude).toBeCloseTo(DEST.latitude, 4)
    expect(JSON.stringify(r.json)).not.toMatch(new RegExp(`Teste ${stamp}|phone|tax_id`))
  }
  /* O token do entregador não é comprador; o lojista não lê pela rota do comprador. */
  expect((await call("GET", `${TRANSACTION}/v1/my-purchases/${orderId}/tracking`, sellerTok)).status).toBe(403)
  expect((await call("GET", `${TRANSACTION}${S}/delivery-tasks/${crypto.randomUUID()}/tracking`, sellerTok)).status).toBe(404)
})

test("comprador, lojista e rede veem o marcador andar; ao entregar, some", async ({ browser }) => {
  /* Comprador na vitrine. */
  const buyer = await browser.newPage({ viewport: { width: 1366, height: 900 }, locale: "pt-BR" })
  await buyer.goto(`${STORE}/sign-in`)
  await buyer.locator("main").getByRole("textbox", { name: /^E-mail/ }).fill(ST.buyer.email)
  await buyer.locator("main").getByRole("textbox", { name: /^Senha/ }).fill(ST.buyer.password)
  await buyer.getByRole("button", { name: "Entrar", exact: true }).click()
  await expect(buyer).toHaveURL(/\/account/)
  await buyer.goto(`${STORE}/account/orders/${orderId}`)
  await expect(buyer.getByTestId("delivery-map")).toBeVisible()
  await expect(buyer.getByTestId("live-stage")).toHaveText("A caminho da loja")
  await expect(buyer.getByTestId("delivery-code")).toContainText(deliveryCode)
  await expect(buyer.locator(".maplibregl-ctrl-attrib")).toContainText(/OpenStreetMap|OpenFreeMap/)
  const b1 = await marker(buyer)
  await shot(buyer, "01-comprador-a-caminho-da-loja")

  const seller = await staffPage(browser, SELLER, ST.seller.client, ST.seller.secret)
  await seller.goto(`${SELLER}/deliveries/${taskId}`)
  await expect(seller.getByTestId("delivery-map")).toBeVisible()
  const s1 = await marker(seller)
  await shot(seller, "02-lojista-ao-vivo")

  const admin = await staffPage(browser, ADMIN, L.cdl.client, L.cdl.secret)
  await admin.goto(`${ADMIN}/logistics/dispatch?org=${E.org}`)
  await expect(admin.getByTestId("network-map")).toBeVisible()
  await expect(admin.locator(".sx-tmap__courier[title*='Rastreio']")).toBeVisible({ timeout: 30_000 })
  await noCdl(admin)
  await shot(admin, "03-rede-monitor")
  await admin.goto(`${ADMIN}/logistics/dispatch/${E.store}/${taskId}?org=${E.org}`)
  await expect(admin.getByTestId("delivery-map")).toBeVisible()
  const a1 = await marker(admin)
  await noCdl(admin)

  /* Com os volumes na mão, segue para o comprador, e o marcador anda. */
  const t = await ok("GET", `${TRANSACTION}${S}/delivery-tasks/${taskId}`, sellerTok)
  for (const v of t.volumes) await ok("POST", `${TRANSACTION}/v1/courier/scans`, courierTok, { qr: v.qr })
  await ok("PUT", `${TRANSACTION}/v1/courier/location`, courierTok, { latitude: -22.4200, longitude: -45.4515 })
  await expect(buyer.getByTestId("live-stage")).toHaveText("Indo até você", { timeout: 30_000 })
  await expect(buyer.getByTestId("live-eta")).toContainText(/cerca de \d+ min/)
  await expect.poll(async () => (await marker(buyer)).at, { timeout: 30_000 }).not.toBe(b1.at)
  expect((await marker(buyer)).turn).toMatch(/rotate\(\d/)
  await shot(buyer, "04-comprador-indo-ate-voce")
  await expect.poll(async () => (await marker(seller)).at, { timeout: 30_000 }).not.toBe(s1.at)
  await shot(seller, "05-lojista-marcador-andou")
  await expect.poll(async () => (await marker(admin)).at, { timeout: 30_000 }).not.toBe(a1.at)
  await shot(admin, "06-rede-detalhe-andou")

  /* Entregue: o entregador sai do mapa nas três telas. */
  await ok("POST", `${TRANSACTION}/v1/courier/tasks/${taskId}/deliver`, courierTok, { code: deliveryCode, ...DEST })
  const after = await ok("GET", `${TRANSACTION}/v1/my-purchases/${orderId}/tracking`, buyerTok)
  expect(after.active).toBe(false)
  expect(after.courier).toBeUndefined()
  await expect(buyer.getByTestId("delivery-map")).toBeHidden({ timeout: 30_000 })
  await shot(buyer, "07-comprador-entregue")
  await seller.reload()
  await expect(seller.getByTestId("delivery-map")).toBeHidden()
  await admin.reload()
  await expect(admin.getByTestId("delivery-map")).toBeHidden()
  await shot(admin, "08-rede-entregue")
})
