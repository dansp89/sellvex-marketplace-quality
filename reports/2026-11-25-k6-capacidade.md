# Capacidade com k6 — custo unitário e efeito do tamanho da base (200 a 120 mil lojas)

Data: 2026-11-25 · Stack local `sellvex-minimal` · Dados brutos resumidos em `reports/data/2026-11-25/` · Tabelas geradas por `bun k6/tabelas.ts` (nenhum número digitado à mão).

**O que este relatório é:** custo unitário medido (CPU-ms, consultas, tempo de banco, WAL, bytes) por tipo de requisição e como ele muda com o tamanho da base, mais o ponto de quebra de cada cenário **nesta máquina**. **O que não é:** declaração de capacidade de produção. O gate de `08 §Gate de capacidade` continua fechado: notebook não é hardware alvo, não houve teste de falha, e os produtos por loja foram reduzidos.

## Registro (08 §Registro de cada teste)

| item | valor |
|---|---|
| commit core | `ba7ca6c2b17425e65485bc419edb4914885c2f9a` (todos os repositórios: `reports/data/2026-11-25/maquina.txt`) |
| commit quality | os desta série (ver "Como reproduzir") |
| imagens | digests de commerce/transaction/control-plane/worker/postgres em `maquina.txt`; k6 `grafana/k6:0.57.0` (digest em `maquina.txt`) |
| hardware | notebook Intel Core i5-10300H, 4 núcleos/8 threads, **limitado a 2,5 GHz** (lscpu max MHz), 23 GB RAM, NVMe WDC PC SN530 512 GB a 88–92 % de uso |
| benchmark de referência | sysbench cpu 1 thread **326,5 eventos/s**, 8 threads 1.962; sysbench memory 10.833 MiB/s; fio 4k randread 130 k IOPS, **4k randwrite 6,6 k IOPS (p99 25 ms)**, seq read 1.336 MB/s, **seq write 146 MB/s** |
| rede | loopback (`--network host`), sem TLS, sem balanceador |
| kernel / SO | Linux 6.8.0-149-generic, Ubuntu 22.04.5; Docker 29.4.2; PostgreSQL 18.6; Go 1.26.8 |
| limites de serviço | sem limite de CPU/memória; durante a medição os contêineres `sellvex-minimal-*` presos aos núcleos 0-5 (`docker update --cpuset-cpus`) e o k6 aos núcleos 6-7; Postgres padrão (shared_buffers 128 MB, max_connections 100, synchronous_commit on) + `pg_stat_statements` |
| dataset | 29 lojas do `sellvex marketplace --local` + lojas de carga clonadas de 5 lojas-molde (média **19,2 produtos/loja**, ~3 variantes/produto): 200, 2.000, 20.000 e 120.000 lojas (2,3 M produtos, 13,8 GB) |
| duração | 20 s por degrau; degraus sobem até quebrar |
| padrão de chegada | aberto, `constant-arrival-rate`; 50 % do tráfego em 20 lojas quentes (Zipf), 50 % na cauda longa log-uniforme sobre todas as lojas |
| RPS, p50/p95/p99, erro | tabelas abaixo, total e por endpoint |
| CPU | CPU-ms por requisição e núcleos médios por serviço (cgroup v2 `cpu.stat`) |
| memória | máxima por serviço (cgroup `memory.current`, inclui page cache — no Postgres isso domina) e ociosa |
| GC | **não medido** (os serviços não expõem métricas de runtime); a memória dos serviços Go ficou em 18–70 MB |
| saturação do banco | consultas/req e tempo de banco/req (`pg_stat_statements`), transações, acerto de cache (≥ 98 %), conexões por serviço, WAL/req, crescimento por pedido |
| cache | acerto do buffer do Postgres; Valkey usou 4–6 MB; cache de borda não existe na stack local |
| fila | outbox pendente e pendências dos consumidores NATS (pico no checkout a 40 pedidos/s: outbox 204, NATS 283, drenados ao fim) |
| custo | calculadora (`capacity-model/calculadora.ts`), seção final |
| gerador | k6 em 2 núcleos isolados; degrau marcado `gerador_saturado` quando a média móvel de 3 s do CPU do k6 passa de 85 % — esse degrau não conta |

### Gerador: um defeito encontrado e corrigido

Na primeira passada de 120 mil lojas todo degrau saiu `gerador_saturado` já a 50 it/s: cada VU fazia `JSON.parse` do arquivo de 120 mil lojas na inicialização. Corrigido (só o `SharedArray` lê o arquivo; saturação por média de 3 s) e o degrau de 120 mil foi **refeito inteiro** — é o que está aqui. Os degraus de 2.000 e 20.000 foram medidos antes da correção: onde aparecem "(gerador saturou)" o degrau que quebrou foi reprovado por regra e o ponto de quebra informado é o **último degrau válido**, portanto um limite inferior. Os núcleos 6-7 do k6 também não ficaram livres de outros contêineres alheios à Sellvex que rodam na máquina.

## Achados principais

1. **A busca do marketplace não escala com a base.** `GET /marketplace/search` p95: 31 ms (200 lojas) → 131 ms (2 mil) → 208 ms (20 mil) → **5,9 s** (120 mil), já a 5 req/s. A consulta faz `to_tsvector($4, l.search_text) @@ plainto_tsquery(...)` com a configuração passada como parâmetro, o que impede o uso do índice `ix_listings__search`: vira varredura das 64 partições (1,9 s por chamada, 1.444 CPU-ms de banco por requisição a 120 mil lojas). Não é questão de hardware: precisa de correção no core (configuração fixa casando com a expressão do índice, ou busca fora do Postgres como prevê o perfil "busca" de DEC-INFRA-001). Core não foi editado.
2. **A lista de lojas da vitrine (`GET /storefronts`) cresce com a base:** p95 7 ms (200) → 50 ms (20 mil) → 170 ms (120 mil); a consulta em `stores.stores` custa ~100 ms a 120 mil lojas. Com isso a vitrine (1 em 4 iterações lista lojas) sai do orçamento de 50 ms já no primeiro degrau a 120 mil. Também é índice/consulta, não hardware.
3. **Os caminhos por loja não pioram com a base.** Produto, carrinho, checkout, painel e entregador têm CPU-ms e consultas por requisição praticamente constantes de 200 a 120 mil lojas (ex.: checkout 2,2 CPU-ms app + 4,7–5,5 CPU-ms banco por requisição em todos os degraus).
4. **Requisições por pedido: 9,2 a 9,8** no fluxo completo medido (navegar 2, carrinho 2, checkout 1, lojista lista Pix pendente 1+, baixa 1, consulta do checkout a cada 1 s até concluir 2+). Fica dentro da faixa 8–15 de DEC-PERF-003. Nesta máquina o checkout sustentou **~40 pedidos/s** (≈390 RPS) com p95 por etapa < 500 ms; a 80 pedidos/s quebrou.
5. **Disco do notebook é o pior componente**: 6,6 k IOPS de escrita aleatória e 146 MB/s sequencial com o disco a 90 %. Cada pedido gera 59–83 KB de WAL e ~27–35 KB de crescimento do banco.

### Ponto de quebra por cenário (RPS máximo com p95 no orçamento)

| cenário | orçamento p95 | 200 lojas | 2.000 lojas | 20.000 lojas | 120.000 lojas |
|---|---|---|---|---|---|
| vitrine | 50 ms | 900 | 899 | 225 | 0 |
| produto | 50 ms | 400 | 800 | 400 | 800 |
| busca | 50 ms | 400 | 0 | 0 | 0 |
| carrinho | 300 ms | 600 | 1.200 | 1.199 (gerador saturou) | 1.200 |
| checkout | 500 ms | 374 | 390 | 371 (gerador saturou) | 393 |
| painel | 150 ms | 801 | 801 | 801 (gerador saturou) | 1.601 |
| entregador | 300 ms | 401 | 1.501 (gerador saturou) | 401 (gerador saturou) | 801 |

### Custo unitário no degrau de referência (maior degrau dentro do orçamento)

| lojas | cenário | RPS | p50 | p95 | p99 | erro | CPU-ms/req app | CPU-ms/req banco | CPU-ms/req worker+nats | consultas/req | banco ms/req | WAL B/req | KB resp/req | k6 pico |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 200 | vitrine | 900 | 3,6 | 18,6 | 97,4 | 0,00 % | 1,77 | 1,27 | 0,09 | 5,9 | 0,61 | 66 | 8,0 | 19 % |
| 200 | produto | 400 | 3,4 | 6,5 | 11,1 | 0,00 % | 2,15 | 1,78 | 0,18 | 10,0 | 0,65 | 8 | 8,8 | 15 % |
| 200 | busca | 400 | 7,1 | 31,4 | 48,4 | 0,00 % | 0,68 | 7,66 | 0,19 | 1,0 | 6,19 | 0 | 3,4 | 13 % |
| 200 | carrinho | 600 | 2,8 | 11,5 | 85,4 | 0,00 % | 1,13 | 1,84 | 0,13 | 8,4 | 0,43 | 441 | 0,5 | 13 % |
| 200 | checkout | 374 | 3,3 | 34,3 | 81,2 | 0,00 % | 2,21 | 4,70 | 1,93 | 22,0 | 1,97 | 6.324 | 2,3 | 12 % |
| 200 | painel | 801 | 1,8 | 3,5 | 5,9 | 0,00 % | 1,63 | 0,62 | 0,09 | 2,5 | 0,23 | 0 | 19,1 | 18 % |
| 200 | entregador | 401 | 1,6 | 15,4 | 29,1 | 0,00 % | 0,86 | 0,76 | 0,14 | 3,0 | 0,69 | 240 | 0,1 | 10 % |
| 2.000 | vitrine | 899 | 3,8 | 9,6 | 19,7 | 0,00 % | 1,74 | 1,59 | 0,11 | 6,0 | 0,91 | 0 | 7,9 | 21 % |
| 2.000 | produto | 800 | 4,3 | 10,1 | 15,8 | 0,00 % | 2,22 | 1,83 | 0,08 | 10,0 | 0,76 | 0 | 8,8 | 28 % |
| 2.000 | busca | 5 | 18,2 | 131,0 | 136,3 | 0,00 % | 1,63 | 46,10 | 12,13 | 2,0 | 20,67 | 151 | 3,4 | 1 % |
| 2.000 | carrinho | 1.200 | 4,4 | 80,3 | 139,4 | 0,00 % | 1,14 | 1,90 | 0,06 | 8,3 | 0,52 | 563 | 0,5 | 26 % |
| 2.000 | checkout | 390 | 4,2 | 94,3 | 453,4 | 0,00 % | 2,23 | 4,77 | 1,86 | 21,4 | 2,32 | 5.997 | 2,2 | 14 % |
| 2.000 | painel | 801 | 1,8 | 3,4 | 6,0 | 0,00 % | 1,63 | 0,63 | 0,09 | 2,5 | 0,23 | 0 | 19,2 | 20 % |
| 2.000 | entregador | 1.501 | 2,1 | 262,0 | 345,7 | 0,00 % | 0,89 | 0,70 | 0,05 | 3,0 | 0,53 | 231 | 0,1 | 46 % |
| 20.000 | vitrine | 225 | 3,4 | 24,4 | 34,3 | 0,00 % | 1,72 | 4,29 | 0,29 | 5,9 | 3,32 | 0 | 7,9 | 13 % |
| 20.000 | produto | 400 | 3,3 | 5,8 | 8,6 | 0,00 % | 2,05 | 2,11 | 0,24 | 10,4 | 0,95 | 0 | 8,7 | 22 % |
| 20.000 | busca | 5 | 113,2 | 207,7 | 1.204,4 | 0,00 % | 1,34 | 163,44 | 13,59 | 2,0 | 130,87 | 0 | 3,3 | 1 % |
| 20.000 | carrinho | 1.199 | 5,1 | 86,4 | 215,6 | 0,00 % | 1,18 | 1,99 | 0,07 | 8,3 | 0,58 | 649 | 0,5 | 67 % |
| 20.000 | checkout | 371 | 3,8 | 35,6 | 68,2 | 0,00 % | 2,30 | 5,47 | 2,06 | 22,6 | 2,64 | 6.620 | 2,3 | 10 % |
| 20.000 | painel | 801 | 1,9 | 5,1 | 13,5 | 0,00 % | 1,69 | 0,65 | 0,09 | 2,5 | 0,25 | 0 | 19,3 | 48 % |
| 20.000 | entregador | 401 | 1,5 | 2,2 | 3,6 | 0,00 % | 0,88 | 0,89 | 0,19 | 3,0 | 0,15 | 212 | 0,1 | 46 % |
| 120.000 | vitrine | 112 | 4,0 | 90,1 | 151,6 | 0,00 % | 2,02 | 21,62 | 0,86 | 7,6 | 13,33 | 61 | 7,9 | 3 % |
| 120.000 | produto | 800 | 4,7 | 17,1 | 67,8 | 0,00 % | 2,26 | 1,96 | 0,09 | 10,0 | 1,18 | 0 | 8,7 | 27 % |
| 120.000 | busca | 5 | 1.120,5 | 5.873,7 | 18.254,8 | 0,00 % | 6,82 | 1.443,95 | 19,47 | 18,8 | 1.873,40 | 243 | 3,4 | 1 % |
| 120.000 | carrinho | 1.200 | 4,3 | 22,0 | 71,9 | 0,00 % | 1,13 | 1,87 | 0,06 | 8,3 | 0,53 | 433 | 0,5 | 23 % |
| 120.000 | checkout | 393 | 3,6 | 48,0 | 128,0 | 0,00 % | 2,16 | 4,95 | 1,89 | 21,2 | 2,13 | 8.489 | 2,2 | 11 % |
| 120.000 | painel | 1.601 | 3,0 | 19,0 | 51,5 | 0,00 % | 1,78 | 0,67 | 0,05 | 2,5 | 0,35 | 0 | 19,2 | 35 % |
| 120.000 | entregador | 801 | 1,7 | 15,7 | 84,8 | 0,00 % | 0,88 | 1,07 | 0,12 | 3,2 | 0,74 | 236 | 0,1 | 17 % |

### Por endpoint (degrau de referência)

| lojas | cenário | endpoint | req | p50 | p95 | p99 | erro |
|---|---|---|---|---|---|---|---|
| 200 | vitrine | `GET /storefronts` | 1996 | 1,2 | 6,9 | 19,4 | 0,00 % |
| 200 | vitrine | `GET /storefronts/{id}/products` | 8001 | 5,2 | 30,8 | 157,3 | 0,00 % |
| 200 | vitrine | `GET /storefronts/{id}/categories` | 8001 | 1,1 | 8,6 | 44,2 | 0,00 % |
| 200 | produto | `GET /storefronts/{id}/products/{pid}` | 4001 | 2,5 | 4,9 | 9,0 | 0,00 % |
| 200 | produto | `GET /storefronts/{id}/products` | 4001 | 4,1 | 7,6 | 12,4 | 0,00 % |
| 200 | busca | `GET /marketplace/search` | 8001 | 7,1 | 31,4 | 48,4 | 0,00 % |
| 200 | carrinho | `POST /carts` | 4001 | 1,7 | 11,4 | 75,8 | 0,00 % |
| 200 | carrinho | `GET /carts/{id}` | 4001 | 2,6 | 6,9 | 76,9 | 0,00 % |
| 200 | carrinho | `PUT /carts/{id}/items/{vid}` | 4001 | 4,3 | 18,0 | 110,7 | 0,00 % |
| 200 | checkout | `PUT /carts/{id}/items/{vid}` | 801 | 5,2 | 20,0 | 24,4 | 0,00 % |
| 200 | checkout | `POST /carts` | 801 | 2,0 | 12,3 | 19,0 | 0,00 % |
| 200 | checkout | `GET /checkouts/{id}` | 1852 | 1,4 | 3,8 | 8,8 | 0,00 % |
| 200 | checkout | `GET /storefronts/{id}/products` | 801 | 5,2 | 9,1 | 11,9 | 0,00 % |
| 200 | checkout | `POST /payments/{id}/manual-confirmation` | 801 | 12,0 | 59,6 | 89,3 | 0,00 % |
| 200 | checkout | `GET /stores/{id}/manual-payments` | 801 | 1,1 | 2,6 | 4,5 | 0,00 % |
| 200 | checkout | `POST /checkouts` | 801 | 21,6 | 112,9 | 161,3 | 0,00 % |
| 200 | checkout | `GET /storefronts/{id}/products/{pid}` | 801 | 2,6 | 5,1 | 7,8 | 0,00 % |
| 200 | painel | `GET /stores/{id}/products` | 8001 | 2,1 | 4,1 | 6,6 | 0,00 % |
| 200 | painel | `GET /stores/{id}/orders` | 8001 | 1,2 | 2,4 | 4,3 | 0,00 % |
| 200 | entregador | `PUT /courier/location` | 8001 | 1,6 | 15,4 | 29,1 | 0,00 % |
| 2.000 | vitrine | `GET /storefronts/{id}/categories` | 8001 | 1,1 | 3,8 | 8,2 | 0,00 % |
| 2.000 | vitrine | `GET /storefronts` | 1969 | 3,6 | 7,4 | 12,8 | 0,00 % |
| 2.000 | vitrine | `GET /storefronts/{id}/products` | 8001 | 5,0 | 13,1 | 28,1 | 0,00 % |
| 2.000 | produto | `GET /storefronts/{id}/products/{pid}` | 8001 | 3,0 | 7,8 | 12,3 | 0,00 % |
| 2.000 | produto | `GET /storefronts/{id}/products` | 8001 | 5,1 | 11,4 | 17,8 | 0,00 % |
| 2.000 | busca | `GET /marketplace/search` | 101 | 18,2 | 131,0 | 136,3 | 0,00 % |
| 2.000 | carrinho | `GET /carts/{id}` | 8001 | 3,2 | 92,2 | 139,7 | 0,00 % |
| 2.000 | carrinho | `POST /carts` | 8001 | 2,0 | 38,4 | 72,7 | 0,00 % |
| 2.000 | carrinho | `PUT /carts/{id}/items/{vid}` | 8001 | 5,4 | 105,3 | 165,1 | 0,00 % |
| 2.000 | checkout | `GET /stores/{id}/manual-payments` | 800 | 1,2 | 16,4 | 24,6 | 0,00 % |
| 2.000 | checkout | `POST /checkouts` | 800 | 40,3 | 316,6 | 802,5 | 0,00 % |
| 2.000 | checkout | `PUT /carts/{id}/items/{vid}` | 800 | 6,7 | 62,1 | 657,9 | 0,00 % |
| 2.000 | checkout | `GET /checkouts/{id}` | 2188 | 1,7 | 12,4 | 625,1 | 0,00 % |
| 2.000 | checkout | `POST /carts` | 800 | 2,9 | 22,0 | 549,2 | 0,00 % |
| 2.000 | checkout | `GET /storefronts/{id}/products/{pid}` | 800 | 2,8 | 34,4 | 61,3 | 0,00 % |
| 2.000 | checkout | `GET /storefronts/{id}/products` | 800 | 5,8 | 79,9 | 479,3 | 0,00 % |
| 2.000 | checkout | `POST /payments/{id}/manual-confirmation` | 800 | 22,3 | 160,1 | 206,7 | 0,00 % |
| 2.000 | painel | `GET /stores/{id}/orders` | 8001 | 1,2 | 2,4 | 4,6 | 0,00 % |
| 2.000 | painel | `GET /stores/{id}/products` | 8001 | 2,1 | 4,0 | 6,7 | 0,00 % |
| 2.000 | entregador | `PUT /courier/location` | 30000 | 2,1 | 262,1 | 345,7 | 0,00 % |
| 20.000 | vitrine | `GET /storefronts` | 497 | 24,2 | 38,6 | 43,9 | 0,00 % |
| 20.000 | vitrine | `GET /storefronts/{id}/products` | 2001 | 4,1 | 7,1 | 10,5 | 0,00 % |
| 20.000 | vitrine | `GET /storefronts/{id}/categories` | 2001 | 0,8 | 1,4 | 2,9 | 0,00 % |
| 20.000 | produto | `GET /storefronts/{id}/products` | 4001 | 3,9 | 6,8 | 9,6 | 0,00 % |
| 20.000 | produto | `GET /storefronts/{id}/products/{pid}` | 4001 | 2,2 | 4,0 | 6,2 | 0,00 % |
| 20.000 | busca | `GET /marketplace/search` | 101 | 113,2 | 207,7 | 1.204,4 | 0,00 % |
| 20.000 | carrinho | `PUT /carts/{id}/items/{vid}` | 7992 | 7,3 | 147,8 | 229,4 | 0,00 % |
| 20.000 | carrinho | `POST /carts` | 7992 | 2,9 | 52,4 | 83,6 | 0,00 % |
| 20.000 | carrinho | `GET /carts/{id}` | 7992 | 4,2 | 120,9 | 218,1 | 0,00 % |
| 20.000 | checkout | `POST /payments/{id}/manual-confirmation` | 801 | 14,4 | 48,2 | 63,8 | 0,00 % |
| 20.000 | checkout | `GET /stores/{id}/manual-payments` | 801 | 1,1 | 2,6 | 4,0 | 0,00 % |
| 20.000 | checkout | `GET /storefronts/{id}/products/{pid}` | 801 | 3,1 | 6,6 | 10,7 | 0,00 % |
| 20.000 | checkout | `POST /carts` | 801 | 2,2 | 9,7 | 18,4 | 0,00 % |
| 20.000 | checkout | `POST /checkouts` | 801 | 24,8 | 81,5 | 103,9 | 0,00 % |
| 20.000 | checkout | `PUT /carts/{id}/items/{vid}` | 801 | 5,8 | 16,5 | 22,3 | 0,00 % |
| 20.000 | checkout | `GET /checkouts/{id}` | 1793 | 1,7 | 4,3 | 6,7 | 0,00 % |
| 20.000 | checkout | `GET /storefronts/{id}/products` | 801 | 6,0 | 13,0 | 18,2 | 0,00 % |
| 20.000 | painel | `GET /stores/{id}/products` | 8001 | 2,2 | 6,7 | 20,2 | 0,00 % |
| 20.000 | painel | `GET /stores/{id}/orders` | 8001 | 1,3 | 3,4 | 6,7 | 0,00 % |
| 20.000 | entregador | `PUT /courier/location` | 8001 | 1,5 | 2,2 | 3,6 | 0,00 % |
| 120.000 | vitrine | `GET /storefronts` | 232 | 88,9 | 169,5 | 271,8 | 0,00 % |
| 120.000 | vitrine | `GET /storefronts/{id}/categories` | 1001 | 0,9 | 2,6 | 7,6 | 0,00 % |
| 120.000 | vitrine | `GET /storefronts/{id}/products` | 1001 | 5,5 | 15,1 | 32,3 | 0,00 % |
| 120.000 | produto | `GET /storefronts/{id}/products/{pid}` | 8001 | 3,1 | 13,3 | 64,2 | 0,00 % |
| 120.000 | produto | `GET /storefronts/{id}/products` | 8001 | 5,7 | 20,6 | 70,8 | 0,00 % |
| 120.000 | busca | `GET /marketplace/search` | 96 | 1.120,5 | 5.873,7 | 18.254,8 | 0,00 % |
| 120.000 | carrinho | `POST /carts` | 8001 | 2,1 | 14,2 | 35,3 | 0,00 % |
| 120.000 | carrinho | `PUT /carts/{id}/items/{vid}` | 8001 | 5,4 | 28,8 | 104,3 | 0,00 % |
| 120.000 | carrinho | `GET /carts/{id}` | 8001 | 3,1 | 21,5 | 87,4 | 0,00 % |
| 120.000 | checkout | `GET /storefronts/{id}/products` | 801 | 5,2 | 10,4 | 14,0 | 0,00 % |
| 120.000 | checkout | `POST /carts` | 801 | 2,3 | 16,4 | 42,9 | 0,00 % |
| 120.000 | checkout | `PUT /carts/{id}/items/{vid}` | 801 | 6,0 | 23,9 | 30,4 | 0,00 % |
| 120.000 | checkout | `GET /checkouts/{id}` | 2225 | 1,4 | 8,4 | 34,0 | 0,00 % |
| 120.000 | checkout | `POST /payments/{id}/manual-confirmation` | 801 | 14,9 | 85,7 | 128,0 | 0,00 % |
| 120.000 | checkout | `POST /checkouts` | 801 | 29,3 | 158,1 | 238,9 | 0,00 % |
| 120.000 | checkout | `GET /storefronts/{id}/products/{pid}` | 801 | 2,6 | 5,5 | 8,1 | 0,00 % |
| 120.000 | checkout | `GET /stores/{id}/manual-payments` | 801 | 1,1 | 3,7 | 13,2 | 0,00 % |
| 120.000 | painel | `GET /stores/{id}/products` | 16001 | 4,0 | 29,7 | 65,5 | 0,00 % |
| 120.000 | painel | `GET /stores/{id}/orders` | 16001 | 2,1 | 9,5 | 21,6 | 0,00 % |
| 120.000 | entregador | `PUT /courier/location` | 16000 | 1,7 | 15,7 | 84,8 | 0,00 % |

### Pedido completo

| lojas | pedidos/s no orçamento | requisições por pedido | tempo do pedido p95 | bytes de banco por pedido | WAL por pedido |
|---|---|---|---|---|---|
| 200 | 40,1 | 9,31 | 3.223 ms | 34.834 | 59.049 |
| 2.000 | 40,0 | 9,74 | 3.237 ms | 34.980 | 58.530 |
| 20.000 | 40,1 | 9,24 | 2.160 ms | 26.734 | 61.328 |
| 120.000 | 40,1 | 9,78 | 5.278 ms | 33.842 | 83.215 |

### Curva de saturação (todos os degraus)

| lojas | cenário | taxa iter/s | RPS | p95 | p99 | pior p95 endpoint | erro | descartadas | CPU commerce (núcleos) | CPU transaction | CPU postgres | k6 pico | resultado |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 200 | vitrine | 50 | 113 | 5,0 | 7,0 | 5,9 | 0,00 % | 0 | 0,18 | 0,00 | 0,20 | 3 % | ok |
| 200 | vitrine | 100 | 226 | 5,0 | 6,8 | 5,7 | 0,00 % | 0 | 0,33 | 0,00 | 0,29 | 6 % | ok |
| 200 | vitrine | 200 | 448 | 5,7 | 9,0 | 7,1 | 0,00 % | 0 | 0,66 | 0,00 | 0,50 | 10 % | ok |
| 200 | vitrine | 400 | 900 | 18,6 | 97,4 | 30,8 | 0,00 % | 0 | 1,38 | 0,00 | 0,99 | 19 % | ok |
| 200 | vitrine | 700 | 1.410 | 468,5 | 583,4 | 528,6 | 0,00 % | 1497 | 2,45 | 0,00 | 1,71 | 33 % | p95 528.6 ms > 50 ms; descartadas 1497 |
| 200 | produto | 50 | 100 | 5,1 | 6,9 | 5,5 | 0,00 % | 0 | 0,21 | 0,00 | 0,23 | 4 % | ok |
| 200 | produto | 100 | 200 | 4,9 | 6,7 | 5,4 | 0,00 % | 0 | 0,35 | 0,00 | 0,33 | 8 % | ok |
| 200 | produto | 200 | 400 | 6,5 | 11,1 | 7,6 | 0,00 % | 0 | 0,77 | 0,00 | 0,64 | 15 % | ok |
| 200 | produto | 400 | 794 | 107,5 | 343,0 | 115,2 | 0,00 % | 60 | 1,69 | 0,00 | 1,36 | 32 % | p95 115.2 ms > 50 ms |
| 200 | busca | 5 | 5 | 23,2 | 64,9 | 23,2 | 0,00 % | 0 | 0,01 | 0,00 | 0,14 | 1 % | ok |
| 200 | busca | 10 | 10 | 25,1 | 42,2 | 25,1 | 0,00 % | 0 | 0,03 | 0,00 | 0,18 | 1 % | ok |
| 200 | busca | 25 | 25 | 20,4 | 29,6 | 20,4 | 0,00 % | 0 | 0,02 | 0,00 | 0,25 | 2 % | ok |
| 200 | busca | 50 | 50 | 20,8 | 29,9 | 20,8 | 0,00 % | 0 | 0,04 | 0,00 | 0,37 | 3 % | ok |
| 200 | busca | 100 | 100 | 20,8 | 28,4 | 20,8 | 0,00 % | 0 | 0,07 | 0,00 | 0,64 | 5 % | ok |
| 200 | busca | 200 | 200 | 22,5 | 33,7 | 22,5 | 0,00 % | 0 | 0,11 | 0,00 | 1,03 | 8 % | ok |
| 200 | busca | 400 | 400 | 31,4 | 48,4 | 31,4 | 0,00 % | 0 | 0,23 | 0,00 | 2,62 | 13 % | ok |
| 200 | busca | 800 | 570 | 832,4 | 871,3 | 832,4 | 0,00 % | 4607 | 0,31 | 0,00 | 3,72 | 20 % | p95 832.4 ms > 50 ms; descartadas 4607 |
| 200 | carrinho | 25 | 75 | 14,4 | 39,2 | 16,6 | 0,00 % | 0 | 0,09 | 0,00 | 0,21 | 2 % | ok |
| 200 | carrinho | 50 | 150 | 4,6 | 6,4 | 5,3 | 0,00 % | 0 | 0,16 | 0,00 | 0,30 | 4 % | ok |
| 200 | carrinho | 100 | 300 | 6,0 | 17,8 | 9,6 | 0,00 % | 0 | 0,30 | 0,00 | 0,50 | 7 % | ok |
| 200 | carrinho | 200 | 600 | 11,5 | 85,4 | 18,0 | 0,00 % | 0 | 0,50 | 0,00 | 0,82 | 13 % | ok |
| 200 | carrinho | 400 | 1.035 | 332,3 | 495,6 | 354,6 | 0,00 % | 1099 | 1,13 | 0,00 | 1,88 | 26 % | p95 354.6 ms > 300 ms; descartadas 1099 |
| 200 | checkout | 5 | 47 | 34,5 | 225,7 | 199,3 | 0,00 % | 0 | 0,03 | 0,05 | 0,28 | 2 % | ok |
| 200 | checkout | 10 | 92 | 16,0 | 32,9 | 39,9 | 0,00 % | 0 | 0,08 | 0,09 | 0,42 | 3 % | ok |
| 200 | checkout | 20 | 181 | 16,7 | 34,3 | 41,4 | 0,00 % | 0 | 0,11 | 0,17 | 0,72 | 6 % | ok |
| 200 | checkout | 40 | 374 | 34,3 | 81,2 | 112,9 | 0,00 % | 0 | 0,24 | 0,36 | 1,28 | 12 % | ok |
| 200 | checkout | 80 | 682 | 188,6 | 594,2 | 688,5 | 0,00 % | 609 | 0,31 | 0,61 | 1,86 | 27 % | p95 688.5 ms > 500 ms; descartadas 609 |
| 200 | painel | 25 | 51 | 3,4 | 5,2 | 3,6 | 0,00 % | 0 | 0,05 | 0,04 | 0,16 | 2 % | ok |
| 200 | painel | 50 | 101 | 2,8 | 4,4 | 3,1 | 0,00 % | 0 | 0,09 | 0,06 | 0,17 | 3 % | ok |
| 200 | painel | 100 | 201 | 2,8 | 4,5 | 3,1 | 0,00 % | 0 | 0,18 | 0,12 | 0,23 | 6 % | ok |
| 200 | painel | 200 | 401 | 2,6 | 4,2 | 3,0 | 0,00 % | 0 | 0,34 | 0,23 | 0,27 | 10 % | ok |
| 200 | painel | 400 | 801 | 3,5 | 5,9 | 4,1 | 0,00 % | 0 | 0,69 | 0,47 | 0,44 | 18 % | ok |
| 200 | painel | 800 | 1.567 | 351,4 | 657,8 | 469,0 | 0,00 % | 341 | 1,49 | 0,96 | 0,96 | 37 % | p95 469.0 ms > 150 ms; descartadas 341 |
| 200 | entregador | 50 | 51 | 11,8 | 14,9 | 12,5 | 0,00 % | 0 | 0,00 | 0,06 | 0,13 | 2 % | ok |
| 200 | entregador | 100 | 101 | 2,1 | 4,7 | 2,1 | 0,00 % | 0 | 0,00 | 0,09 | 0,19 | 4 % | ok |
| 200 | entregador | 200 | 201 | 2,3 | 6,3 | 2,2 | 0,00 % | 0 | 0,02 | 0,17 | 0,20 | 6 % | ok |
| 200 | entregador | 400 | 401 | 15,4 | 29,1 | 15,4 | 0,00 % | 0 | 0,00 | 0,31 | 0,28 | 10 % | ok |
| 200 | entregador | 800 | 447 | 4.012,8 | 5.040,8 | 4.013,2 | 0,00 % | 7063 | 0,00 | 0,34 | 0,32 | 16 % | p95 4013.2 ms > 300 ms; descartadas 7063 |
| 2.000 | vitrine | 50 | 113 | 5,0 | 7,3 | 6,0 | 0,00 % | 0 | 0,15 | 0,00 | 0,21 | 4 % | ok |
| 2.000 | vitrine | 100 | 225 | 5,2 | 8,4 | 6,6 | 0,00 % | 0 | 0,35 | 0,00 | 0,40 | 7 % | ok |
| 2.000 | vitrine | 200 | 450 | 5,9 | 13,8 | 7,4 | 0,00 % | 0 | 0,67 | 0,00 | 0,60 | 10 % | ok |
| 2.000 | vitrine | 400 | 899 | 9,6 | 19,7 | 13,1 | 0,00 % | 0 | 1,11 | 0,00 | 1,02 | 21 % | ok |
| 2.000 | vitrine | 700 | 1.243 | 570,6 | 646,9 | 604,4 | 0,00 % | 2990 | 2,07 | 0,00 | 1,86 | 33 % | p95 604.4 ms > 50 ms; descartadas 2990 |
| 2.000 | produto | 50 | 100 | 5,5 | 8,2 | 6,4 | 0,00 % | 0 | 0,21 | 0,00 | 0,23 | 4 % | ok |
| 2.000 | produto | 100 | 200 | 5,1 | 7,6 | 6,0 | 0,00 % | 0 | 0,38 | 0,00 | 0,40 | 9 % | ok |
| 2.000 | produto | 200 | 400 | 7,0 | 22,9 | 7,8 | 0,00 % | 0 | 0,76 | 0,00 | 0,64 | 14 % | ok |
| 2.000 | produto | 400 | 800 | 10,1 | 15,8 | 11,4 | 0,00 % | 0 | 1,56 | 0,00 | 1,29 | 28 % | ok |
| 2.000 | produto | 700 | 1.085 | 414,4 | 483,4 | 417,7 | 0,00 % | 3151 | 2,28 | 0,00 | 1,91 | 47 % | p95 417.7 ms > 50 ms; descartadas 3151 |
| 2.000 | busca | 5 | 5 | 131,0 | 136,3 | 131,0 | 0,00 % | 0 | 0,01 | 0,00 | 0,21 | 1 % | p95 131.0 ms > 50 ms |
| 2.000 | carrinho | 25 | 75 | 4,5 | 6,1 | 5,1 | 0,00 % | 0 | 0,09 | 0,00 | 0,25 | 3 % | ok |
| 2.000 | carrinho | 50 | 150 | 4,2 | 5,1 | 4,8 | 0,00 % | 0 | 0,15 | 0,00 | 0,30 | 4 % | ok |
| 2.000 | carrinho | 100 | 300 | 4,4 | 6,7 | 5,2 | 0,00 % | 0 | 0,29 | 0,00 | 0,50 | 7 % | ok |
| 2.000 | carrinho | 200 | 600 | 6,0 | 12,9 | 7,4 | 0,00 % | 0 | 0,57 | 0,00 | 0,99 | 13 % | ok |
| 2.000 | carrinho | 400 | 1.200 | 80,3 | 139,4 | 105,3 | 0,00 % | 0 | 1,18 | 0,00 | 1,97 | 26 % | ok |
| 2.000 | carrinho | 700 | 1.375 | 418,8 | 814,5 | 435,3 | 0,00 % | 4836 | 1,40 | 0,00 | 2,40 | 37 % | p95 435.3 ms > 300 ms; descartadas 4836 |
| 2.000 | checkout | 5 | 46 | 20,8 | 36,9 | 40,2 | 0,00 % | 0 | 0,03 | 0,05 | 0,27 | 2 % | ok |
| 2.000 | checkout | 10 | 91 | 30,8 | 70,7 | 74,5 | 0,00 % | 0 | 0,06 | 0,09 | 0,45 | 4 % | ok |
| 2.000 | checkout | 20 | 186 | 52,5 | 98,4 | 111,3 | 0,00 % | 0 | 0,14 | 0,20 | 0,82 | 7 % | ok |
| 2.000 | checkout | 40 | 390 | 94,3 | 453,4 | 316,6 | 0,00 % | 0 | 0,29 | 0,43 | 1,54 | 14 % | ok |
| 2.000 | checkout | 80 | 694 | 159,1 | 443,0 | 495,4 | 0,00 % | 604 | 0,31 | 0,61 | 1,93 | 31 % | descartadas 604 |
| 2.000 | painel | 25 | 51 | 3,4 | 5,7 | 3,8 | 0,00 % | 0 | 0,05 | 0,04 | 0,12 | 2 % | ok |
| 2.000 | painel | 50 | 101 | 2,8 | 4,1 | 3,2 | 0,00 % | 0 | 0,09 | 0,06 | 0,19 | 4 % | ok |
| 2.000 | painel | 100 | 201 | 2,8 | 4,6 | 3,1 | 0,00 % | 0 | 0,18 | 0,12 | 0,29 | 7 % | ok |
| 2.000 | painel | 200 | 401 | 2,7 | 4,2 | 3,1 | 0,00 % | 0 | 0,34 | 0,23 | 0,26 | 10 % | ok |
| 2.000 | painel | 400 | 801 | 3,4 | 6,0 | 4,0 | 0,00 % | 0 | 0,70 | 0,47 | 0,45 | 20 % | ok |
| 2.000 | painel | 800 | 1.600 | 269,1 | 435,1 | 343,8 | 0,00 % | 13 | 1,53 | 0,99 | 1,02 | 40 % | p95 343.8 ms > 150 ms |
| 2.000 | entregador | 50 | 51 | 3,2 | 16,5 | 3,1 | 0,00 % | 0 | 0,00 | 0,06 | 0,13 | 3 % | ok |
| 2.000 | entregador | 100 | 101 | 5,4 | 16,1 | 5,5 | 0,00 % | 0 | 0,00 | 0,09 | 0,24 | 5 % | ok |
| 2.000 | entregador | 200 | 201 | 2,2 | 4,5 | 2,2 | 0,00 % | 0 | 0,00 | 0,16 | 0,20 | 6 % | ok |
| 2.000 | entregador | 400 | 401 | 2,1 | 5,1 | 2,1 | 0,00 % | 0 | 0,00 | 0,31 | 0,29 | 12 % | ok |
| 2.000 | entregador | 800 | 801 | 33,1 | 132,0 | 33,1 | 0,00 % | 0 | 0,02 | 0,60 | 0,61 | 24 % | ok |
| 2.000 | entregador | 1500 | 1.501 | 262,0 | 345,7 | 262,1 | 0,00 % | 0 | 0,00 | 1,12 | 0,89 | 46 % | ok |
| 2.000 | entregador | 2500 | 2.192 | 1.114,7 | 1.467,4 | 1.114,8 | 0,00 % | 6179 | 0,00 | 1,56 | 1,47 | 87 % | gerador_saturado; p95 1114.8 ms > 300 ms; descartadas 6179 |
| 20.000 | vitrine | 50 | 112 | 23,9 | 29,1 | 31,2 | 0,00 % | 0 | 0,17 | 0,00 | 0,55 | 4 % | ok |
| 20.000 | vitrine | 100 | 225 | 24,4 | 34,3 | 38,6 | 0,00 % | 0 | 0,33 | 0,00 | 0,83 | 13 % | ok |
| 20.000 | vitrine | 200 | 451 | 35,6 | 127,9 | 50,2 | 0,00 % | 0 | 0,66 | 0,00 | 1,74 | 19 % | p95 50.2 ms > 50 ms |
| 20.000 | produto | 50 | 100 | 4,9 | 6,7 | 5,4 | 0,00 % | 0 | 0,19 | 0,00 | 0,32 | 7 % | ok |
| 20.000 | produto | 100 | 200 | 5,4 | 7,7 | 6,2 | 0,00 % | 0 | 0,34 | 0,00 | 0,33 | 15 % | ok |
| 20.000 | produto | 200 | 400 | 5,8 | 8,6 | 6,8 | 0,00 % | 0 | 0,70 | 0,00 | 0,72 | 22 % | ok |
| 20.000 | produto | 400 | 800 | 62,9 | 98,1 | 66,6 | 0,00 % | 0 | 1,47 | 0,00 | 1,25 | 52 % | p95 66.6 ms > 50 ms |
| 20.000 | busca | 5 | 5 | 207,7 | 1.204,4 | 207,7 | 0,00 % | 0 | 0,01 | 0,00 | 0,76 | 1 % | p95 207.7 ms > 50 ms |
| 20.000 | carrinho | 25 | 75 | 4,3 | 6,0 | 4,8 | 0,00 % | 0 | 0,08 | 0,00 | 0,29 | 4 % | ok |
| 20.000 | carrinho | 50 | 150 | 4,7 | 15,1 | 6,3 | 0,00 % | 0 | 0,15 | 0,00 | 0,30 | 8 % | ok |
| 20.000 | carrinho | 100 | 300 | 4,7 | 8,5 | 5,4 | 0,00 % | 0 | 0,28 | 0,00 | 0,58 | 15 % | ok |
| 20.000 | carrinho | 200 | 600 | 6,2 | 14,4 | 7,9 | 0,00 % | 0 | 0,56 | 0,00 | 0,92 | 21 % | ok |
| 20.000 | carrinho | 400 | 1.199 | 86,4 | 215,6 | 147,8 | 0,00 % | 9 | 1,09 | 0,00 | 1,85 | 67 % | ok |
| 20.000 | carrinho | 700 | 1.517 | 354,8 | 495,6 | 403,0 | 0,00 % | 3889 | 1,20 | 0,00 | 2,19 | 100 % | gerador_saturado; p95 403.0 ms > 300 ms; descartadas 3889 |
| 20.000 | checkout | 5 | 47 | 15,6 | 20,2 | 20,7 | 0,00 % | 0 | 0,03 | 0,05 | 0,31 | 3 % | ok |
| 20.000 | checkout | 10 | 92 | 17,6 | 29,3 | 31,7 | 0,00 % | 0 | 0,06 | 0,09 | 0,51 | 6 % | ok |
| 20.000 | checkout | 20 | 181 | 17,6 | 32,6 | 33,1 | 0,00 % | 0 | 0,12 | 0,19 | 0,78 | 12 % | ok |
| 20.000 | checkout | 40 | 371 | 35,6 | 68,2 | 81,5 | 0,00 % | 0 | 0,26 | 0,39 | 1,54 | 10 % | ok |
| 20.000 | checkout | 80 | 683 | 259,4 | 770,8 | 899,6 | 0,00 % | 594 | 0,29 | 0,52 | 1,66 | 100 % | gerador_saturado; p95 899.6 ms > 500 ms; descartadas 594 |
| 20.000 | painel | 25 | 51 | 3,1 | 4,3 | 3,4 | 0,00 % | 0 | 0,05 | 0,04 | 0,29 | 4 % | ok |
| 20.000 | painel | 50 | 101 | 2,9 | 4,9 | 3,1 | 0,00 % | 0 | 0,09 | 0,06 | 0,14 | 8 % | ok |
| 20.000 | painel | 100 | 201 | 2,6 | 3,9 | 2,9 | 0,00 % | 0 | 0,16 | 0,11 | 0,17 | 5 % | ok |
| 20.000 | painel | 200 | 401 | 2,7 | 4,4 | 3,0 | 0,00 % | 0 | 0,33 | 0,22 | 0,43 | 18 % | ok |
| 20.000 | painel | 400 | 801 | 5,1 | 13,5 | 6,7 | 0,00 % | 0 | 0,62 | 0,42 | 0,40 | 48 % | ok |
| 20.000 | painel | 800 | 1.601 | 74,1 | 125,9 | 87,9 | 0,00 % | 0 | 1,17 | 0,76 | 0,92 | 100 % | gerador_saturado |
| 20.000 | entregador | 50 | 51 | 2,9 | 12,4 | 2,9 | 0,00 % | 0 | 0,00 | 0,05 | 0,13 | 2 % | ok |
| 20.000 | entregador | 100 | 101 | 2,8 | 12,4 | 2,8 | 0,00 % | 0 | 0,00 | 0,09 | 0,27 | 7 % | ok |
| 20.000 | entregador | 200 | 201 | 7,0 | 55,0 | 7,1 | 0,00 % | 0 | 0,00 | 0,15 | 0,20 | 5 % | ok |
| 20.000 | entregador | 400 | 401 | 2,2 | 3,6 | 2,2 | 0,00 % | 0 | 0,00 | 0,27 | 0,28 | 46 % | ok |
| 20.000 | entregador | 800 | 801 | 7,6 | 16,4 | 7,6 | 0,00 % | 0 | 0,02 | 0,49 | 0,58 | 100 % | gerador_saturado |
| 120.000 | vitrine | 50 | 112 | 90,1 | 151,6 | 169,5 | 0,00 % | 0 | 0,20 | 0,00 | 2,12 | 3 % | p95 169.5 ms > 50 ms |
| 120.000 | produto | 50 | 100 | 6,2 | 9,2 | 7,7 | 0,00 % | 0 | 0,18 | 0,00 | 0,23 | 3 % | ok |
| 120.000 | produto | 100 | 200 | 6,7 | 11,4 | 8,1 | 0,00 % | 0 | 0,38 | 0,00 | 0,38 | 7 % | ok |
| 120.000 | produto | 200 | 400 | 7,3 | 10,7 | 8,5 | 0,00 % | 0 | 0,72 | 0,00 | 0,83 | 14 % | ok |
| 120.000 | produto | 400 | 800 | 17,1 | 67,8 | 20,6 | 0,00 % | 0 | 1,58 | 0,00 | 1,37 | 27 % | ok |
| 120.000 | produto | 700 | 969 | 468,3 | 552,7 | 468,3 | 0,00 % | 4307 | 2,05 | 0,00 | 2,05 | 38 % | p95 468.3 ms > 50 ms; descartadas 4307 |
| 120.000 | busca | 5 | 5 | 5.873,7 | 18.254,8 | 5.873,7 | 0,00 % | 5 | 0,02 | 0,00 | 4,42 | 1 % | p95 5873.7 ms > 50 ms; descartadas 5 |
| 120.000 | carrinho | 25 | 75 | 14,5 | 18,1 | 16,4 | 0,00 % | 0 | 0,08 | 0,00 | 0,36 | 2 % | ok |
| 120.000 | carrinho | 50 | 150 | 4,5 | 16,3 | 5,9 | 0,00 % | 0 | 0,15 | 0,00 | 0,29 | 3 % | ok |
| 120.000 | carrinho | 100 | 300 | 4,1 | 5,1 | 4,6 | 0,00 % | 0 | 0,28 | 0,00 | 0,49 | 6 % | ok |
| 120.000 | carrinho | 200 | 600 | 10,0 | 27,5 | 15,6 | 0,00 % | 0 | 0,59 | 0,00 | 1,17 | 12 % | ok |
| 120.000 | carrinho | 400 | 1.200 | 22,0 | 71,9 | 28,8 | 0,00 % | 0 | 1,19 | 0,00 | 1,96 | 23 % | ok |
| 120.000 | carrinho | 700 | 1.299 | 435,3 | 481,2 | 455,1 | 0,00 % | 5341 | 1,25 | 0,00 | 2,27 | 27 % | p95 455.1 ms > 300 ms; descartadas 5341 |
| 120.000 | checkout | 5 | 47 | 14,9 | 17,3 | 18,5 | 0,00 % | 0 | 0,03 | 0,04 | 0,27 | 1 % | ok |
| 120.000 | checkout | 10 | 92 | 14,9 | 20,5 | 22,9 | 0,00 % | 0 | 0,06 | 0,09 | 0,45 | 3 % | ok |
| 120.000 | checkout | 20 | 184 | 47,9 | 93,2 | 101,8 | 0,00 % | 0 | 0,13 | 0,20 | 0,90 | 6 % | ok |
| 120.000 | checkout | 40 | 393 | 48,0 | 128,0 | 158,1 | 0,00 % | 0 | 0,23 | 0,36 | 1,35 | 11 % | ok |
| 120.000 | checkout | 80 | 667 | 307,8 | 1.020,9 | 1.096,7 | 0,00 % | 691 | 0,26 | 0,49 | 1,64 | 21 % | p95 1096.7 ms > 500 ms; descartadas 691 |
| 120.000 | painel | 25 | 51 | 3,3 | 5,2 | 3,8 | 0,00 % | 0 | 0,05 | 0,04 | 0,18 | 2 % | ok |
| 120.000 | painel | 50 | 101 | 2,9 | 4,3 | 3,2 | 0,00 % | 0 | 0,09 | 0,06 | 0,37 | 3 % | ok |
| 120.000 | painel | 100 | 201 | 2,7 | 3,8 | 3,0 | 0,00 % | 0 | 0,17 | 0,12 | 0,19 | 5 % | ok |
| 120.000 | painel | 200 | 401 | 2,6 | 4,4 | 2,9 | 0,00 % | 0 | 0,32 | 0,22 | 0,27 | 9 % | ok |
| 120.000 | painel | 400 | 801 | 7,0 | 29,8 | 10,0 | 0,00 % | 0 | 0,73 | 0,49 | 0,74 | 19 % | ok |
| 120.000 | painel | 800 | 1.601 | 19,0 | 51,5 | 29,7 | 0,00 % | 0 | 1,44 | 0,94 | 0,89 | 35 % | ok |
| 120.000 | painel | 1200 | 1.832 | 774,6 | 998,8 | 879,4 | 0,00 % | 5694 | 1,72 | 1,11 | 1,31 | 44 % | p95 879.4 ms > 150 ms; descartadas 5694 |
| 120.000 | entregador | 50 | 51 | 3,0 | 4,8 | 2,9 | 0,00 % | 0 | 0,00 | 0,06 | 0,21 | 2 % | ok |
| 120.000 | entregador | 100 | 101 | 2,2 | 3,2 | 2,2 | 0,00 % | 0 | 0,00 | 0,09 | 0,16 | 3 % | ok |
| 120.000 | entregador | 200 | 201 | 2,5 | 5,4 | 2,5 | 0,00 % | 0 | 0,00 | 0,17 | 0,47 | 6 % | ok |
| 120.000 | entregador | 400 | 401 | 2,2 | 4,6 | 2,2 | 0,00 % | 0 | 0,00 | 0,29 | 0,29 | 9 % | ok |
| 120.000 | entregador | 800 | 801 | 15,7 | 84,8 | 15,7 | 0,00 % | 0 | 0,00 | 0,60 | 0,72 | 17 % | ok |
| 120.000 | entregador | 1500 | 1.398 | 758,8 | 793,3 | 758,8 | 0,00 % | 2053 | 0,03 | 1,05 | 1,02 | 30 % | p95 758.8 ms > 300 ms; descartadas 2053 |

### Memória ociosa e conexões por serviço (antes da carga)

| lojas | serviço | memória ociosa MB | conexões ociosas |
|---|---|---|---|
| 200 | dev-idp | 46,0 | 0 |
| 200 | worker | 16,7 | 10 |
| 200 | control-plane-api | 28,2 | 2 |
| 200 | transaction-api | 33,0 | 2 |
| 200 | commerce-api | 69,4 | 10 |
| 200 | otel-collector | 30,4 | 0 |
| 200 | postgres | 455,5 | 0 |
| 200 | nats | 170,1 | 0 |
| 200 | valkey | 4,6 | 0 |
| 200 | mailpit | 27,3 | 0 |
| 2.000 | dev-idp | 46,7 | 0 |
| 2.000 | worker | 18,2 | 10 |
| 2.000 | control-plane-api | 29,8 | 2 |
| 2.000 | transaction-api | 85,7 | 10 |
| 2.000 | commerce-api | 67,6 | 10 |
| 2.000 | otel-collector | 35,1 | 0 |
| 2.000 | postgres | 1.184,2 | 0 |
| 2.000 | nats | 256,5 | 0 |
| 2.000 | valkey | 4,3 | 0 |
| 2.000 | mailpit | 25,9 | 0 |
| 20.000 | dev-idp | 46,2 | 0 |
| 20.000 | worker | 18,3 | 10 |
| 20.000 | control-plane-api | 29,6 | 2 |
| 20.000 | transaction-api | 55,1 | 10 |
| 20.000 | commerce-api | 62,6 | 10 |
| 20.000 | otel-collector | 30,9 | 0 |
| 20.000 | postgres | 3.522,4 | 0 |
| 20.000 | nats | 204,6 | 0 |
| 20.000 | valkey | 4,3 | 0 |
| 20.000 | mailpit | 25,9 | 0 |
| 120.000 | dev-idp | 45,4 | 0 |
| 120.000 | worker | 18,2 | 10 |
| 120.000 | control-plane-api | 28,5 | 2 |
| 120.000 | transaction-api | 62,8 | 2 |
| 120.000 | commerce-api | 63,9 | 10 |
| 120.000 | otel-collector | 35,3 | 0 |
| 120.000 | postgres | 6.240,3 | 0 |
| 120.000 | nats | 266,5 | 0 |
| 120.000 | valkey | 4,2 | 0 |
| 120.000 | mailpit | 25,7 | 0 |

### Base semeada

| lojas de carga | lojas na base | produtos | listagens | banco | semeadura desta etapa | lojas/s |
|---|---|---|---|---|---|---|
| 200 | 229 | 4.799 | 4.799 | 112 MB | 3 s | 66 |
| 2.000 | 2.029 | 39.359 | 39.359 | 371 MB | 38 s | 48 |
| 20.000 | 20.029 | 384.959 | 384.959 | 2.456 MB | 374 s | 48 |
| 120.000 | 120.029 | 2.304.959 | 2.304.959 | 13.780 MB | 2.160 s | 46 |

Entre 200 e 120000 lojas: **116,8 KB por loja** e **6,09 KB por produto** (tudo incluído: tabela, índice, TOAST).

| tabela | bytes por loja |
|---|---|
| audit.events | 77 |
| carts.cart_items | 81 |
| carts.carts | 233 |
| catalog.categories | 267 |
| catalog.product_categories | 5.603 |
| catalog.products | 10.058 |
| catalog.variants | 24.187 |
| checkout.session_steps | 76 |
| controlplane.module_installations | 1.159 |
| controlplane.placements | 128 |
| inventory.movements | 15.515 |
| inventory.stock_positions | 19.600 |
| inventory.warehouses | 269 |
| listings.ix_listings__feed | 1.384 |
| listings.ix_listings__search | 447 |
| listings.ix_listings__store_feed | 1.383 |
| listings.listings | 7.873 |
| listings.pk_listings | 1.125 |
| organizations.accounts | 198 |
| organizations.organizations | 185 |
| payments.operations | 66 |
| pricing.price_entries | 31.630 |
| pricing.price_lists | 537 |
| stores.stores | 317 |

## Bytes por loja, produto e pedido — extrapolação para 1.000 produtos/loja

Medido entre 200 e 120 mil lojas de carga (19,2 produtos/loja): **116,8 KB por loja** e **6,09 KB por produto** (dado + índices + TOAST, sem histórico de auditoria nem mídia). Para a meta de 1.000 produtos/loja do capacity model: ≈ 1.000 × 6,09 KB ≈ **6,1 MB de banco por loja**, ou **≈ 730 GB para 120 mil lojas** só de catálogo/preço/estoque/listagem (sem pedidos, sem auditoria, sem réplica). Por pedido: 27–35 KB de crescimento e 59–83 KB de WAL (o valor usado pela calculadora é a média de todos os degraus de checkout).

Semeadura (clonagem SQL de lojas-molde, `datasets/carga/seed.ts`): 200 lojas em 3 s, 2 mil em 38 s, 20 mil em 374 s, 120 mil em 2.160 s (≈ 46–66 lojas/s).

## Conexões e memória base

Cada instância abre um pool de **10 conexões** (commerce, transaction, worker) — control-plane usou 2. Memória ociosa: commerce 64 MB, transaction 63 MB, control-plane 29 MB, worker 18 MB, NATS 267 MB, Valkey 4 MB; o Postgres aparece com 6,2 GB porque o cgroup conta o page cache do banco de 13,8 GB.

## Calculadora de servidores

`capacity-model/calculadora.ts` lê `reports/data/2026-11-25/`, interpola o custo por requisição em log(lojas) entre os degraus medidos e calcula app, worker, banco (vCPU, RAM, disco, IOPS, conexões), cache e células, com utilização-alvo de 60 %. Custo mensal é opcional (`--custo`), só AWS sa-east-1, lendo os preços de `sellvex-marketplace-budget/fontes.md` (o budget não foi editado). `--sysbench-alvo <eventos/s 1 thread>` converte o CPU-ms para o servidor alvo pela razão com 326,5. `--enxuto`: mínimo 1 nó de app, balanceador ×2, worker mínimo 1, tamanhos 2/4/8/16 vCPU com 4 GB/vCPU, banco pela mesma escada até 16/64; `--fracao-quente` (enxuto 0,25) é premissa, não medida.

Premissas (não medidas; trocáveis por flag): 1 visita = 1 vitrine + 2 páginas de produto + 0,3 busca; 40 req de painel por loja/dia; 20 entregas por entregador/dia e posição a cada 10 s; pedidos retidos 365 dias; pico = média diária × fator.

```sh
bun capacity-model/calculadora.ts --lojas 120000 --pedidos-loja-dia 0.33 --visitas-loja-dia 30 --pico 10 --produtos-loja 1000 --enxuto --custo
bun capacity-model/calculadora.ts --lojas 20000 --pedidos-loja-dia 0.33 --visitas-loja-dia 30 --pico 3 --sysbench-alvo 450 --json
```

### Modo `--enxuto` — 0,33 pedido/loja/dia, 30 visitas/loja/dia, pico ×3 (normal) e ×10 (Black Friday), com a busca **como está hoje**

| modo | lojas | produtos/loja | pico | RPS pico | pedidos/s | app | worker | células | vCPU banco | RAM por primário | disco banco | IOPS | US$/mês AWS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
|--enxuto|200|100|×3|2|0|2 × 2 vCPU/8 GB|1|1|0|4 GB|2 GB|1|573|
|--enxuto|2000|100|×3|18|0.02|2 × 2 vCPU/8 GB|1|1|0.1|4 GB|17 GB|2|578|
|--enxuto|20000|100|×3|177|0.23|2 × 2 vCPU/8 GB|1|1|2.4|12 GB|170 GB|20|947|
|--enxuto|40000|100|×3|354|0.46|2 × 2 vCPU/8 GB|1|2|16.1|12 GB|340 GB|42|5516|
|--enxuto|120000|100|×3|1063|1.38|2 × 4 vCPU/16 GB|1|7|102.4|10 GB|1019 GB|145|18807|
|--enxuto|200|100|×10|6|0.01|2 × 2 vCPU/8 GB|1|1|0|4 GB|2 GB|1|573|
|--enxuto|2000|100|×10|59|0.08|2 × 2 vCPU/8 GB|1|1|0.3|4 GB|17 GB|7|578|
|--enxuto|20000|100|×10|590|0.76|2 × 2 vCPU/8 GB|1|1|8|12 GB|170 GB|64|1592|
|--enxuto|40000|100|×10|1180|1.53|2 × 4 vCPU/16 GB|1|4|53.8|6 GB|340 GB|140|10857|
|--enxuto|120000|100|×10|3542|4.58|2 × 16 vCPU/64 GB|1|22|341.2|4 GB|1019 GB|482|58599|
|--enxuto|200|1000|×3|2|0|2 × 2 vCPU/8 GB|1|1|0|4 GB|5 GB|1|574|
|--enxuto|2000|1000|×3|18|0.02|2 × 2 vCPU/8 GB|1|1|0.1|5 GB|44 GB|2|586|
|--enxuto|20000|1000|×3|177|0.23|2 × 2 vCPU/8 GB|1|1|2.4|46 GB|431 GB|20|1349|
|--enxuto|40000|1000|×3|354|0.46|2 × 2 vCPU/8 GB|1|2|16.1|46 GB|862 GB|42|5675|
|--enxuto|120000|1000|×3|1063|1.38|2 × 4 vCPU/16 GB|1|7|102.4|39 GB|2586 GB|145|19284|
|--enxuto|200|1000|×10|6|0.01|2 × 2 vCPU/8 GB|1|1|0|4 GB|5 GB|1|574|
|--enxuto|2000|1000|×10|59|0.08|2 × 2 vCPU/8 GB|1|1|0.3|5 GB|44 GB|7|586|
|--enxuto|20000|1000|×10|590|0.76|2 × 2 vCPU/8 GB|1|1|8|46 GB|431 GB|64|1672|
|--enxuto|40000|1000|×10|1180|1.53|2 × 4 vCPU/16 GB|1|4|53.8|23 GB|862 GB|140|11016|
|--enxuto|120000|1000|×10|3542|4.58|2 × 16 vCPU/64 GB|1|22|341.2|13 GB|2586 GB|482|59075|

A partir de 40 mil lojas o banco é dominado pela busca atual (item 1 dos achados): 0,3 busca por visita × 1,4 s de CPU de banco cada. Esses números de banco **não devem ir para orçamento** — mostram o custo de não corrigir a busca.

### Modo `--enxuto` com a busca fora do Postgres (`--busca-visita 0`)

Mesmas premissas, sem tráfego de busca no banco (o custo da busca externa — perfil "busca" de DEC-INFRA-001 — **não está medido nem incluído**).

| lojas | produtos/loja | pico | RPS pico | pedidos/s | app | worker | células | vCPU banco | RAM por primário | disco banco | IOPS | US$/mês AWS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
|200|100|×3|2|0|2 × 2 vCPU/8 GB|1|1|0|4 GB|2 GB|1|573|
|2000|100|×3|17|0.02|2 × 2 vCPU/8 GB|1|1|0|4 GB|17 GB|2|578|
|20000|100|×3|171|0.23|2 × 2 vCPU/8 GB|1|1|0.7|12 GB|170 GB|19|624|
|40000|100|×3|342|0.46|2 × 2 vCPU/8 GB|1|1|2.4|23 GB|340 GB|41|999|
|120000|100|×3|1025|1.38|2 × 4 vCPU/16 GB|1|2|12.1|34 GB|1019 GB|135|5901|
|200|100|×10|6|0.01|2 × 2 vCPU/8 GB|1|1|0|4 GB|2 GB|1|573|
|2000|100|×10|57|0.08|2 × 2 vCPU/8 GB|1|1|0.1|4 GB|17 GB|7|578|
|20000|100|×10|569|0.76|2 × 2 vCPU/8 GB|1|1|2.3|12 GB|170 GB|64|947|
|40000|100|×10|1138|1.53|2 × 4 vCPU/16 GB|1|1|8|23 GB|340 GB|135|3113|
|120000|100|×10|3417|4.58|2 × 16 vCPU/64 GB|1|3|40.3|23 GB|1019 GB|448|9554|
|200|1000|×3|2|0|2 × 2 vCPU/8 GB|1|1|0|4 GB|5 GB|1|574|
|2000|1000|×3|17|0.02|2 × 2 vCPU/8 GB|1|1|0|5 GB|44 GB|2|586|
|20000|1000|×3|171|0.23|2 × 2 vCPU/8 GB|1|1|0.7|46 GB|431 GB|19|1349|
|40000|1000|×3|342|0.46|2 × 2 vCPU/8 GB|1|2|2.4|46 GB|862 GB|41|4384|
|120000|1000|×3|1025|1.38|2 × 4 vCPU/16 GB|1|5|12.1|55 GB|2586 GB|135|14121|
|200|1000|×10|6|0.01|2 × 2 vCPU/8 GB|1|1|0|4 GB|5 GB|1|574|
|2000|1000|×10|57|0.08|2 × 2 vCPU/8 GB|1|1|0.1|5 GB|44 GB|7|586|
|20000|1000|×10|569|0.76|2 × 2 vCPU/8 GB|1|1|2.3|46 GB|431 GB|64|1349|
|40000|1000|×10|1138|1.53|2 × 4 vCPU/16 GB|1|2|8|46 GB|862 GB|135|5853|
|120000|1000|×10|3417|4.58|2 × 16 vCPU/64 GB|1|5|40.3|55 GB|2586 GB|448|15193|

### Modo padrão (perfil de referência de DEC-INFRA-001: mínimo 3 nós de 8 vCPU/16 GB, banco 16/64)

| modo | lojas | produtos/loja | pico | RPS pico | pedidos/s | app | worker | células | vCPU banco | RAM por primário | disco banco | IOPS | US$/mês AWS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
|padrão|200|100|×3|2|0|3 × 8 vCPU/16 GB|2|1|0|16 GB|2 GB|1|3844|
|padrão|2000|100|×3|18|0.02|3 × 8 vCPU/16 GB|2|1|0.1|16 GB|17 GB|2|3849|
|padrão|20000|100|×3|177|0.23|3 × 8 vCPU/16 GB|2|1|2.4|23 GB|170 GB|20|3896|
|padrão|40000|100|×3|354|0.46|3 × 8 vCPU/16 GB|2|2|16.1|23 GB|340 GB|42|6528|
|padrão|120000|100|×3|1063|1.38|3 × 8 vCPU/16 GB|2|7|102.4|20 GB|1019 GB|145|19641|
|padrão|200|100|×10|6|0.01|3 × 8 vCPU/16 GB|2|1|0|16 GB|2 GB|1|3844|
|padrão|2000|100|×10|59|0.08|3 × 8 vCPU/16 GB|2|1|0.3|16 GB|17 GB|7|3849|
|padrão|20000|100|×10|590|0.76|3 × 8 vCPU/16 GB|2|1|8|23 GB|170 GB|64|3896|
|padrão|40000|100|×10|1180|1.53|3 × 8 vCPU/16 GB|2|4|53.8|12 GB|340 GB|140|11691|
|padrão|120000|100|×10|3542|4.58|3 × 8 vCPU/16 GB|2|22|341.2|7 GB|1019 GB|482|58360|
|padrão|200|1000|×3|2|0|3 × 8 vCPU/16 GB|2|1|0|16 GB|5 GB|1|3845|
|padrão|2000|1000|×3|18|0.02|3 × 8 vCPU/16 GB|2|1|0.1|16 GB|44 GB|2|3857|
|padrão|20000|1000|×3|177|0.23|3 × 8 vCPU/16 GB|2|3|2.4|53 GB|431 GB|20|9137|
|padrão|40000|1000|×3|354|0.46|3 × 8 vCPU/16 GB|2|5|16.1|64 GB|862 GB|42|14431|
|padrão|120000|1000|×3|1063|1.38|3 × 8 vCPU/16 GB|2|15|102.4|64 GB|2586 GB|145|40768|
|padrão|200|1000|×10|6|0.01|3 × 8 vCPU/16 GB|2|1|0|16 GB|5 GB|1|3845|
|padrão|2000|1000|×10|59|0.08|3 × 8 vCPU/16 GB|2|1|0.3|16 GB|44 GB|7|3857|
|padrão|20000|1000|×10|590|0.76|3 × 8 vCPU/16 GB|2|3|8|53 GB|431 GB|64|9137|
|padrão|40000|1000|×10|1180|1.53|3 × 8 vCPU/16 GB|2|5|53.8|64 GB|862 GB|140|14431|
|padrão|120000|1000|×10|3542|4.58|3 × 8 vCPU/16 GB|2|22|341.2|44 GB|2586 GB|482|58837|

O custo AWS escala linearmente o preço de m7g.large/db.m7g.large Multi-AZ, Valkey t4g.small e EBS gp3 de `fontes.md` (22/11/2026) e **não inclui** tráfego de saída, ALB, NAT, mídia, busca externa, observabilidade nem backup.

## Limitações

- **Notebook ≠ hardware alvo**: CPU de notebook limitada a 2,5 GHz, disco de consumo a ~90 % de ocupação, k6 e stack dividindo a mesma máquina (separados por núcleo, não por host), contêineres alheios à Sellvex rodando ao mesmo tempo. Os pontos de quebra são desta máquina; o que se transporta é o custo unitário, convertido pelo sysbench.
- **Produtos reduzidos**: 19,2 produtos/loja em vez de 1.000. Operações que varrem o catálogo da loja ou do marketplace (busca, listagens) vão custar mais com 1.000; a extrapolação de bytes é linear e não captura isso.
- **Lojas clonadas**: títulos se repetem entre lojas (5 moldes), o que favorece o cache e torna a busca mais "cheia" que um catálogo real.
- **Mix de tráfego, fator de pico, visitas e pedidos por loja são premissas**, não medição de produção.
- **Sem teste de falha, réplica, TLS, borda ou rede real**; sem cache de borda (DEC-PERF-002), que tiraria do banco boa parte da vitrine.
- **Checkout sem frete e sem remessa** (para não oferecer corridas a entregadores reais); o tempo do pedido inclui a espera de 1 s entre consultas do checkout. Entregadores de carga ficaram pendentes (sem ofertas).
- **GC não medido**; memória do Postgres inclui page cache.
- 2.000 e 20.000 lojas medidos com o gerador antes da correção (ver acima): pontos de quebra marcados são limites inferiores.
- Postgres com configuração padrão (shared_buffers 128 MB) — o banco viveu do page cache do SO.

## Como reproduzir

```sh
cd sellvex-marketplace-quality
bun datasets/carga/seed.ts 2000          # converge para o total (200, 2000, 20000, 120000)
bun k6/preparar.ts                       # lojistas e entregadores de carga no dev-idp, módulos e estoque
bun k6/medir.ts 2000                     # todos os cenários; ou: bun k6/medir.ts 2000 busca checkout
bun k6/tabelas.ts                        # tabelas deste relatório
bun k6/preparar.ts --restaurar           # devolve o dev-idp ao override do e2e
bun datasets/carga/seed.ts --remove      # apaga tudo o que a carga criou (registro carga.lojas)
bash k6/ficha-maquina.sh saida.txt /dir/no/disco/alvo   # no servidor alvo: ficha + sysbench + fio
```

`pg_stat_statements` foi ligado no Postgres local (`ALTER SYSTEM` + `docker restart` do contêiner, sem recriar).
