import { test, expect, type Page } from "@playwright/test"

/* Nenhum frame com o chrome errado.
 *
 * Um MutationObserver instalado antes de qualquer script da página
 * (addInitScript) anota todo elemento que chegou a existir no DOM, mesmo
 * que tenha sumido no frame seguinte. Assim prova-se o que um screenshot
 * não prova:
 *
 *   - deslogado, abrir "/" nunca cria a barra/abas/menu do app logado;
 *   - logado, abrir a tela de entrada nunca cria o formulário.
 *
 * A sessão logada é um JWT não assinado no armazenamento que o app lê ao
 * restaurar (o app só decodifica; quem valida é a API). As chamadas à API
 * são respondidas aqui, para um 401 de verdade não encerrar a sessão no meio
 * do teste — o que se mede é o arranque, não a API.
 *
 * Roda contra as apps já de pé (vite preview): entregas 5192, painel da
 * plataforma 5300, painel do lojista 5301. */

type App = {
  name: string
  url: string
  signIn: string
  chrome: string[]
  /** Grava o token onde o app o procura. */
  seed: (token: string) => string
}

const APPS: App[] = [
  {
    name: "entregas", url: process.env.E2E_ENTREGAS_URL || "http://localhost:5192", signIn: "/login",
    chrome: ["app-chrome-top", "app-chrome-tabs"],
    /* @aparajita/capacitor-secure-storage no navegador: localStorage com prefixo, valor em JSON. */
    seed: (t) => `localStorage.setItem("capacitor-storage_sx-courier-session", ${JSON.stringify(JSON.stringify(t))})`,
  },
  {
    name: "plataforma", url: process.env.E2E_ADMIN_URL || "http://localhost:5300", signIn: "/sign-in",
    chrome: ["app-chrome"],
    seed: (t) => `sessionStorage.setItem("sx-platform-client-session", ${JSON.stringify(t)})`,
  },
  {
    name: "lojista", url: process.env.E2E_SELLER_URL || "http://localhost:5301", signIn: "/sign-in",
    chrome: ["app-chrome"],
    seed: (t) => `sessionStorage.setItem("sx-seller-client-session", ${JSON.stringify(t)})`,
  },
]

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
const fakeJwt = (actor: string) => `${b64({ alg: "none" })}.${b64({
  sub: "e2e-chrome", name: "E2E Chrome", email: "chrome@sellvex.local", sellvex_actor_type: actor,
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.x`

const OBSERVER = (ids: string[]) => `(() => {
  const ids = ${JSON.stringify(ids)}
  const seen = (window.__sxSeen = new Set())
  const scan = (root) => {
    if (!(root instanceof Element)) return
    for (const id of ids) {
      if (root.matches('[data-testid="' + id + '"]') || root.querySelector('[data-testid="' + id + '"]')) seen.add(id)
    }
  }
  new MutationObserver((list) => { for (const m of list) m.addedNodes.forEach(scan) })
    .observe(document, { childList: true, subtree: true })
})()`

async function seenIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as { __sxSeen: Set<string> }).__sxSeen ?? [])])
}

async function stubApi(page: Page) {
  await page.route(/\/(v1|api)\//, (route) => {
    if (route.request().resourceType() === "document") return route.continue()
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], data: [] }) })
  })
}

for (const app of APPS) {
  test.describe(app.name, () => {
    test("deslogado, '/' nunca desenha o chrome logado", async ({ page }) => {
      await page.addInitScript(OBSERVER([...app.chrome, "sign-in-form"]))
      await page.goto(app.url + "/")
      await expect(page.getByTestId("sign-in-form")).toBeVisible()
      await page.waitForTimeout(500)
      const seen = await seenIds(page)
      for (const id of app.chrome) expect(seen, `${id} existiu num frame`).not.toContain(id)
      expect(new URL(page.url()).pathname).toBe(app.signIn)
    })

    test("logado, a tela de entrada nunca desenha o formulário", async ({ page }) => {
      await stubApi(page)
      const token = fakeJwt(app.name === "entregas" ? "courier" : app.name === "plataforma" ? "platform" : "store_member")
      await page.addInitScript(`try { ${app.seed(token)} } catch (e) {}`)
      await page.addInitScript(OBSERVER([...app.chrome, "sign-in-form"]))
      await page.goto(app.url + app.signIn)
      await expect(page.getByTestId(app.chrome[0]!)).toBeVisible()
      await page.waitForTimeout(500)
      expect(await seenIds(page), "o formulário de entrada existiu num frame").not.toContain("sign-in-form")
      expect(new URL(page.url()).pathname).not.toBe(app.signIn)
    })
  })
}
