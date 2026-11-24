/* Prepara a stack para o ponta a ponta do comprador com conta
 * (tests/comprador.spec.ts). Roda depois de `prepare-stack` e
 * `prepare-logistics` (lê .tmp/state.json e .tmp/logistics.json) e é
 * idempotente.
 *
 * 1. A loja ganha um endereço de retirada: sem ele a cotação de frete da
 *    vitrine responde 409 storefront.no_origin.
 * 2. As transportadoras da loja ficam só na entrega local (shipping.carriers
 *    = ["local"]), com a chave já concedida pelo prepare-logistics: é a
 *    entrega local que gera o código de quatro dígitos do comprador.
 *
 * A vitrine web tem de ser servida com NUXT_PUBLIC_STORE_ID igual à loja de
 * .tmp/state.json, para o cadastro e a newsletter falarem com ela. */
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const tmp = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".tmp")
const env = (k: string, d: string) => process.env[k] || d
const CONTROL = env("E2E_CONTROL_PLANE", "http://localhost:8080")
const IDP = env("E2E_IDP", "http://localhost:9000")

async function token(id: string, secret: string): Promise<string> {
  const r = await fetch(`${IDP}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, audience: "sellvex-api" }),
  })
  const t = ((await r.json().catch(() => ({}))) as { access_token?: string }).access_token
  if (!t) throw new Error(`sem token para ${id}: HTTP ${r.status}`)
  return t
}

async function call(method: string, url: string, tok: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, text: await r.text() }
}

/** O endereço de retirada em Manaus, a mesma cidade do comprador: a
    entrega local só cota dentro da cidade. Os specs de logística e
    entregas trocam a retirada para Itajubá; os do comprador chamam
    prepareBuyer() antes para não depender da ordem da suíte. */
export const BUYER_PICKUP = { country: "BR", postal_code: "69005-010", locality: "Manaus", region: "AM", line1: "Rua Marcílio Dias, 100", latitude: -3.1365, longitude: -60.0234 }

export async function prepareBuyer(log: (m: string) => void = console.log) {
  const state = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8")) as { store: { id: string }; seller: { client: string; secret: string } }
  const logistics = JSON.parse(readFileSync(join(tmp, "logistics.json"), "utf8")) as { operator: { client: string; secret: string } }
  const s = `${CONTROL}/v1/stores/${state.store.id}`
  const seller = await token(state.seller.client, state.seller.secret)
  const operator = await token(logistics.operator.client, logistics.operator.secret)

  log("• endereço de retirada da loja")
  const pickup = await call("PUT", `${s}/pickup-address`, seller, BUYER_PICKUP)
  if (pickup.status >= 300) throw new Error(`pickup-address: HTTP ${pickup.status} ${pickup.text.slice(0, 300)}`)

  log("• transportadoras da loja: só a entrega local")
  const grant = await call("PUT", `${s}/policy-grants/shipping.carriers`, operator, { reason: "e2e: comprador com entrega local" })
  if (![200, 201, 204, 409].includes(grant.status)) throw new Error(`grant: HTTP ${grant.status} ${grant.text.slice(0, 300)}`)
  const policy = await call("PUT", `${s}/policies/shipping.carriers`, seller, { value: { list: ["local"] }, reason: "e2e: comprador com entrega local" })
  if (policy.status >= 300) throw new Error(`shipping.carriers: HTTP ${policy.status} ${policy.text.slice(0, 300)}`)
  log(`pronto: loja ${state.store.id} — sirva a vitrine com NUXT_PUBLIC_STORE_ID=${state.store.id}`)
}

if (import.meta.main) prepareBuyer().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1) })
