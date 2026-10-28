import { hostingStorage } from "../hosting-storage";
import { compareVersions } from "./wordpress-catalog";
import type { SiteInventory } from "../types";
type Release = NonNullable<NonNullable<SiteInventory["php"]>["release"]>;
// Published support dates: https://www.php.net/supported-versions.php (22 Oct 2026).
const supportEnd: Record<string, string> = {
  "8.2": "2026-12-31",
  "8.3": "2027-12-31",
  "8.4": "2028-12-31",
  "8.5": "2029-12-31",
};
export async function enrichPhpRelease(
  snapshot: SiteInventory,
  transport: typeof fetch = fetch,
): Promise<SiteInventory> {
  const php = snapshot.php;
  if (!php) return snapshot;
  const branch = php.version.match(/^(\d+\.\d+)\./)?.[1];
  if (!branch) return snapshot;
  const db = (await hostingStorage()),
    key = "php:" + branch + ":hourly:1";
  let metadata: {
    latestVersion: string;
    securityRelease: boolean;
    upstreamSupported: boolean | null;
    checkedAt: string;
  } | null = null;
  const cached = (await db
    .prepare(
      "SELECT data FROM wordpress_catalog WHERE cache_key=? AND expires_at>?",
    )
    .get(key, new Date().toISOString())) as { data: string } | undefined;
  if (cached) metadata = JSON.parse(cached.data);
  else
    try {
      const url = new URL("https://www.php.net/releases/index.php");
      url.searchParams.set("json", "");
      url.searchParams.set("version", branch);
      const r = await transport(url.href, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
      });
      if (!r.ok) return snapshot;
      const reader = r.body?.getReader();
      if (!reader) return snapshot;
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 200_000) {
          await reader.cancel();
          return snapshot;
        }
        chunks.push(value);
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        typeof raw.version !== "string" ||
        !raw.version.startsWith(branch + ".") ||
        !/^\d+\.\d+\.\d+$/.test(raw.version)
      )
        return snapshot;
      metadata = {
        latestVersion: raw.version,
        securityRelease:
          Array.isArray(raw.tags) && raw.tags.includes("security"),
        upstreamSupported: Array.isArray(raw.supported_versions)
          ? raw.supported_versions.includes(branch)
          : null,
        checkedAt: new Date().toISOString(),
      };
      (await db.prepare(
        "INSERT INTO wordpress_catalog VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",
      ).run(
        key,
        JSON.stringify(metadata),
        new Date(Date.now() + 3600_000).toISOString(),
      ));
    } catch {
      return snapshot;
    }
  if (!metadata) return snapshot;
  const comparison = compareVersions(metadata.latestVersion, php.version);
  const release: Release = {
    ...metadata,
    updateAvailable: comparison === null ? null : comparison > 0,
    supportEndsAt: supportEnd[branch] || null,
  };
  return { ...snapshot, php: { ...php, release } };
}
