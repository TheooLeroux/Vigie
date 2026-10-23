import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  GitHubMaintenanceClient,
  type GitTreeEntry,
} from "./connectors/github-maintenance";
import { ApiError } from "./http";
import {
  type MaintenanceOperation,
  packageNameSchema,
  safeDirectory,
} from "./maintenance-contract";

export type Manifest = Record<string, any>;
export type MaintenanceFiles = {
  files: Map<string, string>;
  tree: GitTreeEntry[];
  manifest: Manifest;
  manifestPath: string;
  lockPath: string | null;
  lockDirectory: string;
  manager: string;
};
const join = (directory: string, file: string) =>
  directory ? `${directory}/${file}` : file;
export const parseManifest = (raw: string): Manifest => {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new ApiError("package.json invalide.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new ApiError("package.json invalide.");
  return manifest;
};
export async function readMaintenanceFiles(
  client: GitHubMaintenanceClient,
  repository: string,
  commit: string,
  directory: string,
): Promise<MaintenanceFiles> {
  directory = safeDirectory(directory);
  const tree = await client.tree(repository, commit);
  const manifestPath = join(directory, "package.json");
  if (!tree.some((entry) => entry.path === manifestPath))
    throw new ApiError(
      "Aucun package.json régulier dans le répertoire déployé. Cette configuration demande un traitement spécifique.",
    );
  const directories = [directory];
  while (directories.at(-1))
    directories.push(directories.at(-1)!.split("/").slice(0, -1).join("/"));
  let lockPath: string | null = null;
  let lockDirectory = directory;
  for (const candidate of directories) {
    const locks = [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "npm-shrinkwrap.json",
    ]
      .map((name) => join(candidate, name))
      .filter((path) => tree.some((entry) => entry.path === path));
    if (locks.length > 1)
      throw new ApiError(
        "Plusieurs lockfiles concurrents : qualifiez le gestionnaire utilisé avant maintenance.",
      );
    if (locks.length) {
      lockPath = locks[0];
      lockDirectory = candidate;
      break;
    }
  }
  const selected = new Set([
    manifestPath,
    ...(lockPath ? [lockPath] : []),
    ...directories.flatMap((candidate) => [
      join(candidate, ".nvmrc"),
      join(candidate, ".node-version"),
      join(candidate, "package.json"),
    ]),
  ]);
  const files = new Map<string, string>();
  for (const entry of tree.filter((entry) => selected.has(entry.path)))
    files.set(
      entry.path,
      await client.blob(
        repository,
        entry,
        entry.path.endsWith("package.json") ? 100_000 : 4_000_000,
      ),
    );
  const manifest = parseManifest(files.get(manifestPath)!);
  const manager = lockPath?.endsWith("package-lock.json")
    ? "npm"
    : lockPath?.endsWith("pnpm-lock.yaml")
      ? "pnpm"
      : lockPath?.endsWith("yarn.lock")
        ? "yarn"
        : lockPath?.includes("bun.lock")
          ? "bun"
          : "inconnu";
  return {
    files,
    tree,
    manifest,
    manifestPath,
    lockPath,
    lockDirectory,
    manager,
  };
}
export function dependencyBlocker(snapshot: MaintenanceFiles) {
  if (!["npm", "pnpm"].includes(snapshot.manager))
    return "La régénération sécurisée des dépendances est disponible pour npm et pnpm avec lockfile. Yarn, Bun et les autres formats restent bloqués.";
  const declaration = snapshot.files.get(
    join(snapshot.lockDirectory, "package.json"),
  );
  if (!declaration) return "Le manifeste associé au lockfile est absent.";
  const manager = parseManifest(declaration).packageManager;
  if (
    manager &&
    (typeof manager !== "string" ||
      !new RegExp(
        `^${snapshot.manager}@\\d+\\.\\d+\\.\\d+(?:\\+sha(?:224|512)\\.[a-f0-9]+)?$`,
      ).test(manager))
  )
    return "Le gestionnaire déclaré et le lockfile ne correspondent pas ou sa version n’est pas exacte.";
  if (snapshot.manager === "pnpm" && !manager)
    return "pnpm exige une version exacte dans packageManager pour régénérer son lockfile.";
  return null;
}
export function listedDependencies(manifest: Manifest) {
  return ["dependencies", "devDependencies", "optionalDependencies"].flatMap(
    (scope) =>
      Object.entries(manifest[scope] || {}).flatMap(([name, declared]) =>
        packageNameSchema.safeParse(name).success &&
        typeof declared === "string"
          ? [{ name, declared, scope }]
          : [],
      ),
  );
}
export function updateManifest(
  manifest: Manifest,
  operation: MaintenanceOperation,
  nodeMode: "major" | "exact" = "major",
): Manifest {
  const updated = structuredClone(manifest);
  if (operation.kind === "node" || operation.kind === "all") {
    const major = operation.version.split(".")[0];
    const target = nodeMode === "exact" ? operation.version : `${major}.x`;
    updated.engines = { ...updated.engines, node: target };
    if (updated.volta?.node) updated.volta.node = operation.version;
    if (updated.devEngines?.runtime) {
      const runtimes = Array.isArray(updated.devEngines.runtime)
        ? updated.devEngines.runtime
        : [updated.devEngines.runtime];
      for (const runtime of runtimes)
        if (runtime.name === "node") runtime.version = target;
    }
  }
  if (operation.kind === "dependencies" || operation.kind === "all") {
    const names = new Set<string>();
    for (const update of operation.updates) {
      if (names.has(update.name))
        throw new ApiError("Un composant est sélectionné plusieurs fois.");
      names.add(update.name);
      let found = false;
      for (const scope of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ]) {
        if (Object.hasOwn(updated[scope] || {}, update.name)) {
          if (String(updated[scope][update.name]).startsWith("workspace:"))
            throw new ApiError(
              "Les liens de workspace internes ne se remplacent pas par une version du registre.",
            );
          updated[scope][update.name] = update.version;
          found = true;
        }
      }
      if (!found)
        throw new ApiError("Composant absent du manifeste sélectionné.");
    }
  }
  return updated;
}
export function jsonText(value: unknown, previous = "") {
  const indent = previous.match(/\n([ \t]+)"/)?.[1] || "  ";
  const text = JSON.stringify(value, null, indent) + "\n";
  return previous.includes("\r\n") ? text.replaceAll("\n", "\r\n") : text;
}
export function nodeFileChanges(
  snapshot: MaintenanceFiles,
  version: string,
  nodeMode: "major" | "exact" = "major",
) {
  const changed = new Map<string, string>();
  const operation = { kind: "node", version } as const;
  const next = updateManifest(snapshot.manifest, operation, nodeMode);
  if (JSON.stringify(next) !== JSON.stringify(snapshot.manifest))
    changed.set(
      snapshot.manifestPath,
      jsonText(next, snapshot.files.get(snapshot.manifestPath)),
    );
  const directory = snapshot.manifestPath.split("/").slice(0, -1).join("/");
  for (const [path, content] of snapshot.files) {
    if (
      path === join(directory, ".nvmrc") ||
      path === join(directory, ".node-version")
    )
      changed.set(path, `${version}\n`);
    else if (
      (path.endsWith(".nvmrc") || path.endsWith(".node-version")) &&
      directory
    )
      throw new ApiError(
        "Une version Node héritée d’un dossier parent affecte plusieurs services. Qualifiez la portée avant modification.",
      );
    if (path !== snapshot.manifestPath && path.endsWith("package.json")) {
      const parent = parseManifest(content);
      if (
        parent.engines?.node ||
        parent.devEngines?.runtime ||
        parent.volta?.node
      )
        throw new ApiError(
          "Un runtime Node déclaré dans un manifeste parent peut prendre priorité. Cette portée partagée doit être qualifiée.",
        );
    }
  }
  if (snapshot.manager === "npm" && snapshot.lockPath) {
    const previous = snapshot.files.get(snapshot.lockPath)!;
    const lock = parseManifest(previous);
    const key = snapshot.lockDirectory
      ? directory.slice(snapshot.lockDirectory.length + 1)
      : directory;
    if (lock.packages?.[key] &&
      JSON.stringify(lock.packages[key].engines) !== JSON.stringify(next.engines)) {
      lock.packages[key].engines = next.engines;
      changed.set(snapshot.lockPath, jsonText(lock, previous));
    }
  }
  return new Map(
    [...changed].filter(
      ([path, content]) => content !== snapshot.files.get(path),
    ),
  );
}
export function parseWorkspace(raw: string) {
  const workspace = parseYaml(raw, { maxAliasCount: 10 });
  if (
    !workspace ||
    typeof workspace !== "object" ||
    Array.isArray(workspace) ||
    Object.keys(workspace).some(
      (key) =>
        ![
          "packages",
          "catalog",
          "catalogs",
          "overrides",
          "onlyBuiltDependencies",
          "ignoredBuiltDependencies",
          "neverBuiltDependencies",
        ].includes(key),
    )
  )
    throw new ApiError(
      "Configuration pnpm-workspace non prise en charge sans revue spécifique.",
    );
  if (
    workspace.packages &&
    (!Array.isArray(workspace.packages) ||
      workspace.packages.some(
        (path: unknown) =>
          typeof path !== "string" ||
          path.startsWith("/") ||
          path.includes("..") ||
          path.includes("\\") ||
          !/^[!A-Za-z0-9@_.*?{}\/, -]+$/.test(path),
      ))
  )
    throw new ApiError("Chemin de workspace hors périmètre.");
  const specifications = [
    workspace.catalog,
    ...Object.values(workspace.catalogs || {}),
    workspace.overrides,
  ];
  for (const mapping of specifications) {
    if (
      mapping &&
      (typeof mapping !== "object" ||
        Array.isArray(mapping) ||
        Object.values(mapping).some(
          (value) =>
            typeof value !== "string" ||
            !/^[a-zA-Z0-9.*^~<>=| +()-]+$/.test(value),
        ))
    )
      throw new ApiError(
        "Catalogue ou override pnpm non public ou non pris en charge.",
      );
  }
  return stringifyYaml(workspace);
}
