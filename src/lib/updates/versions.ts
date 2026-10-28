import { compare, minVersion, rcompare, satisfies, validRange } from "semver";
import { ApiError } from "../http";
import type { PeerConflict } from "./process";
import { mapConcurrent, planningCatalog } from "./planning";

export class CompatibilitySelectionError extends ApiError {}

export type PackageVersion = { version: string; deprecated?: string; engines?: { node?: string }; peerDependencies?: Record<string, string>; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; dist?: { tarball?: string; integrity?: string }; bin?: string | Record<string, string>; hasInstallScript?: boolean; scripts?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; os?: string[]; cpu?: string[]; libc?: string[] };
export const stableVersion = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;

async function metadata(name: string, transport: typeof fetch, all = false) {
  return planningCatalog(`${name}:${all ? "all" : "latest"}`, transport, () => loadMetadata(name, transport, all));
}
async function loadMetadata(name: string, transport: typeof fetch, all: boolean) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await readMetadata(name, transport, all); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      if (attempt === 1) throw new ApiError(`La lecture du catalogue de ${name} a échoué après deux tentatives. Aucune version non vérifiée n’a été retenue.`, 502);
    }
  }
  throw new ApiError(`Le catalogue de ${name} est indisponible.`, 502);
}
async function readMetadata(name: string, transport: typeof fetch, all: boolean) {
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
  return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")), bytes: size };
}
export async function packageCatalog(name: string, transport: typeof fetch = fetch) {
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new ApiError("Nom de paquet invalide pour la remédiation.");
  const data = await metadata(name, transport, true);
  const latest = data["dist-tags"]?.latest || (await metadata(name, transport)).version;
  if (!stableVersion(latest) || !data.versions || typeof data.versions !== "object") throw new ApiError(`Le catalogue de remédiation de ${name} est invalide.`, 502);
  return (Object.values(data.versions) as PackageVersion[]).filter(item => stableVersion(item.version) && !item.deprecated && compare(item.version, latest) <= 0).sort((first, second) => rcompare(first.version, second.version));
}

export async function latestPackageVersion(name: string, transport: typeof fetch = fetch) {
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new ApiError("Nom de paquet invalide.");
  const data = await metadata(name, transport);
  if (!stableVersion(data.version) || data.deprecated) throw new ApiError("Dernière version stable non vérifiable.");
  return data.version as string;
}

export async function verifiedPeerConflicts(conflicts: PeerConflict[], selected: Record<string, string>, transport: typeof fetch = fetch) {
  const verified: PeerConflict[] = [], catalogs = new Map<string, PackageVersion[]>();
  for (const conflict of conflicts) {
    if (!Object.hasOwn(selected, conflict.peer) || !stableVersion(selected[conflict.peer]) || satisfies(selected[conflict.peer], conflict.range)) continue;
    if (!catalogs.has(conflict.consumer)) catalogs.set(conflict.consumer, await packageCatalog(conflict.consumer, transport));
    const consumer = catalogs.get(conflict.consumer)!.find(item => item.version === conflict.version);
    if (!consumer || consumer.peerDependencies?.[conflict.peer] !== conflict.range) throw new ApiError("Le catalogue npm ne confirme pas le conflit de pairs signalé. Recherche arrêtée.", 502);
    verified.push(conflict);
  }
  return verified;
}

export async function compatibleVersions(manifest: Record<string, any>, nodeVersion: string, transport: typeof fetch = fetch, extra: Record<string, string> = {}, limits: Record<string, string | string[]> = {}) {
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
  const usable = (name: string, item: PackageVersion) => stableVersion(item.version) && !item.deprecated && compare(item.version, floor(name)) >= 0 && (name !== "@types/node" || item.version.split(".")[0] === nodeVersion.split(".")[0]) && (!Object.hasOwn(limits, name) || [limits[name]].flat().every(range => satisfies(item.version, range))) && (!item.engines?.node || !!validRange(item.engines.node) && satisfies(nodeVersion, item.engines.node));
  const packageNames = [...ranges.keys()].sort();
  const heads = await mapConcurrent(packageNames, 8, name => metadata(name, transport) as Promise<PackageVersion>);
  for (const [index, name] of packageNames.entries()) {
    const item = heads[index];
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
  await mapConcurrent([...domains].filter(([, items]) => !items.length).map(([name]) => name), 8, expand);
  let chosen: Map<string, PackageVersion> | null = null;
  const pairCompatibility = new Map<string, boolean>();
  for (let round = 0; round <= domains.size; round++) {
    const conflicts = new Set<string>(), selected = new Map<string, PackageVersion>();
    const neighbors = new Map([...domains.keys()].map(name => [name, new Set<string>()]));
    for (const [name, candidates] of domains) for (const item of candidates) for (const peer of Object.keys(item.peerDependencies || {})) if (peer !== name && neighbors.has(peer)) {
      neighbors.get(name)!.add(peer); neighbors.get(peer)!.add(name);
    }
    const components: string[][] = [], remaining = new Set(domains.keys());
    while (remaining.size) {
      const pending = [remaining.values().next().value!], component: string[] = [];
      while (pending.length) {
        const name = pending.pop()!;
        if (!remaining.delete(name)) continue;
        component.push(name);
        pending.push(...neighbors.get(name)!);
      }
      components.push(component.sort((first, second) => domains.get(first)!.length - domains.get(second)!.length || first.localeCompare(second)));
    }
    let attempts = 0;
    function matches(name: string, item: PackageVersion, other: string, version: PackageVersion) {
      const range = item.peerDependencies && Object.hasOwn(item.peerDependencies, other) ? item.peerDependencies[other] : undefined;
      if (!range) return true;
      const key = JSON.stringify([range, version.version]);
      if (!pairCompatibility.has(key)) {
        if (pairCompatibility.size >= 100_000) pairCompatibility.clear();
        pairCompatibility.set(key, !!validRange(range) && satisfies(version.version, range));
      }
      if (pairCompatibility.get(key)) return true;
      conflicts.add(name); conflicts.add(other);
      return false;
    }
    function search(names: string[], index: number): boolean {
      if (++attempts > 30_000) throw new ApiError("La recherche de versions compatibles dépasse sa limite. Aucun changement n’a été publié.");
      if (index === names.length) return true;
      const name = names[index];
      for (const item of domains.get(name)!) {
        if ([...selected].some(([other, version]) => !matches(name, item, other, version) || !matches(other, version, name, item))) continue;
        if (names.slice(index + 1).some(other => !domains.get(other)!.some(version => matches(name, item, other, version) && matches(other, version, name, item)))) continue;
        selected.set(name, item);
        if (search(names, index + 1)) return true;
        selected.delete(name);
      }
      return false;
    }
    // Independent peer components cannot repair one another. Solving them
    // separately avoids an exponential product of unrelated version choices.
    let solved = true;
    for (const component of components) if (!search(component, 0)) solved = false;
    if (solved) { chosen = selected; break; }
    const changed = (await mapConcurrent([...conflicts].sort(), 8, expand)).some(Boolean);
    if (!changed) break;
  }
  if (!chosen) throw new CompatibilitySelectionError("Aucun ensemble de versions stables compatible avec Node et les dépendances du projet n’a été trouvé. Rien n’a été publié.");
  const versions = Object.fromEntries([...chosen].map(([name, item]) => [name, item.version]));
  for (const [name, item] of chosen) if (item.version !== latest.get(name)!.version) warnings.push(`${name} : ${item.version} retenue pour la compatibilité de l’ensemble (dernière publiée : ${latest.get(name)!.version}).`);
  for (const section of sections) for (const name of Object.keys(next[section] || {})) if (versions[name]) next[section][name] = versions[name];
  next.engines = { ...next.engines, node: nodeVersion };
  if (next.devEngines?.runtime) {
    if (Array.isArray(next.devEngines.runtime) || next.devEngines.runtime.name !== "node") throw new ApiError("La configuration des moteurs exige une adaptation manuelle.");
    next.devEngines.runtime.version = next.engines.node;
  }
  return { manifest: next, warnings, versions };
}
