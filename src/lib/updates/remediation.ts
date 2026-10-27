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
    let publicOrigin = false;
    try { const url = new URL(node.resolved || ""); publicOrigin = url.origin === "https://registry.npmjs.org" && !url.username && !url.password; } catch {}
    if (artifactChanged && (!publicOrigin || !node.integrity || !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/.test(node.integrity))) throw new ApiError("Le correctif indirect ne fournit pas une origine npm publique et une intégrité vérifiable.");
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
export type RemediationDecision = { kind: "lock"; roots: string[]; messages: string[] } | { kind: "parents"; constraints: Map<string, Record<string, string>>; messages: string[] };
class RejectedNpmProposal extends Error {}
export function createNodeRemediator(transport: typeof fetch = fetch, execute = runCommand) {
  const catalogs = new Map<string, Promise<PackageVersion[]>>();
  const safe = new Map<string, Promise<PackageVersion[]>>();
  const catalog = (name: string) => {
    if (!catalogs.has(name)) catalogs.set(name, packageCatalog(name, transport));
    return catalogs.get(name)!;
  };
  const usable = (item: PackageVersion, node: string) => !item.engines?.node || !!validRange(item.engines.node) && satisfies(node, item.engines.node);
  function safeVersions(name: string, node: string, minimum: string) {
    const key = `${name}@${minimum}:${node}`;
    if (!safe.has(key)) safe.set(key, (async () => {
      const candidates = (await catalog(name)).filter(item => compare(item.version, minimum) >= 0 && usable(item, node)).slice(0, 40);
      if (!candidates.length) return [];
      const query = () => transport("https://api.osv.dev/v1/querybatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries: candidates.map(item => ({ package: { name, ecosystem: "npm" }, version: item.version })) }), redirect: "error", signal: AbortSignal.timeout(30000) });
      let response: Response;
      try { response = await query(); }
      catch {
        try { response = await query(); }
        catch { throw new ApiError(`OSV est injoignable pour vérifier les correctifs de ${name} après deux tentatives. Aucun correctif non vérifié retenu.`, 502); }
      }
      if (!response.ok) throw new ApiError("OSV ne permet pas de vérifier les correctifs proposés. Remédiation arrêtée.", 502);
      const content = await response.text();
      if (content.length > 4000000) throw new ApiError("Réponse OSV de remédiation trop volumineuse.");
      const report = z.object({ results: z.array(z.object({ vulns: z.array(z.object({ id: z.string() })).optional(), next_page_token: z.string().optional() }).passthrough()) }).parse(JSON.parse(content));
      if (report.results.length !== candidates.length || report.results.some(entry => entry.next_page_token || "error" in entry)) throw new ApiError("La vérification OSV des correctifs est incomplète.", 502);
      return candidates.filter((_, index) => !report.results[index].vulns?.length);
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
  return async (folder: string, roots: string[], names: string[], findings: SecurityFinding[], node: string, originals: Map<string, string | null>, tried: Set<string>): Promise<RemediationDecision> => {
    const updated: string[] = [], messages: string[] = [], contexts: { root: string; manifest: Record<string, any>; originalManifest: Record<string, any>; graph: ReturnType<typeof npmGraph>; original: ReturnType<typeof npmGraph>; alerts: SecurityFinding[] }[] = [];
    for (const root of [...new Set(findings.map(item => item.scope))]) {
      if (root === undefined || !roots.includes(root)) throw new ApiError("Le périmètre de la dépendance vulnérable n’est pas confirmé.");
      const prefix = root ? root + "/" : "";
      const lockName = ["npm-shrinkwrap.json", "package-lock.json"].find(name => names.includes(prefix + name));
      if (!lockName) throw new ApiError(`${root || "racine"} : la remédiation indirecte automatique exige actuellement un verrou npm. Les contrôles restent actifs pour les autres gestionnaires.`);
      const name = prefix + lockName, manifestName = prefix + "package.json";
      const lock = await readFile(join(folder, name), "utf8"), manifest = await readFile(join(folder, manifestName), "utf8");
      const alerts = findings.filter(item => item.scope === root);
      const lockAttempt = `lock:${root}:${createHash("sha256").update(lock).digest("hex")}`;
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
    const constraints = new Map<string, Record<string, string>>();
    let visits = 0;
    for (const { root, manifest, originalManifest, graph, original, alerts } of contexts) {
      const requirements = new Map<string, { path: string[]; fixed: PackageVersion[]; alert: SecurityFinding }[]>();
      for (const alert of [...new Map(alerts.map(item => [item.package + "@" + item.version, item])).values()]) {
        const installedVersions = [...original.nodes].filter(([location, item]) => location && (item.name || packageName(location)) === alert.package && stableVersion(item.version)).map(([, item]) => item.version!).sort((first, second) => compare(second, first));
        const fixed = await safeVersions(alert.package, node, installedVersions[0] || "0.0.0");
        const paths = graph.paths(alert.package, alert.version);
        if (!paths.length) throw new ApiError(`${root || "racine"} : la chaîne de ${alert.package}@${alert.version} n’a pas pu être prouvée dans le verrou.`);
        for (const path of paths) requirements.set(path[0], [...requirements.get(path[0]) || [], { path, fixed, alert }]);
      }
      for (const related of requirements.values()) {
        const path = related[0].path;
        const direct = packageName(path[0]), current = graph.nodes.get(path[0])!;
        const range = sections.map(section => Object.hasOwn(manifest[section] || {}, direct) ? manifest[section][direct] : undefined).find(Boolean);
        if (!range || !validRange(range)) throw new ApiError(`La source particulière de ${direct} exige une remédiation dédiée.`);
        const installed = original.nodes.get(original.resolve("", direct) || "")?.version;
        const originalRange = sections.map(section => Object.hasOwn(originalManifest[section] || {}, direct) ? originalManifest[section][direct] : undefined).find(Boolean);
        if (!originalRange || !validRange(originalRange)) throw new ApiError(`Les contraintes initiales de ${direct} ne permettent pas une remédiation automatique.`);
        const floor = minVersion(originalRange)!.version;
        async function supports(path: string[], index: number, candidate: PackageVersion, fixed: PackageVersion[]): Promise<boolean> {
          if (++visits > 5000) throw new ApiError("La recherche de parents corrigés atteint sa limite. Aucun contrôle n’a été contourné.");
          if (index === path.length - 1) return fixed.some(item => item.version === candidate.version);
          const child = graph.nodes.get(path[index + 1])!, childName = child.name || packageName(path[index + 1]);
          const edge = graph.edges(path[index], true).find(edge => edge.target === path[index + 1])!;
          const dependencies = { ...candidate.peerDependencies, ...candidate.dependencies, ...candidate.optionalDependencies };
          const childRange = Object.hasOwn(dependencies, edge.name) ? dependencies[edge.name] : undefined;
          if (!childRange) return true;
          const declared = dependencyRange(childRange);
          if (!declared) return false;
          const candidates = index + 1 === path.length - 1 ? fixed : (await catalog(childName)).filter(item => usable(item, node)).slice(0, 40);
          for (const next of candidates) if (satisfies(next.version, declared) && await supports(path, index + 1, next, fixed)) return true;
          return false;
        }
        const candidates = (await catalog(current.name || direct)).filter(item => compare(item.version, floor) >= 0 && usable(item, node) && (!installed || compare(item.version, installed) >= 0 || satisfies(item.version, originalRange))).slice(0, 40);
        let chosen: PackageVersion | undefined;
        for (const candidate of candidates) {
          if (tried.has(`${root}:${direct}@${candidate.version}`)) continue;
          let supported = true;
          for (const route of related) if (!await supports(route.path, 0, candidate, route.fixed)) { supported = false; break; }
          if (supported) { chosen = candidate; break; }
        }
        if (!chosen) {
          const details = [...new Set(related.map(({ path, fixed, alert }) => {
            const chain = path.map(location => { const item = graph.nodes.get(location)!; return `${item.name || packageName(location)}@${item.version}`; }).join(" → ");
            const fixes = fixed.slice(0, 3).map(item => item.version).join(", ") || alert.fixedVersions?.join(", ") || "aucun correctif stable vérifié";
            return `${chain}. Correctifs vérifiés de ${alert.package} : ${fixes}`;
          }))].join(" ; ");
          throw new ApiError(`${root || "racine"} : ${details}. Aucun parent stable compatible avec toutes ces alertes trouvé dans la recherche bornée (40 versions par paquet). Aucun override ni contrôle désactivé.`, 422);
        }
        const selected = constraints.get(root) || {};
        constraints.set(root, { ...selected, [direct]: chosen.version });
        messages.push(`${root || "racine"} : ${direct} ${chosen.version} proposé pour corriger les chaînes de ${[...new Set(related.map(item => item.alert.package))].join(", ")}.${installed && compare(chosen.version, installed) < 0 ? " Version antérieure, dans la plage initialement déclarée ; tous les contrôles restent obligatoires." : ""}`);
      }
    }
    if (!constraints.size) throw new ApiError("Aucune proposition de correction de dépendance n’a pu être établie.");
    for (const [root, packages] of constraints) for (const [name, version] of Object.entries(packages)) tried.add(`${root}:${name}@${version}`);
    return { kind: "parents", constraints, messages };
  };
}
