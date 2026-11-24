import { test } from "node:test"
import { strictEqual } from "node:assert"
import { execFileSync } from "node:child_process"
import { TEST_COURIERS_WHERE } from "./prepare-entregas"

/* O predicado dos entregadores de teste, avaliado no Postgres de verdade
   sobre nomes e subjects de exemplo (sem tocar em tabela nenhuma): os de
   teste casam, uma pessoa real não. `bun test scripts/test-couriers.test.ts` */
const PG = process.env.E2E_POSTGRES_CONTAINER || `${process.env.E2E_COMPOSE_PROJECT || "sellvex-minimal"}-postgres-1`
const matches = (full_name: string, subject: string) =>
  execFileSync("docker", ["exec", PG, "psql", "-U", "sellvex", "-d", "sellvex", "-Atc",
    `select ${TEST_COURIERS_WHERE} from (values ('${full_name}', '${subject}')) as c(full_name, subject)`], { encoding: "utf8" }).trim() === "t"

test("entregadores criados pelos testes casam", () => {
  strictEqual(matches("Entregador E2E", "http://dev-idp:9000|e2e-entregador"), true)
  strictEqual(matches("Entregador Cadastro E2E", "http://dev-idp:9000|81780048"), true)
  strictEqual(matches("Rastreio Teste mwv4adm3", "http://dev-idp:9000|d296bcff"), true)
  strictEqual(matches("Entregador Convidado abc", "http://dev-idp:9000|x"), true)
  strictEqual(matches("Simulado 01", "sellvex-simulator|courier-01"), true)
})

test("quem testa à mão não casa", () => {
  strictEqual(matches("Jandercley Reis da Silva", "http://dev-idp:9000|f2819fbc-7388-4284-be8c-305474828e31"), false)
  strictEqual(matches("Maria Teste da Silva", "http://dev-idp:9000|abc"), false)
})
