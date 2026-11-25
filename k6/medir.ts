/* Curva de saturação por cenário, com o registro de 08 §Registro de cada teste.
 *
 *   bun k6/medir.ts <rotulo> [cenario...]     # ex.: bun k6/medir.ts 2000 vitrine busca
 *
 * Para cada cenário sobe a taxa em degraus (constant-arrival-rate, DURACAO s
 * cada) e para no primeiro degrau que quebra: p95 acima do orçamento da
 * classe (DEC-PERF-001), erro > 1 %, iterações descartadas > 1 % ou o
 * próprio k6 acima de 85 % dos seus núcleos — neste último caso o degrau é
 * marcado `gerador_saturado` e não conta (08 §131).
 *
 * Isolamento: o k6 roda em contêiner com --cpuset-cpus K6_CPUS (padrão 6,7);
 * os contêineres sellvex-minimal-* são presos a SUT_CPUS (padrão 0-5) com
 * `docker update` durante a medição e devolvidos a 0-7 no fim.
 *
 * Por degrau: RPS obtido, p50/p95/p99 total e por endpoint, erro, bytes por
 * requisição, CPU-ms por requisição e memória máxima por serviço (cgroup v2),
 * consultas e tempo de banco por requisição (pg_stat_statements), acerto de
 * cache do Postgres, conexões por serviço, fila (outbox pendente e pendências
 * dos consumidores NATS), CPU do k6.
 *
 * Saída: reports/data/2026-11-25/<rotulo>-<cenario>.json (resumo pequeno). */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { psql } from "../datasets/carga/seed"

const here = dirname(fileURLToPath(import.meta.url))
const DIA = process.env.DIA || "2026-11-25"
const OUT = resolve(here, "../reports/data", DIA)
const K6_CPUS = process.env.K6_CPUS || "6,7"
const SUT_CPUS = process.env.SUT_CPUS || "0-5"
const DURACAO = Number(process.env.DURACAO || 20)
const K6_IMG = "grafana/k6:0.57.0"

type Cenario = { classe: string; orcamento_p95_ms: number; degraus: number[] }
export const CENARIOS: Record<string, Cenario> = {
  vitrine: { classe: "public-read", orcamento_p95_ms: 50, degraus: [50, 100, 200, 400, 700, 1000, 1500, 2000] },
  produto: { classe: "public-read", orcamento_p95_ms: 50, degraus: [50, 100, 200, 400, 700, 1000, 1500, 2000] },
  busca: { classe: "public-read", orcamento_p95_ms: 50, degraus: [5, 10, 25, 50, 100, 200, 400, 800] },
  carrinho: { classe: "transactional-write", orcamento_p95_ms: 300, degraus: [25, 50, 100, 200, 400, 700, 1000] },
  checkout: { classe: "checkout (por etapa)", orcamento_p95_ms: 500, degraus: [5, 10, 20, 40, 80, 120, 160] },
  painel: { classe: "tenant-read", orcamento_p95_ms: 150, degraus: [25, 50, 100, 200, 400, 800, 1200] },
  entregador: { classe: "transactional-write", orcamento_p95_ms: 300, degraus: [50, 100, 200, 400, 800, 1500, 2500] },
}

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8" }).trim()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function containers(): Record<string, string> {
  const r: Record<string, string> = {}
  for (const l of sh("docker", ["ps", "--no-trunc", "--filter", "name=sellvex-minimal-", "--format", "{{.Names}} {{.ID}}"]).split("\n")) {
    const [n, id] = l.split(" ")
    r[n!.replace(/^sellvex-minimal-|-1$/g, "")] = id!
  }
  return r
}
const cg = (id: string) => `/sys/fs/cgroup/system.slice/docker-${id}.scope`
function cpuUsec(id: string): number {
  const m = /usage_usec (\d+)/.exec(readFileSync(join(cg(id), "cpu.stat"), "utf8"))
  return Number(m![1])
}
const memBytes = (id: string) => Number(readFileSync(join(cg(id), "memory.current"), "utf8"))

function ips(): Record<string, string> {
  const r: Record<string, string> = {}
  for (const l of sh("docker", ["inspect", "-f", "{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", ...Object.values(containers())]).split("\n")) {
    const [n, ip] = l.split(" ")
    r[ip!] = n!.replace(/^\/sellvex-minimal-|-1$/g, "")
  }
  return r
}

function conexoes(mapa: Record<string, string>): Record<string, number> {
  const r: Record<string, number> = {}
  for (const l of psql("select coalesce(host(client_addr),'local'), count(*) from pg_stat_activity where datname='sellvex' group by 1").split("\n").filter(Boolean)) {
    const [ip, n] = l.split("|")
    const k = mapa[ip!] ?? ip!
    r[k] = (r[k] ?? 0) + Number(n)
  }
  return r
}

function dbStat() {
  const [x, hit, read, tupr, tupf, tupi, tupu] = psql(`select xact_commit+xact_rollback, blks_hit, blks_read, tup_returned, tup_fetched, tup_inserted, tup_updated
    from pg_stat_database where datname='sellvex'`).split("|").map(Number)
  return { xact: x!, hit: hit!, read: read!, tup_returned: tupr!, tup_fetched: tupf!, tup_inserted: tupi!, tup_updated: tupu! }
}
function statements() {
  const [calls, ms, rows] = psql(`select coalesce(sum(calls),0), coalesce(sum(total_exec_time),0), coalesce(sum(rows),0) from pg_stat_statements s
    join pg_database d on d.oid=s.dbid where d.datname='sellvex' and s.query not ilike '%pg_stat%' and s.query not ilike '%pg_database%' and s.query not ilike '%pg_class%'
    and s.query not ilike '%platform.outbox where published_at%' and s.query !~* '^\\s*(begin|commit|rollback|set |select \\$1$)'`).split("|").map(Number)
  const [tx] = psql(`select coalesce(sum(calls),0) from pg_stat_statements s join pg_database d on d.oid=s.dbid where d.datname='sellvex' and s.query ~* '^\\s*(begin|commit|rollback)'`).split("|").map(Number)
  const top = psql(`select calls, round(total_exec_time::numeric,1), round(mean_exec_time::numeric,3), left(regexp_replace(query,'\\s+',' ','g'),140) from pg_stat_statements s
    join pg_database d on d.oid=s.dbid where d.datname='sellvex' and s.query not ilike '%pg_stat%' order by total_exec_time desc limit 6`)
    .split("\n").filter(Boolean).map((l) => { const [c, t, m, q] = l.split("|"); return { calls: Number(c), total_ms: Number(t), media_ms: Number(m), query: q } })
  return { calls: calls!, exec_ms: ms!, rows: rows!, tx_stmts: tx!, top }
}
const outboxPendente = () => Number(psql("select count(*) from platform.outbox where published_at is null"))
async function natsPendente(): Promise<number> {
  const j = await fetch("http://localhost:8222/jsz?consumers=true&accounts=true").then((r) => r.json()).catch(() => null) as any
  let n = 0
  for (const a of j?.account_details ?? []) for (const s of a.stream_detail ?? []) for (const c of s.consumer_detail ?? []) n += (c.num_pending ?? 0) + (c.num_ack_pending ?? 0)
  return n
}

const k6Cpus = K6_CPUS.split(",").length

async function degrau(cen: string, taxa: number, ids: Record<string, string>, mapa: Record<string, string>) {
  const nome = `carga-k6-${cen}-${taxa}-${Date.now()}`
  const saida = `/k6/.tmp/${nome}.json`
  psql("select pg_stat_statements_reset()")
  const db0 = dbStat(), cpu0 = Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, cpuUsec(id)]))
  const ob0 = outboxPendente()
  const t0 = performance.now()
  const vusMax = cen === "checkout" ? Math.max(50, taxa * 4) : Math.max(100, Math.ceil(taxa * 0.5))
  const p = spawn("docker", ["run", "--rm", "--name", nome, "--network", "host", "--cpuset-cpus", K6_CPUS, "-u", String(process.getuid!()),
    "-v", `${here}:/k6`, "-w", "/k6", "-e", `CENARIO=${cen}`, "-e", `TAXA=${taxa}`, "-e", `DURACAO=${DURACAO}`, "-e", `VUS_MAX=${vusMax}`, "-e", `SAIDA=${saida}`,
    K6_IMG, "run", "-q", "--no-thresholds", "cenarios.js"], { stdio: ["ignore", "ignore", "pipe"] })
  let err = ""
  p.stderr.on("data", (d) => { err += d })
  const fim = new Promise<number>((r) => p.on("exit", (c) => r(c ?? 1)))
  const mem: Record<string, number> = {}, conn: Record<string, number> = {}
  let k6Id = "", k6Cpu0 = 0, k6CpuMax = 0, k6Prev = 0, k6PrevT = 0, k6Last = 0
  let natsMax = 0, obMax = 0
  let acabou = false
  fim.then(() => { acabou = true })
  while (!acabou) {
    await sleep(1000)
    if (!k6Id) {
      try { k6Id = sh("docker", ["inspect", "-f", "{{.Id}}", nome]); k6Cpu0 = cpuUsec(k6Id); k6Prev = k6Cpu0; k6PrevT = performance.now() } catch {}
    } else {
      try {
        const u = cpuUsec(k6Id), t = performance.now()
        const frac = (u - k6Prev) / ((t - k6PrevT) * 1000) / k6Cpus
        if (t - t0 > 4000) k6CpuMax = Math.max(k6CpuMax, frac) // ignora a partida do k6
        k6Prev = u; k6PrevT = t; k6Last = u
      } catch {}
    }
    for (const [n, id] of Object.entries(ids)) mem[n] = Math.max(mem[n] ?? 0, memBytes(id))
    for (const [n, c] of Object.entries(conexoes(mapa))) conn[n] = Math.max(conn[n] ?? 0, c)
    natsMax = Math.max(natsMax, await natsPendente())
    obMax = Math.max(obMax, outboxPendente())
  }
  const code = await fim
  const seg = (performance.now() - t0) / 1000
  const db1 = dbStat(), st = statements()
  const cpu = Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, (cpuUsec(id) - cpu0[n]!) / 1000]))
  const arq = join(here, ".tmp", `${nome}.json`)
  if (!existsSync(arq)) throw new Error(`k6 sem resumo (saída ${code}): ${err.slice(-500)}`)
  const m = JSON.parse(readFileSync(arq, "utf8")).metrics as Record<string, { values: Record<string, number> }>
  const v = (k: string, f: string) => m[k]?.values?.[f] ?? 0
  const reqs = v("http_reqs", "count") - (m["http_reqs{name:token}"] ? v("http_reqs{name:token}", "count") : 0)
  const rps = reqs / DURACAO
  const iter = v("iterations", "count"), dropped = v("dropped_iterations", "count")
  const endpoints: Record<string, unknown> = {}
  for (const k of Object.keys(m)) {
    const mm = /^http_req_duration\{name:(.+)\}$/.exec(k)
    if (!mm || mm[1] === "token") continue
    const n = mm[1]!
    const c = v(`http_reqs{name:${n}}`, "count")
    if (!c) continue
    endpoints[n] = { requisicoes: c, p50_ms: v(k, "med"), p95_ms: v(k, "p(95)"), p99_ms: v(k, "p(99)"), erro: v(`http_req_failed{name:${n}}`, "rate") }
  }
  const p95 = Math.max(0, ...Object.values(endpoints).map((e: any) => e.p95_ms))
  const erro = v("http_req_failed", "rate")
  const k6Media = k6Id && k6Last ? (k6Last - k6Cpu0) / (seg * 1e6) / k6Cpus : 0
  const sut = ["commerce-api", "transaction-api", "control-plane-api", "worker", "postgres", "nats", "valkey", "dev-idp", "otel-collector"]
  const r = {
    cenario: cen, taxa_alvo_iter_s: taxa, duracao_s: DURACAO,
    rps: Number(rps.toFixed(1)), iteracoes: iter, iteracoes_descartadas: dropped,
    p50_ms: v("http_req_duration", "med"), p95_ms: v("http_req_duration", "p(95)"), p99_ms: v("http_req_duration", "p(99)"),
    p95_pior_endpoint_ms: p95, erro,
    bytes_recebidos_por_req: reqs ? v("data_received", "count") / reqs : 0, bytes_enviados_por_req: reqs ? v("data_sent", "count") / reqs : 0,
    endpoints,
    pedidos: v("pedidos_concluidos", "count"), requisicoes_por_pedido: v("pedidos_concluidos", "count") ? v("requisicoes_de_pedido", "count") / v("pedidos_concluidos", "count") : null,
    tempo_do_pedido_p95_ms: m["tempo_do_pedido"] ? v("tempo_do_pedido", "p(95)") : null,
    cpu_ms_por_req: Object.fromEntries(sut.filter((n) => cpu[n] !== undefined).map((n) => [n, Number((cpu[n]! / reqs).toFixed(3))])),
    cpu_nucleos_medios: Object.fromEntries(sut.filter((n) => cpu[n] !== undefined).map((n) => [n, Number((cpu[n]! / 1000 / seg).toFixed(3))])),
    memoria_max_mb: Object.fromEntries(sut.filter((n) => mem[n] !== undefined).map((n) => [n, Number((mem[n]! / 2 ** 20).toFixed(1))])),
    banco: {
      consultas_por_req: reqs ? st.calls / reqs : 0, tempo_banco_ms_por_req: reqs ? st.exec_ms / reqs : 0,
      transacoes_por_req: reqs ? (db1.xact - db0.xact) / reqs : 0,
      acerto_cache: (db1.hit - db0.hit) / Math.max(1, db1.hit - db0.hit + db1.read - db0.read),
      blocos_lidos_disco: db1.read - db0.read, linhas_lidas_por_req: reqs ? (db1.tup_returned - db0.tup_returned) / reqs : 0,
      conexoes_max: conn, top_consultas: st.top,
    },
    fila: { outbox_pendente_inicio: ob0, outbox_pendente_max: obMax, nats_pendente_max: natsMax },
    k6: { cpu_media_fracao: Number(k6Media.toFixed(3)), cpu_pico_fracao: Number(k6CpuMax.toFixed(3)), nucleos: K6_CPUS, saida: code },
  }
  return r
}

async function main() {
  const rotulo = process.argv[2]
  if (!rotulo) throw new Error("uso: bun k6/medir.ts <rotulo> [cenario...]")
  const lista = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(CENARIOS)
  mkdirSync(OUT, { recursive: true })
  const ids = containers()
  const mapa = ips()
  const ociosa = Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, Number((memBytes(id) / 2 ** 20).toFixed(1))]))
  const conexoesOciosas = conexoes(mapa)
  for (const id of Object.values(ids)) sh("docker", ["update", "--cpuset-cpus", SUT_CPUS, id])
  try {
    for (const cen of lista) {
      const c = CENARIOS[cen]
      if (!c) throw new Error(`cenário desconhecido: ${cen}`)
      const degraus = []
      let quebra: string | null = null
      for (const taxa of (process.env.DEGRAUS ? process.env.DEGRAUS.split(",").map(Number) : c.degraus)) {
        const r = await degrau(cen, taxa, ids, mapa)
        const motivos: string[] = []
        if (r.k6.cpu_pico_fracao > 0.85) motivos.push("gerador_saturado")
        if (r.p95_pior_endpoint_ms > c.orcamento_p95_ms) motivos.push(`p95 ${r.p95_pior_endpoint_ms.toFixed(1)} ms > ${c.orcamento_p95_ms} ms`)
        if (r.erro > 0.01) motivos.push(`erro ${(r.erro * 100).toFixed(2)} %`)
        if (r.iteracoes_descartadas > 0.01 * (r.iteracoes + r.iteracoes_descartadas)) motivos.push(`descartadas ${r.iteracoes_descartadas}`)
        degraus.push({ ...r, dentro_do_orcamento: motivos.length === 0, motivos })
        console.log(`${rotulo} ${cen} ${taxa}/s → ${r.rps} rps, p95 ${r.p95_ms.toFixed(1)} ms (pior ${r.p95_pior_endpoint_ms.toFixed(1)}), erro ${(r.erro * 100).toFixed(2)}%, ` +
          `consultas/req ${r.banco.consultas_por_req.toFixed(1)}, k6 ${(r.k6.cpu_pico_fracao * 100).toFixed(0)}% ${motivos.length ? "✗ " + motivos.join("; ") : "✓"}`)
        if (motivos.length) { quebra = motivos.join("; "); break }
      }
      const bons = degraus.filter((d) => d.dentro_do_orcamento)
      const melhor = bons.at(-1)
      writeFileSync(join(OUT, `${rotulo}-${cen}.json`), JSON.stringify({
        rotulo, cenario: cen, classe: c.classe, orcamento_p95_ms: c.orcamento_p95_ms,
        rps_max_no_orcamento: melhor?.rps ?? 0, quebra, gerador_saturou_antes: degraus.some((d) => d.motivos.includes("gerador_saturado")),
        memoria_ociosa_mb: ociosa, conexoes_ociosas: conexoesOciosas, sut_cpus: SUT_CPUS, k6_cpus: K6_CPUS, degraus, medido_em: new Date().toISOString(),
      }, null, 2))
    }
  } finally {
    for (const id of Object.values(ids)) sh("docker", ["update", "--cpuset-cpus", "0-7", id])
  }
}

if (import.meta.main) main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1) })
