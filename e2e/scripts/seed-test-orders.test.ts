import { test } from "node:test"
import { ok, strictEqual } from "node:assert"
import { restockDelta, restockVariant } from "./seed-test-orders"
import { state } from "../tests/state"
import { token } from "../tests/fixtures"

/* `bun test scripts/seed-test-orders.test.ts` — a conta e, contra a stack
   local, a reposição de verdade (só soma estoque; não cria pedido). */
test("reposição só quando falta, com folga", () => {
  strictEqual(restockDelta(10, 9), 0)
  strictEqual(restockDelta(9, 9), 0)
  strictEqual(restockDelta(0, 9), 29)
  strictEqual(restockDelta(-2, 3), 25)
})

test("a variante da loja de teste fica com o necessário", async () => {
  const { seller } = state()
  const tok = await token(seller.client, seller.secret)
  await restockVariant(tok, 60)
  strictEqual(await restockVariant(tok, 60), 0, "depois de repor, nada mais falta")
  ok(true)
})
