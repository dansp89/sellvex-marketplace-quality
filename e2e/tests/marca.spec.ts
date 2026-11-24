import { test, expect, type Page, type APIRequestContext } from "@playwright/test"
import { randomUUID } from "node:crypto"

/* White label: o que o usuário vê vem da marca ativa da plataforma.
 *
 * 1. Toda app de pé mostra a marca atual (Place Premium) e nenhum
 *    "Sellvex" visível: texto do body, <title> e og:site_name. Na vitrine
 *    (Nuxt SSR) confere-se também o HTML cru, fora dos comentários — o
 *    comentário de créditos no topo do documento é intencional.
 * 2. Trocar a marca (pela API e pela tela /platform/brand do admin) chega
 *    à vitrine, depois do cache do servidor, e a um painel, sem rebuild.
 *
 * A marca original é lida no início e regravada no afterAll, mesmo com
 * falha no meio. */

const STORE = process.env.E2E_STORE_URL || "http://localhost:5190"
const MOBILE = process.env.E2E_MOBILE_URL || "http://localhost:5191"
const ENTREGAS = process.env.E2E_ENTREGAS_URL || "http://localhost:5192"
const ADMIN = process.env.E2E_ADMIN_URL || "http://localhost:5300"
const SELLER = process.env.E2E_SELLER_URL || "http://localhost:5301"
const CONTROL = process.env.E2E_CONTROL_PLANE_URL || "http://localhost:8080"
const IDP = process.env.E2E_IDP_URL || "http://localhost:9000"
const OPERATOR = { client: "e2e-operador", secret: "e2e-operador-local-only" }
const EXPECTED = process.env.E2E_BRAND_NAME || "Place Premium"

type Brand = Record<string, unknown> & { name: string; version: number }

async function operatorToken(request: APIRequestContext): Promise<string> {
  const r = await request.post(`${IDP}/token`, {
    form: { grant_type: "client_credentials", client_id: OPERATOR.client, client_secret: OPERATOR.secret, audience: "sellvex-api" },
  })
  expect(r.ok(), await r.text()).toBeTruthy()
  return (await r.json()).access_token as string
}

async function readBrand(request: APIRequestContext): Promise<Brand> {
  const r = await request.get(`${CONTROL}/v1/public/brand`, { headers: { "Cache-Control": "no-cache" } })
  expect(r.ok()).toBeTruthy()
  return (await r.json()) as Brand
}

async function putBrand(request: APIRequestContext, brand: Record<string, unknown>): Promise<Brand> {
  const body = { ...brand }
  delete body.version
  delete body.updated_at
  const r = await request.put(`${CONTROL}/v1/platform/brand`, {
    headers: { Authorization: `Bearer ${await operatorToken(request)}`, "Idempotency-Key": `e2e-marca-${randomUUID()}` },
    data: body,
  })
  expect(r.ok(), await r.text()).toBeTruthy()
  return (await r.json()) as Brand
}

/* O que um usuário vê: texto renderizado, título da aba e og:site_name. */
async function visible(page: Page) {
  return page.evaluate(() => ({
    text: document.body.innerText,
    title: document.title,
    site: document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") ?? "",
  }))
}

async function expectBrand(page: Page, url: string, name: string) {
  await page.goto(url)
  await expect.poll(async () => (await visible(page)).text + " " + (await visible(page)).title, { timeout: 20_000 }).toContain(name)
  const v = await visible(page)
  expect(v.text).not.toMatch(/sellvex/i)
  expect(v.title).not.toMatch(/sellvex/i)
  expect(v.site).not.toMatch(/sellvex/i)
  return v
}

const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "")

test.describe("marca atual em todas as apps", () => {
  test("vitrine: HTML cru do SSR e DOM", async ({ page, request }) => {
    const html = withoutComments(await (await request.get(`${STORE}/`)).text())
    expect(html).toMatch(new RegExp(`<title>[^<]*${EXPECTED}`))
    expect(html).toContain(`og:site_name" content="${EXPECTED}"`)
    const textOnly = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ")
    expect(textOnly).not.toMatch(/sellvex/i)
    const v = await expectBrand(page, `${STORE}/`, EXPECTED)
    expect(v.site).toBe(EXPECTED)
  })

  for (const [name, url] of [
    ["loja celular", `${MOBILE}/`],
    ["entregas", `${ENTREGAS}/login`],
    ["admin", `${ADMIN}/sign-in`],
    ["lojista", `${SELLER}/sign-in`],
  ] as const) {
    test(name, async ({ page }) => {
      await expectBrand(page, url, EXPECTED)
    })
  }
})

test.describe.serial("trocar a marca sem rebuild", () => {
  let original: Brand | undefined

  test.beforeAll(async ({ request }) => {
    original = await readBrand(request)
    expect(original.name).toBe(EXPECTED)
  })

  test.afterAll(async ({ request }) => {
    if (!original) return
    const now = await readBrand(request)
    if (now.name !== original.name) await putBrand(request, original)
    expect((await readBrand(request)).name).toBe(original.name)
  })

  test("pela API: vitrine e painel refletem", async ({ page, request }) => {
    test.setTimeout(180_000)
    const temp = `Marca E2E ${Date.now().toString(36)}`
    await putBrand(request, { ...original!, name: temp, short_name: temp, sender_name: temp })
    /* Painel: lê a marca no arranque; contexto novo, sem cache local. */
    await expectBrand(page, `${SELLER}/sign-in`, temp)
    /* Vitrine: o servidor guarda a marca por até ~60 s. */
    await expect.poll(async () => withoutComments(await (await request.get(`${STORE}/`)).text()),
      { timeout: 120_000, intervals: [5_000] }).toContain(`og:site_name" content="${temp}"`)
    await expectBrand(page, `${STORE}/`, temp)
  })

  test("pela tela do admin /platform/brand", async ({ page, request }) => {
    test.setTimeout(180_000)
    await page.goto(`${ADMIN}/sign-in`)
    await page.getByLabel("Usuário").fill(OPERATOR.client)
    await page.getByLabel("Senha").first().fill(OPERATOR.secret)
    await page.getByRole("button", { name: /Entrar/ }).click()
    await expect(page).not.toHaveURL(/sign-in/)
    await page.goto(`${ADMIN}/platform/brand`)
    await expect(page.getByTestId("brand-form")).toBeVisible()
    const field = page.getByTestId("brand-name")
    const input = (await field.evaluate((e) => e.tagName)) === "INPUT" ? field : field.locator("input")
    await expect(input).not.toHaveValue("")
    const temp = `Marca E2E UI ${Date.now().toString(36)}`
    await input.fill(temp)
    await page.getByTestId("brand-save").click()
    await expect.poll(async () => (await readBrand(request)).name, { timeout: 20_000 }).toBe(temp)
    /* O próprio painel aplica a marca nova sem recarregar o build. */
    await expectBrand(page, `${ADMIN}/platform/brand`, temp)
    await expect.poll(async () => withoutComments(await (await request.get(`${STORE}/`)).text()),
      { timeout: 120_000, intervals: [5_000] }).toContain(`og:site_name" content="${temp}"`)
  })
})
