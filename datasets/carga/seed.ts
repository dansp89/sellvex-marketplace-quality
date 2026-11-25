/* Semeia lojas de carga até um total, por clonagem de lojas-molde.
 *
 *   bun datasets/carga/seed.ts <total_de_lojas>      # ex.: 200, 2000, 20000, 120000
 *   bun datasets/carga/seed.ts --remove              # apaga tudo o que foi criado
 *
 * Converge: roda de novo com o mesmo total e não faz nada; com um total
 * maior acrescenta só a diferença. Lojas-molde: as cinco lojas do
 * `sellvex marketplace --local` com 17 a 24 produtos (média 19,2) — a
 * redução em relação aos 1.000 produtos/loja da meta está no relatório.
 *
 * Grava direto no Postgres local (a API levaria horas para 120 mil lojas),
 * mas copiando linhas que a própria aplicação gravou: ver clone.sql.
 * Escreve datasets/carga/.tmp/seed-<total>.json com o tempo e os tamanhos. */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const PG = process.env.CARGA_POSTGRES_CONTAINER || "sellvex-minimal-postgres-1"
const MOLDES = ["Lar Bonito", "Trilha Viva", "SomDireto", "Cozinha Boa", "Brincar"]
const LOTE = Number(process.env.CARGA_LOTE || 1000)

export function psql(sql: string, input?: string): string {
  const args = ["exec", "-i", PG, "psql", "-U", "sellvex", "-d", "sellvex", "-v", "ON_ERROR_STOP=1", "-Atq"]
  if (!input) args.push("-c", sql)
  return execFileSync("docker", args, { encoding: "utf8", input: input ?? "", maxBuffer: 256 << 20 }).trim()
}

/** Bytes de tabela+índices das tabelas que a carga ocupa. */
export function tamanhos(): Record<string, number> {
  const out = psql(`select n.nspname||'.'||c.relname, pg_total_relation_size(c.oid)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','p') and not c.relispartition and n.nspname in
      ('organizations','stores','controlplane','catalog','inventory','pricing','listings','audit','carts','checkout','orders','payments','ledger')
    order by 1`)
  const r: Record<string, number> = {}
  for (const l of out.split("\n").filter(Boolean)) {
    const [k, v] = l.split("|")
    r[k!] = Number(v)
  }
  // tabela particionada: somar as partições
  for (const l of psql(`select pn.nspname||'.'||p.relname, sum(pg_total_relation_size(c.oid))
      from pg_inherits i join pg_class c on c.oid=i.inhrelid join pg_class p on p.oid=i.inhparent
      join pg_namespace pn on pn.oid=p.relnamespace group by 1`).split("\n").filter(Boolean)) {
    const [k, v] = l.split("|")
    r[k!] = Number(v)
  }
  return r
}

function main() {
  if (process.argv[2] === "--remove") {
    const t0 = performance.now()
    psql("", readFileSync(join(here, "remove.sql"), "utf8"))
    console.log(`lojas de carga removidas em ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    return
  }
  const total = Number(process.argv[2])
  if (!Number.isInteger(total) || total < 1 || total > 200_000) throw new Error("uso: bun datasets/carga/seed.ts <total 1..200000> | --remove")

  psql("", readFileSync(join(here, "clone.sql"), "utf8"))
  const ids = MOLDES.map((n) => psql(`select id from stores.stores where name='${n}' and id not in (select store_id from carga.lojas)`))
  if (ids.some((x) => !/^[0-9a-f-]{36}$/.test(x))) throw new Error(`loja-molde ausente: ${MOLDES.join(", ")} (rode sellvex marketplace --local)`)
  psql(`insert into carga.moldes (pos, store_id) values ${ids.map((id, i) => `(${i}, '${id}')`).join(",")} on conflict (pos) do update set store_id=excluded.store_id`)

  const antes = Number(psql("select coalesce(max(seq), 0) from carga.lojas"))
  const t0 = performance.now()
  let feitas = 0
  for (let from = antes + 1; from <= total; from += LOTE) {
    const to = Math.min(total, from + LOTE - 1)
    feitas += Number(psql(`select carga.clonar(${from}, ${to})`))
    const s = (performance.now() - t0) / 1000
    process.stdout.write(`\r${to}/${total} lojas · ${s.toFixed(0)} s · ${(feitas / s).toFixed(0)} lojas/s   `)
  }
  const segundos = (performance.now() - t0) / 1000
  if (feitas) {
    psql("vacuum analyze organizations.organizations, organizations.accounts, stores.stores, controlplane.placements, controlplane.module_installations, catalog.categories, catalog.products, catalog.variants, catalog.product_categories, inventory.warehouses, inventory.stock_positions, inventory.movements, pricing.price_lists, pricing.price_entries, listings.listings")
  }
  console.log()
  const conta = (t: string) => Number(psql(`select count(*) from ${t}`))
  const r = {
    total_lojas_carga: Number(psql("select count(*) from carga.lojas")),
    lojas_na_base: conta("stores.stores"),
    produtos_na_base: conta("catalog.products"),
    variantes_na_base: conta("catalog.variants"),
    listagens_na_base: conta("listings.listings"),
    criadas_nesta_rodada: feitas,
    segundos_de_semeadura: Number(segundos.toFixed(1)),
    lojas_por_segundo: feitas ? Number((feitas / segundos).toFixed(1)) : null,
    banco_bytes: Number(psql("select pg_database_size('sellvex')")),
    tabelas_bytes: tamanhos(),
    medido_em: new Date().toISOString(),
  }
  mkdirSync(join(here, ".tmp"), { recursive: true })
  writeFileSync(join(here, ".tmp", `seed-${total}.json`), JSON.stringify(r, null, 2))
  console.log(JSON.stringify({ ...r, tabelas_bytes: undefined }, null, 2))
}

if (import.meta.main) main()
