# e2e — ponta a ponta entre as apps

Playwright contra a stack local, cobrindo o caminho que atravessa as
aplicações:

1. **comprador** (vitrine web `app-store` e app `app-mobile`): entra →
   loja → produto → carrinho → checkout com pagamento manual (Pix) →
   confirmação → o pedido aparece em «Meus pedidos»;
2. **lojista** (`app-seller`): entra e vê esses pedidos em «Pagamentos a
   confirmar».

3. **entregador** (`app-mobile`, sabor `entregas`): entra → fica online →
   um pedido real com entrega local (comprador e loja pela API) vira
   oferta no app → aceita → lê o QR do volume na coleta → código errado
   mostra o erro, o certo entrega → a corrida aparece no extrato.

## Por que aqui e não em cada repositório

O fluxo não pertence a nenhuma app: o pedido nasce na vitrine e é
conferido no painel do lojista, com estado (usuário de teste, cliente do
lojista, filiação, módulo de pagamentos) que tem de ser preparado uma vez
para todas. Testes por app continuam em cada repositório (vitest); este
é o único lugar que sabe da stack inteira.

## Rodar

Pré-requisitos: a stack do core de pé e semeada (memória
`bringing-the-local-stack-up`; `sellvex marketplace --local --reason ...`),
e as três apps servidas:

| App | Porta | Como |
|---|---|---|
| app-store (Nuxt) | 5190 | `bun run build && PORT=5190 bun .output/server/index.mjs` |
| app-mobile | 5191 | `bun run build && bunx vite preview --port 5191` |
| app-seller | 5301 | `bun run build && bunx vite preview --port 5301` |
| app-mobile, sabor entregas | 5192 | `SELLVEX_APP_FLAVOUR=entregas bun run build && SELLVEX_APP_FLAVOUR=entregas bunx vite preview --port 5192` |

```bash
bun install
bun run prepare-stack   # idempotente: comprador, lojista, filiação, módulo de pagamentos
bun run test            # loja-web, loja-celular e depois lojista
bun run report          # relatório com as capturas de cada passo

# o app do entregador (precisa da stack em wip/logistica-local do core)
bun run prepare-entregas
bunx playwright test --project entregas
```

O navegador é o Chrome do sistema (`channel: "chrome"`); `E2E_BROWSER_CHANNEL`
troca. Endereços: `E2E_STORE_URL`, `E2E_MOBILE_URL`, `E2E_SELLER_URL`; a stack:
`E2E_CONTROL_PLANE`, `E2E_COMMERCE`, `E2E_TRANSACTION`, `E2E_IDP`,
`E2E_CORE_COMPOSE`, `E2E_COMPOSE_PROJECT`. `E2E_STORE_ID` fixa a loja.

## Entrega local (logística)

`tests/logistica.spec.ts` cobre: a plataforma grava um regime (app-admin),
a CDL cria a frota, aprova o entregador e o põe na frota, o lojista liga a
entrega local, prepara o pedido, reserva a entrega, marca pronto e baixa a
etiqueta (app-seller), e a CDL vê a entrega no monitor de despacho.

```bash
bun run prepare-stack && bun run prepare-logistics
E2E_ADMIN_URL=http://localhost:5300 E2E_SELLER_URL=http://localhost:5301 bunx playwright test --project=logistica
```

A preparação cria os clientes `e2e-cdl`, `e2e-operador` e `e2e-entregador`
no dev-idp, as filiações, a CDL da organização, liga shipping/couriers/
dispatch, concede `shipping.carriers` à loja e gera um pedido pago. Ver o
cabeçalho de `scripts/prepare-logistics.ts`.

## Comprador com conta

`tests/comprador.spec.ts` cobre, na vitrine web: cadastro (com
consentimento de ofertas na loja) → e-mail repetido recusado → entrar →
telefone e endereço guardados na conta → checkout com o endereço da conta,
em que o carrinho é reivindicado pela conta, recebe a entrega e cota o
frete (entrega local), e o cupom inválido é dito → «Minhas compras» vem de
`/v1/my-purchases` (limpar o aparelho não a esvazia) → o lojista confirma
o pagamento e despacha pela entrega local (API) → o detalhe do pedido
mostra a linha do tempo e o código de quatro dígitos.

```bash
bun run prepare-stack && bun run prepare-logistics && bun run prepare-buyer
# a vitrine com a loja do teste (o id está em .tmp/state.json)
NUXT_PUBLIC_STORE_ID=<id> PORT=5190 bun .output/server/index.mjs   # no app-store
bunx playwright test --project=comprador
```

## O que a preparação faz e porquê

Ver o cabeçalho de `scripts/prepare-stack.ts`. Em resumo: não há cadastro
público de comprador nem forma de um teste conceder filiação sem a senha
do develop da instalação, então o comprador é criado no dev-idp e a
filiação do lojista é gravada no Postgres local. O cliente do lojista leva
o `sellvex_store_id` da loja escolhida num arquivo de clientes em `.tmp/`,
montado no dev-idp por um override do compose — o repositório do core não
é alterado.

`prepare-entregas` (cabeçalho de `scripts/prepare-entregas.ts`) cria o
entregador, um operador da plataforma e a equipe da CDL como **usuários**
do dev-idp (`POST /admin/users`), sem recriar o container; liga shipping,
couriers e dispatch na loja, concede `shipping.carriers` e põe `local` na
lista, grava o regime do teste (R$ 8,00 com 10% de taxa), cria a frota
privada com o entregador e faz a CDL aprovar documento e cadastro.
`E2E_ENTREGAS_URL` troca o endereço do app.

## Limites conhecidos (backend)

- Desde o core 8c3976e a vitrine reivindica o carrinho (`carts.carts.claim`)
  antes do checkout quando há sessão, e «Minhas compras» lê
  `/v1/my-purchases`. O `compra.spec.ts` antigo ainda confere o pedido pela
  tabela de «Minhas compras».

## Entregadores simulados

`tests/simulador.spec.ts` (projeto `simulador`) recria o worker com
`SELLVEX_COURIER_SIMULATOR=on` para a CDL da loja, confere
`/v1/health/config`, faz um pedido com entrega local pela API e espera um
entregador simulado aceitar, coletar e entregar sozinho; depois confere o
selo «Modo de teste» e o «Simulado» no painel da CDL e recria o worker com
`off` (os simulados ficam offline). O `afterAll` desliga mesmo se falhar.

```bash
bun run prepare-stack && bun run prepare-logistics && bun run prepare-entregas
E2E_ADMIN_URL=http://localhost:5300 bunx playwright test --project=simulador
```
