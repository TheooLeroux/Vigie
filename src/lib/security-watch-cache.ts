import { claimHostingObservation, hostingStorage } from "./hosting-storage";
import { securityWatchSnapshotKey, type SecurityWatchSnapshot } from "./security-watch";
import { securityWatch } from "./security-watch-data";

export async function readSecurityWatchSnapshot(): Promise<SecurityWatchSnapshot | null> {
  try {
    const db = await hostingStorage();
    const row = await db.prepare("SELECT data FROM wordpress_catalog WHERE cache_key=? AND expires_at>?")
      .get(securityWatchSnapshotKey, new Date().toISOString()) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  } catch {
    return null;
  }
}

export async function refreshSecurityWatchSnapshot(signal: AbortSignal) {
  if (signal.aborted) return;
  // The cron ticks every five minutes. Keep the lease across successful runs
  // to rebuild about every 15 minutes, allowing one minute of scheduling jitter.
  const release = await claimHostingObservation("security-watch", 14 * 60_000);
  if (!release) return;
  let published = false;
  try {
    const started = Date.now();
    const watch = await securityWatch("live", signal);
    if (signal.aborted || !watch.coverage) return;
    const snapshot: SecurityWatchSnapshot = { savedAt: new Date(started).toISOString(), watch };
    const db = await hostingStorage();
    await db.prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at WHERE wordpress_catalog.expires_at<excluded.expires_at")
      .run(securityWatchSnapshotKey, JSON.stringify(snapshot), new Date(started + 24 * 60 * 60_000).toISOString());
    published = true;
  } finally {
    if (!published) await release();
  }
}
