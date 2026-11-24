import { test, expect, type Page, type Locator } from "@playwright/test"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { psql, token } from "./fixtures"

/* A loja convida o próprio entregador; quem aprova é a CDL (FR-COUR-006).
 *
 * 1. o lojista abre "Entregadores" no painel e convida pela página própria;
 * 2. o entregador se cadastra pelo link (aqui, pela API do app) e manda a CNH;
 * 3. a loja não consegue aprovar; a CDL vê a origem "Convidado pela loja"
 *    na fila, filtra por ela e aprova;
 * 4. o lojista vê o entregador aprovado na frota própria.
 *
 * Pré-requisito: `bun run prepare-stack && bun run prepare-logistics`.
 * Re-executável: cada rodada usa e-mail novo e apaga o que criou. */

const tmp = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp")
const file = join(tmp, "logistics.json")
if (!existsSync(file)) throw new Error("rode antes: bun run prepare-logistics")
const L = JSON.parse(readFileSync(file, "utf8")) as {
  storeId: string; orgId: string; cdl: { client: string; secret: string }; operator: { client: string; secret: string }
}
const S = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8")) as { seller: { client: string; secret: string } }

const ADMIN = process.env.E2E_ADMIN_URL || "http://localhost:5300"
const SELLER = process.env.E2E_SELLER_URL || "http://localhost:5301"
const IDP = process.env.E2E_IDP || "http://localhost:9000"
const CONTROL = process.env.E2E_CONTROL || "http://localhost:8080"
const TRANSACTION = process.env.E2E_TRANSACTION || "http://localhost:8083"
const stamp = Date.now().toString(36)
const name = `Entregador Convidado ${stamp}`
const email = `convite-${stamp}@example.test`
const password = "senha-do-convite-1"

async function signIn(page: Page, base: string, client: string, secret: string) {
  await page.goto(`${base}/sign-in`)
  await page.getByLabel("Usuário").fill(client)
  await page.getByLabel("Senha").first().fill(secret)
  await page.getByRole("button", { name: /Entrar/ }).click()
  await expect(page).not.toHaveURL(/sign-in/)
}
async function choose(page: Page, field: Locator, option: string | RegExp) {
  await field.click()
  await page.getByRole("option", { name: option }).first().click()
}
const shot = (page: Page, n: string) => page.screenshot({ path: test.info().outputPath(`${n}.png`), fullPage: true })

async function call(method: string, url: string, tok: string | null, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (tok) headers.authorization = `Bearer ${tok}`
  if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID()
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, json: text ? JSON.parse(text) : null }
}

test.describe.configure({ mode: "serial" })

let fleetName = ""
let inviteToken = ""
let courierId = ""

test.beforeAll(async () => {
  /* A frota privada da loja, com um regime da plataforma. */
  const seller = await token(S.seller.client, S.seller.secret)
  const fleets = await call("GET", `${TRANSACTION}/v1/stores/${L.storeId}/courier-fleets`, seller)
  const own = (fleets.json?.items ?? []).find((f: { visibility: string }) => f.visibility === "private")
  if (own) { fleetName = own.name; return }
  const op = await token(L.operator.client, L.operator.secret)
  const regimes = await call("GET", `${TRANSACTION}/v1/courier-regimes`, op)
  const regime = regimes.json?.items?.[0]?.id
  expect(regime, "nenhum regime na plataforma").toBeTruthy()
  fleetName = `Frota própria E2E ${stamp}`
  const f = await call("POST", `${TRANSACTION}/v1/stores/${L.storeId}/courier-fleets`, seller, { name: fleetName, visibility: "private", regime_id: regime })
  expect(f.status, JSON.stringify(f.json)).toBe(201)
})

test.afterAll(() => {
  /* O que esta rodada criou: o entregador, o convite e a filiação. */
  if (courierId) {
    psql(`delete from couriers.fleet_members where courier_id='${courierId}'; delete from couriers.documents where courier_id='${courierId}'; update couriers.invites set courier_id=null where courier_id='${courierId}'; delete from couriers.couriers where id='${courierId}'`)
  }
  psql(`delete from couriers.invites where full_name='${name}'`)
})

test("lojista convida o próprio entregador", async ({ page }) => {
  await signIn(page, SELLER, S.seller.client, S.seller.secret)
  await page.goto(`${SELLER}/couriers`)
  await expect(page.getByTestId("couriers-list")).toBeVisible()
  await shot(page, "01-entregadores")
  await page.getByTestId("couriers-invite").click()
  await expect(page).toHaveURL(/\/couriers\/invite/)
  await page.getByTestId("invite-name").locator("input").or(page.getByTestId("invite-name")).first().fill(name)
  await page.getByTestId("invite-phone").locator("input").or(page.getByTestId("invite-phone")).first().fill("35999990199")
  await page.getByTestId("invite-email").locator("input").or(page.getByTestId("invite-email")).first().fill(email)
  await choose(page, page.getByTestId("invite-fleet"), new RegExp(fleetName))
  await shot(page, "02-convite")
  await page.getByTestId("invite-submit").click()
  const url = page.getByTestId("invite-url")
  await expect(url).toHaveValue(/invite=/)
  inviteToken = new URL(await url.inputValue()).searchParams.get("invite") ?? ""
  expect(inviteToken).not.toBe("")
  await shot(page, "03-convite-enviado")
})

test("o entregador se cadastra pelo link e fica pendente", async () => {
  const pub = await call("GET", `${TRANSACTION}/v1/courier-invites/${inviteToken}`, null)
  expect(pub.status).toBe(200)
  expect(pub.json.name).toBe(name)
  const signup = await call("POST", `${CONTROL}/v1/couriers/signup`, null, { name, email, password, terms_version: "entregador-v1", invite_token: inviteToken })
  expect(signup.status, JSON.stringify(signup.json)).toBe(201)
  const r = await fetch(`${IDP}/token`, { method: "POST", headers: { authorization: "Basic " + btoa(`${email}:${password}`) }, body: new URLSearchParams({ grant_type: "client_credentials", audience: "sellvex-api" }) })
  const tok = ((await r.json()) as { access_token: string }).access_token
  const me = await call("PUT", `${TRANSACTION}/v1/courier/me`, tok, { name, phone: "+5535999990199", tax_id: "52998224725", vehicle: "motorcycle" })
  expect(me.status, JSON.stringify(me.json)).toBe(200)
  courierId = me.json.id
  const doc = await call("POST", `${TRANSACTION}/v1/courier/documents`, tok, { kind: "cnh", media_id: crypto.randomUUID(), expires_on: new Date(Date.now() + 365 * 864e5).toISOString() })
  expect(doc.status, JSON.stringify(doc.json)).toBe(201)
})

test("a loja não aprova; a CDL vê a origem e aprova", async ({ page }) => {
  const seller = await token(S.seller.client, S.seller.secret)
  const denied = await call("POST", `${TRANSACTION}/v1/organizations/${L.orgId}/couriers/${courierId}/review`, seller, { decision: "approved" })
  expect([403, 404]).toContain(denied.status)

  await signIn(page, ADMIN, L.cdl.client, L.cdl.secret)
  await page.goto(`${ADMIN}/logistics/couriers?status=pending&origin=store_invite`)
  await expect(page.getByTestId("courier-origin-filter")).toBeVisible()
  const row = page.getByText(name, { exact: true }).first()
  await expect(row).toBeVisible()
  await expect(page.getByTestId("courier-origin").filter({ hasText: /Convidado pela loja/ }).first()).toBeVisible()
  await shot(page, "04-fila-cdl-origem")
  await row.click()
  await expect(page.getByRole("heading", { name })).toBeVisible()
  await expect(page.getByTestId("courier-origin").first()).toContainText(/Convidado pela loja/)
  /* A CNH primeiro, depois o cadastro. */
  const docs = page.getByRole("button", { name: /Aprovar documento|Aprovar CNH/ })
  if (await docs.count()) {
    await docs.first().click()
    const dlg = page.getByRole("dialog")
    if (await dlg.count()) await dlg.getByRole("button", { name: /Aprovar/ }).click()
  }
  await page.getByRole("button", { name: "Aprovar" }).first().click()
  await page.getByRole("dialog").getByRole("button", { name: "Aprovar" }).click()
  await expect(page.getByText("Aprovado").first()).toBeVisible()
  await shot(page, "05-cdl-aprovou")
})

test("o lojista vê o entregador aprovado na frota própria", async ({ page }) => {
  await signIn(page, SELLER, S.seller.client, S.seller.secret)
  await page.goto(`${SELLER}/couriers`)
  const line = page.getByRole("row").filter({ hasText: name })
  await expect(line).toContainText("Aprovado")
  await shot(page, "06-lojista-aprovado")
})
