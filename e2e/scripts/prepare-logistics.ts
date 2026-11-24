/* Prepara a stack para o ponta a ponta da entrega local (logistica.md §9).
 * Roda depois de `prepare-stack` (lê .tmp/state.json) e é idempotente.
 *
 * 1. Clientes no dev-idp: a equipe da CDL (store_member com organização e
 *    sem loja), um operador da plataforma e um entregador. O arquivo de
 *    clientes é o mesmo .tmp/dev-idp-clients.json do prepare-stack,
 *    acrescido; o dev-idp é recriado só se algum token falhar.
 * 2. Filiações: organization_admin da CDL na organização da loja, e
 *    super_admin para o operador. Gravadas no Postgres local, pelo mesmo
 *    motivo do prepare-stack (só o develop as concederia pela API).
 * 3. A organização da loja vira uma CDL, se ainda não for (o painel da CDL
 *    lê as permissões de lá).
 * 4. A loja liga os módulos couriers e dispatch; a plataforma concede à
 *    loja a chave shipping.carriers, para o lojista ligar a entrega local.
 * 5. O entregador se cadastra pelo app (PUT /v1/courier/me) e pede entrada
 *    numa frota só depois que o teste a cria; aqui fica pendente de
 *    aprovação, como na vida real.
 * 6. Um pedido pago: carrinho e checkout com pagamento manual (Pix) pela
 *    API pública, e baixa pelo lojista. É o pedido que o teste despacha.
 *
 * Grava .tmp/logistics.json. */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
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
const ISSUER = env("E2E_ISSUER", "http://dev-idp:9000")
const CORE_COMPOSE = env("E2E_CORE_COMPOSE", resolve(root, "../../sellvex-marketplace-core/deploy/compose/compose.yaml"))
const PROJECT = env("E2E_COMPOSE_PROJECT", "sellvex-minimal")
const PG = env("E2E_POSTGRES_CONTAINER", `${PROJECT}-postgres-1`)

export const CDL = { client: "e2e-cdl", secret: "e2e-cdl-local-only" }
export const OPERATOR = { client: "e2e-operador", secret: "e2e-operador-local-only" }
export const COURIER = { client: "e2e-entregador", secret: "e2e-entregador-local-only", name: "Entregador E2E" }

const step = (t: string) => console.log(`• ${t}`)
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, string>
const psql = (sql: string) => execFileSync("docker", ["exec", PG, "psql", "-U", "sellvex", "-d", "sellvex", "-Atc", sql], { encoding: "utf8" }).trim()

async function token(id: string, secret: string): Promise<string | null> {
  const r = await fetch(`${IDP}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, audience: "sellvex-api" }),
  }).catch(() => null)
  if (!r?.ok) return null
  return ((await r.json()) as { access_token?: string }).access_token ?? null
}

const REPASSE_REGIME = "e2e-repasse"
const REPASSE_FLEET = "Frota E2E repasse"

async function call(method: string, url: string, tok: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${tok}` }
  if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID()
  if (body !== undefined) headers["content-type"] = "application/json"
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
function must(r: { status: number; body: any }, what: string, ok = [200, 201, 204]) {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`)
  return r.body
}

async function main() {
  const state = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8")) as {
    store: { id: string; organizationId: string }; seller: { client: string; secret: string }
  }
  const { id: storeId, organizationId: orgId } = state.store

  step("clientes do dev-idp")
  /* O token do operador é o teto do que ele exerce (DEC-ID-008): sem os
     escopos, a filiação não vale nada. Os escopos são os do operador do core. */
  const coreClients = JSON.parse(readFileSync(join(dirname(CORE_COMPOSE), "dev-idp-clients.json"), "utf8")) as { id: string; scopes?: string[] }[]
  /* "*" no dev-idp expande para o catálogo compilado nele, que pode ser
     mais velho que o core: os escopos vêm dos manifestos dos módulos. */
  const modulesDir = resolve(dirname(CORE_COMPOSE), "../../internal/modules")
  const operatorScopes = [...new Set([
    ...(coreClients.find((c) => c.id === "operator")?.scopes ?? []).filter((x) => x !== "*"),
    ...readdirSync(modulesDir).flatMap((m) => {
      const f = join(modulesDir, m, "manifest.yaml")
      if (!existsSync(f)) return []
      const text = readFileSync(f, "utf8")
      const block = text.split(/^scopes:\s*$/m)[1]?.split(/^\S/m)[0] ?? ""
      return [...block.matchAll(/^\s+-\s+([a-z_]+\.[a-z_]+\.[a-z_]+)/gm)].map((x) => x[1]!)
    }),
  ])]
  const wanted = [
    { id: state.seller.client, secret: state.seller.secret, subject: state.seller.client, actor_type: "store_member", scopes: [],
      store_id: storeId, organization_id: orgId, name: "Lojista E2E" },
    { id: CDL.client, secret: CDL.secret, subject: CDL.client, actor_type: "store_member", scopes: [], organization_id: orgId, name: "Equipe CDL E2E" },
    { id: OPERATOR.client, secret: OPERATOR.secret, subject: OPERATOR.client, actor_type: "platform_operator", scopes: operatorScopes, name: "Operador E2E" },
    { id: COURIER.client, secret: COURIER.secret, subject: COURIER.client, actor_type: "courier", scopes: [], name: COURIER.name },
  ]
  const ok = async () => {
    for (const c of wanted) {
      const t = await token(c.id, c.secret)
      if (!t || claims(t).sellvex_actor_type !== c.actor_type) return false
      if (c.actor_type === "platform_operator" && !String(claims(t).scope ?? "").includes("couriers.regimes.write")) return false
    }
    return true
  }
  if (!(await ok())) {
    const file = join(tmp, "dev-idp-clients.json")
    const base = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { id: string }[]
      : JSON.parse(readFileSync(join(dirname(CORE_COMPOSE), "dev-idp-clients.json"), "utf8")) as { id: string }[]
    const core = JSON.parse(readFileSync(join(dirname(CORE_COMPOSE), "dev-idp-clients.json"), "utf8")) as { id: string }[]
    const ids = new Set(wanted.map((c) => c.id))
    const merged = [...core.filter((c) => !base.some((b) => b.id === c.id)), ...base.filter((c) => !ids.has(c.id)), ...wanted]
    writeFileSync(file, JSON.stringify(merged, null, 2))
    const override = join(tmp, "compose.override.yaml")
    writeFileSync(override, ["services:", "  dev-idp:", "    volumes:", `      - ${file}:/etc/sellvex/clients.json:ro`, "      - devidp-data:/var/lib/sellvex/devidp", ""].join("\n"))
    execFileSync("docker", ["compose", "-p", PROJECT, "-f", CORE_COMPOSE, "-f", override, "up", "-d", "--no-build", "--force-recreate", "dev-idp"], {
      stdio: "inherit", env: { SELLVEX_POSTGRES_PORT: "55432", SELLVEX_VALKEY_PORT: "56379", SELLVEX_WORKER_PORT: "58081", ...process.env },
    })
    for (let i = 0; i < 40 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 500))
    if (!(await ok())) throw new Error("o dev-idp não voltou com os clientes da logística")
  }
  const seller = (await token(state.seller.client, state.seller.secret))!
  const operator = (await token(OPERATOR.client, OPERATOR.secret))!
  const courier = (await token(COURIER.client, COURIER.secret))!

  step("filiações")
  psql(`insert into identity.memberships (id, issuer, subject, organization_id, store_id, permissions, created_at, created_by, roles, reach)
        select gen_random_uuid(), '${ISSUER}', '${CDL.client}', '${orgId}', null, '{}', now(), 'e2e-prepare-logistics', '{organization_admin}', 'all_stores'
        where not exists (select 1 from identity.memberships where issuer='${ISSUER}' and subject='${CDL.client}' and organization_id='${orgId}' and deleted_at is null)`)
  psql(`insert into identity.memberships (id, issuer, subject, organization_id, store_id, permissions, created_at, created_by, roles)
        select gen_random_uuid(), '${ISSUER}', '${OPERATOR.client}', null, null, '{}', now(), 'e2e-prepare-logistics', '{super_admin}'
        where not exists (select 1 from identity.memberships where issuer='${ISSUER}' and subject='${OPERATOR.client}' and organization_id is null and deleted_at is null)`)

  step("CDL da organização")
  psql(`insert into cdl.cdls (id, organization_id, name, tax_id, status, created_at, updated_at, version)
        select gen_random_uuid(), '${orgId}', 'CDL E2E Logística', '90381726000104', 'active', now(), now(), 1
        where not exists (select 1 from cdl.cdls where organization_id='${orgId}')`)

  step("módulos shipping, couriers e dispatch")
  for (const m of ["shipping", "couriers", "dispatch"]) {
    for (const action of ["install", "enable"]) {
      const r = await call("POST", `${CONTROL}/v1/stores/${storeId}/modules/${m}/${action}`, seller)
      if (![200, 201, 204, 409].includes(r.status)) throw new Error(`${m} ${action}: HTTP ${r.status} ${JSON.stringify(r.body)}`)
    }
  }
  step("chave shipping.carriers concedida à loja")
  const g = await call("PUT", `${CONTROL}/v1/stores/${storeId}/policy-grants/shipping.carriers`, operator, { reason: "e2e: entrega local" })
  if (![200, 201, 204, 409].includes(g.status)) throw new Error(`grant: HTTP ${g.status} ${JSON.stringify(g.body)}`)

  /* A loja volta às transportadoras da plataforma: o teste liga a entrega
     local pela tela. */
  const clear = await call("DELETE", `${CONTROL}/v1/stores/${storeId}/policies/shipping.carriers`, seller)
  if (![200, 204, 404, 409].includes(clear.status)) throw new Error(`limpar shipping.carriers: HTTP ${clear.status}`)

  step("entregador cadastrado")
  must(await call("PUT", `${TRANSACTION}/v1/courier/me`, courier, { name: COURIER.name, phone: "92991234567", tax_id: "52998224725", vehicle: "motorcycle" }), "cadastro do entregador")
  const me = must(await call("GET", `${TRANSACTION}/v1/courier/me`, courier), "perfil do entregador") as { id: string; status: string }
  if (me.status !== "pending") {
    /* Uma rodada anterior aprovou: volta a pendente para o teste aprovar. */
    psql(`update couriers.couriers set status='pending', reason='' where id='${me.id}'`)
  }

  /* O fechamento manual de período (FR-PAYOUT-004) só aceita entregador
     preso, numa frota da rede, a um regime de diária ou fixo, e confere
     regime, versão, pagador e moeda com o cadastrado: o saldo do repasse
     (ensureOwed) vem de uma frota da CDL sob a diária e2e-repasse. */
  step("regime e frota do repasse")
  const versions = await call("GET", `${TRANSACTION}/v1/courier-regimes/${REPASSE_REGIME}/versions`, operator)
  if (versions.status !== 200 || !(versions.body?.items ?? []).length) {
    must(await call("PUT", `${TRANSACTION}/v1/courier-regimes/${REPASSE_REGIME}`, operator, {
      name: "E2E repasse: diária",
      rules: {
        bond: "autonomous", payer: "cdl", currency: "BRL", pay: { model: "daily", daily_amount: 10_000 }, timing: "on_delivery", hold_hours: 0,
        fee: { kind: "none" }, schedule: "free", max_refusals: 0, can_choose: true, area: {}, requirements: [],
      },
    }), "regime do repasse")
  }
  const cdlTok = (await token(CDL.client, CDL.secret))!
  const fleets = must(await call("GET", `${TRANSACTION}/v1/organizations/${orgId}/courier-fleets`, cdlTok), "frotas da rede") as { items?: { id: string; name: string }[] }
  let fleetId = fleets.items?.find((f) => f.name === REPASSE_FLEET)?.id
  if (!fleetId) fleetId = (must(await call("POST", `${TRANSACTION}/v1/organizations/${orgId}/courier-fleets`, cdlTok, { name: REPASSE_FLEET, visibility: "cdl", regime_id: REPASSE_REGIME }), "frota do repasse") as { id: string }).id
  must(await call("PUT", `${TRANSACTION}/v1/organizations/${orgId}/courier-fleets/${fleetId}/members/${me.id}`, cdlTok, {}), "entregador na frota do repasse")

  step("pedido pago")
  const products = must(await call("GET", `${COMMERCE}/v1/storefronts/${storeId}/products?limit=20`, seller), "produtos") as {
    items: { variants?: { id: string; available?: number }[] }[]
  }
  const variant = products.items.flatMap((p) => p.variants ?? []).find((v) => (v.available ?? 1) > 0)
  if (!variant) throw new Error("nenhuma variante em estoque")
  const anon = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const cart = must(await anon("POST", `${COMMERCE}/v1/storefronts/${storeId}/carts`, { currency: "BRL" }), "carrinho") as { id: string }
  must(await anon("PUT", `${COMMERCE}/v1/storefronts/${storeId}/carts/${cart.id}/items/${variant.id}`, { quantity: 1 }), "item")
  const checkout = must(await anon("POST", `${TRANSACTION}/v1/storefronts/${storeId}/checkouts`, { cart_id: cart.id, payment_method_token: "manual:pix" }), "checkout") as Record<string, any>
  let paymentId = ""
  for (let i = 0; i < 20 && !paymentId; i++) {
    const list = must(await call("GET", `${TRANSACTION}/v1/stores/${storeId}/manual-payments`, seller), "pagamentos manuais") as { items?: { payment_id: string; marketplace_order_id: string; amount: number }[] }
    const p = (list.items ?? []).find((x) => JSON.stringify(checkout).includes(x.marketplace_order_id))
    if (p) {
      paymentId = p.payment_id
      must(await call("POST", `${TRANSACTION}/v1/stores/${storeId}/payments/${p.payment_id}/manual-confirmation`, seller, { amount: p.amount, reference: "e2e-logistica" }), "baixa")
    } else await new Promise((r) => setTimeout(r, 500))
  }
  if (!paymentId) throw new Error(`o pagamento do checkout não apareceu: ${JSON.stringify(checkout).slice(0, 300)}`)
  let orderId = ""
  for (let i = 0; i < 30 && !orderId; i++) {
    const orders = must(await call("GET", `${TRANSACTION}/v1/stores/${storeId}/orders?limit=50`, seller), "pedidos") as { items?: { id: string; marketplace_order_id: string; status: string }[] }
    const o = (orders.items ?? []).find((x) => x.status === "placed" && JSON.stringify(checkout).includes(x.marketplace_order_id))
    if (o) orderId = o.id
    else await new Promise((r) => setTimeout(r, 500))
  }
  if (!orderId) throw new Error("o pedido não ficou confirmado depois da baixa")

  const out = { storeId, orgId, orderId, courierId: me.id, cdl: CDL, operator: OPERATOR, courier: COURIER }
  writeFileSync(join(tmp, "logistics.json"), JSON.stringify(out, null, 2))
  console.log(`pronto: pedido ${orderId}, entregador ${me.id}`)
}

main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1) })
