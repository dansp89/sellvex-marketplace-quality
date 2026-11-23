import { defineConfig, devices } from "@playwright/test"

/* Ponta a ponta entre as apps, contra a stack local já de pé.
 *
 * As apps não são levantadas aqui: cada uma tem o seu jeito de servir
 * (Nuxt em .output, Vite preview), e quem roda escolhe build ou dev. Os
 * endereços vêm do ambiente; os padrões são as portas de cada repo.
 *
 * O navegador é o Chrome do sistema (channel: "chrome"): nesta máquina e
 * no CI não é preciso baixar o Chromium do Playwright. */
const store = process.env.E2E_STORE_URL || "http://localhost:5190"
const mobile = process.env.E2E_MOBILE_URL || "http://localhost:5191"
const seller = process.env.E2E_SELLER_URL || "http://localhost:5301"
const entregas = process.env.E2E_ENTREGAS_URL || "http://localhost:5192"

export default defineConfig({
  testDir: "tests",
  outputDir: ".tmp/results",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: ".tmp/report", open: "never" }]],
  use: {
    channel: process.env.E2E_BROWSER_CHANNEL || "chrome",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    screenshot: "on",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "loja-web", testMatch: /compra\.spec\.ts/, use: { baseURL: store, viewport: { width: 1366, height: 900 } } },
    { name: "loja-celular", testMatch: /compra\.spec\.ts/, use: { ...devices["Pixel 7"], channel: "chrome", baseURL: mobile } },
    /* Entrega local: plataforma e CDL no app-admin, lojista no app-seller;
       cada teste usa os endereços absolutos (E2E_ADMIN_URL, E2E_SELLER_URL). */
    { name: "logistica", testMatch: /logistica(-relatorios)?\.spec\.ts/, use: { viewport: { width: 1366, height: 900 } } },
    /* Comprador com conta: cadastro, endereços, carrinho reivindicado, frete,
       minhas compras com o código de entrega (vitrine web). */
    { name: "comprador", testMatch: /comprador\.spec\.ts/, use: { baseURL: store, viewport: { width: 1366, height: 900 } } },
    { name: "lojista", testMatch: /lojista\.spec\.ts/, dependencies: ["loja-web", "loja-celular"], use: { baseURL: seller, viewport: { width: 1366, height: 900 } } },
    /* O app do entregador (sabor entregas do app-mobile), em tela de celular. */
    { name: "entregas", testMatch: /entregas\.spec\.ts/, use: { ...devices["Pixel 7"], channel: "chrome", baseURL: entregas } },
  ],
})
