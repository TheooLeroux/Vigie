import { randomUUID } from "node:crypto";
import { database } from "./db";
export async function hostingStorage() {
  const db = database();
  (await db.initialize(`CREATE TABLE IF NOT EXISTS hosting_connections (id TEXT PRIMARY KEY,workspace TEXT NOT NULL CHECK(workspace='live'),endpoint TEXT NOT NULL,username TEXT NOT NULL,data TEXT NOT NULL,secret_cipher TEXT,UNIQUE(workspace,endpoint,username));
    CREATE TABLE IF NOT EXISTS hosting_installations (id TEXT PRIMARY KEY,workspace TEXT NOT NULL CHECK(workspace='live'),connection_id TEXT NOT NULL REFERENCES hosting_connections(id) ON DELETE CASCADE,scope TEXT NOT NULL,document_root TEXT NOT NULL,project_id TEXT,link_method TEXT,match_reason TEXT,data TEXT NOT NULL,UNIQUE(connection_id,scope,document_root),FOREIGN KEY(project_id,workspace) REFERENCES projects(id,workspace));
    CREATE INDEX IF NOT EXISTS hosting_installations_project ON hosting_installations(project_id);
    CREATE TABLE IF NOT EXISTS hosting_discovery_runs (connection_id TEXT NOT NULL REFERENCES hosting_connections(id) ON DELETE CASCADE,scope TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(connection_id,scope));
    CREATE TABLE IF NOT EXISTS hosting_site_inventories (installation_id TEXT PRIMARY KEY REFERENCES hosting_installations(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hosting_observers (installation_id TEXT PRIMARY KEY REFERENCES hosting_installations(id) ON DELETE CASCADE,secret_cipher TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wordpress_catalog (cache_key TEXT PRIMARY KEY,data TEXT NOT NULL,expires_at TEXT NOT NULL);`));
  return db;
}

export async function readCatalogReports<T>(keys: Iterable<string>, expiresAfter?: string) {
  const selected = [...new Set(keys)];
  const reports = new Map<string, T>();
  if (!selected.length) return reports;
  const db = await hostingStorage();
  for (let offset = 0; offset < selected.length; offset += 500) {
    const batch = selected.slice(offset, offset + 500);
    const rows = await db.prepare(`SELECT cache_key,data FROM wordpress_catalog WHERE cache_key IN (${batch.map(() => "?").join(",")})${expiresAfter ? " AND expires_at>?" : ""}`)
      .all(...batch, ...(expiresAfter ? [expiresAfter] : [])) as { cache_key: string; data: string }[];
    for (const row of rows) reports.set(row.cache_key, JSON.parse(row.data));
  }
  return reports;
}

export async function claimHostingObservation(scope: string, leaseMs = 10 * 60_000) {
  const db = await hostingStorage();
  const key = `hosting:observation:lease:${scope}`;
  const token = randomUUID();
  const now = Date.now();
  const claimed = await db.prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at WHERE wordpress_catalog.expires_at<=?")
    .run(key, token, new Date(now + leaseMs).toISOString(), new Date(now).toISOString());
  return claimed.changes ? async () => { await db.prepare("DELETE FROM wordpress_catalog WHERE cache_key=? AND data=?").run(key, token); } : null;
}
