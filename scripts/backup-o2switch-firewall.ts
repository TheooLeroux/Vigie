import { isIPv4 } from "node:net";
import { z } from "zod";
import { withHostingCredentials } from "../src/lib/hosting-connections";

const ruleSchema = z.object({
  address: z.string(),
  port: z.coerce.number(),
  direction: z.enum(["in", "out"]),
});
const replySchema = z.object({
  status: z.number(),
  data: z.unknown().optional(),
});

export async function allowBackupSsh(connectionId: string, host: string, username: string) {
  return withHostingCredentials(connectionId, async connection => {
    if (connection.endpoint !== "https://" + host + ":2083" || connection.username !== username ||
        !/^[a-z0-9-]+\.o2switch\.net$/.test(host) || connection.authMode !== "token") {
      throw new Error("Le compte o2switch doit utiliser un jeton cPanel.");
    }
    async function call(operation: "list" | "add" | "remove", fields: Record<string, string> = {}) {
      const url = new URL("/execute/SshWhitelist/" + operation, connection.endpoint);
      url.search = new URLSearchParams(fields).toString();
      const response = await fetch(url, {
        headers: { Authorization: "cpanel " + username + ":" + connection.secret, Accept: "application/json" },
        signal: AbortSignal.timeout(50_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Accès à la liste SSH o2switch refusé.");
      const raw = await response.json();
      const reply = replySchema.parse(raw.result ?? raw);
      if (reply.status !== 1) throw new Error("Opération de pare-feu SSH refusée par o2switch.");
      return reply.data;
    }
    const list = async () => z.object({ ip: z.string(), list: z.array(ruleSchema) }).parse(await call("list"));
    const before = await list();
    const address = before.ip;
    if (!isIPv4(address)) throw new Error("Adresse IPv4 du worker indisponible.");
    const rulesForWorker = (rules: z.infer<typeof ruleSchema>[]) =>
      rules.filter(rule => rule.address === address && rule.port === 22);
    const existing = rulesForWorker(before.list);
    if (existing.some(rule => rule.direction === "in")) return async () => {};
    if (existing.length) throw new Error("L’adresse du worker a déjà une exception SSH partielle.");

    const fields = { address, port: "22" };
    async function release() {
      const current = rulesForWorker((await list()).list);
      for (const rule of current) await call("remove", { ...fields, direction: rule.direction });
      if (rulesForWorker((await list()).list).length) throw new Error("Exception SSH temporaire encore présente.");
    }
    try {
      await call("add", fields);
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  });
}
