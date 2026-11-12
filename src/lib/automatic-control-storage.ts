import { randomUUID } from "node:crypto";
import { hostingStorage, readCatalogReports } from "./hosting-storage";
import type { AutomaticControl, AutomaticControlSchedule } from "./automatic-control-state";

// Durable reports and leases use separate keys in the existing catalog. Reports
// remain available after an outage; their evidence carries its own expiry.
const reportKey = (id: string) => `control:report:1:${id}`;
export async function readAutomaticControl(id: string): Promise<AutomaticControl | null> {
  const row = await (await hostingStorage()).prepare("SELECT data FROM wordpress_catalog WHERE cache_key=?").get(reportKey(id)) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}
export async function readAutomaticControls(ids: string[]) {
  const keys = new Map(ids.map(id => [reportKey(id), id]));
  const reports = await readCatalogReports<AutomaticControl>(keys.keys());
  return new Map([...reports].map(([key, report]) => [keys.get(key)!, report]));
}
export async function readAutomaticControlSchedules(ids: string[]) {
  const keys = new Map(ids.map(id => [reportKey(id), id]));
  const selected = [...keys.keys()];
  const schedules = new Map<string, AutomaticControlSchedule>();
  if (!selected.length) return schedules;
  const db = await hostingStorage();
  for (let offset = 0; offset < selected.length; offset += 500) {
    const batch = selected.slice(offset, offset + 500);
    const rows = await db.prepare(`
      SELECT cache_key, json_extract(data,'$.identity') AS identity,
        json_extract(data,'$.attemptedAt') AS attempted_at,
        json_extract(data,'$.attemptRevision') AS attempt_revision,
        json_extract(data,'$.checkedAt') AS checked_at,
        json_extract(data,'$.error') AS error
      FROM wordpress_catalog WHERE cache_key IN (${batch.map(() => "?").join(",")})
    `).all(...batch) as {
      cache_key: string; identity: string; attempted_at: string; attempt_revision: string | null;
      checked_at: string | null; error: string | null;
    }[];
    for (const row of rows) schedules.set(keys.get(row.cache_key)!, {
      identity: row.identity,
      attemptedAt: row.attempted_at,
      attemptRevision: row.attempt_revision ?? undefined,
      checkedAt: row.checked_at ?? undefined,
      error: row.error ?? undefined,
    });
  }
  return schedules;
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
