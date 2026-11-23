import { execFileSync } from "node:child_process"

/* O que os testes de logística preparam a cada rodada, para rodarem de
 * novo contra o mesmo banco sem um `prepare-logistics` no meio: um pedido
 * pago novo, o entregador de volta a pendente e saldo devido para o
 * repasse. Mesmo caminho do prepare-logistics (API pública e, onde só o
 * develop poderia, o Postgres local). */
const env = (k: string, d: string) => process.env[k] || d
const COMMERCE = env("E2E_COMMERCE", "http://localhost:8082")
const TRANSACTION = env("E2E_TRANSACTION", "http://localhost:8083")
const IDP = env("E2E_IDP", "http://localhost:9000")
const PG = env("E2E_POSTGRES_CONTAINER", `${env("E2E_COMPOSE_PROJECT", "sellvex-minimal")}-postgres-1`)

export const psql = (sql: string) => execFileSync("docker", ["exec", PG, "psql", "-U", "sellvex", "-d", "sellvex", "-Atc", sql], { encoding: "utf8" }).trim()

export async function token(client: string, secret: string): Promise<string> {
  const r = await fetch(`${IDP}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: client, client_secret: secret, audience: "sellvex-api" }) })
  const t = ((await r.json().catch(() => ({}))) as { access_token?: string }).access_token
  if (!t) throw new Error(`sem token para ${client}: HTTP ${r.status}`)
  return t
}

async function call(method: string, url: string, tok?: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (tok) headers.authorization = `Bearer ${tok}`
  if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID()
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  if (r.status >= 300) throw new Error(`${method} ${url}: HTTP ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Um pedido novo, pago por Pix manual e baixado pelo lojista: `placed`. */
export async function paidOrder(storeId: string, seller: { client: string; secret: string }): Promise<string> {
  const tok = await token(seller.client, seller.secret)
  const products = await call("GET", `${COMMERCE}/v1/storefronts/${storeId}/products?limit=20`) as { items: { variants?: { id: string; available?: number }[] }[] }
  const variant = products.items.flatMap((p) => p.variants ?? []).find((v) => (v.available ?? 1) > 0)
  if (!variant) throw new Error("nenhuma variante em estoque")
  const cart = await call("POST", `${COMMERCE}/v1/storefronts/${storeId}/carts`, undefined, { currency: "BRL" }) as { id: string }
  await call("PUT", `${COMMERCE}/v1/storefronts/${storeId}/carts/${cart.id}/items/${variant.id}`, undefined, { quantity: 1 })
  const checkout = await call("POST", `${TRANSACTION}/v1/storefronts/${storeId}/checkouts`, undefined, { cart_id: cart.id, payment_method_token: "manual:pix" })
  const text = JSON.stringify(checkout)
  for (let i = 0; i < 40; i++) {
    const list = await call("GET", `${TRANSACTION}/v1/stores/${storeId}/manual-payments`, tok) as { items?: { payment_id: string; marketplace_order_id: string; amount: number }[] }
    const p = (list.items ?? []).find((x) => text.includes(x.marketplace_order_id))
    if (p) { await call("POST", `${TRANSACTION}/v1/stores/${storeId}/payments/${p.payment_id}/manual-confirmation`, tok, { amount: p.amount, reference: "e2e-logistica" }); break }
    await wait(500)
  }
  for (let i = 0; i < 60; i++) {
    const orders = await call("GET", `${TRANSACTION}/v1/stores/${storeId}/orders?limit=50`, tok) as { items?: { id: string; marketplace_order_id: string; status: string }[] }
    const o = (orders.items ?? []).find((x) => x.status === "placed" && text.includes(x.marketplace_order_id))
    if (o) return o.id
    await wait(500)
  }
  throw new Error("o pedido não ficou confirmado depois da baixa")
}

/** Volta o entregador a pendente, para o teste aprovar pela tela. */
export function courierPending(courierId: string): void {
  psql(`update couriers.couriers set status='pending', reason='' where id='${courierId}'`)
}

/** O que a rede deve ao entregador agora: corridas e períodos fechados
    menos o já pago (a mesma conta do core, payouts.payout_exceeds_owed). */
export function owed(orgId: string, courierId: string): number {
  return Number(psql(`select
      coalesce((select sum(net_amount) from dispatch.rides where organization_id='${orgId}' and courier_id='${courierId}' and currency='BRL'), 0)
    + coalesce((select sum(amount) from dispatch.period_closings where organization_id='${orgId}' and courier_id='${courierId}' and currency='BRL'), 0)
    - coalesce((select sum(amount) from payouts.courier_payouts where organization_id='${orgId}' and courier_id='${courierId}' and currency='BRL'), 0)`))
}

/** Garante pelo menos `amount` devido: fecha um período diário do teste
    (dispatch.period_closings, como o worker faria) com a diferença. */
export function ensureOwed(orgId: string, courierId: string, amount: number): void {
  const missing = amount - owed(orgId, courierId)
  if (missing <= 0) return
  psql(`insert into dispatch.period_closings (id, organization_id, courier_id, regime_id, regime_version, kind, period_start, period_end, payer, currency, amount, closed_at)
        values (gen_random_uuid(), '${orgId}', '${courierId}', 'e2e-repasse', 1, 'daily',
                now() - interval '1 day' + (random() * interval '1 hour'), now(), 'network', 'BRL', ${missing}, now())`)
}
