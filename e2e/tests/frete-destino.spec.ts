import { expect, test } from "@playwright/test"
import { state } from "./state"
import { restorePickup } from "./fixtures"
import { prepareBuyer } from "../scripts/prepare-buyer"

/* A cotação de frete presa ao destino do carrinho, pela API REST pública
 * (sem navegador): cotar para um CEP e fechar a compra entregando em
 * outro é recusado com 409 checkout.shipping_mismatch e não prende nada;
 * de volta ao CEP cotado (digitado de outro jeito), a compra fecha com o
 * frete. Roda depois de prepare-stack, prepare-logistics e prepare-buyer
 * (endereço de retirada e entrega local na loja). */
const env = (k: string, d: string) => process.env[k] || d
const COMMERCE = env("E2E_COMMERCE", "http://localhost:8082")
const TRANSACTION = env("E2E_TRANSACTION", "http://localhost:8083")

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID()
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, json: text ? JSON.parse(text) : null }
}

const contact = { name: "Comprador Frete", email: "frete-e2e@exemplo.com", phone: "+5592999991234" }
const address = (postal: string) => ({
  country: "BR", postal_code: postal, locality: "Manaus", region: "AM", line1: "Rua Marcílio Dias, 250", latitude: -3.1370, longitude: -60.0240,
})

/* A retirada em Manaus antes (a entrega local só cota na cidade do
   comprador) e a de Itajubá de volta depois, para os specs de logística. */
test.beforeAll(async () => { await prepareBuyer(() => {}) })
test.afterAll(async () => { const s = state(); await restorePickup(s.store.id, s.seller) })

test("frete cotado para outro CEP é recusado no checkout", async () => {
  const store = state().store.id
  const f = `/v1/storefronts/${store}`
  const products = await call("GET", `${COMMERCE}${f}/products?limit=20`)
  const variant = (products.json.items as { variants?: { id: string; available?: number }[] }[])
    .flatMap((p) => p.variants ?? []).find((v) => (v.available ?? 1) > 0)
  expect(variant, "uma variante em estoque").toBeTruthy()

  const cart = await call("POST", `${COMMERCE}${f}/carts`, { currency: "BRL" })
  expect(cart.status).toBe(201)
  const c = `${COMMERCE}${f}/carts/${cart.json.id}`
  expect((await call("PUT", `${c}/items/${variant!.id}`, { quantity: 1 })).status).toBe(200)
  expect((await call("PUT", `${c}/delivery`, { address: address("69005-010"), contact })).status).toBe(200)

  const quote = await call("POST", `${TRANSACTION}${f}/shipping-quotes`, { cart_id: cart.json.id })
  expect(quote.status, JSON.stringify(quote.json)).toBe(201)
  const opt = quote.json.options[0]
  expect(opt, "uma opção de frete").toBeTruthy()
  const shipping = { quote_id: quote.json.id, carrier: opt.carrier, service_code: opt.service_code }

  const refused = await call("POST", `${TRANSACTION}${f}/checkouts`, {
    cart_id: cart.json.id, payment_method_token: "manual:pix", shipping, delivery: { address: address("69050-000"), contact },
  })
  expect(refused.status, JSON.stringify(refused.json)).toBe(409)
  expect(refused.json.code ?? refused.json.type ?? JSON.stringify(refused.json)).toContain("checkout.shipping_mismatch")

  const ok = await call("POST", `${TRANSACTION}${f}/checkouts`, {
    cart_id: cart.json.id, payment_method_token: "manual:pix", shipping, delivery: { address: address("69005010"), contact },
  })
  expect(ok.status, JSON.stringify(ok.json)).toBe(201)
  expect(JSON.stringify(ok.json)).not.toContain("shipping_mismatch")
})
