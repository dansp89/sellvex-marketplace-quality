// Cenários de carga por corte vertical (08 §Load tests), um por execução.
//
//   CENARIO=vitrine|busca|produto|carrinho|checkout|painel|entregador
//   TAXA=<iterações/s>  DURACAO=<s>  VUS_MAX=<n>
//
// Chegada aberta (constant-arrival-rate): a taxa não cai quando o sistema
// fica lento, e iteração que não achou VU livre conta em dropped_iterations
// — é o sinal de que o resultado do degrau não vale.
//
// Lojas: metade do tráfego vai às lojas quentes (k6/.tmp/dados.json →
// quentes, com Zipf entre elas), metade à cauda longa, log-uniforme sobre
// todas as lojas de carga (poucas muito visitadas, muitas quase nunca).
import http from "k6/http"
import { check, fail, sleep } from "k6"
import { Counter, Trend } from "k6/metrics"
import { SharedArray } from "k6/data"

const D = JSON.parse(open("./.tmp/dados.json"))
const LOJAS = new SharedArray("lojas", () => D.lojas)
const QUENTES = D.quentes
const CENARIO = __ENV.CENARIO || "vitrine"
const TAXA = Number(__ENV.TAXA || 10)
const DURACAO = Number(__ENV.DURACAO || 30)
const COMMERCE = __ENV.COMMERCE || "http://localhost:8082"
const TRANSACTION = __ENV.TRANSACTION || "http://localhost:8083"
const IDP = __ENV.IDP || "http://localhost:9000"
const TERMOS = ["cadeira", "mesa", "luminaria", "fone", "caixa de som", "tenis", "mochila", "panela", "cafeteira", "boneca", "quebra-cabeca", "garrafa", "barraca", "kit", "modelo 2"]

// Nomes por cenário: um limiar sem efeito por nome faz o resumo do k6
// trazer a submétrica de cada endpoint.
const NOMES = {
  vitrine: ["GET /storefronts", "GET /storefronts/{id}/products", "GET /storefronts/{id}/categories"],
  produto: ["GET /storefronts/{id}/products", "GET /storefronts/{id}/products/{pid}"],
  busca: ["GET /marketplace/search"],
  carrinho: ["POST /carts", "PUT /carts/{id}/items/{vid}", "GET /carts/{id}"],
  checkout: ["GET /storefronts/{id}/products", "GET /storefronts/{id}/products/{pid}", "POST /carts", "PUT /carts/{id}/items/{vid}", "POST /checkouts",
    "GET /stores/{id}/manual-payments", "POST /payments/{id}/manual-confirmation", "GET /checkouts/{id}"],
  painel: ["GET /stores/{id}/orders", "GET /stores/{id}/products"],
  entregador: ["PUT /courier/location"],
}
const thresholds = {}
for (const n of NOMES[CENARIO] || []) {
  thresholds[`http_req_duration{name:${n}}`] = ["max>=0"]
  thresholds[`http_reqs{name:${n}}`] = ["count>=0"]
  thresholds[`http_req_failed{name:${n}}`] = ["rate>=0"]
}

export const options = {
  thresholds,
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    [CENARIO]: {
      executor: "constant-arrival-rate", rate: TAXA, timeUnit: "1s", duration: `${DURACAO}s`,
      preAllocatedVUs: Math.min(Number(__ENV.VUS_MAX || 400), Math.max(10, TAXA * (CENARIO === "checkout" ? 4 : 1))),
      maxVUs: Number(__ENV.VUS_MAX || 400), exec: CENARIO,
    },
  },
}

const pedidos = new Counter("pedidos_concluidos")
const reqPedido = new Counter("requisicoes_de_pedido")
const tempoPedido = new Trend("tempo_do_pedido", true)

function zipf(n) { // posição 0..n-1, s≈1
  return Math.min(n - 1, Math.floor(Math.exp(Math.random() * Math.log(n + 1))) - 1)
}
function loja() {
  if (Math.random() < 0.5) return QUENTES[zipf(QUENTES.length)].store
  return LOJAS[zipf(LOJAS.length)]
}
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const nome = (n) => ({ tags: { name: n } })
const escrita = (n, tok) => ({
  tags: { name: n },
  headers: Object.assign({ "content-type": "application/json", "idempotency-key": `${__VU}-${__ITER}-${Date.now()}-${Math.random()}` }, tok ? { authorization: `Bearer ${tok}` } : {}),
})
const leituraAuth = (n, tok) => ({ tags: { name: n }, headers: { authorization: `Bearer ${tok}` } })

function tokenDe(id) {
  const r = http.post(`${IDP}/token`, { grant_type: "client_credentials", client_id: id, client_secret: D.segredo, audience: "sellvex-api" }, nome("token"))
  if (r.status !== 200) fail(`token ${id}: ${r.status}`)
  return r.json("access_token")
}

export function setup() {
  const t = {}
  if (CENARIO === "checkout" || CENARIO === "painel") for (const q of QUENTES) t[q.store] = tokenDe(q.seller)
  if (CENARIO === "entregador") for (const e of D.entregadores) t[e] = tokenDe(e)
  return t
}

// Vitrine: lista de lojas (1 em 4), lista de produtos da loja, categorias.
export function vitrine() {
  const s = loja()
  if (Math.random() < 0.25) check(http.get(`${COMMERCE}/v1/storefronts?limit=24`, nome("GET /storefronts")), { ok: (r) => r.status === 200 })
  check(http.get(`${COMMERCE}/v1/storefronts/${s}/products?limit=24`, nome("GET /storefronts/{id}/products")), { ok: (r) => r.status === 200 })
  check(http.get(`${COMMERCE}/v1/storefronts/${s}/categories`, nome("GET /storefronts/{id}/categories")), { ok: (r) => r.status === 200 })
}

// Página de produto: escolhe um produto da loja e abre o detalhe.
export function produto() {
  const s = loja()
  const l = http.get(`${COMMERCE}/v1/storefronts/${s}/products?limit=24`, nome("GET /storefronts/{id}/products"))
  const items = l.status === 200 ? l.json("items") : []
  if (!items || !items.length) return
  check(http.get(`${COMMERCE}/v1/storefronts/${s}/products/${pick(items).id}`, nome("GET /storefronts/{id}/products/{pid}")), { ok: (r) => r.status === 200 })
}

// Busca do marketplace inteiro.
export function busca() {
  check(http.get(`${COMMERCE}/v1/marketplace/search?q=${encodeURIComponent(pick(TERMOS))}&limit=24`, nome("GET /marketplace/search")), { ok: (r) => r.status === 200 })
}

// Carrinho: cria, põe item, relê (sem checkout).
export function carrinho() {
  const q = pick(QUENTES)
  const F = `${COMMERCE}/v1/storefronts/${q.store}`
  const c = http.post(`${F}/carts`, JSON.stringify({ currency: "BRL" }), escrita("POST /carts"))
  if (!check(c, { ok: (r) => r.status === 201 })) return
  const id = c.json("id")
  check(http.put(`${F}/carts/${id}/items/${pick(q.variants)}`, JSON.stringify({ quantity: 1 }), escrita("PUT /carts/{id}/items/{vid}")), { ok: (r) => r.status === 200 })
  check(http.get(`${F}/carts/${id}`, nome("GET /carts/{id}")), { ok: (r) => r.status === 200 })
}

// Pedido completo: navega, carrinho, checkout com Pix manual, baixa do Pix
// pelo lojista, espera o checkout concluir. Sem endereço de entrega e sem
// remessa: nada é oferecido a entregador nenhum.
export function checkout(tokens) {
  const t0 = Date.now()
  let n = 0
  const q = QUENTES[zipf(QUENTES.length)]
  const tok = tokens[q.store]
  const F = `/v1/storefronts/${q.store}`
  const r1 = http.get(`${COMMERCE}${F}/products?limit=24`, nome("GET /storefronts/{id}/products")); n++
  const it = r1.status === 200 ? r1.json("items") : []
  if (it && it.length) { http.get(`${COMMERCE}${F}/products/${pick(it).id}`, nome("GET /storefronts/{id}/products/{pid}")); n++ }
  const c = http.post(`${COMMERCE}${F}/carts`, JSON.stringify({ currency: "BRL" }), escrita("POST /carts")); n++
  if (!check(c, { carrinho: (r) => r.status === 201 })) return
  const cart = c.json("id")
  const p = http.put(`${COMMERCE}${F}/carts/${cart}/items/${pick(q.variants)}`, JSON.stringify({ quantity: 1 }), escrita("PUT /carts/{id}/items/{vid}")); n++
  if (!check(p, { item: (r) => r.status === 200 })) return
  const co = http.post(`${TRANSACTION}${F}/checkouts`, JSON.stringify({ cart_id: cart, payment_method_token: "manual:pix" }), escrita("POST /checkouts")); n++
  if (!check(co, { checkout: (r) => r.status === 201 })) return
  const order = co.json("order_id"), cid = co.json("id")
  let pay = null
  for (let i = 0; i < 10 && !pay; i++) {
    if (i) sleep(1)
    const m = http.get(`${TRANSACTION}/v1/stores/${q.store}/manual-payments`, leituraAuth("GET /stores/{id}/manual-payments", tok)); n++
    if (m.status === 200) pay = (m.json("items") || []).find((x) => x.marketplace_order_id === order)
  }
  if (!check(pay, { pagamento_visivel: (x) => !!x })) return
  const conf = http.post(`${TRANSACTION}/v1/stores/${q.store}/payments/${pay.payment_id}/manual-confirmation`,
    JSON.stringify({ amount: pay.amount, reference: `CARGA-${cid}` }), escrita("POST /payments/{id}/manual-confirmation", tok)); n++
  if (!check(conf, { baixa: (r) => r.status < 300 })) return
  let done = false
  // o app consulta o checkout a cada 1 s até concluir (a baixa segue pelo worker)
  for (let i = 0; i < 60 && !done; i++) {
    if (i) sleep(1)
    const g = http.get(`${TRANSACTION}${F}/checkouts/${cid}`, nome("GET /checkouts/{id}")); n++
    done = g.status === 200 && g.json("status") === "completed"
  }
  if (check(done, { concluido: (x) => x })) { pedidos.add(1); reqPedido.add(n); tempoPedido.add(Date.now() - t0) }
}

// Painel do lojista: pedidos, produtos, pagamentos pendentes.
export function painel(tokens) {
  const q = QUENTES[zipf(QUENTES.length)]
  const tok = tokens[q.store]
  const S = `/v1/stores/${q.store}`
  check(http.get(`${TRANSACTION}${S}/orders?limit=50`, leituraAuth("GET /stores/{id}/orders", tok)), { ok: (r) => r.status === 200 })
  check(http.get(`${COMMERCE}${S}/products?limit=50`, leituraAuth("GET /stores/{id}/products", tok)), { ok: (r) => r.status === 200 })
}

// App do entregador: posição a cada iteração (o app manda a cada poucos s).
export function entregador(tokens) {
  const e = pick(D.entregadores)
  const lat = -22.42 + (Math.random() - 0.5) * 0.05, lon = -45.45 + (Math.random() - 0.5) * 0.05
  check(http.put(`${TRANSACTION}/v1/courier/location`, JSON.stringify({ latitude: lat, longitude: lon }), escrita("PUT /courier/location", tokens[e])), { ok: (r) => r.status === 204 })
}

export function handleSummary(data) {
  return { [__ENV.SAIDA || "/dev/stdout"]: JSON.stringify(data) }
}
