import { randomUUID } from "node:crypto";
import { hostingStorage } from "./hosting-storage";
import type { AutomaticControl } from "./automatic-control-state";

// Durable reports and leases use separate keys in the existing catalog. Reports
// remain available after an outage; their evidence carries its own expiry.
const reportKey = (id: string) => `control:report:1:${id}`;
export async function readAutomaticControl(id: string): Promise<AutomaticControl | null> {
  const row = await (await hostingStorage()).prepare("SELECT data FROM wordpress_catalog WHERE cache_key=?").get(reportKey(id)) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}
export async function writeAutomaticControl(control: AutomaticControl) {
  await (await hostingStorage()).prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at").run(reportKey(control.targetId), JSON.stringify(control), "9999-12-31T00:00:00.000Z");
}
export async function claimAutomaticControl(id: string, now = Date.now()) {
  const token = randomUUID(), key = `control:lease:1:${id}`;
  const db = await hostingStorage();
  const claimed = await db.prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at WHERE wordpress_catalog.expires_at<=?").run(key, token, new Date(now + 10 * 60_000).toISOString(), new Date(now).toISOString());
  return claimed.changes ? async () => { await db.prepare("DELETE FROM wordpress_catalog WHERE cache_key=? AND data=?").run(key, token); } : null;
}
