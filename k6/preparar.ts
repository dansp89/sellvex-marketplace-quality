/* Prepara o que os cenários k6 precisam além das lojas semeadas.
 *
 *   bun k6/preparar.ts            # depois de datasets/carga/seed.ts
 *   bun k6/preparar.ts --restaurar  # devolve o dev-idp ao override do e2e
 *
 * 1. Lojistas de carga: as lojas quentes (seq 1..QUENTES do registro
 *    carga.lojas) ganham um cliente `carga-lojista-NNN` no dev-idp, com
 *    `sellvex_store_id` da loja, e filiação store_owner (created_by
 *    'carga-k6'). Sem isso o painel e a baixa do Pix dão 404.
 * 2. Entregadores de carga: `carga-entregador-NN`, actor_type courier,
 *    com perfil criado pela API e deixado PENDENTE: entregador pendente
 *    nunca recebe oferta, então nenhum pedido real é oferecido a eles, e
 *    eles não aparecem para nenhuma loja real.
 * 3. Módulos checkout e payments ligados nas lojas quentes (mesma API do
 *    prepare-stack do e2e); estoque das variantes reposto pela API de ajuste.
 *
 * O dev-idp lê os clientes de um arquivo montado por override do compose.
 * O override atual é o do e2e (e2e/.tmp); este script NÃO o altera: copia a
 * lista dele, acrescenta os clientes de carga em k6/.tmp e monta essa cópia.
 * `--restaurar` volta a montar o arquivo do e2e.
 *
 * Escreve k6/.tmp/dados.json, que os cenários leem. */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { psql } from "../datasets/carga/seed"

const here = dirname(fileURLToPath(import.meta.url))
const tmp = join(here, ".tmp")
mkdirSync(tmp, { recursive: true })
const QUENTES = Number(process.env.CARGA_QUENTES || 20)
const ENTREGADORES = Number(process.env.CARGA_ENTREGADORES || 10)
const CONTROL = "http://localhost:8080", COMMERCE = "http://localhost:8082", TRANSACTION = "http://localhost:8083", IDP = "http://localhost:9000"
const ISSUER = "http://dev-idp:9000"
const CORE_COMPOSE = resolve(here, "../../sellvex-marketplace-core/deploy/compose/compose.yaml")
const E2E_CLIENTS = resolve(here, "../e2e/.tmp/dev-idp-clients.json")
const BASE_CLIENTS = existsSync(E2E_CLIENTS) ? E2E_CLIENTS : join(dirname(CORE_COMPOSE), "dev-idp-clients.json")
const SEGREDO = "carga-k6-local-only"

function montarDevIdp(arquivo: string) {
  const override = join(tmp, "compose.override.yaml")
  writeFileSync(override, ["services:", "  dev-idp:", "    volumes:", `      - ${arquivo}:/etc/sellvex/clients.json:ro`, "      - devidp-data:/var/lib/sellvex/devidp", ""].join("\n"))
  execFileSync("docker", ["compose", "-p", "sellvex-minimal", "-f", CORE_COMPOSE, "-f", override, "up", "-d", "--no-build", "--no-deps", "dev-idp"], {
    stdio: "inherit", env: { ...process.env, SELLVEX_POSTGRES_PORT: "55432", SELLVEX_VALKEY_PORT: "56379", SELLVEX_WORKER_PORT: "58081" },
  })
}

export async function token(id: string, secret = SEGREDO): Promise<string> {
  const r = await fetch(`${IDP}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, audience: "sellvex-api" }) })
  const t = ((await r.json().catch(() => ({}))) as { access_token?: string }).access_token
  if (!t) throw new Error(`sem token para ${id}: HTTP ${r.status}`)
  return t
}

async function api(method: string, url: string, tok?: string, body?: unknown, ok = (s: number) => s < 300): Promise<any> {
  const h: Record<string, string> = {}
  if (tok) h.authorization = `Bearer ${tok}`
  if (method !== "GET") h["idempotency-key"] = crypto.randomUUID()
  if (body !== undefined) h["content-type"] = "application/json"
  const r = await fetch(url, { method, headers: h, body: body === undefined ? null : JSON.stringify(body) })
  const text = await r.text()
  if (!ok(r.status)) throw new Error(`${method} ${url}: HTTP ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (process.argv[2] === "--restaurar") {
    if (!existsSync(E2E_CLIENTS)) throw new Error("sem arquivo de clientes do e2e para restaurar")
    const o = resolve(here, "../e2e/.tmp/compose.override.yaml")
    execFileSync("docker", ["compose", "-p", "sellvex-minimal", "-f", CORE_COMPOSE, "-f", o, "up", "-d", "--no-build", "--no-deps", "dev-idp"], {
      stdio: "inherit", env: { ...process.env, SELLVEX_POSTGRES_PORT: "55432", SELLVEX_VALKEY_PORT: "56379", SELLVEX_WORKER_PORT: "58081" },
    })
    console.log("dev-idp de volta ao override do e2e")
    return
  }
  const lojas = psql(`select seq, store_id, organization_id from carga.lojas where seq <= ${QUENTES} order by seq`).split("\n").map((l) => {
    const [seq, store, org] = l.split("|"); return { seq: Number(seq), store: store!, org: org! }
  })
  if (lojas.length < QUENTES) throw new Error("semeie antes: bun datasets/carga/seed.ts 200")

  const base = (JSON.parse(readFileSync(BASE_CLIENTS, "utf8")) as { id: string }[]).filter((c) => !c.id.startsWith("carga-"))
  const lojistas = lojas.map((l) => ({ id: `carga-lojista-${String(l.seq).padStart(3, "0")}`, secret: SEGREDO, subject: `carga-lojista-${String(l.seq).padStart(3, "0")}`,
    actor_type: "store_member", scopes: [], store_id: l.store, organization_id: l.org, name: `Lojista carga ${l.seq}` }))
  const entregadores = Array.from({ length: ENTREGADORES }, (_, i) => ({ id: `carga-entregador-${String(i + 1).padStart(2, "0")}`, secret: SEGREDO,
    subject: `carga-entregador-${String(i + 1).padStart(2, "0")}`, actor_type: "courier", scopes: [], name: `Entregador carga ${i + 1}` }))
  const arquivo = join(tmp, "dev-idp-clients.json")
  writeFileSync(arquivo, JSON.stringify([...base, ...lojistas, ...entregadores], null, 2))
  console.log(`• dev-idp: ${base.length} clientes existentes + ${lojistas.length} lojistas + ${entregadores.length} entregadores de carga`)
  montarDevIdp(arquivo)
  for (let i = 0; i < 40; i++) { if (await token(lojistas[0]!.id).then(() => true, () => false)) break; await wait(500) }

  console.log("• filiações")
  psql(`insert into identity.memberships (id, issuer, subject, organization_id, store_id, permissions, created_at, created_by, roles)
    select gen_random_uuid(), '${ISSUER}', 'carga-lojista-'||lpad(l.seq::text,3,'0'), l.organization_id, l.store_id, '{}', now(), 'carga-k6', '{store_owner}'
    from carga.lojas l where l.seq <= ${QUENTES} and not exists (select 1 from identity.memberships m where m.store_id=l.store_id
      and m.subject='carga-lojista-'||lpad(l.seq::text,3,'0') and m.deleted_at is null)`)

  console.log("• módulos e estoque das lojas quentes")
  const quentes: { store: string; seller: string; variants: string[] }[] = []
  for (const l of lojas) {
    const sid = `carga-lojista-${String(l.seq).padStart(3, "0")}`
    const tok = await token(sid)
    for (const m of ["checkout", "payments"]) for (const a of ["install", "enable"])
      await api("POST", `${CONTROL}/v1/stores/${l.store}/modules/${m}/${a}`, tok, undefined, (s) => s < 300 || s === 409)
    const houses = await api("GET", `${COMMERCE}/v1/stores/${l.store}/warehouses?limit=50`, tok) as { items: { id: string }[] }
    const variants: string[] = []
    for (const w of houses.items) {
      const page = await api("GET", `${COMMERCE}/v1/stores/${l.store}/warehouses/${w.id}/stock-positions?limit=100`, tok) as { items: { variant_id: string; available: number }[] }
      for (const p of page.items) {
        if (p.available < 50_000) await api("POST", `${COMMERCE}/v1/stores/${l.store}/warehouses/${w.id}/stock-adjustments`, tok,
          { variant_id: p.variant_id, delta: 100_000 - p.available, reason: "carga k6: estoque para checkout" })
        variants.push(p.variant_id)
      }
    }
    quentes.push({ store: l.store, seller: sid, variants })
  }

  console.log("• perfis de entregador (pendentes)")
  for (const e of entregadores) {
    const tok = await token(e.id)
    const me = await fetch(`${TRANSACTION}/v1/courier/me`, { headers: { authorization: `Bearer ${tok}` } })
    if (me.status === 404) await api("PUT", `${TRANSACTION}/v1/courier/me`, tok, { name: e.name, phone: `+5535900000${e.id.slice(-2)}`, tax_id: `0000000${e.id.slice(-2)}00`, vehicle: "motorcycle" })
  }

  const todas = psql("select store_id from carga.lojas order by seq").split("\n")
  writeFileSync(join(tmp, "dados.json"), JSON.stringify({ quentes, lojas: todas, entregadores: entregadores.map((e) => e.id), segredo: SEGREDO }))
  console.log(`pronto: ${quentes.length} lojas quentes, ${todas.length} lojas, ${entregadores.length} entregadores → k6/.tmp/dados.json`)
}

if (import.meta.main) main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1) })
