import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, minVersion, satisfies, validRange } from "semver";
import { z } from "zod";
import { ApiError } from "../http";
import { runCommand } from "./process";
import { packageCatalog, stableVersion, type PackageVersion } from "./versions";
import type { SecurityFinding } from "./types";
import { mapConcurrent } from "./planning";
import { safeVersions as verifiedSafeVersions } from "./advisories";

export const remediationVersionLimit = 256;

const dependencyMap = z.record(z.string(), z.string()).default({});
const lockSchema = z.object({ lockfileVersion: z.union([z.literal(2), z.literal(3)]), packages: z.record(z.string(), z.object({ name: z.string().optional(), version: z.string().optional(), link: z.boolean().optional(), resolved: z.string().optional(), integrity: z.string().optional(), dependencies: dependencyMap, devDependencies: dependencyMap, optionalDependencies: dependencyMap, peerDependencies: dependencyMap }).passthrough()) }).passthrough();
const sections = ["dependencies", "devDependencies", "optionalDependencies"];
const packageName = (path: string) => path.slice(path.lastIndexOf("node_modules/") + 13);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([first], [second]) => first.localeCompare(second)).map(([key, entry]) => JSON.stringify(key) + ":" + canonical(entry)).join(",") + "}";
  return JSON.stringify(value);
}
export function dependencyRange(range: string) {
  const value = range.startsWith("npm:") ? range.slice(range.lastIndexOf("@") + 1) : range;
  return validRange(value) ? value : null;
}
export function npmGraph(raw: string) {
  const lock = lockSchema.parse(JSON.parse(raw));
  if (!lock.packages[""] || Object.keys(lock.packages).length > 15000) throw new ApiError("Le graphe npm est incomplet ou trop volumineux pour la remédiation.");
  const nodes = new Map(Object.entries(lock.packages));
  for (const [path, node] of nodes) if (node.link || path && !/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i.test(path)) throw new ApiError("La remédiation npm ne prend pas en charge les liens ou chemins particuliers.");
  function resolve(parent: string, name: string) {
    for (let directory = parent;;) {
      const path = (directory ? directory + "/" : "") + "node_modules/" + name;
      if (nodes.has(path)) return path;
      if (!directory) return null;
      const boundary = directory.lastIndexOf("/node_modules/");
      directory = boundary < 0 ? "" : directory.slice(0, boundary);
    }
  }
  function edges(path: string, peers = false) {
    const node = nodes.get(path)!;
    return Object.entries({ ...(peers ? node.peerDependencies : {}), ...node.dependencies, ...(!path ? node.devDependencies : {}), ...node.optionalDependencies }).flatMap(([name, range]) => {
      const target = resolve(path, name);
      return target ? [{ name, range, target }] : [];
    });
  }
  function paths(name: string, version: string) {
    const result: string[][] = [];
    const parents = new Map<string, string[]>();
    for (const location of nodes.keys()) for (const edge of edges(location, true)) parents.set(edge.target, [...parents.get(edge.target) || [], location]);
    const queue = [...nodes].filter(([location, item]) => location && (item.name || packageName(location)) === name && item.version === version).map(([location]) => [location]);
    let visits = 0;
    while (queue.length) {
      if (++visits > 20000 || result.length > 100) throw new ApiError("Le graphe contient trop de chemins de dépendances pour cette recherche bornée.");
      const path = queue.shift()!, current = path[0];
      if (!current) { result.push(path.slice(1)); continue; }
      if (path.length > 30) throw new ApiError("Le graphe de dépendances est trop profond pour cette remédiation.");
      for (const parent of parents.get(current) || []) if (!path.includes(parent)) queue.push([parent, ...path]);
    }
    return result;
  }
  return { nodes, resolve, edges, paths };
}
function publicNpmArtifact(node: { resolved?: string; integrity?: string }) {
  try {
    const url = new URL(node.resolved || "");
    return url.origin === "https://registry.npmjs.org" && !url.username && !url.password && !!node.integrity && /^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/.test(node.integrity);
  } catch { return false; }
}
export function validateNpmProposal(before: string, after: string) {
  const original = npmGraph(before), proposed = npmGraph(after);
  const rootBefore = original.nodes.get("")!, rootAfter = proposed.nodes.get("")!;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const left = rootBefore[section] || {}, right = rootAfter[section] || {};
    if (JSON.stringify(Object.entries(left).sort()) !== JSON.stringify(Object.entries(right).sort())) throw new ApiError("La correction indirecte a modifié les dépendances directes sans validation.");
  }
  for (const [path, node] of proposed.nodes) {
    if (!path) continue;
    const previous = original.nodes.get(path);
    if ((!previous || previous.version !== node.version) && !stableVersion(node.version)) throw new ApiError("La remédiation a sélectionné une version non stable.");
    const artifactChanged = !previous || previous.version !== node.version || previous.resolved !== node.resolved || previous.integrity !== node.integrity;
    if (artifactChanged && !publicNpmArtifact(node)) throw new ApiError("Le correctif indirect ne fournit pas une origine npm publique et une intégrité vérifiable.");
    for (const edge of proposed.edges(path)) {
      const range = dependencyRange(edge.range), installed = proposed.nodes.get(edge.target)?.version;
      if (!range || !installed || !satisfies(installed, range)) throw new ApiError(`La correction de ${edge.name} sort des contraintes déclarées par ${node.name || packageName(path)}. Aucun override automatique autorisé.`);
    }
  }
  for (const edge of original.edges("")) {
    const previous = original.nodes.get(edge.target), next = proposed.nodes.get(proposed.resolve("", edge.name) || "");
    if (previous?.version !== next?.version) throw new ApiError("Une correction indirecte ne peut pas changer silencieusement une version directe.");
  }
}
export function npmChangedIndirectPackages(before: string, after: string) {
  const candidate = npmGraph(after), versions = new Map<string, Set<string>>();
  let original: ReturnType<typeof npmGraph>;
  try { original = npmGraph(before); }
  catch (error) { if (error instanceof ApiError || error instanceof z.ZodError || error instanceof SyntaxError) return []; throw error; }
  for (const [path, item] of original.nodes) if (path && item.version) {
    const name = item.name || packageName(path);
    versions.set(name, new Set([...(versions.get(name) || []), item.version]));
  }
  const direct = new Set(candidate.edges("").map(edge => edge.target));
  return [...new Set([...candidate.nodes].flatMap(([path, item]) => {
    const previous = versions.get(item.name || packageName(path));
    return path && !direct.has(path) && item.version && (!previous || !previous.has(item.version)) ? [item.name || packageName(path)] : [];
  }))].sort();
}
export function npmIndirectVersionsChanged(before: string, after: string) {
  return npmChangedIndirectPackages(before, after).length > 0;
}
export function seedNpmIndirectVersions(before: string, after: string, names: string[]) {
  const original = npmGraph(before), candidate = npmGraph(after), direct = new Set(candidate.edges("").map(edge => edge.target));
  const incoming = new Map<string, string[]>();
  for (const path of candidate.nodes.keys()) for (const edge of candidate.edges(path, true)) incoming.set(edge.target, [...incoming.get(edge.target) || [], edge.range]);
  const proposed = JSON.parse(after);
  let changed = false;
  for (const [path, current] of candidate.nodes) {
    const name = current.name || packageName(path), ranges = incoming.get(path);
    if (!path || direct.has(path) || !names.includes(name) || !stableVersion(current.version) || !ranges?.length) continue;
    const previous = [...original.nodes].filter(([location, item]) => location && (item.name || packageName(location)) === name && stableVersion(item.version) && compare(item.version!, current.version!) < 0 && publicNpmArtifact(item) && ranges.every(range => { const declared = dependencyRange(range); return declared && satisfies(item.version!, declared); })).map(([, item]) => item).sort((first, second) => compare(second.version!, first.version!))[0];
    if (previous) { proposed.packages[path] = previous; changed = true; }
  }
  return changed ? JSON.stringify(proposed) + "\n" : null;
}
export function seedNpmCatalogVersion(raw: string, name: string, item: PackageVersion, locations: string[] = [], coordinateParents = false) {
  if (!stableVersion(item.version) || item.deprecated || !publicNpmArtifact({ resolved: item.dist?.tarball, integrity: item.dist?.integrity })) return null;
  const graph = npmGraph(raw), direct = new Set(graph.edges("").map(edge => edge.target)), incoming = new Map<string, { parent: string; range: string }[]>();
  for (const path of graph.nodes.keys()) for (const edge of graph.edges(path, true)) incoming.set(edge.target, [...incoming.get(edge.target) || [], { parent: path, range: edge.range }]);
  const proposed = JSON.parse(raw), paths: string[] = [];
  for (const [path, current] of graph.nodes) {
    const ranges = incoming.get(path);
    if (!path || direct.has(path) || locations.length && !locations.includes(path) || (current.name || packageName(path)) !== name || !ranges?.length || !stableVersion(current.version) || compare(item.version, current.version) >= 0 || !ranges.every(edge => { const declared = dependencyRange(edge.range); return coordinateParents && !!edge.parent && !direct.has(edge.parent) || declared && satisfies(item.version, declared); })) continue;
    const replacement = { ...current, version: item.version, resolved: item.dist!.tarball, integrity: item.dist!.integrity, dependencies: item.dependencies || {}, optionalDependencies: item.optionalDependencies || {}, peerDependencies: item.peerDependencies || {}, peerDependenciesMeta: item.peerDependenciesMeta || {}, engines: item.engines || {}, hasInstallScript: !!item.hasInstallScript || ["preinstall", "install", "postinstall"].some(script => !!item.scripts?.[script]), bin: typeof item.bin === "string" ? { [name.split("/").at(-1)!]: item.bin } : item.bin || {} };
    for (const field of ["os", "cpu", "libc"] as const) {
      delete (replacement as Record<string, unknown>)[field];
      if (item[field]) (replacement as Record<string, unknown>)[field] = item[field];
    }
    proposed.packages[path] = replacement;
    paths.push(path);
  }
  return paths.length ? { lock: JSON.stringify(proposed) + "\n", paths } : null;
}
export function seedNpmCoordinatedVersion(originalRaw: string, failed: string, name: string, item: PackageVersion, targets: string[] = []) {
  const original = npmGraph(originalRaw), initial = npmGraph(failed), direct = new Set(initial.edges("").map(edge => edge.target));
  const first = seedNpmCatalogVersion(failed, name, item, targets, true);
  if (!first) return null;
  const proposed = JSON.parse(failed), seeded = JSON.parse(first.lock), changed = new Set(first.paths);
  for (const path of first.paths) proposed.packages[path] = seeded.packages[path];
  const tried = new Set<string>();
  for (let round = 0; round < 12; round++) {
    const graph = npmGraph(JSON.stringify(proposed));
    // npm may create nested copies for normal dependencies. Visible peer assignments
    // must be coordinated here; the complete resolved graph is checked afterwards.
    const conflict = [...graph.nodes.keys()].flatMap(path => graph.edges(path, true).filter(edge => changed.has(edge.target)).map(edge => ({ parent: path, ...edge }))).find(edge => {
      const parent = graph.nodes.get(edge.parent)!, peer = parent.peerDependencies[edge.name];
      if (edge.parent && !peer) return false;
      const range = dependencyRange(peer || edge.range), version = graph.nodes.get(edge.target)?.version;
      return !range || !version || !satisfies(version, range);
    });
    if (!conflict) return { lock: JSON.stringify(proposed) + "\n", paths: first.paths, coordinated: [...changed].filter(path => !first.paths.includes(path)) };
    if (!conflict.parent || direct.has(conflict.parent) || first.paths.includes(conflict.parent)) return null;
    const parent = graph.nodes.get(conflict.parent)!, parentName = parent.name || packageName(conflict.parent), targetVersion = graph.nodes.get(conflict.target)!.version!;
    const choices = [...original.nodes].filter(([path, value]) => path && (value.name || packageName(path)) === parentName && stableVersion(value.version) && publicNpmArtifact(value) && !tried.has(`${conflict.parent}@${value.version}`)).map(([, value]) => value).sort((a, b) => compare(b.version!, a.version!));
    const replacement = choices.find(value => {
      const range = value.peerDependencies[conflict.name];
      const declared = range && dependencyRange(range);
      return !range || !!declared && satisfies(targetVersion, declared);
    });
    if (!replacement) return null;
    tried.add(`${conflict.parent}@${replacement.version}`);
    proposed.packages[conflict.parent] = replacement;
    changed.add(conflict.parent);
  }
  return null;
}
export function npmCoordinationCandidates(raw: string, findings: SecurityFinding[]) {
  const graph = npmGraph(raw), versions = new Map<string, Set<string>>();
  for (const [path, item] of graph.nodes) if (path && stableVersion(item.version)) {
    const name = item.name || packageName(path);
    versions.set(name, new Set([...(versions.get(name) || []), item.version]));
  }
  const candidates = new Set<string>();
  for (const finding of findings) for (const path of graph.paths(finding.package, finding.version)) for (const location of path.slice(0, -1)) {
    const item = graph.nodes.get(location)!, name = item.name || packageName(location);
    if ((versions.get(name)?.size || 0) > 1) candidates.add(name);
  }
  return [...candidates].sort();
}
export type RemediationDecision = { kind: "lock"; roots: string[]; messages: string[] } | { kind: "balance"; roots: string[]; messages: string[] } | { kind: "parents"; constraints: Map<string, Record<string, string>>; messages: string[] };
class RejectedNpmProposal extends Error {}
export function createNodeRemediator(transport: typeof fetch = fetch, execute = runCommand) {
  const catalogs = new Map<string, Promise<PackageVersion[]>>();
  const safe = new Map<string, Promise<PackageVersion[]>>();
  type Route = { graph: ReturnType<typeof npmGraph>; path: string[]; alert: SecurityFinding };
  const history = new Map<string, Map<string, Route>>();
  const catalog = (name: string) => {
    if (!catalogs.has(name)) catalogs.set(name, packageCatalog(name, transport));
    return catalogs.get(name)!;
  };
  const usable = (item: PackageVersion, node: string) => !item.engines?.node || !!validRange(item.engines.node) && satisfies(node, item.engines.node);
  function safeVersions(name: string, node: string, minimum: string) {
    const key = `${name}@${minimum}:${node}`;
    if (!safe.has(key)) safe.set(key, (async () => {
      const candidates = (await catalog(name)).filter(item => compare(item.version, minimum) >= 0 && usable(item, node)).slice(0, remediationVersionLimit);
      return verifiedSafeVersions(name, candidates, transport);
    })());
    return safe.get(key)!;
  }
  async function inPlace(manifest: string, lock: string, ids: string[]) {
    const temporary = await mkdtemp(join(tmpdir(), "vigie-remediate-"));
    try {
      const path = join(temporary, "package-lock.json");
      await writeFile(path, lock);
      await writeFile(join(temporary, "package.json"), manifest);
      const output = await execute("osv-scanner", ["fix", "--strategy=in-place", "--format=json", "--data-source=native", "--no-introduce", ...ids.flatMap(id => ["--vulns", id]), "--lockfile", path], { cwd: temporary, env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, npm_config_ignore_scripts: "true", npm_config_strict_peer_deps: "true", npm_config_legacy_peer_deps: "false", npm_config_force: "false", npm_config_engine_strict: "true", npm_config_registry: "https://registry.npmjs.org" }, acceptedExitCodes: [1], timeout: 180000 });
      try { JSON.parse(output); } catch { throw new ApiError("OSV n’a pas confirmé sa proposition de correction.", 502); }
      if (await readFile(join(temporary, "package.json"), "utf8") !== manifest) throw new RejectedNpmProposal("La correction indirecte a tenté de modifier le manifeste.");
      const proposed = await readFile(path, "utf8");
      try { validateNpmProposal(lock, proposed); }
      catch (error) {
        if (error instanceof ApiError || error instanceof z.ZodError || error instanceof SyntaxError) throw new RejectedNpmProposal("Le verrou proposé ne respecte pas les contraintes de remédiation.");
        throw error;
      }
      return canonical(JSON.parse(lock)) === canonical(JSON.parse(proposed)) ? null : proposed;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return async (folder: string, roots: string[], names: string[], findings: SecurityFinding[], node: string, originals: Map<string, string | null>, tried: Set<string>, proposalContext = ""): Promise<RemediationDecision> => {
    const updated: string[] = [], messages: string[] = [], contexts: { root: string; manifest: Record<string, any>; originalManifest: Record<string, any>; graph: ReturnType<typeof npmGraph>; original: ReturnType<typeof npmGraph>; alerts: SecurityFinding[] }[] = [];
    for (const root of [...new Set(findings.map(item => item.scope))]) {
      if (root === undefined || !roots.includes(root)) throw new ApiError("Le périmètre de la dépendance vulnérable n’est pas confirmé.");
      const prefix = root ? root + "/" : "";
      const lockName = ["npm-shrinkwrap.json", "package-lock.json"].find(name => names.includes(prefix + name));
      if (!lockName) throw new ApiError(`${root || "racine"} : la remédiation indirecte automatique exige actuellement un verrou npm. Les contrôles restent actifs pour les autres gestionnaires.`);
      const name = prefix + lockName, manifestName = prefix + "package.json";
      const lock = await readFile(join(folder, name), "utf8"), manifest = await readFile(join(folder, manifestName), "utf8");
      const alerts = findings.filter(item => item.scope === root);
      const lockAttempt = `lock:${root}:${createHash("sha256").update(proposalContext + "\n" + lock).digest("hex")}`;
      let proposed: string | null = null;
      if (!tried.has(lockAttempt)) {
        tried.add(lockAttempt);
        try { proposed = await inPlace(manifest, lock, [...new Set(alerts.map(item => item.id))]); }
        catch (error) {
          if (!(error instanceof RejectedNpmProposal)) throw error;
          messages.push(`${root || "racine"} : proposition OSV rejetée sans modifier les sources ; recherche de versions compatibles des paquets parents.`);
        }
      }
      if (proposed) {
        await writeFile(join(folder, name), proposed);
        updated.push(root);
        messages.push(`${root || "racine"} : correctifs indirects proposés dans les contraintes existantes ; nouvelle installation stricte et nouvelle analyse obligatoires.`);
      }
      contexts.push({ root, manifest: JSON.parse(manifest), originalManifest: JSON.parse(originals.get(manifestName) || manifest), graph: npmGraph(lock), original: npmGraph(originals.get(name) || lock), alerts });
    }
    if (updated.length) return { kind: "lock", roots: updated, messages };
    for (const { root, graph, alerts } of contexts) {
      const routes = history.get(root) || new Map<string, Route>();
      for (const alert of [...new Map(alerts.map(item => [item.package + "@" + item.version, item])).values()]) for (const path of graph.paths(alert.package, alert.version)) {
        const fingerprint = createHash("sha256").update(canonical([alert.package, alert.version, path.map(location => [location, graph.nodes.get(location)])])).digest("hex");
        routes.set(fingerprint, { graph, path, alert });
      }
      history.set(root, routes);
    }
    const coordinated: string[] = [];
    for (const { root, graph, alerts } of contexts) {
      const raw = canonical([proposalContext, Object.fromEntries(graph.nodes)]), fingerprint = `balance:${root}:${createHash("sha256").update(raw).digest("hex")}`;
      if (tried.has(fingerprint)) continue;
      const names = npmCoordinationCandidates(JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(graph.nodes) }), alerts);
      if (!names.length) continue;
      tried.add(fingerprint);
      coordinated.push(root);
      messages.push(`${root || "racine"} : coordination des versions indirectes de ${names.slice(0, 8).join(", ")} dans les contraintes existantes ; le manifeste et les versions directes restent figés, puis installation stricte et nouveau scan obligatoires.`);
    }
    if (coordinated.length) return { kind: "balance", roots: coordinated, messages };
    const constraints = new Map<string, Record<string, string>>();
    let visits = 0;
    for (const { root, manifest, originalManifest, graph, original, alerts } of contexts) {
      const affected = new Set(alerts.flatMap(alert => graph.paths(alert.package, alert.version).map(path => packageName(path[0]))));
      const requirements = new Map<string, { graph: ReturnType<typeof npmGraph>; path: string[]; fixed: PackageVersion[]; alert: SecurityFinding }[]>();
      const routes = [...history.get(root)!.values()].filter(({ path }) => affected.has(packageName(path[0])));
      const verifiedRoutes = await mapConcurrent(routes, 8, async ({ graph: source, path, alert }) => {
        const installedVersions = [...original.nodes].filter(([location, item]) => location && (item.name || packageName(location)) === alert.package && stableVersion(item.version)).map(([, item]) => item.version!).sort((first, second) => compare(second, first));
        const fixed = await safeVersions(alert.package, node, installedVersions[0] || "0.0.0");
        return { graph: source, path, fixed, alert };
      });
      for (const { graph: source, path, fixed, alert } of verifiedRoutes) {
        const direct = packageName(path[0]);
        requirements.set(direct, [...requirements.get(direct) || [], { graph: source, path, fixed, alert }]);
      }
      if (!requirements.size) throw new ApiError(`${root || "racine"} : la chaîne vulnérable n’a pas pu être prouvée dans le verrou.`);
      const supportCache = new Map<string, Promise<boolean>>();
      for (const related of requirements.values()) {
        const path = related[0].path;
        const direct = packageName(path[0]), current = graph.nodes.get(graph.resolve("", direct) || "")!;
        const range = sections.map(section => Object.hasOwn(manifest[section] || {}, direct) ? manifest[section][direct] : undefined).find(Boolean);
        if (!range || !validRange(range)) throw new ApiError(`La source particulière de ${direct} exige une remédiation dédiée.`);
        const installed = original.nodes.get(original.resolve("", direct) || "")?.version;
        const originalRange = sections.map(section => Object.hasOwn(originalManifest[section] || {}, direct) ? originalManifest[section][direct] : undefined).find(Boolean);
        if (!originalRange || !validRange(originalRange)) throw new ApiError(`Les contraintes initiales de ${direct} ne permettent pas une remédiation automatique.`);
        const floor = minVersion(originalRange)!.version;
        async function supports(source: ReturnType<typeof npmGraph>, path: string[], index: number, candidate: PackageVersion, fixed: PackageVersion[]): Promise<boolean> {
          // Identical suffixes reached through several parents have the same
          // answer. Include edge aliases and all verified leaf versions: a failed
          // route must never rule out a different constraint or a new advisory.
          const suffix = path.slice(index).map((location, offset) => [source.nodes.get(location)!.name || packageName(location), offset + index + 1 < path.length ? source.edges(location, true).find(edge => edge.target === path[offset + index + 1])!.name : null]);
          const key = canonical([suffix, candidate, fixed.map(item => item.version)]);
          if (!supportCache.has(key)) supportCache.set(key, evaluate());
          return supportCache.get(key)!;
          async function evaluate(): Promise<boolean> {
            if (++visits > 5000) throw new ApiError("La recherche de parents corrigés atteint sa limite. Aucun contrôle n’a été contourné.");
            if (index === path.length - 1) return fixed.some(item => item.version === candidate.version);
            const child = source.nodes.get(path[index + 1])!, childName = child.name || packageName(path[index + 1]);
            const edge = source.edges(path[index], true).find(edge => edge.target === path[index + 1])!;
            const dependencies = { ...candidate.peerDependencies, ...candidate.dependencies, ...candidate.optionalDependencies };
            const childRange = Object.hasOwn(dependencies, edge.name) ? dependencies[edge.name] : undefined;
            if (!childRange) return true;
            const declared = dependencyRange(childRange);
            if (!declared) return false;
            const candidates = index + 1 === path.length - 1 ? fixed : (await catalog(childName)).filter(item => usable(item, node)).slice(0, remediationVersionLimit);
            for (const next of candidates) if (satisfies(next.version, declared) && await supports(source, path, index + 1, next, fixed)) return true;
            return false;
          }
        }
        const candidates = await verifiedSafeVersions(current.name || direct, (await catalog(current.name || direct)).filter(item => compare(item.version, floor) >= 0 && usable(item, node) && (!installed || compare(item.version, installed) >= 0 || satisfies(item.version, originalRange))).slice(0, remediationVersionLimit), transport);
        const admissible: PackageVersion[] = [];
        for (const candidate of candidates) {
          if (tried.has(`${root}:${direct}@${candidate.version}`)) continue;
          let supported = true;
          for (const route of related) if (!await supports(route.graph, route.path, 0, candidate, route.fixed)) { supported = false; break; }
          if (supported) admissible.push(candidate);
        }
        if (!admissible.length) {
          const details = [...new Set(related.map(({ graph: source, path, fixed, alert }) => {
            const chain = path.map(location => { const item = source.nodes.get(location)!; return `${item.name || packageName(location)}@${item.version}`; }).join(" → ");
            const fixes = fixed.slice(0, 3).map(item => item.version).join(", ") || alert.fixedVersions?.join(", ") || "aucun correctif stable vérifié";
            return `${chain}. Correctifs vérifiés de ${alert.package} : ${fixes}`;
          }))].slice(0, 5).join(" ; ");
          throw new ApiError(`${root || "racine"} : ${details}. Aucun parent stable compatible avec toutes ces alertes trouvé dans le budget de recherche (${remediationVersionLimit} versions par paquet). Recherche bornée, absence de solution non démontrée au-delà du budget. Aucun override ni contrôle désactivé.`, 422);
        }
        const selected = constraints.get(root) || {};
        constraints.set(root, { ...selected, [direct]: admissible.map(item => item.version).join(" || ") });
        messages.push(`${root || "racine"} : ${direct}, versions admissibles ${admissible.map(item => item.version).join(", ")}, pour corriger les chaînes de ${[...new Set(related.map(item => item.alert.package))].join(", ")}. Choix coordonné des versions les plus récentes compatibles avec les autres parents et leurs pairs ; tous les contrôles restent obligatoires.`);
        if (installed && admissible.some(item => compare(item.version, installed) < 0)) messages.push(`${root || "racine"} : Version antérieure envisagée uniquement dans la plage initialement déclarée, après les versions admissibles plus récentes.`);
      }
    }
    if (!constraints.size) throw new ApiError("Aucune proposition de correction de dépendance n’a pu être établie.");
    // Do not reject the head of a domain before the peer solver has actually
    // selected it. Multiple individually safe parents may require coordination.
    return { kind: "parents", constraints, messages };
  };
}
