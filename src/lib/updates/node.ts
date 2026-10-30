import { createHash } from "node:crypto";
import { readFile, writeFile, lstat, realpath, rm, mkdtemp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ApiError } from "../http";
import { runCommand, DependencyValidationError, IndirectValidationError, PeerResolutionError } from "./process";
import { compatibleVersions, CompatibilitySelectionError, verifiedPeerConflicts } from "./versions";
import { dockerPackages, rewriteDockerfile, validateDockerfile } from "./dockerfile";
import { nodeTestProfile } from "./node-test-profile";
import { SecurityPolicyError } from "./security";
import { createNodeRemediator, npmChangedIndirectPackages, npmGraph, npmIndirectVersionsChanged, seedNpmIndirectVersions, validateNpmProposal } from "./remediation";
import { searchIndirectCompatibility, maxIndirectAttempts, type IndirectEvaluation } from "./indirect-compatibility";
export { stableVersion } from "./versions";
import { stableVersion } from "./versions";
import { withPlanningSession } from "./planning";
import { checkPackageVersions } from "./advisories";
import { requireStrictYarnConfiguration } from "./manager-policy";
import { minVersion, satisfies, validRange } from "semver";

const maxRemediationProposals = 24;
const maxValidationRetries = 12;

export type SourceFile = { path: string; hash: string };
export async function latestNode(transport: typeof fetch = fetch) {
  const [index, schedule] = await Promise.all([
    fetchJson("https://nodejs.org/dist/index.json", transport),
    fetchJson("https://raw.githubusercontent.com/nodejs/Release/main/schedule.json", transport),
  ]);
  const candidates = (index as { version: string; lts: string | false }[]).filter(item => item.lts && stableVersion(item.version.replace(/^v/, "")) && Date.parse(schedule[`v${item.version.split(".")[0].slice(1)}`]?.end || "") > Date.now());
  candidates.sort((first, second) => compareVersion(second.version.slice(1), first.version.slice(1)));
  if (!candidates.length) throw new ApiError("La dernière version LTS de Node n’a pas pu être déterminée.", 502);
  return candidates[0].version.slice(1);
}
function compareVersion(first: string, second: string) {
  const left = first.split(".").map(Number), right = second.split(".").map(Number);
  for (const index of [0, 1, 2]) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}
async function fetchJson(url: string, transport: typeof fetch) {
  const response = await transport(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new ApiError("Un catalogue de versions est indisponible. Aucune version n’a été choisie au hasard.", 502);
  const content = await response.text();
  if (content.length > 3_000_000) throw new ApiError("Catalogue de versions trop volumineux.");
  return JSON.parse(content);
}
export async function snapshotSources(folder: string, names: string[]): Promise<SourceFile[]> {
  const result: SourceFile[] = [];
  // Parallel service copies must not multiply thousands of open descriptors.
  for (let offset = 0; offset < names.length; offset += 64) result.push(...await Promise.all(names.slice(offset, offset + 64).map(async name => {
    const path = join(folder, name);
    if (!(await realpath(path)).startsWith(resolve(folder) + (process.platform === "win32" ? "\\" : "/"))) throw new ApiError("Source située hors du répertoire autorisé.");
    if ((await lstat(path)).isSymbolicLink()) throw new ApiError("Lien symbolique non autorisé dans les sources.");
    return { path: name, hash: createHash("sha256").update(await readFile(path)).digest("hex") };
  })));
  return result;
}
export async function changedSources(folder: string, before: SourceFile[], allowed: Set<string>) {
  const files: { path: string; content: string }[] = [];
  for (const original of before) {
    const path = join(folder, original.path);
    if (!(await realpath(path)).startsWith(resolve(folder) + (process.platform === "win32" ? "\\" : "/"))) throw new ApiError("Source située hors du répertoire autorisé.");
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new ApiError("La validation a supprimé ou remplacé un fichier source.");
    const content = await readFile(path);
    if (createHash("sha256").update(content).digest("hex") !== original.hash) {
      if (!allowed.has(original.path)) throw new ApiError("La construction a modifié du code hors du périmètre des versions. Publication annulée.");
      files.push({ path: original.path, content: content.toString("utf8") });
    }
  }
  for (const name of allowed) {
    if (before.some(file => file.path === name)) continue;
    const info = await lstat(join(folder, name)).catch(() => null);
    if (!info) continue;
    if (!(await realpath(join(folder, name))).startsWith(resolve(folder) + (process.platform === "win32" ? "\\" : "/"))) throw new ApiError("Source située hors du répertoire autorisé.");
    if (!info.isFile() || info.isSymbolicLink()) throw new ApiError("Fichier de versions non autorisé.");
    files.push({ path: name, content: await readFile(join(folder, name), "utf8") });
  }
  return files;
}
export async function upgradeManifest(manifest: Record<string, any>, nodeVersion: string, transport: typeof fetch = fetch) {
  return compatibleVersions(manifest, nodeVersion, transport);
}
export function managerCommands(manifest: Record<string, any>, names: string[]) {
  const additional = ["test:integration", "test:e2e"].filter(name => manifest.scripts?.[name]);
  const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("+")[0] : "";
  if (names.includes("bun.lock") || names.includes("bun.lockb") || manifest.engines?.bun) throw new ApiError("Ce projet utilise Bun : ce parcours est réservé à Node.");
  if (declared.startsWith("pnpm@") || names.includes("pnpm-lock.yaml")) {
    const version = declared.startsWith("pnpm@") ? declared.slice(5) : "12.15.0";
    if (!stableVersion(version)) throw new ApiError("Version de pnpm non stable ou non précisée.");
    const tool = `npx --yes --package=pnpm@${version} -- pnpm`;
    return { lock: "pnpm-lock.yaml", resolve: `${tool} install --lockfile-only --ignore-scripts --strict-peer-dependencies`, validate: `${tool} install --frozen-lockfile --strict-peer-dependencies && ${tool} run --if-present typecheck && ${tool} run --if-present test && ${tool} run --if-present build` + additional.map(name => ` && ${tool} run ${name}`).join("") };
  }
  if (declared.startsWith("yarn@") || names.includes("yarn.lock")) {
    const version = declared.startsWith("yarn@") ? declared.slice(5) : "1.22.22";
    if (!stableVersion(version)) throw new ApiError("Version de Yarn non stable ou non précisée.");
    const modern = Number(version.split(".")[0]) > 1;
    const tool = `npx --yes --package=${modern ? "@yarnpkg/cli-dist" : "yarn"}@${version} -- yarn`;
    const mode = Number(version.split(".")[0]) >= 4 ? "skip-build" : "skip-builds";
    const resolve = modern ? `YARN_ENABLE_IMMUTABLE_INSTALLS=false ${tool} install --mode=${mode}` : `${tool} install --ignore-scripts --modules-folder /tmp/vigie-yarn-resolution`;
    const cleanModules = `node -e "require('node:fs').rmSync('node_modules',{recursive:true,force:true})"`;
    const install = modern ? `${tool} install --immutable` : `${cleanModules} && ${tool} install --frozen-lockfile`;
    const scripts = ["typecheck", "test", "build", ...additional].filter(name => manifest.scripts?.[name]).map(name => `${tool} run ${name}`);
    return { lock: "yarn.lock", resolve, validate: [install, ...scripts].join(" && ") };
  }
  if (declared && !declared.startsWith("npm@")) throw new ApiError("Gestionnaire de dépendances non pris en charge.");
  const lock = names.includes("npm-shrinkwrap.json") ? "npm-shrinkwrap.json" : "package-lock.json";
  if (!names.includes(lock)) throw new ApiError("Ajoutez un fichier de verrouillage au projet avant sa mise à jour automatique.");
  const npmVersion = declared ? declared.slice(4) : null;
  if (npmVersion && !stableVersion(npmVersion)) throw new ApiError("Version de npm non stable ou non précisée.");
  const tool = npmVersion ? `npx --yes --package=npm@${npmVersion} -- npm` : "npm";
  const strict = "--strict-peer-deps --legacy-peer-deps=false --force=false --no-audit --no-fund";
  return { lock, resolve: `${tool} install --package-lock-only --ignore-scripts ${strict}`, balance: `${tool} dedupe --package-lock-only --ignore-scripts --prefer-dedupe ${strict}`, verify: `${tool} ci --ignore-scripts ${strict} && ${tool} ls --all --json`, validate: `${tool} ci ${strict} && ${tool} ls --all --json && ${tool} run typecheck --if-present && ${tool} run test --if-present && ${tool} run build --if-present` + additional.map(name => ` && ${tool} run ${name}`).join("") };
}
export type NodeUpdateChecks = {
  resolved: (names: string[]) => Promise<void>;
  image: (root: string, image: string) => Promise<void>;
  validated: (root: string, scripts: string[]) => Promise<void>;
  remediating?: (message: string) => Promise<void>;
  reused?: (message: string) => Promise<void>;
};
type RemediationState = { iterations: number; constraints: Map<string, Record<string, string>>; tried: Set<string>; seen: Set<string>; repair: ReturnType<typeof createNodeRemediator> };
type ResolutionState = { attempts: number; learned: Map<string, Record<string, string[]>> };
export type NodeValidationRuntime = { image: () => Promise<string>; downloads?: (root: string) => Promise<string>; dispose?: () => Promise<void>; execute?: typeof runCommand; signal?: AbortSignal };
export function nodeValidationRuntime(nodeVersion: string, execute = runCommand): NodeValidationRuntime {
  let pending: Promise<string> | undefined;
  let directory: Promise<string> | undefined, disposed = false;
  const caches = new Map<string, Promise<string>>();
  return {
    downloads: root => {
      if (disposed) throw new ApiError("Le cache de cette exécution est fermé.");
      if (!caches.has(root)) caches.set(root, (async () => {
        directory ||= mkdtemp(join(tmpdir(), "vigie-node-downloads-"));
        const path = join(await directory, createHash("sha256").update(root).digest("hex"));
        await mkdir(path, { mode: 0o700 });
        return path;
      })());
      return caches.get(root)!;
    },
    dispose: async () => {
      disposed = true;
      await Promise.allSettled(caches.values());
      if (directory) await rm(await directory, { recursive: true, force: true });
    },
    image: () => pending ||= (async () => {
    const tag = `node:${nodeVersion}-bookworm`;
    const inspect = () => execute("docker", ["image", "inspect", tag, "--format", "{{.Id}}"]);
    let value: string;
    try { value = await inspect(); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 502) throw error;
      await execute("docker", ["pull", tag], { timeout: 180_000 });
      value = await inspect();
    }
    const id = value.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new ApiError("L’image Node de validation ne possède pas d’identité exacte.", 502);
    return id;
  })() };
}
type PreparationRetry = { limits: Map<string, Record<string, string>>; attempt: number; remediation?: RemediationState; resolution?: ResolutionState; lockFallbacks?: Map<string, string>; lockSeeds?: Map<string, string>; indirectAttempts?: Map<string, number>; validations?: Set<string>; rejected?: Map<string, Record<string, string>[]>; preferences?: Map<string, Record<string, string>>; priority?: string; runtime?: NodeValidationRuntime };
function nodeSandbox(folder: string, runtime: NodeValidationRuntime) {
  const execute = runtime.execute || runCommand;
  return async (root: string, commands: string, diagnosticPackages?: string[], environment: Record<string, string> = {}, peerResolution = false, diagnosticIndirectPackages: string[] = [], diagnosticIndirectLocations?: Record<string, string>) => {
    runtime.signal?.throwIfAborted();
    const name = `vigie-check-${crypto.randomUUID()}`;
    try {
      const downloads = await runtime.downloads?.(root);
      // Pacote retrieves tarballs by the lockfile's integrity digest. Share only
      // that content store: HTTP indexes, package metadata and npx executables
      // remain private to each container. Nothing crosses update executions.
      const cacheMount = downloads ? ["--mount", `type=bind,source=${downloads},target=/vigie-npm-content`] : [];
      const cacheSetup = downloads ? "mkdir -p /tmp/npm/_cacache; ln -s /vigie-npm-content /tmp/npm/_cacache/content-v2; " : "";
      await execute("docker", ["run", "--name", name, "--rm", "--read-only", "--tmpfs=/tmp:rw,exec,nosuid,size=1g", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=3g", "--cpus=2", "--pids-limit=512", `--user=${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, "--env=HOME=/tmp", "--env=CI=true", "--env=npm_config_cache=/tmp/npm", "--env=npm_config_engine_strict=true", ...Object.entries(environment).map(([key, value]) => `--env=${key}=${value}`), ...cacheMount, "--mount", `type=bind,source=${resolve(folder)},target=/app`, "--workdir", `/app${root ? `/${root}` : ""}`, await runtime.image(), "sh", "-c", `set -eu; ${cacheSetup}${commands}`], { timeout: 12 * 60_000, signal: runtime.signal, diagnosticPackages, diagnosticIndirectPackages, diagnosticIndirectLocations, peerResolution, strictYarnPeers: /-- yarn (?:install|run)\b/.test(commands), errorPatterns: [{ pattern: /\bERESOLVE\b|ERR_PNPM_PEER_DEP_ISSUES/, message: "Les nouvelles versions de dépendances sont incompatibles entre elles. Mise à jour non publiée : une adaptation du projet est nécessaire." }] });
    } finally { await execute("docker", ["rm", "--force", name]).catch(() => {}); }
  };
}

// Validate a frozen, assembled proposal without selecting versions again. This
// is mandatory after independently prepared services have been joined.
export async function validatePreparedNodeSources(folder: string, roots: string[], names: string[], nodeVersion: string, validations: Set<string>, security: NodeUpdateChecks, runtime?: NodeValidationRuntime) {
  const selected = runtime || nodeValidationRuntime(nodeVersion);
  try { return await validatePreparedSources(folder, roots, names, nodeVersion, validations, security, selected); }
  finally { if (!runtime) await selected.dispose?.(); }
}
async function validatePreparedSources(folder: string, roots: string[], names: string[], nodeVersion: string, validations: Set<string>, security: NodeUpdateChecks, runtime: NodeValidationRuntime) {
  const protectedFiles = await snapshotSources(folder, names);
  await security.resolved(names);
  await changedSources(folder, protectedFiles, new Set());
  const isolated = nodeSandbox(folder, runtime);
  for (const root of [...new Set(roots)]) {
    const prefix = root ? root + "/" : "";
    const manifest = JSON.parse(await readFile(join(folder, prefix + "package.json"), "utf8"));
    if (manifest.engines?.node !== nodeVersion || !manifest.scripts?.test && !manifest.scripts?.build) throw new ApiError("Proposition assemblée non validable : version Node exacte et scripts obligatoires.", 422);
    const manager = managerCommands(manifest, names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)));
    const schema = prefix + "src/config/env.ts";
    const environment = nodeTestProfile(manifest, names.includes(schema) ? await readFile(join(folder, schema), "utf8") : "")?.environment || {};
    const files = await snapshotSources(folder, [...names].sort());
    const key = createHash("sha256").update(JSON.stringify([nodeVersion, root, manager.validate, environment, files, await runtime.image()])).digest("hex");
    if (validations.has(key)) await security.reused?.(`${root || "racine"} : validation déjà réussie pour les sources assemblées exactes ; résultat de cette exécution réutilisé.`);
    else {
      await isolated(root, manager.validate, undefined, environment);
      await changedSources(folder, files, new Set());
      validations.add(key);
    }
    await security.validated(root, ["typecheck", "test", "build", "test:integration", "test:e2e"].filter(name => manifest.scripts?.[name]));
  }
  await changedSources(folder, protectedFiles, new Set());
}
export async function prepareNodeSources(folder: string, roots: string[], names: string[], nodeVersion: string, transport: typeof fetch = fetch, requiredDockerRoots: string[] = [], retry: PreparationRetry = { limits: new Map(), attempt: 0 }, security?: NodeUpdateChecks): Promise<{ allowed: Set<string>; warnings: string[] }> {
  return withPlanningSession(async () => {
    const runtime = retry.runtime || nodeValidationRuntime(nodeVersion);
    try { return await prepareSources(folder, roots, names, nodeVersion, transport, requiredDockerRoots, { ...retry, runtime }, security); }
    finally { if (!retry.runtime) await runtime.dispose?.(); }
  });
}
async function prepareSources(folder: string, roots: string[], names: string[], nodeVersion: string, transport: typeof fetch, requiredDockerRoots: string[], retry: PreparationRetry, security?: NodeUpdateChecks): Promise<{ allowed: Set<string>; warnings: string[] }> {
  retry.runtime?.signal?.throwIfAborted();
  const remediation = retry.remediation || { iterations: 0, constraints: new Map(), tried: new Set(), seen: new Set(), repair: createNodeRemediator(transport) } as RemediationState;
  const resolution = retry.resolution || { attempts: 0, learned: new Map() } as ResolutionState;
  retry = { ...retry, remediation, resolution, rejected: retry.rejected || new Map(), indirectAttempts: retry.indirectAttempts || new Map(), validations: retry.validations || new Set(), runtime: retry.runtime || nodeValidationRuntime(nodeVersion) };
  const resolutionKey = (root: string) => JSON.stringify([root, Object.entries(remediation.constraints.get(root) || {}).sort(), Object.entries(retry.limits.get(root) || {}).sort()]);
  if (requiredDockerRoots.some(root => !names.includes((root ? root + "/" : "") + "Dockerfile"))) throw new ApiError("Le service Railway utilise Docker, mais son Dockerfile est absent du répertoire source attendu.");
  const custom = names.find(name => {
    if (!/(^|\/)(Dockerfile|mise\.toml|\.tool-versions|railpack\.json)$/.test(name)) return false;
    const directory = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    const applicable = !directory || roots.some(root => root === directory || root.startsWith(directory + "/"));
    return applicable && !(name.endsWith("Dockerfile") && roots.includes(directory));
  });
  if (custom) throw new ApiError(`La configuration ${custom} doit être vérifiée avant l’automatisation.`);
  const rootManifest = names.includes("package.json") ? JSON.parse(await readFile(join(folder, "package.json"), "utf8")) : null;
  const workspace = rootManifest?.workspaces || names.includes("pnpm-workspace.yaml");
  if (workspace) throw new ApiError("Ce dépôt utilise des workspaces : il nécessite une validation dédiée avant une mise à jour groupée.");
  const initialSources = await snapshotSources(folder, names);
  const originalVersions = new Map<string, string | null>();
  async function remember(name: string) { if (!originalVersions.has(name)) originalVersions.set(name, await readFile(join(folder, name), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; })); }
  async function restoreVersions() {
    for (const [name, content] of originalVersions) {
      if (content === null) await rm(join(folder, name), { force: true });
      else await writeFile(join(folder, name), content);
    }
  }
  const allowed = new Set<string>(), warnings: string[] = [], checks: { root: string; lock: string; resolve: string; validate: string; verify?: string; balance?: string; docker: boolean; original: Record<string, any>; packages: string[]; environment: Record<string, string> }[] = [], intended = new Map<string, string>();
  for (const root of [...new Set(roots)]) {
    const prefix = root ? `${root}/` : "", path = `${prefix}package.json`;
    if (!names.includes(path)) throw new ApiError("Sources Node introuvables dans le répertoire configuré.");
    const manifest = JSON.parse(await readFile(join(folder, path), "utf8"));
    if (!manifest.scripts?.test && !manifest.scripts?.build) throw new ApiError("Ce projet doit fournir au moins un script test ou build pour vérifier la mise à jour.");
    const localNames = names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
    const manager = managerCommands(manifest, localNames);
    if (manager.lock === "yarn.lock") {
      for (const name of names.filter(name => /(^|\/)\.yarnrc(?:\.yml)?$/.test(name))) {
        const directory = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
        if (!directory || directory === root || root.startsWith(directory + "/")) requireStrictYarnConfiguration(await readFile(join(folder, name), "utf8"));
      }
    }
    const dockerName = prefix + "Dockerfile", docker = names.includes(dockerName), dockerSource = docker ? await readFile(join(folder, dockerName), "utf8") : "";
    const extra = docker ? dockerPackages(dockerSource) : {};
    const limits: Record<string, string | string[]> = Object.assign(Object.create(null), retry.limits.get(root));
    for (const [name, range] of Object.entries(remediation.constraints.get(root) || {})) limits[name] = Object.hasOwn(limits, name) ? [limits[name], range].flat() : range;
    const learned = resolution.learned.get(resolutionKey(root)) || {};
    for (const [name, ranges] of Object.entries(learned)) limits[name] = Object.hasOwn(limits, name) ? [limits[name], ranges].flat() : ranges;
    let upgraded: Awaited<ReturnType<typeof compatibleVersions>>;
    try { upgraded = await compatibleVersions(manifest, nodeVersion, transport, extra, limits, { screen: items => checkPackageVersions(items, transport), rejectedCombinations: retry.rejected!.get(root), preferredRanges: retry.preferences?.get(root), platform: { os: "linux", cpu: process.arch, libc: "glibc" } }); }
    catch (error) {
      if (!(error instanceof CompatibilitySelectionError) || !Object.keys(learned).length || !Object.keys(remediation.constraints.get(root) || {}).length) throw error;
      await changedSources(folder, initialSources, allowed);
      await restoreVersions();
      remediation.constraints.delete(root);
      const message = `${root || "racine"} : proposition de sécurité écartée car ses pairs indirects ne permettent aucun ensemble admissible ; recherche d’autres parents.`;
      await security?.remediating?.(message);
      const result = await prepareNodeSources(folder, roots, names, nodeVersion, transport, requiredDockerRoots, retry, security);
      result.warnings.push(...warnings, message);
      return result;
    }
    warnings.push(...upgraded.warnings);
    warnings.push(`${root || "racine"} : sélection optimisée, ${Object.keys(retry.preferences?.get(root) || {}).length ? "priorité à la récupération des API signalées, puis aux dernières versions stables" : "priorité au nombre de dernières versions stables puis au recul minimal"} ; ${upgraded.selection.screenedVersions} versions préanalysées, ${upgraded.selection.states} états explorés.`);
    for (const name of Object.keys(remediation.constraints.get(root) || {})) if (upgraded.versions[name]) remediation.tried.add(`${root}:${name}@${upgraded.versions[name]}`);
    const content = JSON.stringify(upgraded.manifest, null, 2) + "\n";
    await remember(path);
    await remember(prefix + manager.lock);
    await writeFile(join(folder, path), content);
    intended.set(path, content);
    allowed.add(path);
    allowed.add(prefix + manager.lock);
    if (manager.lock === "package-lock.json" || manager.lock === "npm-shrinkwrap.json") {
      const seed = retry.lockSeeds?.get(root);
      if (seed) await writeFile(join(folder, prefix + manager.lock), seed);
      else if (!retry.lockFallbacks?.has(root)) await writeFile(join(folder, prefix + manager.lock), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: {} }) + "\n");
    }
    if (docker) {
      await remember(dockerName);
      const candidate = rewriteDockerfile(dockerSource, nodeVersion, { ...extra, ...upgraded.versions });
      await writeFile(join(folder, dockerName), candidate);
      intended.set(dockerName, candidate);
      allowed.add(dockerName);
    }
    for (const versionFile of [".nvmrc", ".node-version"]) {
      const name = prefix + versionFile;
      if (names.includes(name)) { await remember(name); await writeFile(join(folder, name), nodeVersion + "\n"); allowed.add(name); }
    }
    const schemaName = prefix + "src/config/env.ts";
    const profile = nodeTestProfile(manifest, names.includes(schemaName) ? await readFile(join(folder, schemaName), "utf8") : "");
    if (profile) warnings.push(profile.message);
    checks.push({ root, lock: prefix + manager.lock, resolve: manager.resolve, validate: manager.validate, verify: "verify" in manager ? manager.verify : undefined, balance: "balance" in manager ? manager.balance : undefined, docker, original: manifest, packages: Object.keys(upgraded.versions), environment: profile?.environment || {} });
  }
  const isolated = nodeSandbox(folder, retry.runtime!);
  function rejectCombination(check: typeof checks[number], candidate: Record<string, any>) {
    const selected = { ...candidate.dependencies, ...candidate.devDependencies, ...candidate.optionalDependencies };
    const combination = Object.fromEntries(check.packages.filter(name => stableVersion(selected[name])).sort().map(name => [name, selected[name] as string]));
    if (!Object.keys(combination).length) return false;
    const previous = retry.rejected!.get(check.root) || [];
    if (previous.some(item => JSON.stringify(item) === JSON.stringify(combination))) return false;
    retry.rejected!.set(check.root, [...previous, combination]);
    return true;
  }
  async function validate(check: typeof checks[number], indirects: string[], locations?: Record<string, string>) {
    const files = await snapshotSources(folder, [...new Set([...names, ...allowed])].sort());
    // Include the WHOLE repository, not only this root: tests may import sibling
    // services. Changing any source, lock, Node, script or test profile invalidates it.
    const key = createHash("sha256").update(JSON.stringify([nodeVersion, check.root, check.validate, check.environment, files, await retry.runtime!.image()])).digest("hex");
    if (retry.validations!.has(key)) {
      await security?.reused?.(`${check.root || "racine"} : installation et tests déjà réussis pour ces sources, verrous et version Node exacts ; résultat de cette exécution réutilisé.`);
      return;
    }
    await isolated(check.root, check.validate, check.packages, check.environment, false, indirects, locations);
    await changedSources(folder, files, new Set());
    retry.validations!.add(key);
  }
  for (const check of checks) {
    try {
      await isolated(check.root, check.resolve, undefined, {}, true);
      const previous = retry.lockFallbacks?.get(check.root);
      if (previous) validateNpmProposal(previous, await readFile(join(folder, check.lock), "utf8"));
    }
    catch (error) {
      if (!(error instanceof PeerResolutionError)) throw error;
      if (resolution.attempts >= maxRemediationProposals) throw new ApiError("Budget de résolution des pairs épuisé. Recherche incomplète ; aucune publication autorisée.", 422);
      const candidate = JSON.parse(intended.get((check.root ? check.root + "/" : "") + "package.json")!);
      const selected = Object.assign({}, candidate.dependencies, candidate.devDependencies, candidate.optionalDependencies);
      const conflicts = await verifiedPeerConflicts(error.conflicts, selected, transport);
      const key = resolutionKey(check.root);
      let learned = { ...resolution.learned.get(key) };
      let progress = false;
      const messages: string[] = [];
      for (const conflict of conflicts) {
        const ranges = Object.hasOwn(learned, conflict.peer) ? learned[conflict.peer] : [];
        if (ranges.includes(conflict.range)) continue;
        learned = { ...learned, [conflict.peer]: [...ranges, conflict.range] };
        progress = true;
        messages.push(`${check.root || "racine"} : ${conflict.consumer}@${conflict.version} exige ${conflict.peer} ${conflict.range} ; nouvelle recherche coordonnée après refus de l’installation stricte.`);
      }
      if (!progress) throw error;
      await changedSources(folder, initialSources, allowed);
      for (const [path, content] of intended) if (await readFile(join(folder, path), "utf8") !== content) throw new ApiError("La résolution a modifié un manifeste ou le Dockerfile au-delà des versions demandées.");
      resolution.attempts++;
      resolution.learned.set(key, learned);
      for (const message of messages) await security?.remediating?.(message);
      await restoreVersions();
      const result = await prepareNodeSources(folder, roots, names, nodeVersion, transport, requiredDockerRoots, retry, security);
      result.warnings.push(...warnings, ...messages);
      return result;
    }
  }
  for (const [path, content] of intended) if (await readFile(join(folder, path), "utf8") !== content) throw new ApiError("Le gestionnaire a modifié un manifeste au-delà des versions demandées.");
  let resolvedFiles = await snapshotSources(folder, [...allowed]);
  for (;;) {
    try {
      await security?.resolved([...new Set([...names, ...allowed])]);
      break;
    } catch (error) {
      if (!(error instanceof SecurityPolicyError) || error.check.tool !== "OSV") throw error;
      if (++remediation.iterations > maxRemediationProposals) throw new ApiError(`Budget de remédiation épuisé (${maxRemediationProposals} propositions). Recherche incomplète ; aucune publication autorisée et aucun contrôle désactivé.`, 422);
      await changedSources(folder, resolvedFiles, new Set());
      await changedSources(folder, initialSources, allowed);
      const fingerprint = JSON.stringify({ files: resolvedFiles.map(file => [file.path, file.hash]), tried: [...remediation.tried].sort(), limits: [...retry.limits] });
      if (remediation.seen.has(fingerprint)) throw new ApiError("La remédiation reproduit un ensemble déjà refusé. Aucun changement n’a été publié.", 422);
      remediation.seen.add(fingerprint);
      await security?.remediating?.("Recherche de correctifs indirects et de versions compatibles des paquets parents.");
      const lockCopies = new Map<string, string>();
      for (const file of resolvedFiles.filter(file => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(file.path))) lockCopies.set(file.path, await readFile(join(folder, file.path), "utf8"));
      const proposalContext = JSON.stringify([...intended].sort(([first], [second]) => first.localeCompare(second)));
      const decision = await remediation.repair(folder, roots, [...new Set([...names, ...allowed])], error.check.blockers || error.check.findings, nodeVersion, originalVersions, remediation.tried, proposalContext);
      for (const message of decision.messages) { warnings.push(message); await security?.remediating?.(message); }
      if (decision.kind === "lock" || decision.kind === "balance") {
        try {
          for (const root of decision.roots) {
            const check = checks.find(check => check.root === root);
            if (!check?.verify) throw new ApiError("Le gestionnaire ne permet pas de vérifier strictement le correctif indirect.");
            if (decision.kind === "balance") {
              if (!check.balance) throw new ApiError("Le gestionnaire ne permet pas de coordonner les dépendances indirectes.");
              await isolated(root, check.balance);
              validateNpmProposal(lockCopies.get(check.lock)!, await readFile(join(folder, check.lock), "utf8"));
            }
            await isolated(root, check.verify);
          }
        } catch (validationError) {
          if (!(validationError instanceof ApiError) || ![400, 422, 502].includes(validationError.status)) throw validationError;
          await changedSources(folder, initialSources, allowed);
          for (const [path, content] of intended) if (await readFile(join(folder, path), "utf8") !== content) throw new ApiError("La vérification du correctif a altéré un manifeste ou le Dockerfile.");
          for (const [path, content] of lockCopies) await writeFile(join(folder, path), content);
          const message = "Proposition de verrou rejetée par l’installation stricte ; recherche d’une correction par les paquets parents.";
          warnings.push(message);
          await security?.remediating?.(message);
          resolvedFiles = await snapshotSources(folder, [...allowed]);
          continue;
        }
        for (const [path, content] of intended) if (await readFile(join(folder, path), "utf8") !== content) throw new ApiError("La remédiation a modifié un manifeste hors de sa proposition validée.");
        await changedSources(folder, initialSources, allowed);
        resolvedFiles = await snapshotSources(folder, [...allowed]);
        continue;
      }
      for (const [root, constraints] of decision.constraints) remediation.constraints.set(root, { ...remediation.constraints.get(root), ...constraints });
      for (const [name, content] of originalVersions) {
        if (content === null) await rm(join(folder, name), { force: true });
        else await writeFile(join(folder, name), content);
      }
      const result = await prepareNodeSources(folder, roots, names, nodeVersion, transport, requiredDockerRoots, { ...retry, remediation }, security);
      result.warnings.push(...warnings);
      return result;
    }
  }
  for (const check of [...checks].sort((a, b) => Number(b.root === retry.priority) - Number(a.root === retry.priority))) {
    try {
      const originalLock = originalVersions.get(check.lock);
      const indirects = check.verify && originalLock ? npmChangedIndirectPackages(originalLock, await readFile(join(folder, check.lock), "utf8")) : [];
      const locations = check.verify ? Object.fromEntries([...npmGraph(await readFile(join(folder, check.lock), "utf8")).nodes].flatMap(([path, item]) => { const name = item.name || path.slice(path.lastIndexOf("node_modules/") + 13); return path && indirects.includes(name) ? [[path, name]] : []; })) : undefined;
      await validate(check, indirects, locations);
    }
    catch (error) {
      retry.priority = check.root;
      if (error instanceof IndirectValidationError && check.verify) {
        const originalLock = originalVersions.get(check.lock), failedLock = await readFile(join(folder, check.lock), "utf8");
        const used = retry.indirectAttempts!.get(check.root) || 0;
        if (originalLock && used < maxIndirectAttempts) {
          await changedSources(folder, resolvedFiles, new Set());
          await changedSources(folder, initialSources, allowed);
          const result = await searchIndirectCompatibility(originalLock, failedLock, error.packages, nodeVersion, async (candidate): Promise<IndirectEvaluation> => {
            await writeFile(join(folder, check.lock), candidate.lock);
            let protectedFiles: Awaited<ReturnType<typeof snapshotSources>> | null = null;
            let projectValidation = false;
            try {
              await isolated(check.root, check.resolve, undefined, {}, true);
              const proposed = await readFile(join(folder, check.lock), "utf8");
              validateNpmProposal(failedLock, proposed);
              const graph = npmGraph(proposed);
              if (candidate.paths.some(path => graph.nodes.get(path)?.version !== candidate.version)) return { kind: "rejected" };
              for (const [path, content] of intended) if (await readFile(join(folder, path), "utf8") !== content) throw new ApiError("La recherche indirecte a altéré un manifeste ou le Dockerfile.");
              await changedSources(folder, initialSources, allowed);
              protectedFiles = await snapshotSources(folder, [...new Set([...names, ...allowed])]);
              await security?.resolved([...new Set([...names, ...allowed])]);
              projectValidation = true;
              const locations = Object.fromEntries([...graph.nodes].flatMap(([path, item]) => { const name = item.name || path.slice(path.lastIndexOf("node_modules/") + 13); return path && error.packages.includes(name) ? [[path, name]] : []; }));
              await validate(check, error.packages, locations);
              await changedSources(folder, protectedFiles, new Set());
              return { kind: "valid", lock: await readFile(join(folder, check.lock), "utf8") };
            } catch (candidateError) {
              await changedSources(folder, initialSources, allowed);
              for (const [path, content] of intended) if (await readFile(join(folder, path), "utf8") !== content) throw new ApiError("La validation indirecte a altéré un manifeste ou le Dockerfile.");
              if (protectedFiles) await changedSources(folder, protectedFiles, new Set());
              if (candidateError instanceof SecurityPolicyError) return { kind: "rejected" };
              if (candidateError instanceof PeerResolutionError || projectValidation && candidateError instanceof ApiError && candidateError.status === 502) return { kind: "incompatible" };
              throw candidateError;
            }
          }, transport, async message => { warnings.push(message); await security?.remediating?.(`${check.root || "racine"} : ${message}`); }, maxIndirectAttempts - used, () => { retry.indirectAttempts!.set(check.root, (retry.indirectAttempts!.get(check.root) || 0) + 1); }, error.locations);
          if (result) {
            retry.lockFallbacks = new Map(retry.lockFallbacks).set(check.root, failedLock);
            retry.lockSeeds = new Map(retry.lockSeeds).set(check.root, result.lock);
            resolvedFiles = await snapshotSources(folder, [...allowed]);
            await security?.validated(check.root, ["typecheck", "test", "build", "test:integration", "test:e2e"].filter(name => check.original.scripts?.[name]));
            continue;
          }
          await writeFile(join(folder, check.lock), failedLock);
          resolvedFiles = await snapshotSources(folder, [...allowed]);
        }
        if ((retry.indirectAttempts!.get(check.root) || 0) > used || used >= maxIndirectAttempts) throw new ApiError(`${check.root || "racine"} : aucune version indirecte validée dans le budget de ${maxIndirectAttempts} essais. Recherche incomplète au-delà du budget ; aucun contrôle désactivé.`, 422);
      }
      if (retry.attempt >= maxValidationRetries) throw new ApiError(`Budget de validation épuisé (${maxValidationRetries} reprises). Recherche incomplète ; aucune publication autorisée.`, 422);
      if (error instanceof ApiError && error.status === 502 && !(error instanceof DependencyValidationError) && check.verify && !retry.lockFallbacks?.has(check.root)) {
        const originalLock = originalVersions.get(check.lock), candidateLock = await readFile(join(folder, check.lock), "utf8");
        if (originalLock && npmIndirectVersionsChanged(originalLock, candidateLock)) {
          await changedSources(folder, resolvedFiles, new Set());
          await changedSources(folder, initialSources, allowed);
          const lockFallbacks = new Map(retry.lockFallbacks).set(check.root, candidateLock);
          const seed = error instanceof IndirectValidationError ? seedNpmIndirectVersions(originalLock, candidateLock, error.packages) : null;
          const heldIndirects = seed ? npmChangedIndirectPackages(candidateLock, seed) : [];
          const lockSeeds = new Map(retry.lockSeeds);
          if (seed) lockSeeds.set(check.root, seed);
          const message = `${check.root || "racine"} : échec de validation après changement de versions indirectes ; ${seed ? `repli ciblé ${heldIndirects.length ? "de " + heldIndirects.join(", ") : "des versions indirectes admissibles"} dans les contraintes actuelles` : "nouvelle résolution à partir du verrou initial"}, sans changer les versions directes proposées, puis installation stricte, scan et tests obligatoires.`;
          await security?.remediating?.(message);
          await restoreVersions();
          const result = await prepareNodeSources(folder, roots, names, nodeVersion, transport, requiredDockerRoots, { ...retry, attempt: retry.attempt + 1, lockFallbacks, lockSeeds }, security);
          result.warnings.push(...warnings, message);
          return result;
        }
      }
      const secured = remediation.constraints.get(check.root) || {};
      const rejected = error instanceof DependencyValidationError ? error.packages.filter(name => Object.hasOwn(secured, name)) : error instanceof ApiError && error.status === 502 ? Object.keys(secured) : [];
      if (!(error instanceof DependencyValidationError) && !rejected.length) throw error;
      await changedSources(folder, resolvedFiles, new Set());
      await changedSources(folder, initialSources, allowed);
      if (rejected.length) {
        const remaining = { ...secured };
        for (const name of rejected) delete remaining[name];
        remediation.constraints.set(check.root, remaining);
        const manifest = JSON.parse(intended.get((check.root ? check.root + "/" : "") + "package.json")!);
        rejectCombination(check, manifest);
        const message = `${check.root || "racine"} : proposition de sécurité écartée après échec des tests (${rejected.join(", ")}) ; recherche d’une autre combinaison sans ignorer les assertions.`;
        await security?.remediating?.(message);
        for (const [name, content] of originalVersions) {
          if (content === null) await rm(join(folder, name), { force: true });
          else await writeFile(join(folder, name), content);
        }
        const result = await prepareNodeSources(folder, roots, names, nodeVersion, transport, requiredDockerRoots, { ...retry, attempt: retry.attempt + 1, remediation }, security);
        result.warnings.push(...warnings, message);
        return result;
      }
      if (!(error instanceof DependencyValidationError)) throw error;
      const candidate = JSON.parse(intended.get((check.root ? check.root + "/" : "") + "package.json")!);
      if (!rejectCombination(check, candidate)) throw error;
      const preferences = new Map(retry.preferences), preferred = { ...preferences.get(check.root) };
      for (const name of error.packages) {
        const original = check.original.dependencies?.[name] || check.original.devDependencies?.[name] || check.original.optionalDependencies?.[name];
        const minimum = typeof original === "string" && validRange(original) ? minVersion(original) : null;
        const selected = candidate.dependencies?.[name] || candidate.devDependencies?.[name] || candidate.optionalDependencies?.[name];
        if (minimum && stableVersion(selected) && !satisfies(selected, `^${minimum.version}`)) preferred[name] = `^${minimum.version}`;
      }
      preferences.set(check.root, preferred);
      await security?.remediating?.(`${check.root || "racine"} : combinaison précise écartée après refus des tests (${error.packages.join(", ")}) ; aucune branche entière exclue. Nouvelle résolution, nouveau scan et tests obligatoires.`);
      if (Object.keys(preferred).length) await security?.remediating?.(`${check.root || "racine"} : recherche ciblée sur ${Object.keys(preferred).join(", ")} ; priorité à la dernière version sûre de la branche initiale après rupture d’API. Les autres branches restent admissibles et tous les contrôles sont conservés.`);
      for (const [name, content] of originalVersions) {
        if (content === null) await rm(join(folder, name), { force: true });
        else await writeFile(join(folder, name), content);
      }
      const result = await prepareNodeSources(folder, roots, names, nodeVersion, transport, requiredDockerRoots, { ...retry, attempt: retry.attempt + 1, remediation, resolution, preferences }, security);
      result.warnings.push(...warnings, `${check.root || "racine"} : combinaison refusée mémorisée ; autre ensemble choisi et validé sans exclure une branche entière.`);
      return result;
    }
    await security?.validated(check.root, ["typecheck", "test", "build", "test:integration", "test:e2e"].filter(name => check.original.scripts?.[name]));
  }
  await changedSources(folder, resolvedFiles, new Set());
  for (const check of checks.filter(check => check.docker)) await validateDockerfile(folder, check.root, [...new Set([...names, ...allowed])], nodeVersion, security ? image => security.image(check.root, image) : undefined, async message => { warnings.push(message); await security?.remediating?.(`${check.root || "racine"} : ${message}`); });
  return { allowed, warnings };
}
