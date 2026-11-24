/* Cria pedidos de teste aleatórios com entrega local, prontos para coleta,
 * para alguém testar o app do entregador à mão.
 *
 *   bun run scripts/seed-test-orders.ts [quantidade=3]
 *
 * Mesmo caminho da API REST do e2e (simulador.spec): comprador anônimo
 * compra na loja do preparo (`.tmp/entregas.json`) com Pix manual, a loja
 * confirma o pagamento, reserva a entrega local e marca pronto. A cascata
 * de despacho oferece cada corrida aos entregadores online da rede.
 *
 * Clientes com e-mail `teste.pedido.*@sellvex.local`, para a limpeza achar
 * só o que este script criou. Pré-requisito: prepare-stack, prepare-logistics
 * e prepare-entregas. */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { state } from "../tests/state"
import { token } from "../tests/fixtures"

const here = dirname(fileURLToPath(import.meta.url))
const E = JSON.parse(readFileSync(join(here, "..", ".tmp", "entregas.json"), "utf8")) as { store: string; variant: { id: string } }
const env = (k: string, d: string) => process.env[k] || d
const COMMERCE = env("E2E_COMMERCE", "http://localhost:8082")
const TRANSACTION = env("E2E_TRANSACTION", "http://localhost:8083")
const S = `/v1/stores/${E.store}`
const F = `/v1/storefronts/${E.store}`

const NAMES = ["Ana Souza", "Bruno Lima", "Carla Mendes", "Diego Rocha", "Elisa Prado", "Fábio Nunes", "Gabriela Reis", "Heitor Campos", "Isabela Torres", "João Pedro Alves"]
const STREETS = [
  ["Rua Coronel Rennó", "Centro"], ["Avenida BPS", "Pinheirinho"], ["Rua Doutor Pereira Cabral", "Centro"],
  ["Rua Wenceslau Braz", "Varginha"], ["Avenida Cesário Alvim", "Centro"], ["Rua Xavier Lisboa", "Morro Chic"],
]
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!

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

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error(`esperando ${what}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function one(sellerTok: string, n: number) {
  const name = pick(NAMES)
  const [street, district] = pick(STREETS)
  const number = String(10 + Math.floor(Math.random() * 990))
  const phone = `+55359${String(80000000 + Math.floor(Math.random() * 19999999))}`
  const address = (recipient: string) => ({ country: "BR", postal_code: "37500-000", region: "MG", locality: "Itajubá", line1: `${street}, ${number}`, line2: district, recipient })
  const qty = 1 + Math.floor(Math.random() * 3)

  const cart = await api<{ id: string }>("POST", `${COMMERCE}${F}/carts`, "", { currency: "BRL" })
  await api("PUT", `${COMMERCE}${F}/carts/${cart.id}/items/${E.variant.id}`, "", { quantity: qty })
  const checkout = await api<{ id: string }>("POST", `${TRANSACTION}${F}/checkouts`, "", {
    cart_id: cart.id, payment_method_token: "manual:pix",
    delivery: { contact: { name, phone, email: `teste.pedido.${Date.now()}.${n}@sellvex.local` }, address: address(name) },
  })
  await until("o checkout aguardar o Pix", async () => (await api<{ status: string }>("GET", `${TRANSACTION}${F}/checkouts/${checkout.id}`, "")).status === "payment_pending")
  const manual = await api<{ items: { payment_id: string; amount: number; status: string }[] }>("GET", `${TRANSACTION}${S}/manual-payments`, sellerTok)
  const pay = manual.items.filter((m) => m.status !== "confirmed").at(-1) ?? manual.items.at(-1)!
  await api("POST", `${TRANSACTION}${S}/payments/${pay.payment_id}/manual-confirmation`, sellerTok, { amount: pay.amount, reference: `PIX-TESTE-${Date.now()}` })
  const done = await until("o checkout completar", async () => {
    const c = await api<{ status: string; order_id?: string }>("GET", `${TRANSACTION}${F}/checkouts/${checkout.id}`, "")
    return c.status === "completed" && c.order_id ? c : null
  })
  const order = await until("o pedido da loja", async () => {
    const page = await api<{ items: { id: string; marketplace_order_id: string; status: string }[] }>("GET", `${TRANSACTION}${S}/orders?limit=50`, sellerTok)
    return page.items.find((o) => o.marketplace_order_id === done.order_id && o.status === "placed")
  })
  const quote = await api<{ id: string; options: { carrier: string; service_code: string }[] }>("POST", `${TRANSACTION}${S}/shipping/quotes`, sellerTok, {
    currency: "BRL", origin: address("Loja"), destination: address(name),
    packages: [{ weight_grams: 500 * qty, length_mm: 200, width_mm: 150, height_mm: 100 }],
  })
  const local = quote.options.find((o) => o.carrier === "local")
  if (!local) throw new Error("a cotação não oferece entrega local")
  await api("POST", `${TRANSACTION}${S}/shipments`, sellerTok, { seller_order_id: order.id, quote_id: quote.id, carrier: "local", service_code: local.service_code })
  await until("a tarefa de entrega", async () => {
    const page = await api<{ items: { seller_order_id: string }[] }>("GET", `${TRANSACTION}${S}/delivery-tasks`, sellerTok)
    return page.items.find((t) => t.seller_order_id === order.id)
  })
  await api("POST", `${TRANSACTION}${S}/orders/${order.id}/fulfillment`, sellerTok, { status: "ready_for_pickup" })
  console.log(`pedido ${n}: ${name}, ${street}, ${number} (${district}) — ${qty} item(ns), pronto para coleta`)
}

const count = Math.max(1, Math.min(20, Number(process.argv[2] ?? 3) || 3))
const { seller } = state()
const sellerTok = await token(seller.client, seller.secret)
for (let i = 1; i <= count; i++) await one(sellerTok, i)
console.log(`${count} pedido(s) criados; as ofertas vão para os entregadores online.`)
