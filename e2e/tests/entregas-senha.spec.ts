import { test, expect, type Page } from "@playwright/test"
import { psql } from "./fixtures"
import { linkFromMail, onBase, MAILPIT } from "./mailpit"

/* O entregador esqueceu a senha, no app Log:
 *
 *   conta criada pelo cadastro público (API) → na entrada, "Esqueci minha
 *   senha" → pede o link (a tela diz o mesmo com ou sem conta) → o e-mail
 *   chega ao Mailpit com o link do app do entregador
 *   (SELLVEX_COURIER_PASSWORD_RECOVERY_URL) → abre o link no app → senha
 *   nova duas vezes → volta à entrada com aviso → entra com a nova; a
 *   antiga não entra mais e o mesmo link, gasto, oferece pedir outro.
 *
 * Precisa da stack local com o conector smtp no Mailpit
 * (sh deploy/compose/mailpit-connector.sh no core) e do app em 5192. Ao
 * final apaga o que esta rodada criou: o perfil, os pedidos de
 * recuperação e os e-mails. */

const CONTROL = process.env.E2E_CONTROL_PLANE || "http://localhost:8080"
const RUN = Date.now().toString(36)
const courier = { name: "Entregador Senha E2E", email: `entregador.senha.${RUN}@sellvex.local`, password: `antiga-${RUN}-e2e`, next: `nova-${RUN}-e2e-ok` }
let subject = ""

test.beforeAll(async () => {
  const r = await fetch(`${CONTROL}/v1/couriers/signup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: courier.name, email: courier.email, password: courier.password, terms_version: "entregador-v1" }),
  })
  const body = await r.json() as { subject?: string }
  expect(r.status, JSON.stringify(body)).toBe(201)
  subject = body.subject ?? ""
  expect(subject).not.toBe("")
})

test.afterAll(async () => {
  if (subject) psql(`delete from identity.password_recoveries where subject='${subject}'; delete from identity.customer_profiles where subject='${subject}'`)
  await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${courier.email}"`)}`, { method: "DELETE" })
})

test("entregador troca a senha pelo link do e-mail e entra com a nova", async ({ page }) => {
  await page.goto("/login")
  const field = (id: string, on: Page = page) => on.locator(`[data-testid="${id}"] input, input[data-testid="${id}"]`).first()
  await field("login-email").fill(courier.email)
  await page.getByTestId("go-forgot").click()
  await expect(page).toHaveURL(/\/forgot-password/)
  await expect(page.getByRole("heading", { name: "Esqueceu a senha?" })).toBeVisible()
  const email = field("forgot-email")
  await expect(email).toHaveValue(courier.email)
  await page.getByTestId("forgot-submit").click()
  await expect(page.getByTestId("forgot-sent")).toContainText("Se houver uma conta com esse e-mail, enviamos um link")
  await page.screenshot({ path: test.info().outputPath("pedido.png") })

  const link = await linkFromMail(courier.email, /\/reset-password$/)
  expect(link.port, "o link abre o app do entregador").toBe("5192")
  expect(link.searchParams.get("token")).toBeTruthy()

  await page.goto(onBase(link))
  await expect(page.getByRole("heading", { name: "Crie uma senha nova" })).toBeVisible()
  await field("reset-password").fill(courier.next)
  await field("reset-confirm").fill(courier.next + "x")
  await page.getByTestId("reset-submit").click()
  await expect(page.getByText("As duas senhas não são iguais.")).toBeVisible()
  await field("reset-confirm").fill(courier.next)
  await page.getByTestId("reset-submit").click()

  await expect(page).toHaveURL(/\/login\?reset=1/)
  await expect(page.getByTestId("login-reset")).toContainText("Senha trocada")
  await field("login-email").fill(courier.email)
  await field("login-password").fill(courier.password)
  await page.getByTestId("login-submit").click()
  await expect(page.getByTestId("login-error")).toBeVisible()

  await field("login-password").fill(courier.next)
  await page.getByTestId("login-submit").click()
  await expect(page).not.toHaveURL(/\/login/)
  await page.screenshot({ path: test.info().outputPath("entrou.png") })

  /* O link é de uso único: aberto de novo, explica e oferece outro. */
  const ctx = await page.context().newPage()
  await ctx.goto(onBase(link))
  const f2 = (id: string) => field(id, ctx)
  await f2("reset-password").fill("outra-senha-qualquer-1")
  await f2("reset-confirm").fill("outra-senha-qualquer-1")
  await ctx.getByTestId("reset-submit").click()
  await expect(ctx.getByTestId("reset-invalid")).toContainText("Este link não vale mais")
  await ctx.getByTestId("reset-request-again").click()
  await expect(ctx).toHaveURL(/\/forgot-password/)
})

test("link sem token explica e oferece pedir outro", async ({ page }) => {
  await page.goto("/reset-password")
  await expect(page.getByTestId("reset-invalid")).toContainText("Este link não vale mais")
})
