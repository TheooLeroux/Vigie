import { createHash } from "node:crypto";
import { readFile, writeFile, lstat, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApiError } from "../http";
import { runCommand, DependencyValidationError } from "./process";
import { minVersion, satisfies, validRange } from "semver";
import { compatibleVersions } from "./versions";
import { dockerPackages, rewriteDockerfile, validateDockerfile } from "./dockerfile";
import { nodeTestProfile } from "./node-test-profile";
export { stableVersion } from "./versions";
import { stableVersion } from "./versions";

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
  return Promise.all(names.map(async name => {
    const path = join(folder, name);
    if (!(await realpath(path)).startsWith(resolve(folder) + (process.platform === "win32" ? "\\" : "/"))) throw new ApiError("Source située hors du répertoire autorisé.");
    if ((await lstat(path)).isSymbolicLink()) throw new ApiError("Lien symbolique non autorisé dans les sources.");
    return { path: name, hash: createHash("sha256").update(await readFile(path)).digest("hex") };
  }));
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
  const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("+")[0] : "";
  if (names.includes("bun.lock") || names.includes("bun.lockb") || manifest.engines?.bun) throw new ApiError("Ce projet utilise Bun : ce parcours est réservé à Node.");
  if (declared.startsWith("pnpm@") || names.includes("pnpm-lock.yaml")) {
    const version = declared.startsWith("pnpm@") ? declared.slice(5) : "12.15.0";
    if (!stableVersion(version)) throw new ApiError("Version de pnpm non stable ou non précisée.");
    const tool = `npx --yes --package=pnpm@${version} -- pnpm`;
    return { lock: "pnpm-lock.yaml", resolve: `${tool} install --lockfile-only --ignore-scripts --strict-peer-dependencies`, validate: `${tool} install --frozen-lockfile --strict-peer-dependencies && ${tool} run --if-present typecheck && ${tool} run --if-present test && ${tool} run --if-present build` };
  }
  if (declared.startsWith("yarn@") || names.includes("yarn.lock")) {
    const version = declared.startsWith("yarn@") ? declared.slice(5) : "1.22.22";
    if (!stableVersion(version)) throw new ApiError("Version de Yarn non stable ou non précisée.");
    const modern = Number(version.split(".")[0]) > 1;
    const tool = `npx --yes --package=${modern ? "@yarnpkg/cli-dist" : "yarn"}@${version} -- yarn`;
    const mode = Number(version.split(".")[0]) >= 4 ? "skip-build" : "skip-builds";
    const resolve = modern ? `YARN_ENABLE_IMMUTABLE_INSTALLS=false ${tool} install --mode=${mode}` : `${tool} install --ignore-scripts`;
    const install = modern ? `${tool} install --immutable` : `${tool} install --frozen-lockfile --force`;
    const scripts = ["typecheck", "test", "build"].filter(name => manifest.scripts?.[name]).map(name => `${tool} run ${name}`);
    return { lock: "yarn.lock", resolve, validate: [install, ...scripts].join(" && ") };
  }
  if (declared && !declared.startsWith("npm@")) throw new ApiError("Gestionnaire de dépendances non pris en charge.");
  const lock = names.includes("npm-shrinkwrap.json") ? "npm-shrinkwrap.json" : "package-lock.json";
  if (!names.includes(lock)) throw new ApiError("Ajoutez un fichier de verrouillage au projet avant sa mise à jour automatique.");
  const npmVersion = declared ? declared.slice(4) : null;
  if (npmVersion && !stableVersion(npmVersion)) throw new ApiError("Version de npm non stable ou non précisée.");
  const tool = npmVersion ? `npx --yes --package=npm@${npmVersion} -- npm` : "npm";
  return { lock, resolve: `${tool} install --package-lock-only --ignore-scripts --strict-peer-deps --no-audit --no-fund`, validate: `${tool} ci --strict-peer-deps --no-audit --no-fund && ${tool} run typecheck --if-present && ${tool} run test --if-present && ${tool} run build --if-present` };
}
export async function prepareNodeSources(folder: string, roots: string[], names: string[], nodeVersion: string, transport: typeof fetch = fetch, requiredDockerRoots: string[] = [], retry: { limits: Map<string, Record<string, string>>; attempt: number } = { limits: new Map(), attempt: 0 }): Promise<{ allowed: Set<string>; warnings: string[] }> {
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
  const allowed = new Set<string>(), warnings: string[] = [], checks: { root: string; resolve: string; validate: string; docker: boolean; original: Record<string, any>; packages: string[]; environment: Record<string, string> }[] = [], intended = new Map<string, string>();
  for (const root of [...new Set(roots)]) {
    const prefix = root ? `${root}/` : "", path = `${prefix}package.json`;
    if (!names.includes(path)) throw new ApiError("Sources Node introuvables dans le répertoire configuré.");
    const manifest = JSON.parse(await readFile(join(folder, path), "utf8"));
    if (!manifest.scripts?.test && !manifest.scripts?.build) throw new ApiError("Ce projet doit fournir au moins un script test ou build pour vérifier la mise à jour.");
    const localNames = names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
    const manager = managerCommands(manifest, localNames);
    const dockerName = prefix + "Dockerfile", docker = names.includes(dockerName), dockerSource = docker ? await readFile(join(folder, dockerName), "utf8") : "";
    const extra = docker ? dockerPackages(dockerSource) : {};
    const upgraded = await compatibleVersions(manifest, nodeVersion, transport, extra, retry.limits.get(root));
    warnings.push(...upgraded.warnings);
    const content = JSON.stringify(upgraded.manifest, null, 2) + "\n";
    await remember(path);
    await remember(prefix + manager.lock);
    await writeFile(join(folder, path), content);
    intended.set(path, content);
    allowed.add(path);
    allowed.add(prefix + manager.lock);
    if (manager.lock === "package-lock.json" || manager.lock === "npm-shrinkwrap.json") await writeFile(join(folder, prefix + manager.lock), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: {} }) + "\n");
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
    checks.push({ root, resolve: manager.resolve, validate: manager.validate, docker, original: manifest, packages: Object.keys(upgraded.versions), environment: profile?.environment || {} });
  }
  async function isolated(root: string, commands: string, diagnosticPackages?: string[], environment: Record<string, string> = {}) {
    const name = `vigie-check-${crypto.randomUUID()}`;
    try {
      await runCommand("docker", ["run", "--name", name, "--rm", "--read-only", "--tmpfs=/tmp:rw,exec,nosuid,size=1g", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=3g", "--cpus=2", "--pids-limit=512", `--user=${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, "--env=HOME=/tmp", "--env=CI=true", "--env=npm_config_cache=/tmp/npm", "--env=npm_config_engine_strict=true", ...Object.entries(environment).map(([key, value]) => `--env=${key}=${value}`), "--mount", `type=bind,source=${resolve(folder)},target=/app`, "--workdir", `/app${root ? `/${root}` : ""}`, `node:${nodeVersion}-bookworm`, "sh", "-c", `set -eu; ${commands}`], { timeout: 12 * 60_000, diagnosticPackages, errorPatterns: [{ pattern: /\bERESOLVE\b|ERR_PNPM_PEER_DEP_ISSUES/, message: "Les nouvelles versions de dépendances sont incompatibles entre elles. Mise à jour non publiée : une adaptation du projet est nécessaire." }] });
    } finally { await runCommand("docker", ["rm", "--force", name]).catch(() => {}); }
  }
  for (const check of checks) await isolated(check.root, check.resolve);
  for (const [path, content] of intended) if (await readFile(join(folder, path), "utf8") !== content) throw new ApiError("Le gestionnaire a modifié un manifeste au-delà des versions demandées.");
  const resolvedFiles = await snapshotSources(folder, [...allowed]);
  for (const check of checks) {
    try { await isolated(check.root, check.validate, check.packages, check.environment); }
    catch (error) {
      if (!(error instanceof DependencyValidationError) || retry.attempt >= 3) throw error;
      await changedSources(folder, resolvedFiles, new Set());
      await changedSources(folder, initialSources, allowed);
      const limits = structuredClone(retry.limits), held: string[] = [];
      let rootLimits = limits.get(check.root) || {};
      const candidate = JSON.parse(intended.get((check.root ? check.root + "/" : "") + "package.json")!);
      for (const name of error.packages) {
        const range = check.original.dependencies?.[name] || check.original.devDependencies?.[name] || check.original.optionalDependencies?.[name];
        const minimum = typeof range === "string" && validRange(range) ? minVersion(range) : null;
        const selected = candidate.dependencies?.[name] || candidate.devDependencies?.[name] || candidate.optionalDependencies?.[name];
        if (!minimum || !stableVersion(selected) || satisfies(selected, `^${minimum.version}`) || Object.hasOwn(rootLimits, name)) continue;
        rootLimits = { ...rootLimits, [name]: `^${minimum.version}` };
        held.push(name);
      }
      if (!held.length) throw error;
      limits.set(check.root, rootLimits);
      for (const [name, content] of originalVersions) {
        if (content === null) await rm(join(folder, name), { force: true });
        else await writeFile(join(folder, name), content);
      }
      const result = await prepareNodeSources(folder, roots, names, nodeVersion, transport, requiredDockerRoots, { limits, attempt: retry.attempt + 1 });
      result.warnings.push(...held.map(name => `${name} : montée majeure écartée après les tests ; dernière version compatible de la branche actuelle retenue.`));
      return result;
    }
  }
  await changedSources(folder, resolvedFiles, new Set());
  for (const check of checks.filter(check => check.docker)) await validateDockerfile(folder, check.root, [...new Set([...names, ...allowed])], nodeVersion);
  return { allowed, warnings };
}
