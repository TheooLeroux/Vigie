import { getCache } from "@vercel/functions";
import { claimHostingObservation, hostingStorage } from "./hosting-storage";
import { securityWatchSnapshotKey, type SecurityWatchSnapshot } from "./security-watch";
import { securityWatch } from "./security-watch-data";

const runtimeKey = "vigie:security-watch:1:live";
const refreshIntervalMs = 14 * 60_000;
type WatchEntry = { snapshot: SecurityWatchSnapshot; expiresAt: string };
type WatchCache = Pick<ReturnType<typeof getCache>, "get" | "set">;

function runtimeWatchCache(): WatchCache | undefined {
  if (process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production") return getCache();
}

export async function loadSecurityWatchSnapshot(minimumRevision?: string | null, cache = runtimeWatchCache()): Promise<{
  snapshot: SecurityWatchSnapshot | null;
  source: "cache" | "neon";
}> {
  if (cache && minimumRevision !== null) {
    const entry = await cache.get(runtimeKey).catch(() => null) as WatchEntry | null;
    const expires = Date.parse(entry?.expiresAt ?? "");
    if (entry?.snapshot?.watch && expires > Date.now() &&
      (!minimumRevision || expires >= Date.parse(minimumRevision))) {
      return { snapshot: entry.snapshot, source: "cache" };
    }
  }
  try {
    const db = await hostingStorage();
    const row = await db.prepare("SELECT data FROM wordpress_catalog WHERE cache_key=? AND expires_at>?")
      .get(securityWatchSnapshotKey, new Date().toISOString()) as { data: string } | undefined;
    return { snapshot: row ? JSON.parse(row.data) : null, source: "neon" };
  } catch {
    return { snapshot: null, source: "neon" };
  }
}

export async function readSecurityWatchSnapshot() {
  return (await loadSecurityWatchSnapshot()).snapshot;
}

export async function refreshSecurityWatchSnapshot(signal: AbortSignal, cache = runtimeWatchCache()) {
  if (signal.aborted) return;
  // A recently published snapshot covers this tick without acquiring a SQL lease.
  const cached = await cache?.get(runtimeKey).catch(() => null) as WatchEntry | null | undefined;
  const age = Date.now() - Date.parse(cached?.snapshot?.savedAt ?? "");
  if (cached?.snapshot?.watch?.coverage && age >= 0 && age < refreshIntervalMs &&
    Date.parse(cached.expiresAt) > Date.now()) return;
  if (signal.aborted) return;
  // The cron ticks every five minutes. Keep the lease across successful runs
  // to rebuild about every 15 minutes, allowing one minute of scheduling jitter.
  const release = await claimHostingObservation("security-watch", refreshIntervalMs);
  if (!release) return;
  let published = false;
  try {
    const started = Date.now();
    const watch = await securityWatch("live", signal);
    if (signal.aborted || !watch.coverage) return;
    const snapshot: SecurityWatchSnapshot = { savedAt: new Date(started).toISOString(), watch };
    const db = await hostingStorage();
    const expiresAt = new Date(started + 24 * 60 * 60_000).toISOString();
    const data = JSON.stringify(snapshot);
    const result = await db.prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at WHERE wordpress_catalog.expires_at<excluded.expires_at")
      .run(securityWatchSnapshotKey, data, expiresAt);
    published = true;
    // Only the publisher fills the cache. A reader that missed during publication
    // cannot overwrite the newer version with a snapshot it read earlier.
    if (result.changes && cache && Buffer.byteLength(data) < 1_950_000) {
      await cache.set(runtimeKey, { snapshot, expiresAt }, { ttl: 20 * 60, name: "Vigie · veille sécurité" })
        .catch(() => console.warn("Vigie : publication du cache Vercel indisponible."));
    }
  } finally {
    if (!published) await release();
  }
}
