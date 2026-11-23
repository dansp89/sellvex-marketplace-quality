import { test, expect, type Page, type Locator } from "@playwright/test"
import { state } from "./state"

/* O comprador com conta, de ponta a ponta na vitrine web (Nuxt):
 *
 * cadastro (com consentimento de ofertas na loja) → sair → entrar →
 * endereço guardado → checkout com o endereço da conta (o carrinho é
 * reivindicado pela conta, recebe a entrega e cota o frete) → Minhas
 * compras mostra o pedido → o lojista (pela API) confirma o pagamento e
 * despacha pela entrega local → o detalhe do pedido mostra a linha do
 * tempo e o código de quatro dígitos.
 *
 * Pré-requisito: prepare-stack, prepare-logistics e prepare-buyer, e a
 * vitrine servida com NUXT_PUBLIC_STORE_ID da loja de .tmp/state.json. */
const { store, seller } = state()
const IDP = process.env.E2E_IDP || "http://localhost:9000"
const TRANSACTION = process.env.E2E_TRANSACTION || "http://localhost:8083"


const stamp = Date.now().toString(36)
const person = { name: "Clara Compradora", email: `clara.${stamp}@e2e.sellvex.local`, password: `senha-e2e-${stamp}` }

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: false })
}

async function sellerToken(): Promise<string> {
  const r = await fetch(`${IDP}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: seller.client, client_secret: seller.secret, audience: "sellvex-api" }) })
  return ((await r.json()) as { access_token: string }).access_token
}
async function api(method: string, url: string, tok: string, body?: unknown): Promise<any> {
  const r = await fetch(url, {
    method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  if (r.status >= 300) throw new Error(`${method} ${url}: HTTP ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function fillAddress(page: Page, scope: Page | Locator = page) {
  await scope.getByLabel("CEP").fill("69005-010")
  const street = scope.getByLabel("Rua")
  /* O CEP é resolvido no ViaCEP, serviço externo: se não responder a
     tempo, o endereço é preenchido à mão, como faria o comprador. */
  const resolved = await expect(street).not.toHaveValue("", { timeout: 12_000 }).then(() => true, () => false)
  if (!resolved) {
    await street.fill("Rua Marcílio Dias")
    await scope.getByLabel("Bairro").fill("Centro")
    await scope.getByLabel("Cidade").fill("Manaus")
    await scope.getByLabel("Estado").click()
    await page.keyboard.type("AM")
    await page.keyboard.press("Enter")
  }
  await scope.getByLabel("Número").fill("250")
}

test.describe.configure({ mode: "serial" })

test("cadastro → entrar → endereço → checkout reivindicado com frete → minhas compras com código", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))

  await test.step("cadastro com consentimento de ofertas", async () => {
    await page.goto("/sign-up")
    await expect(page.getByRole("heading", { name: "Criar conta" })).toBeVisible()
    await page.locator("main").getByLabel("Nome completo").fill(person.name)
    await page.locator("main").getByRole("textbox", { name: /^E-mail/ }).fill(person.email)
    await page.locator("main").getByRole("textbox", { name: /^Senha/ }).fill(person.password)
    await page.getByTestId("sign-up-terms").click()
    await expect(page.getByTestId("sign-up-marketing")).toBeVisible()
    await page.getByTestId("sign-up-marketing").click()
    await shot(page, "01-cadastro")
    await page.getByRole("button", { name: "Criar conta" }).click()
    await expect(page).toHaveURL(/\/account/, { timeout: 30_000 })
    await expect(page.getByText(`Olá, ${person.name}`)).toBeVisible()
  })

  await test.step("o mesmo e-mail não cria outra conta", async () => {
    await page.getByRole("button", { name: "Sair" }).first().click()
    await expect(page).toHaveURL(/\/$/)
    /* Com a mesma senha o core trata como repetição e responde 201 com a
       mesma conta; com outra senha recusa com identity.signup_login_exists. */
    await page.goto("/sign-up")
    await page.locator("main").getByLabel("Nome completo").fill(person.name)
    await page.locator("main").getByRole("textbox", { name: /^E-mail/ }).fill(person.email)
    await page.locator("main").getByRole("textbox", { name: /^Senha/ }).fill(`outra-${person.password}`)
    await page.getByTestId("sign-up-terms").click()
    await page.getByRole("button", { name: "Criar conta" }).click()
    await expect(page.getByTestId("sign-up-error")).toContainText("Já existe uma conta")
  })

  await test.step("entrar com a senha", async () => {
    await page.goto("/sign-in")
    await page.locator("main").getByRole("textbox", { name: /^E-mail/ }).fill(person.email)
    await page.locator("main").getByRole("textbox", { name: /^Senha/ }).fill(person.password)
    await page.getByRole("button", { name: "Entrar", exact: true }).click()
    await expect(page).toHaveURL(/\/account/)
    await page.goto("/account/profile")
    await expect(page.getByTestId("my-profile")).toContainText(person.email)
    await shot(page, "02-meus-dados")
  })

  await test.step("telefone pela edição dos dados", async () => {
    await page.goto("/account/profile/edit")
    await page.locator("main").getByLabel("Telefone").fill("(92) 99123-4567")
    await page.getByRole("button", { name: "Salvar" }).click()
    await expect(page).toHaveURL(/\/account\/profile$/)
    await expect(page.getByTestId("my-profile")).toContainText("92991234567")
  })

  await test.step("endereço guardado na conta", async () => {
    await page.goto("/account/addresses/new")
    await page.getByLabel("Nome do endereço").fill("Casa")
    await fillAddress(page, page.getByTestId("address-form"))
    await page.getByText("Usar como endereço padrão").click()
    await shot(page, "03-endereco-novo")
    await page.getByRole("button", { name: "Salvar endereço" }).click()
    await expect(page).toHaveURL(/\/account\/addresses$/)
    await expect(page.getByTestId("my-addresses")).toContainText("Casa")
    await expect(page.getByTestId("my-addresses")).toContainText("Padrão")
    await shot(page, "04-enderecos")
  })

  await test.step("loja → produto → carrinho → checkout", async () => {
    await page.goto(`/stores/${store.handle}`)
    const product = page.locator('a[href^="/p/"]').first()
    await product.scrollIntoViewIfNeeded()
    await product.click()
    await expect(page).toHaveURL(/\/p\//)
    await page.getByRole("button", { name: "Adicionar ao carrinho" }).first().click()
    await page.goto("/cart")
    await page.getByRole("button", { name: "Finalizar compra" }).first().click()
    await expect(page).toHaveURL(/\/checkout/)

    await expect(page.locator("main").getByRole("textbox", { name: /^E-mail/ })).toHaveValue(person.email)
    await page.getByLabel("CPF ou CNPJ").fill("529.982.247-25")
    await page.getByRole("button", { name: "Continuar" }).click()

    /* O endereço padrão da conta já vem escolhido. */
    await expect(page.getByText(/, 250 — .*Manaus\/AM · CEP 69005-010/).first()).toBeVisible()
    await page.getByRole("button", { name: "Continuar" }).click()
    await page.getByText("Pix", { exact: true }).first().click()
    await page.getByRole("button", { name: "Continuar" }).click()

    /* Na revisão o carrinho já está na plataforma: da conta, com a entrega
       gravada e o frete cotado pela entrega local. */
    const prepared = page.getByTestId(`prepared-${store.id}`)
    await expect(prepared).toBeVisible({ timeout: 30_000 })
    await expect(prepared.getByText("Este pedido não ficou ligado à sua conta.")).toHaveCount(0)
    await expect(prepared.getByTestId("shipping-quote")).toContainText(/Entrega local|local/i)
    await page.getByTestId("coupon-input").fill("NAOEXISTE")
    await page.getByRole("button", { name: "Aplicar" }).click()
    await expect(prepared).toContainText(/Cupom inválido|não dá desconto/)
    await shot(page, "05-revisao")
    await page.getByRole("button", { name: "Confirmar pedido" }).click()
    await expect(page).toHaveURL(/\/thank-you/, { timeout: 30_000 })
    await expect(page.getByText(/Pedido reservado/).first()).toBeVisible()
    await shot(page, "06-obrigado")
  })

  const marketplaceOrderId = await page.evaluate(() => {
    const raw = localStorage.getItem("sx-last-purchase")
    const p = raw ? JSON.parse(raw) as { stores: { orderId?: string }[] } : null
    return p?.stores.find((s) => s.orderId)?.orderId ?? ""
  })
  expect(marketplaceOrderId).toMatch(/^[0-9a-f-]{36}$/)

  let orderId = ""
  await test.step("o pedido aparece em Minhas compras (da conta, não do aparelho)", async () => {
    await page.getByRole("button", { name: "Acompanhar em Minhas compras" }).click()
    await expect(page).toHaveURL(/\/account\/orders/)
    const table = page.getByTestId("my-orders")
    await expect(table).toBeVisible()
    await expect(table).toContainText("Aguardando pagamento")
    /* A lista vem de /v1/my-purchases: limpar o aparelho não a esvazia. */
    await page.evaluate(() => { localStorage.removeItem("sx-purchases"); localStorage.removeItem("sx-last-purchase") })
    await page.reload()
    await expect(page.getByTestId("my-orders")).toContainText("Aguardando pagamento")
    await shot(page, "07-minhas-compras")
  })

  await test.step("o lojista confirma o pagamento e despacha pela entrega local", async () => {
    const tok = await sellerToken()
    const s = `${TRANSACTION}/v1/stores/${store.id}`
    await expect(async () => {
      const list = await api("GET", `${s}/manual-payments`, tok) as { items?: { payment_id: string; marketplace_order_id: string; amount: number }[] }
      const p = (list.items ?? []).find((x) => x.marketplace_order_id === marketplaceOrderId)
      expect(p, "pagamento manual do pedido").toBeTruthy()
      await api("POST", `${s}/payments/${p!.payment_id}/manual-confirmation`, tok, { amount: p!.amount, reference: "e2e-comprador" })
    }).toPass({ timeout: 30_000, intervals: [1000] })
    await expect(async () => {
      const orders = await api("GET", `${s}/orders?limit=50`, tok) as { items?: { id: string; marketplace_order_id: string; status: string }[] }
      const o = (orders.items ?? []).find((x) => x.marketplace_order_id === marketplaceOrderId && x.status === "placed")
      expect(o, "pedido confirmado").toBeTruthy()
      orderId = o!.id
    }).toPass({ timeout: 30_000, intervals: [1000] })
    /* A lista de transportadoras é cacheada pelo core por até um minuto. */
    let quote: { id: string; options: { carrier: string; service_code: string }[] } | null = null
    await expect(async () => {
      quote = await api("POST", `${s}/shipping/quotes`, tok, {
        currency: "BRL", seller_order_id: orderId,
        origin: { country: "BR", postal_code: "69005-010", locality: "Manaus", region: "AM", line1: "Rua Marcílio Dias, 100" },
        packages: [{ weight_grams: 1000, length_mm: 200, width_mm: 150, height_mm: 100 }],
      })
      expect(quote!.options.some((o) => o.carrier === "local")).toBe(true)
    }).toPass({ timeout: 90_000, intervals: [5000] })
    const local = quote!.options.find((o) => o.carrier === "local")!
    await api("POST", `${s}/shipments`, tok, { seller_order_id: orderId, quote_id: quote!.id, carrier: "local", service_code: local.service_code })
  })

  await test.step("detalhe: linha do tempo da entrega e código de 4 dígitos", async () => {
    await page.goto("/account/orders")
    await page.getByRole("link", { name: orderId.slice(0, 8).toUpperCase() }).click()
    await expect(page).toHaveURL(new RegExp(`/account/orders/${orderId}$`))
    await expect(page.getByTestId("order-status")).toHaveText("Confirmado")
    await expect(async () => {
      await page.getByRole("button", { name: "Recarregar" }).click()
      await expect(page.getByTestId("delivery-code")).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 60_000, intervals: [3000] })
    await expect(page.getByTestId("delivery-code")).toContainText(/entrega\d{4}Diga/)
    await expect(page.getByTestId("delivery-timeline")).toContainText("Entrega criada")
    await expect(page.getByTestId("order-history")).toContainText("Confirmado")
    await shot(page, "08-pedido-com-codigo")
  })

  expect(errors, `erros na página: ${errors.join(" | ")}`).toEqual([])
})
