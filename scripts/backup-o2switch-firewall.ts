import { isIPv4 } from "node:net";
import { z } from "zod";
import { withHostingCredentials } from "../src/lib/hosting-connections";
import { database, isPostgres } from "../src/lib/storage";
import { backupLeaseMs } from "../src/lib/backup-store";

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
  if (!isPostgres()) throw new Error("Le pare-feu automatique nécessite le catalogue PostgreSQL.");
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
    const db = database();
    const rulesForAddress = (rules: z.infer<typeof ruleSchema>[], address: string) =>
      rules.filter(rule => rule.address === address && rule.port === 22);
    async function release(address: string) {
      if (!isIPv4(address)) throw new Error("Adresse d’exception SSH invalide.");
      const current = rulesForAddress((await list()).list, address);
      for (const rule of current) await call("remove", { address, port: "22", direction: rule.direction });
      if (rulesForAddress((await list()).list, address).length) throw new Error("Exception SSH temporaire encore présente.");
      await db.prepare("DELETE FROM backup_firewall_rules WHERE account_id=? AND address=?").run(connectionId, address);
    }
    const now = new Date();
    const abandoned = await db.prepare("SELECT address FROM backup_firewall_rules WHERE account_id=? AND expires_at<=?")
      .all(connectionId, now.toISOString());
    for (const rule of abandoned) await release(String(rule.address));

    const before = await list();
    const address = before.ip;
    if (!isIPv4(address)) throw new Error("Adresse IPv4 du worker indisponible.");
    const existing = rulesForAddress(before.list, address);
    if (existing.some(rule => rule.direction === "in")) return async () => {};
    if (existing.length) throw new Error("L’adresse du worker a déjà une exception SSH partielle.");

    const tracked = await db.prepare("INSERT INTO backup_firewall_rules(account_id,address,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING")
      .run(connectionId, address, new Date(now.getTime() + backupLeaseMs).toISOString());
    if (!tracked.changes) throw new Error("Une autre exécution prépare déjà l’accès SSH.");
    try {
      await call("add", { address, port: "22" });
      return () => release(address);
    } catch (error) {
      await release(address);
      throw error;
    }
  });
}
