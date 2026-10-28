import { compare, major, minor, patch, satisfies, validRange } from "semver";
import { ApiError } from "../http";
import { dependencyRange, npmGraph, seedNpmCoordinatedVersion, remediationVersionLimit } from "./remediation";
import { packageCatalog, stableVersion } from "./versions";
import { safeVersions as screenedVersions } from "./advisories";

export type IndirectCandidate = { name: string; version: string; lock: string; paths: string[]; coordinated?: string[] };
export type IndirectEvaluation = { kind: "valid"; lock: string } | { kind: "incompatible" | "rejected" };

export const maxIndirectAttempts = 12;

export async function searchIndirectCompatibility(original: string, failed: string, names: string[], node: string, evaluate: (candidate: IndirectCandidate) => Promise<IndirectEvaluation>, transport: typeof fetch = fetch, notify: (message: string) => Promise<void> = async () => {}, budget = maxIndirectAttempts, attempted: () => void = () => {}, targets: string[] = []) {
  const graph = npmGraph(failed), baseline = npmGraph(original);
  const nameOf = (path: string, item: { name?: string }) => item.name || path.slice(path.lastIndexOf("node_modules/") + 13);
  const direct = new Set(graph.edges("").map(edge => edge.target)), incoming = new Map<string, string[]>(), fixedIncoming = new Map<string, string[]>();
  const peerConsumers = new Map<string, number>();
  for (const [path, item] of graph.nodes) for (const name of Object.keys(item.peerDependencies)) {
    const target = graph.resolve(path, name);
    if (target) peerConsumers.set(target, (peerConsumers.get(target) || 0) + 1);
  }
  for (const path of graph.nodes.keys()) for (const edge of graph.edges(path, true)) {
    incoming.set(edge.target, [...incoming.get(edge.target) || [], edge.range]);
    if (!path || direct.has(path)) fixedIncoming.set(edge.target, [...fixedIncoming.get(edge.target) || [], edge.range]);
  }
  const delta = (name: string) => {
    const newest = [...graph.nodes].filter(([path, item]) => path && nameOf(path, item) === name && stableVersion(item.version)).map(([, item]) => item.version!).sort((a, b) => compare(b, a))[0];
    const before = [...baseline.nodes].filter(([path, item]) => path && nameOf(path, item) === name && stableVersion(item.version)).map(([, item]) => item.version!).sort((a, b) => compare(b, a))[0];
    return newest && before ? [major(newest) - major(before), minor(newest) - minor(before), patch(newest) - patch(before)] : [0, 0, 0];
  };
  const ordered = [...new Set(names)].sort((a, b) => { const first = delta(a), second = delta(b); return second[0] - first[0] || second[1] - first[1] || second[2] - first[2] || a.localeCompare(b); });
  const plans = await Promise.all(ordered.slice(0, 6).map(async name => {
    const locations = [...graph.nodes].filter(([path, item]) => path && !direct.has(path) && (!targets.length || targets.includes(path)) && nameOf(path, item) === name && stableVersion(item.version) && incoming.has(path));
    const domain = (await packageCatalog(name, transport)).filter(item => {
      if (!item.dist?.tarball || !item.dist.integrity || item.engines?.node && (!validRange(item.engines.node) || !satisfies(node, item.engines.node))) return false;
      let publicArtifact = false;
      try { const url = new URL(item.dist.tarball); publicArtifact = url.origin === "https://registry.npmjs.org" && !url.username && !url.password && /^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/.test(item.dist.integrity); } catch {}
      const usable = publicArtifact && locations.some(([path, current]) => compare(item.version, current.version!) < 0 && (fixedIncoming.get(path) || []).every(range => { const declared = dependencyRange(range); return declared && satisfies(item.version, declared); }));
      return usable;
    }).slice(0, remediationVersionLimit).filter(item => !!seedNpmCoordinatedVersion(original, failed, name, item, targets));
    const newest = locations.map(([, item]) => item.version!).sort((a, b) => compare(b, a))[0], oldest = domain.at(-1)?.version;
    const span = newest && oldest ? [major(newest) - major(oldest), minor(newest) - minor(oldest), patch(newest) - patch(oldest)] : [-1, -1, -1];
    return { name, domain, span, peers: locations.reduce((sum, [path]) => sum + (peerConsumers.get(path) || 0), 0) };
  }));
  plans.sort((a, b) => b.peers - a.peers || b.span[0] - a.span[0] || b.span[1] - a.span[1] || b.span[2] - a.span[2] || a.name.localeCompare(b.name));
  let attempts = 0;
  for (const { name, domain } of plans) {
    const versions = await screenedVersions(name, domain, transport);
    let best: (IndirectCandidate & { lock: string }) | null = null;
    const tried = new Set<string>();
    while (attempts < budget) {
      const remaining = versions.filter(item => !tried.has(item.version));
      if (!remaining.length) break;
      // Compatibility is not monotonic across releases. Never discard all newer
      // versions because a middle release failed. Inspect the highest safe one.
      const selected = remaining[0], seed = seedNpmCoordinatedVersion(original, failed, name, selected, targets)!;
      const candidate = { name, version: selected.version, ...seed };
      tried.add(selected.version);
      attempts++;
      attempted();
      const packages = JSON.parse(seed.lock).packages;
      const companions = seed.coordinated.map(path => `${packages[path].name || nameOf(path, packages[path])} ${packages[path].version}`);
      await notify(`${name} ${selected.version}${companions.length ? " avec " + companions.join(", ") : ""} : essai indirect dans les plages actuelles ; installation stricte, scan et validation obligatoires (${attempts}/${budget}).`);
      const result = await evaluate(candidate);
      if (result.kind === "valid") { best = { ...candidate, lock: result.lock }; break; }
    }
    if (best) {
      await notify(`${name} ${best.version} : meilleure version validée parmi les essais indirects ; vérification finale de ce verrou.`);
      const final = await evaluate(best);
      if (final.kind !== "valid") throw new ApiError("Le verrou indirect retenu n’a pas reproduit sa validation. Aucune publication autorisée.", 422);
      return { name, version: best.version, lock: final.lock, attempts };
    }
    if (attempts >= budget) break;
  }
  return null;
}
