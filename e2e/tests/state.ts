import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const tmp = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp")

export type State = {
  store: { id: string; name: string; handle: string; organizationId: string }
  buyer: { email: string; password: string; name: string }
  seller: { client: string; secret: string }
}

export function state(): State {
  const file = join(tmp, "state.json")
  if (!existsSync(file)) throw new Error("rode antes: bun run prepare-stack")
  return JSON.parse(readFileSync(file, "utf8")) as State
}

/* Os pedidos feitos pelos testes do comprador, para o do lojista conferir. */
const ordersFile = join(tmp, "orders.json")
export function recordOrder(project: string, orderId: string): void {
  const all = existsSync(ordersFile) ? JSON.parse(readFileSync(ordersFile, "utf8")) as Record<string, string> : {}
  all[project] = orderId
  writeFileSync(ordersFile, JSON.stringify(all, null, 2))
}
export function recordedOrders(): Record<string, string> {
  return existsSync(ordersFile) ? JSON.parse(readFileSync(ordersFile, "utf8")) as Record<string, string> : {}
}
