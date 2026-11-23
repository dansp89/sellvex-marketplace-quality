import { test, expect } from "@playwright/test"
import { state, recordedOrders } from "./state"

/* O lojista entra no painel (app-seller) e vê, em «Pagamentos a
   confirmar», os pedidos que o comprador acabou de fazer na loja dele. */

const { seller } = state()

test("lojista entra e vê os pedidos do comprador", async ({ page }) => {
  const orders = Object.values(recordedOrders())
  expect(orders.length, "os testes do comprador gravam os pedidos antes").toBeGreaterThan(0)

  await page.goto("/sign-in")
  await page.getByLabel("Usuário").fill(seller.client)
  await page.getByLabel("Senha").fill(seller.secret)
  await page.getByRole("button", { name: /Entrar/ }).click()
  await expect(page).not.toHaveURL(/sign-in/)

  await page.goto("/payments")
  await expect(page.getByRole("heading", { name: "Pagamentos a confirmar" })).toBeVisible()
  for (const id of orders) {
    await expect(page.getByText(id.slice(-8).toUpperCase())).toBeVisible()
  }
  await page.screenshot({ path: test.info().outputPath("lojista-pagamentos.png") })
})
