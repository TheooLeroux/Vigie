import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { GitHubMaintenanceClient } from "../src/lib/connectors/github-maintenance";
import { ApiError } from "../src/lib/http";
import { maintenanceToken } from "../src/lib/maintenance-credentials";
import {
  maintenanceBranch,
  workerPayloadSchema,
  type MaintenancePayload,
} from "../src/lib/maintenance-contract";
import {
  dependencyBlocker,
  jsonText,
  nodeFileChanges,
  parseManifest,
  parseWorkspace,
  readMaintenanceFiles,
  updateManifest,
  type MaintenanceFiles,
} from "../src/lib/maintenance-files";

type TreeChange = {
  path: string;
  mode: "100644";
  type: "blob";
  content?: string;
  sha?: string;
};
const execute = promisify(execFile);
const forbidden = /(?:^|\/)(?:\.git|\.github|node_modules)(?:\/|$)/;
function writable(path: string) {
  return (
    !forbidden.test(path) &&
    !path
      .split("/")
      .some(
        (part) =>
          part === ".." || part === "." || !/^[A-Za-z0-9@_.-]+$/.test(part),
      ) &&
    /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|\.nvmrc|\.node-version)$/.test(
      path,
    )
  );
}
export function assertPublicDependencies(manifest: Record<string, any>) {
  for (const scope of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const specification of Object.values(manifest[scope] || {})) {
      if (
        typeof specification !== "string" ||
        (!/^workspace:(?:\*|\^|~|[0-9.*^~<>=| -]+)$/.test(specification) &&
          !/^catalog:[A-Za-z0-9_-]*$/.test(specification) &&
          !/^[a-zA-Z0-9.*^~<>=| +()-]+$/.test(specification))
      )
        throw new ApiError(
          "Dépendance Git, fichier, alias ou registre privé non prise en charge par cet exécuteur.",
        );
    }
  }
}
export function assertPublicLock(
  raw: string,
  manager: string,
  workspaceManifests = new Set<string>(),
) {
  const lock =
    manager === "npm"
      ? parseManifest(raw)
      : parseYaml(raw, { maxAliasCount: 10 });
  if (!lock || typeof lock !== "object")
    throw new ApiError("Lockfile invalide.");
  if (manager === "npm" && ![2, 3].includes(lock.lockfileVersion))
    throw new ApiError("Seuls les lockfiles npm 2 et 3 sont pris en charge.");
  const safeLinks = new Set<string>();
  for (const [importer, content] of Object.entries(lock.importers || {})) {
    for (const scope of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const dependency of Object.values((content as any)?.[scope] || {})) {
        const version = (dependency as any)?.version;
        if (typeof version === "string" && version.startsWith("link:")) {
          const path = posix.normalize(
            posix.join(importer === "." ? "" : importer, version.slice(5)),
          );
          if (
            path === ".." ||
            path.startsWith("../") ||
            path.startsWith("/") ||
            !workspaceManifests.has(
              path === "." ? "package.json" : `${path}/package.json`,
            )
          )
            throw new ApiError(
              "Lien de workspace hors des manifestes autorisés.",
            );
          safeLinks.add(version);
        }
      }
    }
  }
  if (manager === "npm")
    for (const entry of Object.values(lock.packages || {})) {
      const linked = entry as any;
      if (
        linked?.link &&
        (typeof linked.resolved !== "string" ||
          linked.resolved.includes("..") ||
          !workspaceManifests.has(`${linked.resolved}/package.json`))
      )
        throw new ApiError("Lien npm hors des manifestes autorisés.");
    }
  function walk(value: unknown, depth: number, path: string[] = []) {
    if (depth > 40) throw new ApiError("Lockfile trop imbriqué.");
    if (path.includes("funding")) return;
    if (typeof value === "string") {
      if (value.startsWith("link:") && !safeLinks.has(value))
        throw new ApiError("Lien de workspace non qualifié.");
      if (/(?:git\+|git:|github:|file:|ssh:)/i.test(value))
        throw new ApiError(
          "Le lockfile contient une source non publique ou locale non prise en charge.",
        );
      if (/https?:\/\//i.test(value)) {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new ApiError("URL de résolution non prise en charge.");
        }
        if (
          url.protocol !== "https:" ||
          url.hostname !== "registry.npmjs.org" ||
          url.username ||
          url.password ||
          url.port
        )
          throw new ApiError(
            "Le lockfile utilise un registre autre que registry.npmjs.org.",
          );
      }
    } else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value))
        walk(item, depth + 1, [...path, key]);
  }
  walk(lock, 0);
}
function isolatedEnvironment(temp: string) {
  return {
    PATH: process.env.PATH || "",
    HOME: join(temp, "home"),
    NODE_ENV: "development" as const,
    CI: "true",
    npm_config_userconfig: join(temp, "user.npmrc"),
    npm_config_globalconfig: join(temp, "global.npmrc"),
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_manage_package_manager_versions: "false",
    npm_config_ignore_pnpmfile: "true",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
  };
}
export async function regenerateDependencies(
  client: GitHubMaintenanceClient,
  payload: MaintenancePayload,
  snapshot: MaintenanceFiles,
  command: typeof execute = execute,
) {
  const blocker = dependencyBlocker(snapshot);
  if (blocker) throw new ApiError(blocker);
  const operation = payload.operation;
  if (operation.kind !== "dependencies" && operation.kind !== "all")
    throw new ApiError("Opération invalide.");
  const temp = await mkdtemp(join(tmpdir(), "vigie-maintenance-"));
  try {
    await mkdir(join(temp, "home"), { recursive: true });
    await writeFile(join(temp, "user.npmrc"), "");
    await writeFile(join(temp, "global.npmrc"), "");
    const manifests = snapshot.tree.filter(
      (entry) =>
        /(?:^|\/)package\.json$/.test(entry.path) &&
        !forbidden.test(entry.path),
    );
    if (manifests.length > 80)
      throw new ApiError(
        "Monorepo de plus de 80 manifestes : intervention spécifique requise.",
      );
    const copied = new Map(snapshot.files);
    for (const entry of manifests) {
      if (!writable(entry.path))
        throw new ApiError("Chemin de manifeste non pris en charge.");
      if (!copied.has(entry.path))
        copied.set(
          entry.path,
          await client.blob(payload.repository, entry, 100_000),
        );
      assertPublicDependencies(parseManifest(copied.get(entry.path)!));
    }
    const workspaceManifests = new Set(
      manifests.map((entry) =>
        snapshot.lockDirectory
          ? entry.path.slice(snapshot.lockDirectory.length + 1)
          : entry.path,
      ),
    );
    assertPublicLock(
      copied.get(snapshot.lockPath!)!,
      snapshot.manager,
      workspaceManifests,
    );
    const workspacePath = snapshot.lockDirectory
      ? `${snapshot.lockDirectory}/pnpm-workspace.yaml`
      : "pnpm-workspace.yaml";
    const workspace = snapshot.tree.find(
      (entry) => entry.path === workspacePath,
    );
    if (workspace && snapshot.manager === "pnpm")
      copied.set(
        workspacePath,
        parseWorkspace(
          await client.blob(payload.repository, workspace, 100_000),
        ),
      );
    const nodeChanges = operation.kind === "all"
      ? nodeFileChanges(snapshot, operation.version, payload.nodeMode)
      : new Map<string, string>();
    for (const [path, content] of nodeChanges) copied.set(path, content);
    copied.set(
      snapshot.manifestPath,
      jsonText(
        updateManifest(snapshot.manifest, operation, payload.nodeMode),
        copied.get(snapshot.manifestPath),
      ),
    );
    for (const [path, content] of copied) {
      if (!writable(path) && path !== workspacePath) continue;
      const destination = resolve(temp, "source", path);
      if (!destination.startsWith(resolve(temp, "source") + sep))
        throw new ApiError("Chemin de fichier refusé.");
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    const cwd = join(temp, "source", snapshot.lockDirectory);
    if (snapshot.manager === "npm") {
      const root = parseManifest(
        copied.get(
          snapshot.lockDirectory
            ? `${snapshot.lockDirectory}/package.json`
            : "package.json",
        )!,
      );
      const version =
        typeof root.packageManager === "string"
          ? root.packageManager.match(/^npm@(\d+\.\d+\.\d+)/)?.[1]
          : null;
      const argumentsList = [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--strict-peer-deps",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
      ];
      if (version) {
        const tooling = join(temp, "npm-tooling");
        await command(
          "npm",
          [
            "install",
            "--prefix",
            tooling,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--registry=https://registry.npmjs.org",
            `npm@${version}`,
          ],
          {
            env: isolatedEnvironment(temp),
            timeout: 120_000,
            maxBuffer: 1_000_000,
          },
        );
        await command(
          process.execPath,
          [
            join(tooling, "node_modules", "npm", "bin", "npm-cli.js"),
            ...argumentsList,
          ],
          {
            cwd,
            env: isolatedEnvironment(temp),
            timeout: 240_000,
            maxBuffer: 1_000_000,
          },
        );
      } else
        await command("npm", argumentsList, {
          cwd,
          env: isolatedEnvironment(temp),
          timeout: 240_000,
          maxBuffer: 1_000_000,
        });
    } else {
      const root = parseManifest(
        copied.get(
          snapshot.lockDirectory
            ? `${snapshot.lockDirectory}/package.json`
            : "package.json",
        )!,
      );
      const version = String(root.packageManager).match(
        /^pnpm@(\d+\.\d+\.\d+)/,
      )?.[1];
      if (!version) throw new ApiError("Version pnpm exacte requise.");
      const tooling = join(temp, "tooling");
      await command(
        "npm",
        [
          "install",
          "--prefix",
          tooling,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry=https://registry.npmjs.org",
          `pnpm@${version}`,
        ],
        {
          env: isolatedEnvironment(temp),
          timeout: 120_000,
          maxBuffer: 1_000_000,
        },
      );
      await command(
        process.execPath,
        [
          join(tooling, "node_modules", "pnpm", "bin", "pnpm.cjs"),
          "install",
          "--lockfile-only",
          "--ignore-scripts",
          "--ignore-pnpmfile",
          "--strict-peer-dependencies",
          "--no-frozen-lockfile",
          "--registry=https://registry.npmjs.org",
        ],
        {
          cwd,
          env: isolatedEnvironment(temp),
          timeout: 240_000,
          maxBuffer: 1_000_000,
        },
      );
    }
    for (const entry of manifests) {
      const content = await readFile(join(temp, "source", entry.path), "utf8");
      if (
        JSON.stringify(parseManifest(content)) !==
        JSON.stringify(parseManifest(copied.get(entry.path)!))
      )
        throw new ApiError(
          "Le gestionnaire a modifié un manifeste hors du plan approuvé.",
        );
    }
    const lock = await readFile(
      join(temp, "source", snapshot.lockPath!),
      "utf8",
    );
    if (Buffer.byteLength(lock) > 4_000_000)
      throw new ApiError("Lockfile régénéré trop volumineux.");
    assertPublicLock(lock, snapshot.manager, workspaceManifests);
    return new Map([
      ...nodeChanges,
      [snapshot.manifestPath, copied.get(snapshot.manifestPath)!],
      [snapshot.lockPath!, lock],
    ]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "La résolution isolée des dépendances a échoué. Aucun script applicatif n’a été lancé ni changement fusionné. Vérifiez compatibilités, versions et registres.",
    );
  } finally {
    if (
      !resolve(temp).startsWith(resolve(tmpdir()) + sep) ||
      !temp.split(sep).at(-1)?.startsWith("vigie-maintenance-")
    )
      throw new ApiError(
        "Nettoyage refusé hors du répertoire temporaire attendu.",
      );
    await rm(temp, { recursive: true, force: true });
  }
}
export async function rollbackTree(
  client: GitHubMaintenanceClient,
  payload: MaintenancePayload,
): Promise<TreeChange[]> {
  if (payload.operation.kind !== "rollback")
    throw new ApiError("Retour code attendu.");
  const prefix = client.repo(payload.repository);
  const pull = await client.request(
    `${prefix}/pulls/${payload.operation.pullNumber}`,
  );
  if (
    !pull.merged ||
    !String(pull.body || "").includes("Vigie maintenance job ") ||
    pull.base?.ref !== payload.baseBranch ||
    pull.head?.repo?.full_name?.toLowerCase() !==
      payload.repository.toLowerCase()
  )
    throw new ApiError(
      "Retour limité aux PR Vigie fusionnées sur ce dépôt et cette branche.",
    );
  const commit = await client.request(
    `${prefix}/git/commits/${pull.merge_commit_sha}`,
  );
  if (commit.parents?.length !== 1)
    throw new ApiError(
      "Le retour automatisé exige une fusion squash à parent unique.",
    );
  const files = await client.request(
    `${prefix}/pulls/${payload.operation.pullNumber}/files?per_page=100`,
  );
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > 20 ||
    files.length !== pull.changed_files ||
    files.some(
      (file: any) => file.status !== "modified" || !writable(file.filename),
    )
  )
    throw new ApiError(
      "Le retour touche des fichiers non pris en charge ou une liste incomplète.",
    );
  const [before, merged, current] = await Promise.all([
    client.tree(payload.repository, commit.parents[0].sha),
    client.tree(payload.repository, pull.merge_commit_sha),
    client.tree(payload.repository, payload.baseSha),
  ]);
  return files.map((file: any) => {
    const old = before.find((entry) => entry.path === file.filename);
    const after = merged.find((entry) => entry.path === file.filename);
    const now = current.find((entry) => entry.path === file.filename);
    if (!old || !after || !now || now.sha !== after.sha)
      throw new ApiError(
        "Un fichier a changé depuis la mise à jour ; retour automatique bloqué pour ne pas écraser ces changements.",
      );
    return { path: file.filename, mode: "100644", type: "blob", sha: old.sha };
  });
}
export async function runMaintenanceWorker(
  raw: unknown,
  client: GitHubMaintenanceClient,
  allowedRepositories: string[],
) {
  const payload = workerPayloadSchema.parse(raw);
  if (
    !allowedRepositories.some(
      (repository) =>
        repository.trim().toLowerCase() === payload.repository.toLowerCase(),
    )
  )
    throw new ApiError("Dépôt non autorisé sur cet exécuteur.", 403);
  const prefix = client.repo(payload.repository);
  const branch = maintenanceBranch(payload.id);
  const existingPulls = await client.request(
    `${prefix}/pulls?state=all&head=${encodeURIComponent(`${payload.repository.split("/")[0]}:${branch}`)}&per_page=10`,
  );
  if (!Array.isArray(existingPulls) || existingPulls.length > 1)
    throw new ApiError("Pull request ambiguë.");
  if (existingPulls.length) {
    if (
      !String(existingPulls[0].body || "").includes(
        `Vigie maintenance job ${payload.id}`,
      ) ||
      existingPulls[0].base?.ref !== payload.baseBranch
    )
      throw new ApiError("La PR existante ne correspond pas au plan.");
    return { pullNumber: existingPulls[0].number };
  }
  if (
    (await client.branch(payload.repository, payload.baseBranch)) !==
    payload.baseSha
  )
    throw new ApiError(
      "La branche a changé depuis l’approbation. Préparez un nouveau plan.",
      409,
    );
  let changes: TreeChange[];
  if (payload.operation.kind === "rollback")
    changes = await rollbackTree(client, payload);
  else {
    const snapshot = await readMaintenanceFiles(
      client,
      payload.repository,
      payload.baseSha,
      payload.directory,
    );
    const changed =
      payload.operation.kind === "node"
        ? nodeFileChanges(snapshot, payload.operation.version, payload.nodeMode)
        : await regenerateDependencies(client, payload, snapshot);
    changes = [...changed]
      .filter(([path, content]) => content !== snapshot.files.get(path))
      .map(([path, content]) => ({
        path,
        mode: "100644",
        type: "blob",
        content,
      }));
  }
  if (!changes.length || changes.some((change) => !writable(change.path)))
    throw new ApiError("Aucun changement autorisé à publier.");
  if (
    (await client.branch(payload.repository, payload.baseBranch)) !==
    payload.baseSha
  )
    throw new ApiError(
      "La branche a changé pendant la préparation ; aucune PR publiée.",
      409,
    );
  const title = `[Vigie] ${payload.operation.kind === "all" ? `Node ${payload.operation.version} et dépendances` : payload.operation.kind === "node" ? `Node ${payload.operation.version}` : payload.operation.kind === "rollback" ? "Retour code" : "Dépendances applicatives"}`;
  const base = await client.request(`${prefix}/git/commits/${payload.baseSha}`);
  const tree = await client.request(`${prefix}/git/trees`, "POST", {
    base_tree: base.tree.sha,
    tree: changes,
  });
  const commit = await client.request(`${prefix}/git/commits`, "POST", {
    message: `${title}\n\nVigie maintenance job ${payload.id}`,
    tree: tree.sha,
    parents: [payload.baseSha],
  });
  const existingBranch = await client.request(
    `${prefix}/git/ref/heads/${encodeURIComponent(branch)}`,
    "GET",
    undefined,
    true,
  );
  if (existingBranch) {
    const previous = await client.request(
      `${prefix}/git/commits/${existingBranch.object.sha}`,
    );
    if (
      !String(previous.message).includes(
        `Vigie maintenance job ${payload.id}`,
      ) ||
      previous.tree?.sha !== tree.sha ||
      previous.parents?.[0]?.sha !== payload.baseSha
    )
      throw new ApiError(
        "Branche de maintenance déjà présente avec un contenu différent ; aucun écrasement.",
      );
  } else
    await client.request(`${prefix}/git/refs`, "POST", {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  const pull = await client.request(`${prefix}/pulls`, "POST", {
    title,
    head: branch,
    base: payload.baseBranch,
    body: `Vigie maintenance job ${payload.id}\n\nOpération : ${payload.operation.kind}.\n\nFichiers :\n${changes.map((change) => `- \`${change.path}\``).join("\n")}\n\nAucun script applicatif, test, build, migration ou déploiement exécuté par ce préparateur. Vérifier les contrôles CI et la prévisualisation avant fusion. La fusion peut déclencher le déploiement automatique. Le retour code ne restaure pas les données ni les effets externes.`,
  });
  return { pullNumber: pull.number };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = workerPayloadSchema.parse(
    JSON.parse(process.env.VIGIE_MAINTENANCE_JOB || "null"),
  );
  const token = maintenanceToken(raw.repository);
  if (!token) throw new Error("Jeton de maintenance absent.");
  runMaintenanceWorker(
    raw,
    new GitHubMaintenanceClient(token),
    (process.env.VIGIE_MAINTENANCE_REPOSITORIES || "").split(","),
  )
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        error instanceof ApiError
          ? error.message
          : "Préparation refusée. Vérifiez le plan et la configuration de l’exécuteur.",
      );
      process.exitCode = 1;
    });
}
