/* Calculadora de servidores a partir das medições k6 (reports/data/<dia>/).
 *
 *   bun capacity-model/calculadora.ts --lojas 20000 --pedidos-loja-dia 5 --visitas-loja-dia 200 \
 *       [--pico 3] [--produtos-loja 1000] [--vcpu 8] [--ram 16] [--sysbench-alvo <eventos/s por thread>] \
 *       [--util 0.6] [--custo] [--dados reports/data/2026-11-25] [--json]
 *
 * Saída principal: recursos — nós de aplicação, worker, banco (vCPU, RAM,
 * disco, IOPS), cache e células. Custo mensal (--custo) é opcional e usa só
 * AWS sa-east-1, lido de sellvex-marketplace-budget/fontes.md (preço da
 * família escalado linearmente pelo tamanho, como a AWS cobra dentro da
 * família); o budget não é editado.
 *
 * O que é medido e o que é premissa está separado na saída: custos por
 * requisição, requisições por pedido, consultas, WAL e bytes por loja,
 * produto e pedido vêm das medições; o mix de tráfego por visita, o fator
 * de pico, a utilização-alvo e o número de entregadores são premissas
 * declaradas, com valor padrão e flag para trocar.
 *
 * Conversão de hardware: o CPU-ms medido vale para esta máquina. Com
 * --sysbench-alvo (sysbench cpu, 1 thread, eventos/s, rodado com
 * k6/ficha-maquina.sh no servidor alvo) o custo é multiplicado por
 * score_local/score_alvo. Sem ele, assume-se um vCPU alvo = um núcleo daqui. */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (k: string, d?: number): number => {
  const i = args.indexOf(`--${k}`)
  if (i < 0) { if (d === undefined) throw new Error(`falta --${k}`); return d }
  return Number(args[i + 1])
}
const tem = (k: string) => args.includes(`--${k}`)
const DADOS = (() => { const i = args.indexOf("--dados"); return resolve(i >= 0 ? args[i + 1]! : join(here, "../reports/data/2026-11-25")) })()

// ---------- medições ----------
type Degrau = any
type Medida = { rotulo: number; cenario: string; rps_max_no_orcamento: number; degraus: Degrau[]; memoria_ociosa_mb: Record<string, number> }
const medidas: Medida[] = readdirSync(DADOS).filter((f) => /^\d+-[a-z]+\.json$/.test(f)).map((f) => {
  const m = JSON.parse(readFileSync(join(DADOS, f), "utf8"))
  return { ...m, rotulo: Number(m.rotulo) }
})
if (!medidas.length) throw new Error(`sem medições em ${DADOS}`)
const sementes = readdirSync(DADOS).filter((f) => /^seed-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(DADOS, f), "utf8")))
  .sort((a, b) => a.total_lojas_carga - b.total_lojas_carga)
const maquina = existsSync(join(DADOS, "maquina.txt")) ? readFileSync(join(DADOS, "maquina.txt"), "utf8") : ""
const scoreLocal = Number(/sysbench cpu[\s\S]*?events per second:\s*([\d.]+)/.exec(maquina)?.[1] ?? NaN)

/** Degrau de referência de um cenário num tamanho de base: o de maior RPS
    ainda dentro do orçamento (custo unitário em regime, sem fila). */
function referencia(cen: string, rotulo: number): Degrau | null {
  const m = medidas.find((x) => x.cenario === cen && x.rotulo === rotulo)
  const bons = m?.degraus.filter((d: Degrau) => d.dentro_do_orcamento) ?? []
  return bons.at(-1) ?? m?.degraus[0] ?? null
}
const rotulos = [...new Set(medidas.map((m) => m.rotulo))].sort((a, b) => a - b)
/** Interpola em log(lojas) entre os degraus medidos; fora deles usa o mais próximo. */
function porBase(lojas: number, f: (rot: number) => number | null): number {
  const pts = rotulos.map((r) => [r, f(r)] as const).filter(([, v]) => v !== null && Number.isFinite(v)) as [number, number][]
  if (!pts.length) return NaN
  if (lojas <= pts[0]![0]) return pts[0]![1]
  if (lojas >= pts.at(-1)![0]) return pts.at(-1)![1]
  for (let i = 1; i < pts.length; i++) {
    const [a, va] = pts[i - 1]!, [b, vb] = pts[i]!
    if (lojas <= b) { const t = (Math.log(lojas) - Math.log(a)) / (Math.log(b) - Math.log(a)); return va + t * (vb - va) }
  }
  return pts.at(-1)![1]
}
const somaCpu = (d: Degrau, servs: string[]) => servs.reduce((s, n) => s + (d?.cpu_ms_por_req?.[n] ?? 0), 0)
const APP = ["commerce-api", "transaction-api", "control-plane-api"]
const custo = (cen: string, lojas: number, campo: (d: Degrau) => number) => porBase(lojas, (r) => { const d = referencia(cen, r); return d ? campo(d) : null })

// bytes de banco por loja e por produto: regressão entre o menor e o maior degrau semeado
function bytesPorLoja(): { loja: number; produto: number; produtos_por_loja: number } {
  const a = sementes[0], b = sementes.at(-1)
  if (!a || !b || a === b) return { loja: NaN, produto: NaN, produtos_por_loja: NaN }
  const dl = b.total_lojas_carga - a.total_lojas_carga
  const dp = b.produtos_na_base - a.produtos_na_base
  const db = b.banco_bytes - a.banco_bytes
  return { loja: db / dl, produto: db / dp, produtos_por_loja: dp / dl }
}

// ---------- entradas ----------
const lojas = flag("lojas")
const pedidosLojaDia = flag("pedidos-loja-dia", 5)
const visitasLojaDia = flag("visitas-loja-dia", 200)
const pico = flag("pico", 3)
const produtosLoja = flag("produtos-loja", 1000)
/* --enxuto: política de entrada pedida pelo usuário — o menor servidor que
   aguenta o pico (1 nó no mínimo) e o balanceador dobra (×2), para um poder
   cair ou ser atualizado. Tamanhos escolhidos na escada 2/4/8/16 vCPU com
   4 GB por vCPU (família m7g). Sem a flag, vale a topologia de DEC-INFRA-001
   (3 nós de app, 2 de worker, banco de 16 vCPU). */
const ENXUTO = args.includes("--enxuto")
const ESCADA = [2, 4, 8, 16]
const vcpuFixo = ENXUTO && !args.includes("--vcpu") ? 0 : flag("vcpu", 8)
let vcpu = vcpuFixo || 2, ram = ENXUTO && !args.includes("--ram") ? 0 : flag("ram", 16)
const fatorLb = flag("fator-lb", ENXUTO ? 2 : 1)
const minApp = flag("min-app", ENXUTO ? 1 : 3), minWorker = flag("min-worker", ENXUTO ? 1 : 2)
const util = flag("util", 0.6)
const scoreAlvo = flag("sysbench-alvo", NaN)
const fatorHw = Number.isFinite(scoreAlvo) && Number.isFinite(scoreLocal) ? scoreLocal / scoreAlvo : 1
// premissas de mix (não medidas): uma visita = 1 vitrine + 2 páginas de produto + 0,3 busca
const PREM = {
  vitrine_por_visita: flag("vitrine-visita", 1), produto_por_visita: flag("produto-visita", 2), busca_por_visita: flag("busca-visita", 0.3),
  painel_req_por_loja_dia: flag("painel-loja-dia", 40), entregas_por_entregador_dia: flag("entregas-entregador-dia", 20),
  intervalo_localizacao_s: flag("intervalo-localizacao", 10), retencao_pedidos_dias: flag("retencao-dias", 365), pool_por_instancia: 10,
}

// ---------- tráfego ----------
const pedidosDia = lojas * pedidosLojaDia
const visitasDia = lojas * visitasLojaDia
const it = (cen: string) => { const d = referencia(cen, rotulos.at(-1)!); return d ? d.rps / Math.max(1, d.iteracoes / d.duracao_s) : 1 } // req por iteração
const reqPedido = custo("checkout", lojas, (d) => d.requisicoes_por_pedido ?? NaN)
const entregadoresOnline = Math.ceil(pedidosDia / PREM.entregas_por_entregador_dia / 3) // ~1/3 do dia em linha
const rpsMedio: Record<string, number> = {
  vitrine: (visitasDia * PREM.vitrine_por_visita * it("vitrine")) / 86400,
  produto: (visitasDia * PREM.produto_por_visita * it("produto")) / 86400,
  busca: (visitasDia * PREM.busca_por_visita * it("busca")) / 86400,
  checkout: (pedidosDia * reqPedido) / 86400,
  painel: (lojas * PREM.painel_req_por_loja_dia) / 86400,
  entregador: entregadoresOnline / PREM.intervalo_localizacao_s / 3,
}
const rpsPico = Object.fromEntries(Object.entries(rpsMedio).map(([k, v]) => [k, v * pico]))
const rpsTotal = Object.values(rpsPico).reduce((a, b) => a + b, 0)
const pedidosPicoS = (pedidosDia / 86400) * pico

// ---------- recursos ----------
const nucleos = (servs: string[]) => Object.entries(rpsPico).reduce((s, [cen, rps]) => s + rps * custo(cen, lojas, (d) => somaCpu(d, servs)) / 1000, 0) * fatorHw / util
const appCores = nucleos(APP)
const workerCores = nucleos(["worker", "nats"])
const dbCores = nucleos(["postgres"])
/* Menor tamanho da escada que leva o pico num só nó; acima de 16 vCPU, mais nós. */
const tamanho = (cores: number) => ESCADA.find((t) => cores <= t) ?? ESCADA.at(-1)!
if (!vcpuFixo) vcpu = tamanho(Math.max(appCores, workerCores))
if (!ram) ram = vcpu * 4
const appNos = Math.max(minApp, Math.ceil(appCores / vcpu)) * fatorLb
const workerNos = Math.max(minWorker, Math.ceil(workerCores / vcpu))
const memApp = Math.max(...APP.map((s) => porBase(lojas, (r) => { const d = referencia("vitrine", r); return d?.memoria_max_mb?.[s] ?? null })))
const consultasS = Object.entries(rpsPico).reduce((s, [cen, rps]) => s + rps * custo(cen, lojas, (d) => d.banco.consultas_por_req), 0)
const walS = Object.entries(rpsPico).reduce((s, [cen, rps]) => s + rps * custo(cen, lojas, (d) => d.banco.wal_bytes_por_req ?? 0), 0)
const bpl = bytesPorLoja()
const ck = medidas.filter((m) => m.cenario === "checkout").flatMap((m) => m.degraus).filter((d: Degrau) => d.pedidos > 0)
const bytesPedido = ck.length ? ck.reduce((s: number, d: Degrau) => s + d.banco.crescimento_banco_bytes, 0) / ck.reduce((s: number, d: Degrau) => s + d.pedidos, 0) : NaN
const catalogoBytes = lojas * (bpl.loja + (produtosLoja - bpl.produtos_por_loja) * bpl.produto)
const pedidosBytes = pedidosDia * PREM.retencao_pedidos_dias * bytesPedido
const dadosBytes = catalogoBytes + pedidosBytes
const discoDb = dadosBytes * 2.5 // dado + índices já incluídos; ×2,5 = WAL, vacuum, crescimento e folga de 40 %
/* Fração do catálogo que fica quente na RAM do banco: premissa, não medida (padrão 1 = catálogo inteiro; enxuto 0,25). */
const fracaoQuente = flag("fracao-quente", ENXUTO ? 0.25 : 1)
const ramDb = Math.max(ENXUTO ? 4 : 16, Math.ceil((catalogoBytes * fracaoQuente + pedidosBytes * 0.1) / 2 ** 30 * 1.3)) // catálogo inteiro + 10 % dos pedidos (quentes) em memória
const iopsDb = Math.ceil((walS / 8192) * 3 + consultasS * 0.01) // escrita: páginas de WAL ×3 (WAL + checkpoint + dado); leitura: 1 % de falta de cache
const conexoes = (appNos * APP.length + workerNos) * PREM.pool_por_instancia
const DB_REF = { vcpu: 16, ram: 64 } // perfil de referência de DEC-INFRA-001
/* Enxuto: o banco também sobe pela escada (vCPU pelo pico, RAM pelo dado quente), até o perfil de referência. */
const dbVcpu = ENXUTO ? Math.min(DB_REF.vcpu, Math.max(tamanho(dbCores), Math.ceil(ramDb / 8 / 2) * 2, 2)) : DB_REF.vcpu
const DB_NO = { vcpu: dbVcpu, ram: ENXUTO ? Math.min(DB_REF.ram, Math.max(dbVcpu * 4, ramDb)) : DB_REF.ram }
const celulas = Math.max(1, Math.ceil(dbCores / DB_NO.vcpu), Math.ceil(ramDb / DB_NO.ram))
const valkeyMb = porBase(lojas, (r) => referencia("vitrine", r)?.memoria_max_mb?.valkey ?? null)

// ---------- custo AWS sa-east-1 (opcional) ----------
function precosAws() {
  const f = resolve(here, "../../sellvex-marketplace-budget/fontes.md")
  if (!existsSync(f)) return null
  const t = readFileSync(f, "utf8")
  const hora = (re: RegExp) => Number((re.exec(t)?.[1] ?? "NaN").replace(",", "."))
  const ec2 = hora(/EC2 m7g\.large sa-east-1 \| US\$ ([\d,]+)\/h/)
  const rds = Number((/RDS PostgreSQL Multi-AZ db\.t4g\.medium \/ db\.m7g\.large \| US\$ [\d.,]+ \/ US\$ ([\d.,]+)/.exec(t)?.[1] ?? "NaN").replace(".", "").replace(",", "."))
  const valkey = Number((/ElastiCache Valkey t4g\.small \| US\$ [\d,]+\/h = US\$ ([\d,]+)/.exec(t)?.[1] ?? "NaN").replace(",", "."))
  const ebs = hora(/EBS gp3 sa-east-1 \| US\$ ([\d,]+)\/GB-mês/)
  return { ec2_m7g_large_mes: ec2 * 730, rds_m7g_large_multiaz_mes: rds, valkey_t4g_small_mes: valkey, ebs_gp3_gb_mes: ebs, fonte: f }
}

const r = {
  entrada: { lojas, pedidos_por_loja_dia: pedidosLojaDia, visitas_por_loja_dia: visitasLojaDia, fator_pico: pico, produtos_por_loja: produtosLoja,
    servidor_app: { vcpu, ram_gb: ram }, utilizacao_alvo: util, fator_hardware: Number(fatorHw.toFixed(3)), sysbench_local: scoreLocal, sysbench_alvo: scoreAlvo },
  premissas: PREM,
  medido: { requisicoes_por_pedido: Number(reqPedido.toFixed(2)), bytes_banco_por_loja_carga: Math.round(bpl.loja), bytes_banco_por_produto: Math.round(bpl.produto),
    bytes_banco_por_pedido: Math.round(bytesPedido), base_medida_mais_proxima: rotulos.reduce((a, b) => Math.abs(Math.log(b / lojas)) < Math.abs(Math.log(a / lojas)) ? b : a) },
  trafego_pico: { rps_total: Math.round(rpsTotal), pedidos_por_s: Number(pedidosPicoS.toFixed(2)), por_cenario: Object.fromEntries(Object.entries(rpsPico).map(([k, v]) => [k, Number(v.toFixed(1))])),
    consultas_banco_por_s: Math.round(consultasS), wal_mb_por_s: Number((walS / 2 ** 20).toFixed(2)) },
  recursos: {
    app: { nos: appNos, vcpu_necessarios: Number(appCores.toFixed(1)), vcpu_por_no: vcpu, ram_por_no_gb: ram, memoria_processo_medida_mb: Math.round(memApp) },
    worker: { nos: workerNos, vcpu_necessarios: Number(workerCores.toFixed(1)) },
    banco: { celulas, vcpu_necessarios: Number(dbCores.toFixed(1)), ram_gb_por_primario: Math.min(DB_NO.ram, Math.ceil(ramDb / celulas)), ram_gb_total: ramDb,
      disco_gb_total: Math.ceil(discoDb / 2 ** 30), disco_gb_por_celula: Math.ceil(discoDb / 2 ** 30 / celulas), iops_pico: iopsDb, conexoes_app: conexoes,
      topologia: "primário + standby síncrono por célula (DEC-INFRA-001)" },
    cache: { valkey_mb_medido: Number(valkeyMb.toFixed(1)), recomendacao: "1 nó pequeno + réplica (uso medido é de poucos MB; cache de borda não medido)" },
  },
  custo_mensal_usd_aws_sa_east_1: null as null | Record<string, number | string>,
}
if (tem("custo")) {
  const p = precosAws()
  if (p) {
    const ec2PorVcpu = p.ec2_m7g_large_mes / 2, rdsPorVcpu = p.rds_m7g_large_multiaz_mes / 2
    const app = appNos * vcpu * ec2PorVcpu, worker = workerNos * vcpu * ec2PorVcpu
    const db = celulas * DB_NO.vcpu * rdsPorVcpu
    const disco = (r.recursos.banco.disco_gb_total * 2) * p.ebs_gp3_gb_mes // primário + standby
    const cache = 2 * p.valkey_t4g_small_mes
    r.custo_mensal_usd_aws_sa_east_1 = { app: Math.round(app), worker: Math.round(worker), banco_rds_multiaz: Math.round(db), disco_gp3: Math.round(disco), cache: Math.round(cache),
      total: Math.round(app + worker + db + disco + cache), nota: "m7g/db.m7g escalados linearmente a partir do .large; sem tráfego de saída, ALB, NAT, mídia, busca, observabilidade", fonte: p.fonte }
  }
}

if (tem("json")) console.log(JSON.stringify(r, null, 2))
else {
  const R = r.recursos
  console.log(`${lojas} lojas · ${pedidosDia.toLocaleString("pt-BR")} pedidos/dia · pico ×${pico}: ${r.trafego_pico.rps_total} RPS, ${r.trafego_pico.pedidos_por_s} pedidos/s`)
  if (ENXUTO) console.log(`  política: mínimo ${minApp} nó de app, balanceador ×${fatorLb}; banco ${DB_NO.vcpu} vCPU/${DB_NO.ram} GB por célula`)
  console.log(`  app     ${R.app.nos} nós de ${vcpu} vCPU/${ram} GB (${R.app.vcpu_necessarios} vCPU a ${util * 100}% de uso)`)
  console.log(`  worker  ${R.worker.nos} nós (${R.worker.vcpu_necessarios} vCPU)`)
  console.log(`  banco   ${R.banco.celulas} célula(s) · ${R.banco.vcpu_necessarios} vCPU · ${R.banco.ram_gb_total} GB RAM · ${R.banco.disco_gb_total} GB disco · ${R.banco.iops_pico} IOPS · ${R.banco.conexoes_app} conexões`)
  console.log(`  cache   ${R.cache.recomendacao}`)
  if (r.custo_mensal_usd_aws_sa_east_1) console.log(`  custo   US$ ${r.custo_mensal_usd_aws_sa_east_1.total}/mês (AWS sa-east-1, ${r.custo_mensal_usd_aws_sa_east_1.nota})`)
}
