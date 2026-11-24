/* Prepara a stack para o ponta a ponta do app Sellvex Log
 * (core docs/logistica.md §9). Roda depois de `prepare-stack` (lê
 * .tmp/state.json: a loja e o lojista) e é idempotente.
 *
 * Os logins novos são usuários do dev-idp (POST /admin/users), e não
 * clientes no arquivo de clientes: usuários ficam no volume do dev-idp e
 * não pedem recriar o container — outro teste pode estar usando o mesmo
 * dev-idp com o seu próprio arquivo de clientes montado.
 *
 * 1. Logins: o entregador (actor courier, entra pelo app com e-mail e
 *    senha), um operador da plataforma e a equipe da CDL (store_member da
 *    organização da loja).
 * 2. Filiações, gravadas no Postgres local pelo mesmo motivo do
 *    prepare-stack (só o develop as concederia pela API): `admin` da
 *    plataforma para o operador; na organização, as permissões que a CDL
 *    usa para aprovar entregadores.
 * 3. A loja liga shipping, couriers e dispatch; a plataforma concede
 *    shipping.carriers e a loja põe `local` na lista.
 * 4. A plataforma grava o regime "por corrida" do teste (R$ 8,00, taxa de
 *    10%): o líquido esperado no app é R$ 7,20.
 * 5. O endereço de retirada da loja (a tarefa o leva ao entregador).
 * 6. A loja cria a frota privada do teste. O entregador NÃO é criado
 *    aqui: o teste faz o cadastro público pela tela, envia a CNH por
 *    upload, e só então põe o entregador na frota e a CDL aprova
 *    (`approveCourier`, abaixo).
 * 7. Uma variante em estoque, para o teste comprar.
 *
 * Grava .tmp/entregas.json. */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const tmp = join(root, ".tmp")
const env = (k: string, d: string) => process.env[k] || d
const CONTROL = env("E2E_CONTROL_PLANE", "http://localhost:8080")
const COMMERCE = env("E2E_COMMERCE", "http://localhost:8082")
const TRANSACTION = env("E2E_TRANSACTION", "http://localhost:8083")
const IDP = env("E2E_IDP", "http://localhost:9000")
const IDP_ADMIN_SECRET = env("E2E_IDP_ADMIN_SECRET", "local-devidp-admin-secret")
const ISSUER = env("E2E_ISSUER", "http://dev-idp:9000")
const PROJECT = env("E2E_COMPOSE_PROJECT", "sellvex-minimal")
const PG = env("E2E_POSTGRES_CONTAINER", `${PROJECT}-postgres-1`)

export const PICKUP = { country: "BR", postal_code: "37500-014", region: "MG", locality: "Itajubá", line1: "Av. BPS, 1303", recipient: "Balcão da loja E2E" }
const OPERATOR = { email: "operador.app.e2e@sellvex.local", password: "operador-app-e2e-123", name: "Operador App E2E" }
const CDL = { email: "cdl.app.e2e@sellvex.local", password: "cdl-app-e2e-123", name: "Equipe CDL App E2E" }
const REGIME = "e2e-app-por-corrida"
const FLEET = "Frota E2E app entregas"

const step = (t: string) => console.log(`• ${t}`)
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, string>
const psql = (sql: string) => execFileSync("docker", ["exec", PG, "psql", "-U", "sellvex", "-d", "sellvex", "-Atc", sql], { encoding: "utf8" }).trim()
const q = (s: string) => s.replace(/'/g, "''")

async function token(id: string, secret: string): Promise<string> {
  const r = await fetch(`${IDP}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, audience: "sellvex-api" }),
  })
  const body = await r.json().catch(() => ({})) as { access_token?: string }
  if (!body.access_token) throw new Error(`o dev-idp não emite token para ${id} (HTTP ${r.status})`)
  return body.access_token
}

export async function call<T = any>(method: string, url: string, tok: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {}
  if (tok) headers.authorization = `Bearer ${tok}`
  if (method !== "GET" && tok) headers["idempotency-key"] = crypto.randomUUID()
  if (body !== undefined) headers["content-type"] = "application/json"
  const r = await fetch(url, { method, headers, body: body === undefined ? null : JSON.stringify(body) })
  const text = await r.text()
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: r.status, body: parsed as T }
}

function must<T>(r: { status: number; body: T }, ok: number[], what: string): T {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`)
  return r.body
}

async function user(u: { email: string; password: string; name: string }, actorType: string, organizationId?: string): Promise<string> {
  const r = await fetch(`${IDP}/admin/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${IDP_ADMIN_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ ...u, actor_type: actorType, ...(organizationId ? { organization_id: organizationId } : {}) }),
  })
  if (![200, 201, 409].includes(r.status)) throw new Error(`criar ${u.email}: HTTP ${r.status}`)
  const tok = await token(u.email, u.password)
  if (claims(tok).sellvex_actor_type !== actorType) throw new Error(`${u.email} não é ${actorType}`)
  return tok
}

async function main() {
  const state = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8")) as { store: { id: string; organizationId: string }; seller: { client: string; secret: string } }
  const store = state.store.id
  const org = state.store.organizationId
  const s = `/v1/stores/${store}`

  step("logins")
  const operatorTok = await user(OPERATOR, "platform_operator")
  let cdlTok = await user(CDL, "store_member", org)
  const seller = await token(state.seller.client, state.seller.secret)

  step("filiações")
  const opSub = claims(operatorTok).sub!
  psql(`insert into identity.memberships (id, issuer, subject, permissions, created_at, created_by, roles)
        select gen_random_uuid(), '${ISSUER}', '${q(opSub)}', '{}', now(), 'e2e-prepare-entregas', '{admin}'
        where not exists (select 1 from identity.memberships where issuer='${ISSUER}' and subject='${q(opSub)}'
                          and organization_id is null and store_id is null and deleted_at is null)`)
  const cdlSub = claims(cdlTok).sub!
  const cdlPerms = "{couriers.regimes.read,couriers.fleets.read,couriers.fleets.write,couriers.couriers.read,couriers.couriers.review,payouts.couriers.read,payouts.couriers.write}"
  psql(`insert into identity.memberships (id, issuer, subject, organization_id, permissions, created_at, created_by, roles)
        select gen_random_uuid(), '${ISSUER}', '${q(cdlSub)}', '${org}', '${cdlPerms}', now(), 'e2e-prepare-entregas', '{}'
        where not exists (select 1 from identity.memberships where issuer='${ISSUER}' and subject='${q(cdlSub)}'
                          and organization_id='${org}' and store_id is null and deleted_at is null)`)
  psql(`update identity.memberships set permissions='${cdlPerms}' where issuer='${ISSUER}' and subject='${q(cdlSub)}'
        and organization_id='${org}' and store_id is null and deleted_at is null`)
  cdlTok = await token(CDL.email, CDL.password)

  step("módulos de entrega da loja")
  for (const mod of ["shipping", "couriers", "dispatch"]) {
    for (const action of ["install", "enable"]) {
      await call("POST", `${CONTROL}${s}/modules/${mod}/${action}`, seller)
    }
  }
  must(await call("PUT", `${CONTROL}${s}/policy-grants/shipping.carriers`, operatorTok, { reason: "entrega local da CDL (e2e do app)" }), [200, 201, 409], "conceder shipping.carriers")
  must(await call("PUT", `${CONTROL}${s}/policies/shipping.carriers`, seller, { value: { list: ["local"] }, reason: "entrega local da CDL (e2e do app)" }), [200, 201], "ligar a entrega local")
  for (let i = 0; i < 40; i++) {
    const ok = (await call("GET", `${TRANSACTION}${s}/delivery-tasks`, seller)).status === 200 && (await call("GET", `${TRANSACTION}${s}/courier-fleets`, seller)).status === 200
    if (ok) break
    if (i === 39) throw new Error("a loja não lê tarefas e frotas depois de ligar os módulos")
    await new Promise((r) => setTimeout(r, 500))
  }

  step("regime de trabalho")
  must(await call("PUT", `${TRANSACTION}/v1/courier-regimes/${REGIME}`, operatorTok, {
    name: "E2E app: por corrida",
    rules: {
      bond: "autonomous", payer: "store", currency: "BRL", pay: { model: "per_ride", ride_amount: 800 }, timing: "on_delivery", hold_hours: 0,
      fee: { kind: "percent", basis_points: 1000 }, schedule: "free", max_refusals: 0, can_choose: true, area: {}, requirements: ["cnh"],
    },
  }), [200, 201], "regime")

  step("endereço de retirada da loja")
  must(await call("PUT", `${CONTROL}/v1/stores/${store}/pickup-address`, seller, PICKUP), [200, 201, 204], "endereço de retirada")

  step("frota privada da loja")
  const fleets = must(await call<{ items: { id: string; name: string }[] }>("GET", `${TRANSACTION}${s}/courier-fleets`, seller), [200], "frotas")
  let fleetId = fleets.items?.find((f) => f.name === FLEET)?.id
  if (!fleetId) fleetId = must(await call<{ id: string }>("POST", `${TRANSACTION}${s}/courier-fleets`, seller, { name: FLEET, visibility: "private", regime_id: REGIME }), [201], "criar frota").id

  step("variante em estoque")
  const products = must(await call<{ items: { id: string; title: string; variants?: { id: string; available?: number }[] }[] }>("GET", `${COMMERCE}/v1/storefronts/${store}/products?limit=50`, ""), [200], "produtos")
  const variant = products.items.flatMap((p) => (p.variants ?? []).map((v) => ({ product: p.title, ...v }))).find((v) => (v.available ?? 1) > 0)
  if (!variant) throw new Error("nenhuma variante em estoque na loja do teste")

  const out = { store, org, cdl: CDL, regime: REGIME, fleetId, pickup: PICKUP, variant: { id: variant.id, product: variant.product } }
  writeFileSync(join(tmp, "entregas.json"), JSON.stringify(out, null, 2))
  console.log(`pronto: frota ${fleetId}, regime ${REGIME}; o entregador é criado pelo teste`)
}

/** Depois do cadastro pela tela: a loja põe o entregador na frota e a
    CDL aprova os documentos pendentes e o cadastro. */
export async function approveCourier(setup: { store: string; org: string; fleetId: string; cdl: { email: string; password: string } }, sellerTok: string, courierId: string): Promise<void> {
  const s = `/v1/stores/${setup.store}`
  must(await call("PUT", `${TRANSACTION}${s}/courier-fleets/${setup.fleetId}/members/${courierId}`, sellerTok, {}), [200, 201], "pôr o entregador na frota")
  const cdlTok = await token(setup.cdl.email, setup.cdl.password)
  const detail = must(await call<{ status: string; documents?: { id: string; status: string }[] }>("GET", `${TRANSACTION}/v1/organizations/${setup.org}/couriers/${courierId}`, cdlTok), [200], "a CDL lê o entregador")
  for (const d of detail.documents ?? []) {
    if (d.status === "pending") must(await call("POST", `${TRANSACTION}/v1/organizations/${setup.org}/courier-documents/${d.id}/review`, cdlTok, { decision: "approve" }), [200], "aprovar documento")
  }
  if (detail.status !== "approved") must(await call("POST", `${TRANSACTION}/v1/organizations/${setup.org}/couriers/${courierId}/review`, cdlTok, { decision: "approved" }), [200], "aprovar entregador")
}

/** A CDL registra um repasse ao entregador. */
export async function payCourier(setup: { org: string; cdl: { email: string; password: string } }, courierId: string, amount: number, reference: string): Promise<{ id: string }> {
  const cdlTok = await token(setup.cdl.email, setup.cdl.password)
  return must(await call<{ id: string }>("POST", `${TRANSACTION}/v1/organizations/${setup.org}/courier-payouts`, cdlTok, {
    courier_id: courierId, currency: "BRL", amount, reference, paid_at: new Date().toISOString(),
  }), [200, 201], "registrar repasse")
}

/** Tira da fila os entregadores de rodadas anteriores deste teste (o teste corre sozinho na stack; um
    teste que falhou a meio deixa o seu online, e ele levaria a oferta). */
export function offlinePreviousRuns(): void {
  psql(`update couriers.couriers set online = false where online`)
}

export { token }

if (import.meta.main) main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1) })
