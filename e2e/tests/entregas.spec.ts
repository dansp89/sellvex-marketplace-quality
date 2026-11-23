import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { state } from "./state"
import { approveCourier, payCourier } from "../scripts/prepare-entregas"

/* O entregador no app Sellvex Entregas, do cadastro ao repasse, com um
 * pedido de verdade:
 *
 *   cria a conta pela tela (cadastro público) → completa o perfil → envia
 *   a CNH fotografada (upload direto pela URL assinada) → a loja o põe na
 *   frota e a CDL aprova (API) → fica online → um comprador compra pela API, a loja confirma o
 *   Pix, reserva a entrega local e marca pronto → a oferta chega ao app →
 *   aceita → lê o QR do volume na loja (o valor é injetado no campo de
 *   código, como faria quem digita a etiqueta) → na porta, código errado
 *   mostra o erro e o certo entrega → a corrida aparece no extrato →
 *   a CDL registra um repasse e ele aparece na tela de repasses.
 *
 * A tarefa leva o endereço de retirada da loja; o telefone de quem recebe
 * só aparece (botão Ligar, tel:) com a corrida na rua, e some ao concluir.
 *
 * O comprador e a loja falam pela API REST (o app da loja e a vitrine têm
 * os seus testes); só o entregador anda pela tela. Rode antes
 * `bun run prepare-stack` e `bun run prepare-entregas`. */

const tmp = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp")
const setup = JSON.parse(readFileSync(join(tmp, "entregas.json"), "utf8")) as {
  store: string; org: string; fleetId: string; cdl: { email: string; password: string }
  pickup: { line1: string; recipient: string }; variant: { id: string }
}
const RUN = Date.now().toString(36)
const courier = { name: "Entregador Cadastro E2E", email: `entregador.${RUN}@sellvex.local`, password: `entrega-${RUN}-e2e`, phone: "35999990777", cpf: "52998224725" }
const BUYER_PHONE = "+5535988887777"
/* Um PNG de 1×1: o que a câmera do navegador (seletor de arquivo) devolve. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
const { seller } = state()
const COMMERCE = process.env.E2E_COMMERCE || "http://localhost:8082"
const TRANSACTION = process.env.E2E_TRANSACTION || "http://localhost:8083"
const IDP = process.env.E2E_IDP || "http://localhost:9000"
const S = `/v1/stores/${setup.store}`
const F = `/v1/storefronts/${setup.store}`

async function token(id: string, secret: string) {
  const r = await fetch(`${IDP}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, audience: "sellvex-api" }) })
  return ((await r.json()) as { access_token: string }).access_token
}

async function api<T = any>(method: string, url: string, tok: string, body?: unknown, idem = true): Promise<T> {
  const headers: Record<string, string> = {}
  if (tok) headers.authorization = `Bearer ${tok}`
  if (method !== "GET" && idem) headers["idempotency-key"] = crypto.randomUUID()
  if (body !== undefined) headers["content-type"] = "application/json"
  const r = await fetch(url, { method, headers, body: body === undefined ? null : JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${url}: HTTP ${r.status} ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : null) as T
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 45_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error(`esperando ${what}`)
    await new Promise((r) => setTimeout(r, 700))
  }
}

const address = (recipient: string) => ({ country: "BR", postal_code: "37500-000", region: "MG", locality: "Itajubá", line1: "Rua Coronel Rennó, 10", recipient })

type Task = { id: string; seller_order_id: string; status: string; delivery_code: string; volumes: { qr: string; holder_kind: string }[]
  distance_meters: number; distance_estimated: boolean; pickup?: { line1: string }; recipient_phone?: string }

/** O comprador compra 1 unidade com Pix, a loja confirma, reserva a
    entrega local e marca pronto para coleta. Devolve a tarefa como a loja
    a vê (com o código do comprador e o QR do volume). */
async function placeLocalDeliveryOrder(sellerTok: string): Promise<Task> {
  const cart = await api<{ id: string }>("POST", `${COMMERCE}${F}/carts`, "", { currency: "BRL" }, true)
  await api("PUT", `${COMMERCE}${F}/carts/${cart.id}/items/${setup.variant.id}`, "", { quantity: 1 })
  let checkout = await api<{ id: string; status: string; order_id?: string }>("POST", `${TRANSACTION}${F}/checkouts`, "", {
    cart_id: cart.id, payment_method_token: "manual:pix",
    delivery: { contact: { name: "Bia Comprador", phone: BUYER_PHONE, email: `bia.${RUN}@sellvex.local` }, address: address("Bia Comprador") },
  })
  checkout = await until("o checkout aguardar o Pix", async () => {
    const c = await api<typeof checkout>("GET", `${TRANSACTION}${F}/checkouts/${checkout.id}`, "")
    return c.status === "payment_pending" ? c : null
  })
  const manual = await api<{ items: { payment_id: string; amount: number; status: string; checkout_id?: string }[] }>("GET", `${TRANSACTION}${S}/manual-payments`, sellerTok)
  const pendingPay = manual.items.filter((m) => m.status !== "confirmed").at(-1) ?? manual.items.at(-1)!
  await api("POST", `${TRANSACTION}${S}/payments/${pendingPay.payment_id}/manual-confirmation`, sellerTok, { amount: pendingPay.amount, reference: `PIX-E2E-${Date.now()}` })
  const done = await until("o checkout completar", async () => {
    const c = await api<typeof checkout>("GET", `${TRANSACTION}${F}/checkouts/${checkout.id}`, "")
    return c.status === "completed" && c.order_id ? c : null
  })
  const order = await until("o pedido da loja", async () => {
    const page = await api<{ items: { id: string; marketplace_order_id: string; status: string }[] }>("GET", `${TRANSACTION}${S}/orders?limit=50`, sellerTok)
    return page.items.find((o) => o.marketplace_order_id === done.order_id && o.status === "placed")
  })
  const quote = await api<{ id: string; options: { carrier: string; service_code: string }[] }>("POST", `${TRANSACTION}${S}/shipping/quotes`, sellerTok, {
    currency: "BRL", origin: address("Loja"), destination: address("Bia Comprador"),
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
  return api<Task>("GET", `${TRANSACTION}${S}/delivery-tasks/${task.id}`, sellerTok)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: false })
}

test("entregador: online, oferta real, coleta por QR, entrega com código e extrato", async ({ page, context }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await context.grantPermissions(["geolocation"])
  await context.setGeolocation({ latitude: -22.4256, longitude: -45.4528 })
  const sellerTok = await token(seller.client, seller.secret)

  let courierId = ""
  await test.step("cadastro público pela tela", async () => {
    await page.goto("/")
    await expect(page).toHaveURL(/\/login/)
    await page.getByTestId("go-signup").click()
    await expect(page).toHaveURL(/\/signup$/)
    await page.getByTestId("signup-name").fill(courier.name)
    await page.getByTestId("signup-email").fill(courier.email)
    await page.getByTestId("signup-phone").fill(courier.phone)
    await page.getByTestId("signup-password").fill(courier.password)
    await expect(page.getByTestId("signup-submit")).toBeDisabled()
    await page.getByTestId("signup-terms").click()
    await shot(page, "01-cadastro")
    await page.getByTestId("signup-submit").click()
    await expect(page).toHaveURL(/\/profile\/edit$/, { timeout: 20_000 })
    await page.getByTestId("profile-name").fill(courier.name)
    await page.getByTestId("profile-phone").fill(courier.phone)
    await page.getByTestId("profile-cpf").fill(courier.cpf)
    await page.getByTestId("profile-save").click()
    await expect(page).toHaveURL(/\/profile$/)
    const tok = await token(courier.email, courier.password)
    courierId = (await api<{ id: string }>("GET", `${TRANSACTION}/v1/courier/me`, tok)).id
  })

  await test.step("enviar a CNH por upload", async () => {
    await page.getByTestId("add-document").click()
    await expect(page).toHaveURL(/\/profile\/documents\/new$/)
    await expect(page.getByTestId("document-submit")).toBeDisabled()
    const chooser = page.waitForEvent("filechooser")
    await page.getByTestId("photo-take").click()
    await (await chooser).setFiles({ name: "cnh.png", mimeType: "image/png", buffer: PNG })
    await expect(page.getByTestId("photo-preview")).toBeVisible()
    await shot(page, "02-documento")
    await page.getByTestId("document-submit").click()
    await expect(page).toHaveURL(/\/profile$/, { timeout: 20_000 })
    const tok = await token(courier.email, courier.password)
    const me = await api<{ documents?: { kind: string; status: string; media_id: string }[] }>("GET", `${TRANSACTION}/v1/courier/me`, tok)
    const cnh = me.documents?.find((d) => d.kind === "cnh")
    expect(cnh, "a CNH entrou no cadastro").toBeTruthy()
    const up = await api<{ status: string; kind: string; size_bytes: number }>("GET", `${TRANSACTION}/v1/courier/uploads/${cnh!.media_id}`, tok)
    expect(up).toMatchObject({ status: "uploaded", kind: "document", size_bytes: PNG.length })
  })

  await test.step("a loja põe na frota e a CDL aprova", async () => {
    await approveCourier(setup, sellerTok, courierId)
    await page.goto("/")
    await expect(page.getByTestId("courier-status")).toContainText("Aprovado")
  })

  await test.step("ficar online", async () => {
    const toggle = page.getByTestId("online-toggle")
    await expect(toggle).toBeEnabled()
    await expect(toggle).toContainText("Offline")
    await toggle.click()
    await expect(toggle).toContainText("Online")
    await expect(page.getByTestId("presence-dot")).toHaveText("Online")
    await shot(page, "2-online")
  })

  const task = await test.step("um pedido real com entrega local", () => placeLocalDeliveryOrder(sellerTok))
  expect(task.delivery_code).toMatch(/^\d{4}$/)
  expect(task.volumes.length).toBeGreaterThan(0)

  await test.step("a oferta chega e é aceita", async () => {
    const card = page.getByTestId("offer-card")
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("offer-net")).toHaveText(/R\$\s?7,20/)
    await expect(page.getByTestId("offer-countdown")).toHaveText(/^\s*\d+:\d{2}\s*$/)
    if (task.distance_estimated && task.distance_meters > 0) await expect(page.getByTestId("offer-distance")).toContainText(/≈.*estimada/)
    await shot(page, "3-oferta")
    await page.getByTestId("offer-accept").click()
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`))
    await expect(page.getByTestId("task-status")).toHaveText("Coletar na loja")
    await expect(page.getByTestId("task-pickup")).toContainText(setup.pickup.line1)
    await expect(page.getByTestId("call-recipient"), "antes da coleta o telefone não aparece").toHaveCount(0)
    await shot(page, "4-tarefa-coleta")
  })

  await test.step("ler o QR do volume na loja", async () => {
    await page.getByTestId("go-scan").click()
    await expect(page).toHaveURL(/\/scan$/)
    await page.getByTestId("scan-manual").fill(task.volumes[0]!.qr)
    await shot(page, "5-leitura-qr")
    await page.getByTestId("scan-submit").click()
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`))
    await expect(page.getByTestId("task-status")).toHaveText("A caminho")
    await expect(page.getByTestId("open-maps").last()).toHaveAttribute("href", /google\.com\/maps\/dir/)
    await expect(page.getByTestId("open-waze").last()).toHaveAttribute("href", /waze\.com\/ul/)
    await expect(page.getByTestId("call-recipient")).toHaveAttribute("href", `tel:${BUYER_PHONE}`)
    await shot(page, "6-a-caminho")
  })

  await test.step("código errado mostra o erro; o certo entrega", async () => {
    await page.getByTestId("go-deliver").click()
    const wrong = task.delivery_code === "0000" ? "1111" : "0000"
    for (const d of wrong) await page.locator(`[data-key="${d}"]`).click()
    await page.getByTestId("deliver-submit").click()
    await expect(page.getByRole("alert").filter({ hasText: "Código errado" })).toBeVisible()
    await shot(page, "7-codigo-errado")
    for (const d of task.delivery_code) await page.locator(`[data-key="${d}"]`).click()
    await shot(page, "8-codigo-certo")
    await page.getByTestId("deliver-submit").click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText("Entregue! A corrida entrou no seu extrato.")).toBeVisible()
  })

  await test.step("concluída, o telefone de quem recebe some", async () => {
    await page.goto(`/tasks/${task.id}`)
    await expect(page.getByTestId("task-status")).toHaveText("Entregue")
    await expect(page.getByTestId("call-recipient")).toHaveCount(0)
    const tok = await token(courier.email, courier.password)
    const t = await api<Task>("GET", `${TRANSACTION}/v1/courier/tasks/${task.id}`, tok)
    expect(t.recipient_phone, "a plataforma não manda mais o telefone").toBeFalsy()
  })

  await test.step("a corrida aparece no extrato", async () => {
    await page.goto("/earnings")
    await expect(page.getByTestId(`ride-${task.id}`)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(`ride-${task.id}`)).toContainText("R$ 7,20")
    await shot(page, "9-extrato")
  })

  await test.step("a CDL paga e o repasse aparece", async () => {
    const reference = `PIX-E2E-REPASSE-${RUN}`
    const paid = await payCourier(setup, courierId, 720, reference)
    await page.goto("/earnings")
    await page.getByTestId("go-payouts").click()
    await expect(page).toHaveURL(/\/earnings\/payouts$/)
    const row = page.getByTestId(`payout-${paid.id}`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText("R$ 7,20")
    await expect(row).toContainText(reference)
    await shot(page, "12-repasses")
  })

  await test.step("ficar offline no fim (e o tema escuro)", async () => {
    await page.goto("/")
    await page.getByTestId("online-toggle").click()
    await expect(page.getByTestId("online-toggle")).toContainText("Offline")
    await page.evaluate(() => localStorage.setItem("sx-theme", "dark"))
    await page.reload()
    await expect(page.getByTestId("online-toggle")).toContainText("Offline")
    await shot(page, "10-escuro-offline")
    await page.goto("/earnings")
    await expect(page.getByTestId(`ride-${task.id}`)).toBeVisible()
    await shot(page, "11-escuro-extrato")
  })

  const final = await api<Task>("GET", `${TRANSACTION}${S}/delivery-tasks/${task.id}`, sellerTok)
  expect(final.status).toBe("delivered")
  expect(errors, `erros na página: ${errors.join(" | ")}`).toEqual([])
})
