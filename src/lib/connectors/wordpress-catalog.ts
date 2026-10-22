import { hostingStorage } from "../hosting-storage";
import type { UpdateInfo } from "../types";
export const unknownUpdate = (): UpdateInfo => ({
  latestVersion: null,
  updateState: "unknown",
  updateCheckedAt: null,
  updateSource: null,
});
export function compareVersions(a: string, b: string): number | null {
  if (!/^\d+(?:\.\d+)*$/.test(a) || !/^\d+(?:\.\d+)*$/.test(b)) return null;
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] || 0) !== (right[i] || 0))
      return (left[i] || 0) > (right[i] || 0) ? 1 : -1;
  }
  return 0;
}
const pending = new Map<
  string,
  Promise<{ version: string | null; checkedAt: string; found: boolean }>
>();
export async function catalogUpdate(
  kind: "plugin" | "theme" | "core",
  slug: string,
  installed: string | null,
  transport: typeof fetch = fetch,
): Promise<UpdateInfo> {
  if (!/^[a-z0-9][a-z0-9_.-]{0,150}$/.test(slug) || !installed)
    return unknownUpdate();
  const key = `${kind}:${slug}`,
    db = (await hostingStorage());
  const cached = (await db
    .prepare(
      "SELECT data FROM wordpress_catalog WHERE cache_key=? AND expires_at>?",
    )
    .get(key, new Date().toISOString())) as { data: string } | undefined;
  async function fetchMetadata() {
    const checkedAt = new Date().toISOString();
    let url: URL;
    if (kind === "core") {
      url = new URL("https://api.wordpress.org/core/version-check/1.7/");
      url.searchParams.set("version", installed!);
      url.searchParams.set("locale", "fr_FR");
    } else {
      url = new URL(
        `https://api.wordpress.org/${kind === "plugin" ? "plugins" : "themes"}/info/1.2/`,
      );
      url.searchParams.set(
        "action",
        kind === "plugin" ? "plugin_information" : "theme_information",
      );
      url.searchParams.set("request[slug]", slug);
      for (const field of [
        "sections",
        "description",
        "reviews",
        "screenshots",
        "banners",
        "icons",
        "contributors",
        "ratings",
        "tags",
        "homepage",
        "download_link",
      ])
        url.searchParams.set(`request[fields][${field}]`, "0");
    }
    let answer = { version: null as string | null, checkedAt, found: false };
    try {
      const r = await transport(url.href, {
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
        headers: { Accept: "application/json" },
      });
      if (!r.ok) return answer;
      const reader = r.body?.getReader();
      if (!reader) return answer;
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_000_000) {
          await reader.cancel();
          return answer;
        }
        chunks.push(value);
      }
      const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let version: unknown;
      if (kind === "core")
        version = Array.isArray(json.offers)
          ? json.offers
              .filter((o: { response?: string }) =>
                ["upgrade", "latest"].includes(o.response || ""),
              )
              .map((o: { current?: string }) => o.current)
              .filter((v: unknown) => typeof v === "string")
              .sort((a: string, b: string) => compareVersions(b, a) || 0)[0]
          : null;
      else if (json.slug === slug) version = json.version;
      if (
        typeof version === "string" &&
        /^[0-9][0-9a-zA-Z.+_-]{0,80}$/.test(version)
      )
        answer = { version, checkedAt, found: true };
      // Cache only parsed responses, including a genuine missing catalogue entry.
      (await db.prepare(
        "INSERT INTO wordpress_catalog VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",
      ).run(
        key,
        JSON.stringify(answer),
        new Date(Date.now() + 6 * 3600_000).toISOString(),
      ));
    } catch {
      /* Unavailable catalogues must never turn into a green status. */
    }
    return answer;
  }
  let metadata: Awaited<ReturnType<typeof fetchMetadata>>;
  if (cached) metadata = JSON.parse(cached.data);
  else {
    let promise = pending.get(key);
    if (!promise) {
      promise = fetchMetadata();
      pending.set(key, promise);
    }
    try {
      metadata = await promise;
    } finally {
      pending.delete(key);
    }
  }
  const comparison = metadata.version
    ? compareVersions(metadata.version, installed)
    : null;
  return {
    latestVersion: metadata.version,
    updateCheckedAt: metadata.checkedAt,
    updateSource: "wordpress.org",
    updateState:
      comparison === null
        ? "unknown"
        : comparison > 0
          ? "available"
          : comparison === 0
            ? "current"
            : "ahead",
  };
}
