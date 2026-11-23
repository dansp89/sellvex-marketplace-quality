# sellvex-marketplace-quality

Cenários k6, soak, spike, chaos, fault injection, datasets sintéticos, capacity models e relatórios (`01-ARQUITETURA §Repositórios`; `08-INFRAESTRUTURA §Carga`). Acesso controlado.

Regra que governa tudo aqui (`08 §Gate de capacidade`): **"Não declare suporte a 120 mil lojas ou milhões de requisições apenas por arquitetura."** Um resultado só vale com o registro completo de `08 §Registro de cada teste` (commit, digest da imagem, hardware, kernel, dataset, padrão de chegada, RPS, p50/p95/p99, erro, CPU, memória, GC, saturação do banco, cache, lag de fila, custo) e é reprovado se a ferramenta geradora saturar antes do sistema.

| Pasta | Conteúdo |
|---|---|
| `capacity-model/` | O modelo com as variáveis de `08 §Capacity model`, sem valor até haver medição |
| `datasets/` | Geradores de dado sintético representativo; nunca dado real |
| `k6/`, `soak/`, `spike/` | Cenários de `08 §Cenários de carga`, um por corte vertical |
| `chaos/` | Injeção de falha: banco, broker, cache, réplica, célula (`04 §Caos`) |
| `reports/` | Relatórios assinados e versionados, um por execução |
| `e2e/` | Ponta a ponta entre as apps (Playwright): comprador na loja web e no app, lojista no painel |

Nenhum cenário ou resultado é fabricado, em nenhuma dessas pastas: cada item entra com o registro exigido por `08 §Registro de cada teste`. As pastas estão vazias porque ainda não houve medição — um `.gitkeep` as mantém versionadas.

Os orçamentos de latência (`DEC-PERF-001`) e o perfil de tráfego (`DEC-PERF-003`) ficam `proposed` até o primeiro baseline reproduzível sair daqui.
