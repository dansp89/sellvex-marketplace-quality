import { expect } from "@playwright/test"

/* O Mailpit da stack local (deploy/compose/mailpit-connector.sh liga o
 * conector smtp da plataforma a ele). Os e-mails de recuperação de senha e
 * de confirmação da newsletter chegam aqui, e o teste segue o link como a
 * pessoa seguiria. */
export const MAILPIT = process.env.E2E_MAILPIT || "http://localhost:8025"

type Summary = { ID: string; Subject: string; Created: string }

/** O link do último e-mail para `to` cujo endereço casa com `path`. Espera
    a mensagem chegar (o envio é assíncrono, pelo worker). */
export async function linkFromMail(to: string, path: RegExp, timeout = 60_000): Promise<URL> {
  let link: URL | null = null
  await expect(async () => {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=20`)
    expect(r.status, "Mailpit respondeu").toBe(200)
    const list = ((await r.json()) as { messages?: Summary[] }).messages ?? []
    expect(list.length, `e-mail para ${to}`).toBeGreaterThan(0)
    for (const m of list) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { Text?: string; HTML?: string }
      const urls = `${msg.Text ?? ""} ${msg.HTML ?? ""}`.match(/https?:\/\/[^\s"'<>]+/g) ?? []
      const hit = urls.map((u) => new URL(u.replace(/&amp;/g, "&"))).find((u) => path.test(u.pathname))
      if (hit) { link = hit; return }
    }
    throw new Error(`nenhum link ${path} nos e-mails para ${to}`)
  }).toPass({ timeout, intervals: [1000, 2000, 3000] })
  return link!
}

/** O mesmo caminho e consulta, na app que o teste está servindo: o link do
    e-mail aponta para SELLVEX_*_URL, que pode ser outra porta. */
export function onBase(link: URL): string {
  return `${link.pathname}${link.search}`
}
