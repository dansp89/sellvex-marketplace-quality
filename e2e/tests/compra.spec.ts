import { test, expect, type Page } from "@playwright/test"
import { state, recordOrder } from "./state"

/* O comprador: entra, navega até a loja, escolhe um produto, compra com
   pagamento manual (Pix) e encontra o pedido em «Meus pedidos». Roda na
   vitrine web (Nuxt) e no app do celular (o mesmo pacote storefront). */

const { store, buyer } = state()

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: false })
}

test("navegar, comprar com Pix e ver o pedido", async ({ page }, info) => {
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))

  await test.step("entrar como comprador", async () => {
    await page.goto("/sign-in")
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible()
    await expect(page.getByText(/Entrar com Google/)).toHaveCount(0)
    await page.locator("main").getByRole("textbox", { name: /^E-mail/ }).fill(buyer.email)
    await page.locator("main").getByRole("textbox", { name: /^Senha/ }).fill("senha-errada")
    await page.getByRole("button", { name: "Entrar", exact: true }).click()
    await expect(page.getByText("E-mail ou senha incorretos.")).toBeVisible()
    await page.locator("main").getByRole("textbox", { name: /^Senha/ }).fill(buyer.password)
    await page.getByRole("button", { name: "Entrar", exact: true }).click()
    await expect(page).toHaveURL(/\/account/)
    await expect(page.getByText(`Olá, ${buyer.name}`)).toBeVisible()
    await shot(page, "1-conta")
  })

  await test.step("loja → produto → carrinho", async () => {
    await page.goto(`/stores/${store.handle}`)
    await expect(page.getByRole("heading", { name: store.name }).first()).toBeVisible()
    const product = page.locator('a[href^="/p/"]').first()
    await product.scrollIntoViewIfNeeded()
    await product.click()
    await expect(page).toHaveURL(/\/p\//)
    await expect(page.getByText("Frete grátis acima de R$ 150")).toHaveCount(0)
    await shot(page, "2-produto")
    await page.getByRole("button", { name: "Adicionar ao carrinho" }).first().click()
    await page.goto("/cart")
    await expect(page.getByText(store.name).first()).toBeVisible()
    await expect(page.getByText("Combinado com a loja").first()).toBeVisible()
    await shot(page, "3-carrinho")
    await page.getByRole("button", { name: "Finalizar compra" }).first().click()
    await expect(page).toHaveURL(/\/checkout/)
  })

  await test.step("checkout com pagamento manual", async () => {
    await expect(page.locator("main").getByRole("textbox", { name: /^E-mail/ })).toHaveValue(buyer.email)
    await page.getByLabel("Nome completo").fill(buyer.name)
    await page.getByLabel("CPF ou CNPJ").fill("529.982.247-25")
    await page.getByRole("button", { name: "Continuar" }).click()

    await page.getByLabel("CEP").fill("01310-100")
    /* O CEP é resolvido no ViaCEP, serviço externo: se não responder a
       tempo, o endereço é preenchido à mão, como faria o comprador. */
    const street = page.getByLabel("Rua")
    const resolved = await expect(street).not.toHaveValue("", { timeout: 12_000 }).then(() => true, () => false)
    if (!resolved) {
      await street.fill("Avenida Paulista")
      await page.getByLabel("Bairro").fill("Bela Vista")
      await page.getByLabel("Cidade").fill("São Paulo")
      await page.getByLabel("Estado").click()
      await page.keyboard.type("SP")
      await page.keyboard.press("Enter")
    }
    await page.getByLabel("Número").fill("1000")
    await page.getByRole("button", { name: "Continuar" }).click()

    await page.getByText("Pix", { exact: true }).first().click()
    await page.getByRole("button", { name: "Continuar" }).click()
    await shot(page, "4-revisao")
    await page.getByRole("button", { name: "Confirmar pedido" }).click()

    await expect(page).toHaveURL(/\/thank-you/, { timeout: 30_000 })
    await expect(page.getByText(/Pedido reservado/).first()).toBeVisible()
    await shot(page, "5-obrigado")
  })

  const orderId = await page.evaluate(() => {
    const raw = localStorage.getItem("sx-last-purchase")
    const p = raw ? JSON.parse(raw) as { stores: { orderId?: string }[] } : null
    return p?.stores.find((s) => s.orderId)?.orderId ?? ""
  })
  expect(orderId).toMatch(/^[0-9a-f-]{36}$/)
  recordOrder(info.project.name, orderId)

  await test.step("o pedido aparece em Meus pedidos", async () => {
    await page.goto("/account/orders")
    const table = page.getByTestId("my-orders")
    await expect(table).toContainText(orderId.slice(0, 8).toUpperCase())
    await expect(table).toContainText("Aguardando pagamento")
    await shot(page, "6-meus-pedidos")
  })

  expect(errors, `erros na página: ${errors.join(" | ")}`).toEqual([])
})
