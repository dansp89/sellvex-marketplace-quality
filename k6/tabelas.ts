/* Tabelas em Markdown a partir de reports/data/<dia>/ — o relatório cita
 * estas tabelas, geradas, nunca digitadas.
 *
 *   bun k6/tabelas.ts [reports/data/2026-11-25] */
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const DIR = resolve(process.argv[2] ?? join(import.meta.dir, "../reports/data/2026-11-25"))
const arq = readdirSync(DIR).filter((f) => /^\d+-[a-z]+\.json$/.test(f))
const M = arq.map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")))
const rot = [...new Set(M.map((m) => Number(m.rotulo)))].sort((a, b) => a - b)
const CEN = ["vitrine", "produto", "busca", "carrinho", "checkout", "painel", "entregador"]
const f = (n: number | null | undefined, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("pt-BR", { maximumFractionDigits: d, minimumFractionDigits: d }))
const ref = (m: any) => m.degraus.filter((d: any) => d.dentro_do_orcamento).at(-1) ?? m.degraus[0]
const get = (r: number, c: string) => M.find((m) => Number(m.rotulo) === r && m.cenario === c)

console.log("### Ponto de quebra por cenário (RPS máximo com p95 no orçamento)\n")
console.log(`| cenário | orçamento p95 | ${rot.map((r) => `${r.toLocaleString("pt-BR")} lojas`).join(" | ")} |`)
console.log(`|---|---|${rot.map(() => "---").join("|")}|`)
for (const c of CEN) {
  const ms = rot.map((r) => get(r, c))
  if (!ms.some(Boolean)) continue
  console.log(`| ${c} | ${ms.find(Boolean).orcamento_p95_ms} ms | ${ms.map((m) => m ? `${f(m.rps_max_no_orcamento, 0)}${m.gerador_saturou_antes ? " (gerador saturou)" : ""}${m.quebra ? "" : " (não quebrou)"}` : "—").join(" | ")} |`)
}

console.log("\n### Custo unitário no degrau de referência (maior degrau dentro do orçamento)\n")
console.log("| lojas | cenário | RPS | p50 | p95 | p99 | erro | CPU-ms/req app | CPU-ms/req banco | CPU-ms/req worker+nats | consultas/req | banco ms/req | WAL B/req | KB resp/req | k6 pico |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for (const r of rot) for (const c of CEN) {
  const m = get(r, c); if (!m) continue
  const d = ref(m), cpu = d.cpu_ms_por_req
  console.log(`| ${r.toLocaleString("pt-BR")} | ${c} | ${f(d.rps, 0)} | ${f(d.p50_ms)} | ${f(d.p95_ms)} | ${f(d.p99_ms)} | ${f(d.erro * 100, 2)} % | ${f((cpu["commerce-api"] ?? 0) + (cpu["transaction-api"] ?? 0) + (cpu["control-plane-api"] ?? 0), 2)} | ${f(cpu.postgres, 2)} | ${f((cpu.worker ?? 0) + (cpu.nats ?? 0), 2)} | ${f(d.banco.consultas_por_req)} | ${f(d.banco.tempo_banco_ms_por_req, 2)} | ${f(d.banco.wal_bytes_por_req ?? 0, 0)} | ${f(d.bytes_recebidos_por_req / 1024)} | ${f(d.k6.cpu_pico_fracao * 100, 0)} % |`)
}

console.log("\n### Por endpoint (degrau de referência)\n")
console.log("| lojas | cenário | endpoint | req | p50 | p95 | p99 | erro |")
console.log("|---|---|---|---|---|---|---|---|")
for (const r of rot) for (const c of CEN) {
  const m = get(r, c); if (!m) continue
  for (const [n, e] of Object.entries(ref(m).endpoints) as [string, any][])
    console.log(`| ${r.toLocaleString("pt-BR")} | ${c} | \`${n}\` | ${e.requisicoes} | ${f(e.p50_ms)} | ${f(e.p95_ms)} | ${f(e.p99_ms)} | ${f(e.erro * 100, 2)} % |`)
}

console.log("\n### Pedido completo\n")
console.log("| lojas | pedidos/s no orçamento | requisições por pedido | tempo do pedido p95 | bytes de banco por pedido | WAL por pedido |")
console.log("|---|---|---|---|---|---|")
for (const r of rot) {
  const m = get(r, "checkout"); if (!m) continue
  const d = ref(m)
  console.log(`| ${r.toLocaleString("pt-BR")} | ${f(d.pedidos / d.duracao_s, 1)} | ${f(d.requisicoes_por_pedido, 2)} | ${f(d.tempo_do_pedido_p95_ms, 0)} ms | ${f(d.banco.crescimento_banco_bytes / Math.max(1, d.pedidos), 0)} | ${f(d.banco.wal_bytes_total / Math.max(1, d.pedidos), 0)} |`)
}

console.log("\n### Curva de saturação (todos os degraus)\n")
console.log("| lojas | cenário | taxa iter/s | RPS | p95 | p99 | pior p95 endpoint | erro | descartadas | CPU commerce (núcleos) | CPU transaction | CPU postgres | k6 pico | resultado |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for (const r of rot) for (const c of CEN) {
  const m = get(r, c); if (!m) continue
  for (const d of m.degraus) console.log(`| ${r.toLocaleString("pt-BR")} | ${c} | ${d.taxa_alvo_iter_s} | ${f(d.rps, 0)} | ${f(d.p95_ms)} | ${f(d.p99_ms)} | ${f(d.p95_pior_endpoint_ms)} | ${f(d.erro * 100, 2)} % | ${d.iteracoes_descartadas} | ${f(d.cpu_nucleos_medios["commerce-api"], 2)} | ${f(d.cpu_nucleos_medios["transaction-api"], 2)} | ${f(d.cpu_nucleos_medios.postgres, 2)} | ${f(d.k6.cpu_pico_fracao * 100, 0)} % | ${d.dentro_do_orcamento ? "ok" : d.motivos.join("; ")} |`)
}

console.log("\n### Memória ociosa e conexões por serviço (antes da carga)\n")
console.log("| lojas | serviço | memória ociosa MB | conexões ociosas |")
console.log("|---|---|---|---|")
for (const r of rot) {
  const m = get(r, "vitrine") ?? M.find((x) => Number(x.rotulo) === r); if (!m) continue
  for (const [s, mb] of Object.entries(m.memoria_ociosa_mb)) console.log(`| ${r.toLocaleString("pt-BR")} | ${s} | ${f(mb as number)} | ${m.conexoes_ociosas[s] ?? 0} |`)
}

const S = readdirSync(DIR).filter((x) => /^seed-\d+\.json$/.test(x)).map((x) => JSON.parse(readFileSync(join(DIR, x), "utf8"))).sort((a, b) => a.total_lojas_carga - b.total_lojas_carga)
if (S.length) {
  console.log("\n### Base semeada\n")
  console.log("| lojas de carga | lojas na base | produtos | listagens | banco | semeadura desta etapa | lojas/s |")
  console.log("|---|---|---|---|---|---|---|")
  for (const s of S) console.log(`| ${s.total_lojas_carga.toLocaleString("pt-BR")} | ${s.lojas_na_base.toLocaleString("pt-BR")} | ${s.produtos_na_base.toLocaleString("pt-BR")} | ${s.listagens_na_base.toLocaleString("pt-BR")} | ${f(s.banco_bytes / 2 ** 20, 0)} MB | ${f(s.segundos_de_semeadura, 0)} s | ${f(s.lojas_por_segundo, 0)} |`)
  if (S.length > 1) {
    const a = S[0], b = S.at(-1)
    const dl = b.total_lojas_carga - a.total_lojas_carga, dp = b.produtos_na_base - a.produtos_na_base
    console.log(`\nEntre ${a.total_lojas_carga} e ${b.total_lojas_carga} lojas: **${f((b.banco_bytes - a.banco_bytes) / dl / 1024, 1)} KB por loja** e **${f((b.banco_bytes - a.banco_bytes) / dp / 1024, 2)} KB por produto** (tudo incluído: tabela, índice, TOAST).\n`)
    console.log("| tabela | bytes por loja |")
    console.log("|---|---|")
    for (const t of Object.keys(b.tabelas_bytes).sort()) {
      const d = (b.tabelas_bytes[t] - (a.tabelas_bytes[t] ?? 0)) / dl
      if (d > 50) console.log(`| ${t} | ${f(d, 0)} |`)
    }
  }
}
