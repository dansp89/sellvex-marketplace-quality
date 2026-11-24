/* Prepara a stack local para o ponta a ponta. Idempotente: pode correr de
 * novo, e converge para o mesmo estado em vez de saltar o que já existe.
 *
 * O que faz, e porquê cada passo:
 *
 * 1. Confere que control-plane, commerce, transaction e dev-idp respondem.
 * 2. Escolhe uma loja da vitrine com produto em estoque (E2E_STORE_ID fixa uma).
 * 3. Cria o comprador no dev-idp (actor_type customer). Não há cadastro
 *    público de comprador na plataforma; em local, o emissor de
 *    desenvolvimento é quem cria logins.
 * 4. Cria o cliente do lojista com `sellvex_store_id` da loja escolhida.
 *    O id muda a cada semeadura, então não pode estar fixo no arquivo do
 *    core: uma cópia em .tmp/ é montada no dev-idp por um override do
 *    compose (o repositório do core não é tocado).
 * 5. Dá ao lojista a filiação store_owner nessa loja. Sem ela a plataforma
 *    responde 404 a tudo. Gravada direto no Postgres local porque a única
 *    conta que a poderia conceder pela API é o develop da instalação, cuja
 *    senha não é do teste.
 * 6. Liga o módulo de pagamentos da loja (pagamento manual, DEC-PAY-004).
 * 7. Repõe o estoque: toda variante da loja com menos de 20 disponíveis
 *    ganha 50, pela API de ajuste. Cada rodada compra; sem isto a segunda
 *    rodada seguida falhava com inventory.insufficient_stock.
 *
 * Escreve .tmp/state.json, que os testes leem. */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const tmp = join(root, ".tmp")
mkdirSync(tmp, { recursive: true })

const env = (k: string, d: string) => process.env[k] || d
const CONTROL = env("E2E_CONTROL_PLANE", "http://localhost:8080")
const COMMERCE = env("E2E_COMMERCE", "http://localhost:8082")
const TRANSACTION = env("E2E_TRANSACTION", "http://localhost:8083")
const IDP = env("E2E_IDP", "http://localhost:9000")
const IDP_ADMIN_SECRET = env("E2E_IDP_ADMIN_SECRET", "local-devidp-admin-secret")
const ISSUER = env("E2E_ISSUER", "http://dev-idp:9000")
const CORE_COMPOSE = env("E2E_CORE_COMPOSE", resolve(root, "../../sellvex-marketplace-core/deploy/compose/compose.yaml"))
const PROJECT = env("E2E_COMPOSE_PROJECT", "sellvex-minimal")
const PG = env("E2E_POSTGRES_CONTAINER", `${PROJECT}-postgres-1`)

const BUYER = { email: "comprador.e2e@sellvex.local", password: "compra-e2e-123", name: "Comprador E2E" }
const SELLER = { client: "e2e-lojista", secret: "e2e-lojista-local-only" }

const uuid = /^[0-9a-f-]{36}$/

function step(text: string) { console.log(`• ${text}`) }

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => null) as T
  return { status: res.status, body }
}

async function token(id: string, secret: string): Promise<string | null> {
  const r = await json<{ access_token?: string }>(`${IDP}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, audience: "sellvex-api" }),
  })
  return r.body?.access_token ?? null
}

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, string>

function psql(sql: string): string {
  return execFileSync("docker", ["exec", PG, "psql", "-U", "sellvex", "-d", "sellvex", "-Atc", sql], { encoding: "utf8" }).trim()
}

async function main() {
  step("serviços")
  for (const [name, url] of [["control-plane", CONTROL], ["commerce", COMMERCE], ["transaction", TRANSACTION]] as const) {
    const r = await fetch(`${url}/v1/health/readiness`).catch(() => null)
    if (!r?.ok) throw new Error(`${name} não está pronto em ${url} (ver memória bringing-the-local-stack-up)`)
  }
  if (!(await fetch(`${IDP}/.well-known/openid-configuration`).catch(() => null))?.ok) throw new Error(`dev-idp não responde em ${IDP}`)

  step("loja")
  const shops = await json<{ items: { id: string; name: string }[] }>(`${COMMERCE}/v1/storefronts?limit=100`)
  if (!shops.body?.items?.length) throw new Error("a vitrine está vazia: rode `sellvex marketplace --local --reason ...`")
  let store = shops.body.items.find((s) => s.id === process.env.E2E_STORE_ID)
  if (!store) {
    for (const s of shops.body.items) {
      const products = await json<{ items: { variants?: { available?: number }[] }[] }>(`${COMMERCE}/v1/storefronts/${s.id}/products?limit=5`)
      if (products.body?.items?.some((p) => p.variants?.some((v) => (v.available ?? 1) > 0))) { store = s; break }
    }
  }
  if (!store) throw new Error("nenhuma loja com produto em estoque")
  const organizationId = psql(`select organization_id from stores.stores where id='${store.id}'`)
  if (!uuid.test(organizationId)) throw new Error(`organização da loja ${store.id} não encontrada`)
  const handle = store.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

  step("comprador")
  const created = await fetch(`${IDP}/admin/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${IDP_ADMIN_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ ...BUYER, actor_type: "customer" }),
  })
  if (created.status !== 201 && created.status !== 200 && created.status !== 409) throw new Error(`criar comprador: HTTP ${created.status}`)
  const buyerToken = await token(BUYER.email, BUYER.password)
  if (!buyerToken || claims(buyerToken).sellvex_actor_type !== "customer") throw new Error("o comprador não recebe token de customer")

  step("lojista")
  let sellerToken = await token(SELLER.client, SELLER.secret)
  if (!sellerToken || claims(sellerToken).sellvex_store_id !== store.id) {
    const base = JSON.parse(readFileSync(join(dirname(CORE_COMPOSE), "dev-idp-clients.json"), "utf8")) as { id: string }[]
    const clients = [...base.filter((c) => c.id !== SELLER.client), {
      id: SELLER.client, secret: SELLER.secret, subject: SELLER.client, actor_type: "store_member", scopes: [],
      store_id: store.id, organization_id: organizationId, name: "Lojista E2E",
    }]
    writeFileSync(join(tmp, "dev-idp-clients.json"), JSON.stringify(clients, null, 2))
    writeFileSync(join(tmp, "compose.override.yaml"), [
      "services:", "  dev-idp:", "    volumes:",
      `      - ${join(tmp, "dev-idp-clients.json")}:/etc/sellvex/clients.json:ro`,
      "      - devidp-data:/var/lib/sellvex/devidp", "",
    ].join("\n"))
    execFileSync("docker", ["compose", "-p", PROJECT, "-f", CORE_COMPOSE, "-f", join(tmp, "compose.override.yaml"), "up", "-d", "--no-build", "dev-idp"], {
      stdio: "inherit",
      env: { SELLVEX_POSTGRES_PORT: "55432", SELLVEX_VALKEY_PORT: "56379", SELLVEX_WORKER_PORT: "58081", ...process.env },
    })
    for (let i = 0; i < 30 && !(sellerToken && claims(sellerToken).sellvex_store_id === store.id); i++) {
      await new Promise((r) => setTimeout(r, 500))
      sellerToken = await token(SELLER.client, SELLER.secret).catch(() => null)
    }
    if (!sellerToken) throw new Error("o dev-idp não voltou com o cliente do lojista")
  }
  psql(`insert into identity.memberships (id, issuer, subject, organization_id, store_id, permissions, created_at, created_by, roles)
        select gen_random_uuid(), '${ISSUER}', '${SELLER.client}', '${organizationId}', '${store.id}', '{}', now(), 'e2e-prepare-stack', '{store_owner}'
        where not exists (select 1 from identity.memberships where issuer='${ISSUER}' and subject='${SELLER.client}'
                          and store_id='${store.id}' and deleted_at is null)`)

  step("módulo de pagamentos")
  for (const action of ["install", "enable"]) {
    await fetch(`${CONTROL}/v1/stores/${store.id}/modules/payments/${action}`, {
      method: "POST", headers: { authorization: `Bearer ${sellerToken}`, "idempotency-key": crypto.randomUUID() },
    })
  }
  const probe = await fetch(`${TRANSACTION}/v1/stores/${store.id}/manual-payments`, { headers: { authorization: `Bearer ${sellerToken}` } })
  if (!probe.ok) throw new Error(`o lojista não lê os pagamentos manuais: HTTP ${probe.status}`)

  step("estoque reposto")
  const auth = { authorization: `Bearer ${sellerToken}` }
  const houses = await json<{ items: { id: string }[] }>(`${COMMERCE}/v1/stores/${store.id}/warehouses?limit=50`, { headers: auth })
  if (houses.status !== 200) throw new Error(`armazéns: HTTP ${houses.status}`)
  let restocked = 0
  for (const w of houses.body.items) {
    let cursor = ""
    do {
      const page = await json<{ items: { variant_id: string; available: number }[]; next_cursor?: string }>(
        `${COMMERCE}/v1/stores/${store.id}/warehouses/${w.id}/stock-positions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: auth })
      if (page.status !== 200) throw new Error(`posições de estoque: HTTP ${page.status}`)
      for (const p of page.body.items.filter((x) => x.available < 20)) {
        const r = await fetch(`${COMMERCE}/v1/stores/${store.id}/warehouses/${w.id}/stock-adjustments`, {
          method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ variant_id: p.variant_id, delta: 50, reason: "e2e: reposição entre rodadas" }),
        })
        if (r.status >= 300) throw new Error(`ajuste de estoque: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
        restocked++
      }
      cursor = page.body.next_cursor ?? ""
    } while (cursor)
  }
  console.log(`  ${restocked} variante(s) repostas`)

  const state = { store: { id: store.id, name: store.name, handle, organizationId }, buyer: BUYER, seller: SELLER }
  writeFileSync(join(tmp, "state.json"), JSON.stringify(state, null, 2))
  console.log(`pronto: ${store.name} (${store.id})`)
}

main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1) })
