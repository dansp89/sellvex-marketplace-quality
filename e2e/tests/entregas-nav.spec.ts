import { test, expect, type Page } from "@playwright/test"

/* A navegação dentro do app Log, sem depender da stack: o login, a API do
 * entregador e o roteador (OSRM) são simulados, e a posição do aparelho é
 * movida ao longo da rota. Confere a escolha da rota, a manobra no topo
 * com a distância, o ETA, o recálculo ao sair da rota e a sugestão ao
 * chegar. Os tiles do mapa vêm do provedor real (sem chave). */

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
const JWT = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "courier|nav-e2e", sellvex_actor_type: "courier", name: "Entregador Nav E2E", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`

/* Rota sintética: 600 m para o norte, vira à direita, 400 m para leste. */
const A: [number, number] = [-45.4560, -22.4260]
const T: [number, number] = [-45.4560, -22.4206]
const D: [number, number] = [-45.4521, -22.4206]
const dest = { country: "BR", postal_code: "37500-180", region: "MG", locality: "Itajubá", line1: "Rua de Teste, 10", recipient: "Pessoa Teste", latitude: D[1], longitude: D[0] }
const pickup = { country: "BR", postal_code: "37500-014", region: "MG", locality: "Itajubá", line1: "Av. Teste, 1", recipient: "Loja Teste", latitude: A[1], longitude: A[0] }
const task = { id: "nav1", status: "in_route", attempts: 0, cascade: [], created_at: new Date().toISOString(), currency: "BRL", destination: dest, pickup, distance_estimated: false, distance_meters: 1000, fare_amount: 1000, fee_amount: 100, peak: false, seller_order_id: "s", shipment_id: "s", store_id: "s", tracking_code: "NAV-E2E", updated_at: new Date().toISOString(), volumes: [] }
const profile = { id: "c", name: "Entregador Nav E2E", created_at: new Date().toISOString(), online: true, phone: "+5535999990000", simulated: false, status: "approved", tax_id: "52998224725", vehicle: "motorcycle", documents: [{ id: "d", courier_id: "c", created_at: new Date().toISOString(), kind: "cnh", media_id: "m", status: "approved", valid: true }], memberships: [] }
const osrm = (from: [number, number]) => ({
  code: "Ok",
  routes: [
    { distance: 1000, duration: 150, geometry: { coordinates: [from, T, D] }, legs: [{ summary: "Rua Norte, Rua Leste", steps: [
      { distance: 600, duration: 90, name: "Rua Norte", maneuver: { type: "depart", location: from } },
      { distance: 400, duration: 60, name: "Rua Leste", maneuver: { type: "turn", modifier: "right", location: T } },
      { distance: 0, duration: 0, name: "Rua Leste", maneuver: { type: "arrive", location: D } },
    ] }] },
    { distance: 1300, duration: 200, geometry: { coordinates: [from, [-45.4600, -22.4230], D] }, legs: [{ summary: "Rua Oeste", steps: [] }] },
  ],
})

async function setup(page: Page) {
  let routed = 0
  await page.addInitScript(() => {
    const w = window as unknown as { __pos: [number, number]; __cbs: ((p: unknown) => void)[]; __move: (lng: number, lat: number) => void }
    w.__pos = [-45.4560, -22.4260]; w.__cbs = []
    const fix = () => ({ coords: { latitude: w.__pos[1], longitude: w.__pos[0], accuracy: 6, heading: null, speed: 8 }, timestamp: Date.now() })
    w.__move = (lng, lat) => { w.__pos = [lng, lat]; w.__cbs.forEach((cb) => cb(fix())) }
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      getCurrentPosition: (ok: (p: unknown) => void) => setTimeout(() => ok(fix()), 20),
      watchPosition: (ok: (p: unknown) => void) => { w.__cbs.push(ok); setTimeout(() => ok(fix()), 20); return w.__cbs.length },
      clearWatch: () => undefined,
    } })
  })
  await page.route(/\/idp\/token$|\/token$/, (r) => r.fulfill({ json: { access_token: JWT, token_type: "Bearer", expires_in: 3600 } }))
  await page.route(/\/v1\/courier\//, (r) => {
    const p = new URL(r.request().url()).pathname
    if (p.endsWith("/me")) return r.fulfill({ json: profile })
    if (p.endsWith("/route")) return r.fulfill({ json: { items: [task] } })
    if (p.includes("/tasks/")) return r.fulfill({ json: task })
    return r.fulfill({ json: { items: [] } })
  })
  await page.route(/\/route\/v1\//, (r) => {
    routed++
    const c = new URL(r.request().url()).pathname.split("/").pop()!.split(";")[0]!.split(",").map(Number) as [number, number]
    return r.fulfill({ json: osrm(c) })
  })
  return { routed: () => routed }
}

const move = (page: Page, p: [number, number]) => page.evaluate(([lng, lat]) => (window as unknown as { __move: (a: number, b: number) => void }).__move(lng, lat), p)

test("navegação no app: rotas, manobra, ETA, recálculo e chegada", async ({ page }) => {
  const net = await setup(page)
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto("/login")
  await page.locator("input[type=email]").fill("nav.e2e@sellvex.local")
  await page.locator("input[type=password]").fill("nav-e2e-123")
  await page.getByTestId("login-submit").click()
  await expect(page).not.toHaveURL(/\/login/)

  await page.goto("/tasks/nav1")
  await expect(page.getByTestId("map-navigate")).toBeVisible()
  await page.getByTestId("map-expand").click()
  await expect(page).toHaveURL(/\/tasks\/nav1\/map$/)

  /* Antes de sair: duas rotas, a mais rápida escolhida; tocar troca. */
  await expect(page.getByTestId("nav-route-0")).toContainText("3 min")
  await expect(page.getByTestId("nav-route-1")).toContainText("1,3 km")
  await page.getByTestId("nav-route-1").click()
  await expect(page.getByTestId("nav-route-1")).toHaveAttribute("aria-checked", "true")
  await page.getByTestId("nav-route-0").click()
  await page.getByTestId("nav-start").click()

  /* Navegando: a manobra que vem e a chegada prevista. */
  await expect(page.getByTestId("nav-maneuver")).toBeVisible()
  await move(page, [-45.4560, -22.4230])
  await expect(page.getByTestId("nav-instruction")).toHaveText("Vire à direita na Rua Leste")
  await expect(page.getByTestId("nav-distance")).toHaveText(/^\d+ m$/)
  await expect(page.getByTestId("nav-eta")).toHaveText(/^\d{2}:\d{2}$/)

  /* Fora da rota por três leituras: recalcula. */
  const before = net.routed()
  for (const lat of [-22.4228, -22.4227, -22.4226]) await move(page, [-45.4600, lat])
  await expect(page.getByTestId("nav-tip")).toHaveText("Rota recalculada")
  expect(net.routed()).toBeGreaterThan(before)

  /* Chegou: sugere a ação da etapa. */
  await move(page, [D[0] + .00005, D[1]])
  await expect(page.getByTestId("nav-tip")).toContainText("Peça o código")
  await expect(page.getByTestId("nav-action")).toHaveText("Entregar com código")
  await page.getByTestId("nav-action").click()
  await expect(page).toHaveURL(/\/tasks\/nav1\/deliver$/)
  expect(errors).toEqual([])
})
