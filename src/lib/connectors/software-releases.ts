import { database } from "../db";
import type { RailwayProject, SoftwareRelease } from "../railway-types";
import { compareVersions } from "./wordpress-catalog";
const NODE_INDEX = "https://nodejs.org/dist/index.json";
const NODE_SCHEDULE =
  "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
const CADDY_RELEASE =
  "https://api.github.com/repos/caddyserver/caddy/releases/latest";
const CADDY_SOURCE = "https://github.com/caddyserver/caddy/releases/latest";
type NodeRelease = {
  version: string;
  date: string;
  lts: string | false;
  security: boolean;
};
type NodeCatalog = {
  releases: NodeRelease[];
  schedule: Record<string, { start: string; end: string; lts?: string }>;
  checkedAt: string;
};
type CaddyCatalog = { version: string; checkedAt: string };
const unknown: SoftwareRelease = {
  state: "unknown",
  latestVersion: null,
  latestStable: null,
  latestLts: null,
  supported: null,
  supportEndsAt: null,
  securityUpdate: null,
  checkedAt: null,
  source: null,
};
const version = (v: unknown) =>
  typeof v === "string" && /^v?\d+\.\d+\.\d+$/.test(v)
    ? v.replace(/^v/, "")
    : null;
const date = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\d$/.test(v) &&
  !Number.isNaN(Date.parse(v));
async function json(url: string, limit: number, transport: typeof fetch) {
  const response = await transport(url, {
    redirect: "error",
    headers: { Accept: "application/json", "User-Agent": "Vigie/1.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok || !response.body) throw new Error("Catalogue indisponible");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Catalogue trop volumineux");
    }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function storage() {
  const db = database();
  (await db.initialize(
    "CREATE TABLE IF NOT EXISTS software_release_catalog(cache_key TEXT PRIMARY KEY,data TEXT NOT NULL,expires_at TEXT NOT NULL)",
  ));
  return db;
}
async function cached<T>(
  key: string,
  read: () => Promise<T>,
): Promise<T | null> {
  key += ":hourly:1"; // Do not reuse six-hour entries created before hourly control.
  const db = (await storage()),
    row = (await db
      .prepare(
        "SELECT data FROM software_release_catalog WHERE cache_key=? AND expires_at>?",
      )
      .get(key, new Date().toISOString())) as { data: string } | undefined;
  if (row) return JSON.parse(row.data) as T;
  try {
    const data = await read();
    (await db.prepare(
      "INSERT INTO software_release_catalog VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",
    ).run(
      key,
      JSON.stringify(data),
      new Date(Date.now() + 3600_000).toISOString(),
    ));
    return data;
  } catch {
    return null;
  }
}
async function nodeCatalog(
  transport: typeof fetch,
): Promise<NodeCatalog | null> {
  return cached("node:official", async () => {
    const [index, scheduleResult] = await Promise.allSettled([
      json(NODE_INDEX, 4_000_000, transport),
      json(NODE_SCHEDULE, 100_000, transport),
    ]);
    if (index.status !== "fulfilled" || scheduleResult.status !== "fulfilled")
      throw new Error("Catalogue indisponible");
    const raw = index.value,
      rawSchedule = scheduleResult.value;
    if (
      !Array.isArray(raw) ||
      raw.length > 10000 ||
      !rawSchedule ||
      typeof rawSchedule !== "object"
    )
      throw new Error("Catalogue invalide");
    const today = new Date().toISOString().slice(0, 10);
    const releases: NodeRelease[] = raw
      .filter(
        (r) =>
          version(r?.version) &&
          date(r.date) &&
          r.date <= today &&
          (r.lts === false || typeof r.lts === "string") &&
          typeof r.security === "boolean",
      )
      .map((r) => ({
        version: version(r.version)!,
        date: r.date,
        lts: r.lts,
        security: r.security,
      }));
    releases.sort((a, b) => compareVersions(b.version, a.version) || 0);
    const schedule: NodeCatalog["schedule"] = {};
    for (const [branch, rawEntry] of Object.entries(rawSchedule)) {
      const e = rawEntry as Record<string, unknown>;
      if (
        /^v\d+$/.test(branch) &&
        e &&
        date(e.start) &&
        date(e.end) &&
        (!e.lts || date(e.lts))
      )
        schedule[branch] = {
          start: e.start as string,
          end: e.end as string,
          ...(e.lts ? { lts: e.lts as string } : {}),
        };
    }
    if (!releases.length || !Object.keys(schedule).length)
      throw new Error("Catalogue incomplet");
    return { releases, schedule, checkedAt: new Date().toISOString() };
  });
}
async function caddyCatalog(
  transport: typeof fetch,
): Promise<CaddyCatalog | null> {
  return cached("caddy:official", async () => {
    const raw = await json(CADDY_RELEASE, 1_000_000, transport),
      v = version(raw?.tag_name);
    if (
      !v ||
      raw.draft !== false ||
      raw.prerelease !== false ||
      typeof raw.published_at !== "string" ||
      Number.isNaN(Date.parse(raw.published_at)) ||
      Date.parse(raw.published_at) > Date.now()
    )
      throw new Error("Publication Caddy invalide");
    return { version: v, checkedAt: new Date().toISOString() };
  });
}
export function nodeRelease(
  current: string,
  catalog: NodeCatalog | null,
): SoftwareRelease {
  if (!catalog) return { ...unknown, source: NODE_INDEX };
  const major = current.split(".")[0],
    today = new Date().toISOString().slice(0, 10),
    branch = catalog.schedule["v" + major];
  const same = catalog.releases.filter(
      (r) => r.version.split(".")[0] === major,
    ),
    latest = same[0];
  const supported = branch
    ? branch.start <= today && branch.end >= today
    : null;
  const lts = catalog.releases.find(
    (r) =>
      r.lts !== false &&
      catalog.schedule["v" + r.version.split(".")[0]]?.end >= today,
  );
  const comparison = latest ? compareVersions(latest.version, current) : null;
  return {
    state:
      comparison === null
        ? "unknown"
        : comparison > 0
          ? "available"
          : comparison === 0
            ? "current"
            : "ahead",
    latestVersion: latest?.version || null,
    latestStable: catalog.releases[0]?.version || null,
    latestLts: lts?.version || null,
    supported,
    supportEndsAt: branch?.end || null,
    securityUpdate: latest
      ? same.some(
          (r) => r.security && (compareVersions(r.version, current) || 0) > 0,
        )
      : null,
    checkedAt: catalog.checkedAt,
    source: NODE_INDEX,
  };
}
export async function nodeBranchInfo(
  branch: string,
  transport: typeof fetch = fetch,
): Promise<SoftwareRelease> {
  if (!/^\d+\.x$/.test(branch)) return { ...unknown };
  const data = await nodeCatalog(transport),
    release = nodeRelease(branch.split(".")[0] + ".0.0", data);
  // A major branch is not an observed patch version. Never manufacture a missing-patch warning.
  return { ...release, state: "unknown", securityUpdate: null };
}
export async function enrichRailwayReleases(
  projects: RailwayProject[],
  transport: typeof fetch = fetch,
): Promise<RailwayProject[]> {
  const names = new Set(
    projects.flatMap((p) =>
      p.services.flatMap((s) =>
        [...s.activeDeployments, s.latestDeployment].flatMap(
          (d) => d?.evidence?.packages.map((p) => p.name) || [],
        ),
      ),
    ),
  );
  const [node, caddy] = await Promise.all([
    names.has("node") ? nodeCatalog(transport) : null,
    names.has("caddy") ? caddyCatalog(transport) : null,
  ]);
  return projects.map((p) => ({
    ...p,
    services: p.services.map((s) => {
      const enrich = (d: typeof s.latestDeployment) =>
        d
          ? {
              ...d,
              evidence: d.evidence
                ? {
                    ...d.evidence,
                    packages: d.evidence.packages.map((pkg) => {
                      let release: SoftwareRelease = { ...unknown };
                      if (pkg.name === "node")
                        release = nodeRelease(pkg.version, node);
                      if (pkg.name === "caddy" && caddy) {
                        const c = compareVersions(caddy.version, pkg.version);
                        release = {
                          ...unknown,
                          state:
                            c === null
                              ? "unknown"
                              : c > 0
                                ? "available"
                                : c === 0
                                  ? "current"
                                  : "ahead",
                          latestVersion: caddy.version,
                          latestStable: caddy.version,
                          checkedAt: caddy.checkedAt,
                          source: CADDY_SOURCE,
                        };
                      }
                      return { ...pkg, release };
                    }),
                  }
                : null,
            }
          : null;
      return {
        ...s,
        latestDeployment: enrich(s.latestDeployment),
        activeDeployments: s.activeDeployments.map((d) => enrich(d)!),
      };
    }),
  }));
}
