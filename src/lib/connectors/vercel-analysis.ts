import { database } from "../db";
import { compareVersions } from "./wordpress-catalog";
import type { VercelAnalysis, VercelTechnology } from "../vercel-types";

// Only these public packages may be queried. Never use a name/URL from logs.
const packages = new Set([
  "next",
  "vite",
  "react",
  "react-dom",
  "nuxt",
  "astro",
  "@sveltejs/kit",
  "svelte",
  "typescript",
  "npm",
  "pnpm",
  "yarn",
]);
const frameworkPackages = new Set([
  "next",
  "vite",
  "nuxt",
  "astro",
  "@sveltejs/kit",
]);
const tools = new Set(["npm", "pnpm", "yarn"]);
const exact = "(\\d+\\.\\d+\\.\\d+)(?![\\w.+-])";
const patterns: [string, RegExp][] = [
  [
    "next",
    new RegExp(
      `^(?:Detected Next\\.js version:|[▲△] Next\\.js|Next\\.js)\\s+${exact}$`,
      "i",
    ),
  ],
  ["vite", new RegExp(`^vite v${exact} building\\b`, "i")],
  ["astro", new RegExp(`^astro v${exact}(?:\\s|$)`, "i")],
  ["nuxt", new RegExp(`^Nuxt ${exact}(?:\\s|$)`, "i")],
  ...[...packages].map((name): [string, RegExp] => [
    name,
    new RegExp(
      `^\\+?\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${exact}(?:\\s|$)`,
    ),
  ]),
  ...[...tools].map((name): [string, RegExp] => [
    name,
    new RegExp(`^Using ${name}@${exact}(?:\\s|$)`, "i"),
  ]),
];

export function runtimeEvidence(meta: unknown): VercelAnalysis["runtimes"] {
  let raw: any = meta;
  try {
    if (typeof raw === "string" && raw.length < 20_000) raw = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw).flatMap(([name, count]) =>
    /^(?:nodejs(?:\d+\.x)?|edge|python(?:\d+(?:\.\d+)?)?|go(?:\d+(?:\.\d+)?)?|ruby(?:\d+(?:\.\d+)?)?|bun(?:\d+(?:\.\d+)?)?)$/.test(
      name,
    ) &&
    Number.isSafeInteger(count) &&
    (count as number) > 0 &&
    (count as number) < 100_000
      ? [{ name, functions: count as number }]
      : [],
  );
}

export function analyzeVercelBuild(
  raw: unknown,
  runtimes: VercelAnalysis["runtimes"] = [],
): VercelAnalysis {
  const valid = Array.isArray(raw) && raw.length <= 1000;
  const technologies: VercelTechnology[] = [];
  const languages = new Set<string>();
  if (runtimes.some((r) => /^(nodejs|edge|bun)/.test(r.name)))
    languages.add("JavaScript / TypeScript");
  for (const r of runtimes) {
    if (r.name.startsWith("python")) languages.add("Python");
    if (r.name.startsWith("ruby")) languages.add("Ruby");
    if (r.name.startsWith("go")) languages.add("Go");
  }
  for (const e of valid ? raw : []) {
    if (!e || (e.type !== "stdout" && e.type !== "stderr")) continue;
    const value = e.text ?? e.payload?.text;
    if (typeof value !== "string" || value.length > 20_000) continue;
    // Do not retain text, commands, paths, environment variables or arbitrary package names.
    for (const line of value.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
      const text = line.trim();
      for (const [name, pattern] of patterns) {
        const m = pattern.exec(text);
        if (
          m &&
          !technologies.some((p) => p.name === name && p.version === m[1])
        )
          technologies.push({
            name,
            version: m[1],
            usage: frameworkPackages.has(name)
              ? "framework"
              : tools.has(name)
                ? "tool"
                : name === "typescript"
                  ? "build"
                  : "dependency",
            source: "build-log",
          });
      }
      if (
        /^(?:Running TypeScript(?: \.\.\.)?|.*Checking validity of types)\s*$/.test(
          text,
        )
      )
        languages.add("TypeScript (vérification de types)");
    }
  }
  if (
    technologies.some(
      (p) => frameworkPackages.has(p.name) || p.name === "react",
    )
  )
    languages.add("JavaScript / TypeScript");
  return {
    status: valid ? "observed" : "unavailable",
    checkedAt: new Date().toISOString(),
    truncated: valid && raw.length === 1000,
    languages: [...languages],
    runtimes,
    technologies,
  };
}

export async function enrichVercelTechnologies(
  analyses: VercelAnalysis[],
  transport: typeof fetch,
) {
  const db = database();
  db.exec(
    "CREATE TABLE IF NOT EXISTS software_release_catalog(cache_key TEXT PRIMARY KEY,data TEXT NOT NULL,expires_at TEXT NOT NULL)",
  );
  for (const name of new Set(
    analyses.flatMap((a) => a.technologies.map((t) => t.name)),
  )) {
    if (!packages.has(name)) continue;
    const key = `npm:public:${name}`;
    let catalog: { version: string; checkedAt: string } | null = null;
    const row = db
      .prepare(
        "SELECT data FROM software_release_catalog WHERE cache_key=? AND expires_at>?",
      )
      .get(key, new Date().toISOString()) as { data: string } | undefined;
    if (row) catalog = JSON.parse(row.data);
    else
      try {
        const response = await transport(
          `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
          {
            method: "GET",
            redirect: "error",
            headers: { Accept: "application/json", "User-Agent": "Vigie/1.0" },
            signal: AbortSignal.timeout(12_000),
          },
        );
        if (!response.ok || !response.body) throw new Error();
        const reader = response.body.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 500_000) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(part.value);
        }
        const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (raw.name !== name || !/^\d+\.\d+\.\d+$/.test(raw.version))
          throw new Error();
        catalog = { version: raw.version, checkedAt: new Date().toISOString() };
        db.prepare(
          "INSERT INTO software_release_catalog VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",
        ).run(
          key,
          JSON.stringify(catalog),
          new Date(Date.now() + 6 * 3600_000).toISOString(),
        );
      } catch {
        /* A registry outage must not erase observed versions. */
      }
    for (const t of analyses
      .flatMap((a) => a.technologies)
      .filter((t) => t.name === name)) {
      const c = catalog ? compareVersions(catalog.version, t.version) : null;
      t.latestVersion = catalog?.version || null;
      t.checkedAt = catalog?.checkedAt || null;
      t.update =
        c === null
          ? "unknown"
          : c > 0
            ? "available"
            : c === 0
              ? "current"
              : "ahead";
    }
  }
}
