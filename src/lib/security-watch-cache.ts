import { hostingStorage } from "./hosting-storage";
import type { SecurityWatchSnapshot } from "./security-watch";
import { securityWatch } from "./security-watch-data";

const cacheKey = "security-watch:snapshot:1:live";

export async function readSecurityWatchSnapshot(): Promise<SecurityWatchSnapshot | null> {
  try {
    const db = await hostingStorage();
    const row = await db.prepare("SELECT data FROM wordpress_catalog WHERE cache_key=? AND expires_at>?")
      .get(cacheKey, new Date().toISOString()) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  } catch {
    return null;
  }
}

export async function refreshSecurityWatchSnapshot(signal: AbortSignal) {
  const started = Date.now();
  const watch = await securityWatch("live", signal);
  if (signal.aborted || !watch.coverage) return;
  const snapshot: SecurityWatchSnapshot = { savedAt: new Date(started).toISOString(), watch };
  const db = await hostingStorage();
  await db.prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at WHERE wordpress_catalog.expires_at<excluded.expires_at")
    .run(cacheKey, JSON.stringify(snapshot), new Date(started + 24 * 60 * 60_000).toISOString());
}
