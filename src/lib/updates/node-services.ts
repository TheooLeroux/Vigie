import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { ApiError } from "../http";
import { changedSources, nodeValidationRuntime, prepareNodeSources, snapshotSources, validatePreparedNodeSources, type NodeUpdateChecks, type NodeValidationRuntime } from "./node";

type CheckFactory = (folder: string, roots: string[], phase: "prepare" | "final") => NodeUpdateChecks;
type Options = {
  transport?: typeof fetch;
  runtime?: NodeValidationRuntime;
  dockerRoots?: string[];
  concurrency?: number;
  prepare?: typeof prepareNodeSources;
  validate?: typeof validatePreparedNodeSources;
  progress?: (root: string, phase: "preparing" | "prepared" | "validating" | "ready") => Promise<void>;
};

export function nodeServiceConcurrency(cpus = availableParallelism(), memory = totalmem()) {
  // Each validation container is limited to 3 GiB. Keep at least 1 GiB for the
  // worker, scanners and Docker, and never start more than two service pipelines.
  return Math.max(1, Math.min(2, cpus, Math.floor((memory - 1024 ** 3) / (3 * 1024 ** 3))));
}

async function boundedMap<T, R>(items: T[], limit: number, execute: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await execute(items[index], index); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  // All in-flight work must settle before its private directories are removed.
  if (failed) throw failure;
  return results;
}

function safeName(name: string) {
  if (!name || /[\\\x00-\x1f:]/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..")) throw new ApiError("Chemin de préparation non autorisé.");
  return name;
}
async function copySources(from: string, to: string, names: string[]) {
  await mkdir(to, { recursive: true });
  await snapshotSources(from, names);
  await boundedMap(names, 16, async name => {
    safeName(name);
    const destination = join(to, name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(from, name), destination);
  });
}

async function coordinatedLayout(folder: string, roots: string[], names: string[]) {
  if (roots.some((root, index) => roots.some((other, next) => index !== next && (!root || other.startsWith(root + "/"))))) return true;
  if (names.includes("pnpm-workspace.yaml")) return true;
  const manifests = [...new Set([...(names.includes("package.json") ? ["package.json"] : []), ...roots.map(root => (root ? root + "/" : "") + "package.json")])];
  const local = (value: unknown): boolean => typeof value === "string" ? /^(?:file:|link:|workspace:|portal:|\.\.?[\\/]|[\\/]|[a-z]:[\\/])/i.test(value) : !!value && typeof value === "object" && Object.values(value).some(local);
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(join(folder, path), "utf8"));
    if (manifest.workspaces || ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"].some(section => local(manifest[section]))) return true;
  }
  return false;
}

const versionFiles = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "Dockerfile", ".nvmrc", ".node-version"];

export async function prepareNodeServices(folder: string, roots: string[], names: string[], nodeVersion: string, checks: CheckFactory, options: Options = {}) {
  const selected = [...new Set(roots)], prepare = options.prepare || prepareNodeSources, validate = options.validate || validatePreparedNodeSources;
  if (!selected.length) throw new ApiError("Aucun service à préparer.");
  for (const root of selected) if (root) safeName(root);
  const limit = options.concurrency ?? nodeServiceConcurrency();
  if (!Number.isInteger(limit) || limit < 1 || limit > 2) throw new ApiError("La concurrence des services doit être comprise entre un et deux.");
  if (selected.length === 1 || await coordinatedLayout(folder, selected, names)) {
    return prepare(folder, selected, names, nodeVersion, options.transport || fetch, options.dockerRoots || [], options.runtime ? { limits: new Map(), attempt: 0, runtime: options.runtime } : undefined, checks(folder, selected, "prepare"));
  }
  const original = await snapshotSources(folder, names);
  const temporary = await mkdtemp(join(tmpdir(), "vigie-node-services-"));
  const validations = new Set<string>();
  const runtime = options.runtime || nodeValidationRuntime(nodeVersion);
  try {
    const prepared = await boundedMap(selected, limit, async root => {
      const working = await mkdtemp(join(temporary, "prepare-"));
      const started = performance.now();
      try {
        await options.progress?.(root, "preparing");
        await copySources(folder, working, names);
        // Each service owns its retry limits, peer constraints and remediation
        // history. Only successful validations with identical full inputs are shared.
        const result = await prepare(working, [root], names, nodeVersion, options.transport || fetch, (options.dockerRoots || []).filter(item => item === root), { limits: new Map(), attempt: 0, validations, runtime }, checks(working, [root], "prepare"));
        const prefix = root ? root + "/" : "";
        if ([...result.allowed].some(name => !versionFiles.some(file => name === prefix + file))) throw new ApiError("La préparation d’un service a dépassé son périmètre de versions.", 422);
        const files = await changedSources(working, original, result.allowed);
        await options.progress?.(root, "prepared");
        return { root, ...result, files, elapsedMs: Math.round(performance.now() - started) };
      } finally { await rm(working, { recursive: true, force: true }); }
    });
    const allowed = new Set(prepared.flatMap(result => [...result.allowed]));
    const combinedNames = [...new Set([...names, ...allowed])].filter(name => names.includes(name) || prepared.some(result => result.files.some(file => file.path === name)));
    const combined = join(temporary, "combined");
    await copySources(folder, combined, names);
    for (const result of prepared) for (const file of result.files) {
      await mkdir(dirname(join(combined, file.path)), { recursive: true });
      await writeFile(join(combined, file.path), file.content);
    }
    // Always validate the assembled proposal in fresh copies. A script can read
    // siblings even without a declared local dependency. No shared node_modules,
    // outputs or mutable lockfiles are exposed to concurrent validations.
    await boundedMap(selected, limit, async root => {
      const working = await mkdtemp(join(temporary, "final-"));
      try {
        await options.progress?.(root, "validating");
        await copySources(combined, working, combinedNames);
        await validate(working, [root], combinedNames, nodeVersion, validations, checks(working, [root], "final"), runtime);
        await changedSources(working, await snapshotSources(combined, combinedNames), new Set());
        await options.progress?.(root, "ready");
      } catch (error) {
        if (error instanceof ApiError) throw new ApiError(`${root || "racine"} : validation de l’ensemble refusée. ${error.message}`, error.status);
        throw error;
      } finally { await rm(working, { recursive: true, force: true }); }
    });
    await changedSources(folder, original, new Set());
    await changedSources(combined, original, allowed);
    for (const result of prepared) for (const file of result.files) {
      await mkdir(dirname(join(folder, file.path)), { recursive: true });
      await writeFile(join(folder, file.path), file.content);
    }
    return { allowed, warnings: [...new Set(prepared.flatMap(result => result.warnings))], services: prepared.map(result => ({ root: result.root, prepareMs: result.elapsedMs, warnings: result.warnings })), concurrency: limit };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
