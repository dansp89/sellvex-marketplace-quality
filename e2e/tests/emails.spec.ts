import { test, expect, type Page } from "@playwright/test"
import { state } from "./state"
import { linkFromMail, onBase } from "./mailpit"

/* Os dois e-mails que a vitrine manda e que só se completam pelo link:
 *
 * 1. recuperação de senha: pedir o link → o e-mail chega ao Mailpit → a
 *    página do link troca a senha → entra com a nova; o mesmo link de novo
 *    é recusado;
 * 2. newsletter com dupla confirmação: inscrever na faixa (202, pendente)
 *    → o e-mail chega → /newsletter/confirm grava o consentimento → o
 *    mesmo link de novo é recusado (422 privacy.confirmation_invalid).
 *
 * Pré-requisito: prepare-stack e a stack com o conector smtp no Mailpit
 * (sh deploy/compose/mailpit-connector.sh no core). Cada rodada usa e-mails
 * novos: re-executável contra o mesmo banco. */
const { store } = state()
const CONTROL = process.env.E2E_CONTROL_PLANE || "http://localhost:8080"
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: false })
}

test("recuperação de senha pelo link do e-mail", async ({ page }) => {
  const email = `rec.${stamp}@e2e.sellvex.local`
  const old = `antiga-${stamp}`
  const fresh = `nova-${stamp}`
  const r = await fetch(`${CONTROL}/v1/customers/signup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Rita Recupera", email, password: old, terms_version: "termos-2026-11", store_id: store.id }),
  })
  expect(r.status, await r.clone().text()).toBeLessThan(300)

  await page.goto("/reset-password")
  await page.locator("main").getByRole("textbox", { name: /^E-mail/ }).fill(email)
  await page.getByRole("button", { name: "Enviar link" }).click()
  await expect(page.getByTestId("recovery-sent")).toBeVisible()
  await shot(page, "m01-recuperacao-pedida")

  const link = await linkFromMail(email, /\/reset-password\/finish$/)
  expect(link.searchParams.get("token")).toBeTruthy()
  await page.goto(onBase(link))
  await expect(page.getByRole("heading", { name: "Criar uma senha nova" })).toBeVisible()
  await page.getByLabel("Senha nova").fill(fresh)
  await page.getByLabel("Repita a senha").fill(fresh)
  await page.getByRole("button", { name: "Trocar a senha" }).click()
  await expect(page).toHaveURL(/\/sign-in/)

  await page.locator("main").getByRole("textbox", { name: /^E-mail/ }).fill(email)
  await page.locator("main").getByRole("textbox", { name: /^Senha/ }).fill(fresh)
  await page.getByRole("button", { name: "Entrar", exact: true }).click()
  await expect(page).toHaveURL(/\/account/)
  await shot(page, "m02-entrou-com-a-nova")

  /* O token é de uso único. */
  await page.goto(onBase(link))
  await page.getByLabel("Senha nova").fill(`outra-${fresh}`)
  await page.getByLabel("Repita a senha").fill(`outra-${fresh}`)
  await page.getByRole("button", { name: "Trocar a senha" }).click()
  await expect(page.getByText("Link inválido")).toBeVisible()
})

test("newsletter: inscrição pendente até o link do e-mail", async ({ page }) => {
  const email = `news.${stamp}@e2e.sellvex.local`
  await page.goto("/")
  await page.evaluate(() => localStorage.removeItem("sx-newsletter"))
  await page.reload()
  const band = page.locator(".sx-news")
  await band.scrollIntoViewIfNeeded()
  await band.getByRole("textbox", { name: "Seu e-mail" }).fill(email)
  const consent = band.locator(".sx-news__consent")
  if (await consent.count()) await consent.click()
  await band.getByRole("button").click()
  await expect(band.getByRole("status")).toContainText(`Enviamos um link para ${email}`)
  await shot(page, "m03-newsletter-pendente")

  const link = await linkFromMail(email, /\/newsletter\/confirm$/)
  expect(link.searchParams.get("store_id")).toBe(store.id)
  expect(link.searchParams.get("token")).toBeTruthy()
  await page.goto(onBase(link))
  await expect(page.getByTestId("newsletter-confirmed")).toBeVisible()
  await shot(page, "m04-newsletter-confirmada")

  /* O mesmo link de novo: 422 privacy.confirmation_invalid, explicado. */
  await page.goto(onBase(link))
  await expect(page.getByTestId("newsletter-confirm-failed")).toContainText(/expirou ou já foi usado/)
  await shot(page, "m05-newsletter-link-usado")
})
