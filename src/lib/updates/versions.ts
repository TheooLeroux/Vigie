import { compare, minVersion, rcompare, satisfies, validRange } from "semver";
import { ApiError } from "../http";

export type PackageVersion = { version: string; deprecated?: string; engines?: { node?: string }; peerDependencies?: Record<string, string> };
export const stableVersion = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;

async function metadata(name: string, transport: typeof fetch, all = false) {
  const response = await transport(`https://registry.npmjs.org/${encodeURIComponent(name)}${all ? "" : "/latest"}`, { headers: { Accept: all ? "application/vnd.npm.install-v1+json" : "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new ApiError(`Le catalogue de ${name} est indisponible. Aucune version n’a été choisie au hasard.`, 502);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 40_000_000) { await reader.cancel(); throw new ApiError(`Le catalogue de ${name} est trop volumineux.`, 502); }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function compatibleVersions(manifest: Record<string, any>, nodeVersion: string, transport: typeof fetch = fetch, extra: Record<string, string> = {}, limits: Record<string, string> = {}) {
  const next = structuredClone(manifest), warnings: string[] = [];
  const ranges = new Map<string, string[]>();
  for (const section of [...sections, "extra"] as const) for (const [name, range] of Object.entries(section === "extra" ? extra : manifest[section] || {})) {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || typeof range !== "string" || !validRange(range)) {
      warnings.push(`${name} : référence locale, privée ou particulière conservée.`);
      continue;
    }
    ranges.set(name, [...ranges.get(name) || [], range]);
  }
  if (ranges.size > 250) throw new ApiError("Le projet contient trop de dépendances directes pour cette validation automatique.");
  const domains = new Map<string, PackageVersion[]>(), latest = new Map<string, PackageVersion>(), expanded = new Set<string>();
  const floor = (name: string) => (ranges.get(name) || []).map(range => minVersion(range)?.version || "0.0.0").sort(rcompare)[0];
  const usable = (name: string, item: PackageVersion) => stableVersion(item.version) && !item.deprecated && compare(item.version, floor(name)) >= 0 && (name !== "@types/node" || item.version.split(".")[0] === nodeVersion.split(".")[0]) && (!Object.hasOwn(limits, name) || satisfies(item.version, limits[name])) && (!item.engines?.node || !!validRange(item.engines.node) && satisfies(nodeVersion, item.engines.node));
  for (const name of [...ranges.keys()].sort()) {
    const item = await metadata(name, transport) as PackageVersion;
    if (!stableVersion(item.version) || item.deprecated || compare(item.version, floor(name)) < 0) {
      warnings.push(`${name} : aucune version stable non dépréciée plus récente disponible ; version conservée.`);
      continue;
    }
    latest.set(name, item);
    domains.set(name, usable(name, item) ? [item] : []);
  }
  async function expand(name: string) {
    if (expanded.has(name)) return false;
    expanded.add(name);
    const data = await metadata(name, transport, true);
    if (!data.versions || typeof data.versions !== "object") throw new ApiError(`Le catalogue complet de ${name} est invalide.`, 502);
    const ceiling = latest.get(name)!.version;
    const candidates = (Object.values(data.versions) as PackageVersion[]).filter(item => usable(name, item) && compare(item.version, ceiling) <= 0).sort((first, second) => rcompare(first.version, second.version));
    domains.set(name, candidates);
    return true;
  }
  for (const [name, items] of domains) if (!items.length) await expand(name);
  let chosen: Map<string, PackageVersion> | null = null;
  for (let round = 0; round <= domains.size; round++) {
    const conflicts = new Set<string>(), selected = new Map<string, PackageVersion>();
    const names = [...domains.keys()].sort((first, second) => domains.get(first)!.length - domains.get(second)!.length || first.localeCompare(second));
    let attempts = 0;
    function matches(name: string, item: PackageVersion, other: string, version: PackageVersion) {
      const range = item.peerDependencies && Object.hasOwn(item.peerDependencies, other) ? item.peerDependencies[other] : undefined;
      if (!range) return true;
      if (validRange(range) && satisfies(version.version, range)) return true;
      conflicts.add(name); conflicts.add(other);
      return false;
    }
    function search(index: number): boolean {
      if (++attempts > 30_000) throw new ApiError("La recherche de versions compatibles dépasse sa limite. Aucun changement n’a été publié.");
      if (index === names.length) return true;
      const name = names[index];
      for (const item of domains.get(name)!) {
        if ([...selected].some(([other, version]) => !matches(name, item, other, version) || !matches(other, version, name, item))) continue;
        if (names.slice(index + 1).some(other => !domains.get(other)!.some(version => matches(name, item, other, version) && matches(other, version, name, item)))) continue;
        selected.set(name, item);
        if (search(index + 1)) return true;
        selected.delete(name);
      }
      return false;
    }
    if (search(0)) { chosen = selected; break; }
    let changed = false;
    for (const name of conflicts) if (await expand(name)) changed = true;
    if (!changed) break;
  }
  if (!chosen) throw new ApiError("Aucun ensemble de versions stables compatible avec Node et les dépendances du projet n’a été trouvé. Rien n’a été publié.");
  const versions = Object.fromEntries([...chosen].map(([name, item]) => [name, item.version]));
  for (const [name, item] of chosen) if (item.version !== latest.get(name)!.version) warnings.push(`${name} : ${item.version} retenue pour la compatibilité de l’ensemble (dernière publiée : ${latest.get(name)!.version}).`);
  for (const section of sections) for (const name of Object.keys(next[section] || {})) if (versions[name]) next[section][name] = versions[name];
  next.engines = { ...next.engines, node: `${nodeVersion.split(".")[0]}.x` };
  if (next.devEngines?.runtime) {
    if (Array.isArray(next.devEngines.runtime) || next.devEngines.runtime.name !== "node") throw new ApiError("La configuration des moteurs exige une adaptation manuelle.");
    next.devEngines.runtime.version = next.engines.node;
  }
  return { manifest: next, warnings, versions };
}
