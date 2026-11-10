import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runBackup } from "../src/lib/backups";
import { runCommand } from "../src/lib/updates/process";
import { githubBackupToken } from "./backup-github-app";

type Service = { repository: string | null; commit: string | null; root: string | null };
type GitSource = {
  repository: string;
  transport: "ssh" | "https" | "github-app";
  directory?: string;
  checkout?: boolean;
};
type Database = {
  file: string;
  windowsClient: number;
  environment: () => NodeJS.ProcessEnv;
  dumpOptions?: string[];
  requiredTables: string[];
};

type Dump = { file: string; tableDataEntries: number };

type Profile<T extends Service> = {
  projectId: string;
  name: string;
  inventory: () => Promise<T[]>;
  assertLinked?: () => Promise<void>;
  sameInventory?: (before: T[], after: T[]) => boolean;
  git: GitSource;
  databases: Database[];
  manifest: (services: T[], sources: Record<string, string>, dumps: Dump[]) => object;
};

export async function archiveSources(folder: string, services: Service[], source: GitSource) {
  const commits = new Set<string>();
  for (const service of services) {
    if (!service.commit) {
      if (service.repository) throw new Error("Commit déployé manquant pour un service Git.");
      continue;
    }
    if (!/^[0-9a-f]{40}$/.test(service.commit) || service.repository !== source.repository || service.root === null) {
      throw new Error("Source Git différente du périmètre qualifié.");
    }
    commits.add(service.commit);
  }
  if (!commits.size) throw new Error("Aucune source Git de production vérifiable.");

  const directory = source.directory ?? join(folder, "source.git");
  const git = (args: string[], acceptedExitCodes?: number[], env?: NodeJS.ProcessEnv) => runCommand("git", [
    "--no-replace-objects", ...(source.checkout ? [] : ["--git-dir", directory]), ...args,
  ], { timeout: 180_000, acceptedExitCodes, env });
  if (!source.checkout && !source.directory) await git(["init", "--bare"]);
  const remote = (source.transport === "ssh" ? "ssh://git@github.com/" : "https://github.com/") + source.repository + ".git";
  const archives: Record<string, string> = {};
  for (const commit of commits) {
    const local = (await git(["rev-parse", "--verify", "--quiet", commit + "^{commit}"], [0, 1])).trim();
    if (local && local !== commit) throw new Error("La référence Git ne désigne pas un commit.");
    if (!local && !source.directory) {
      let env: NodeJS.ProcessEnv | undefined;
      if (source.transport === "github-app") {
        const token = await githubBackupToken(source.repository);
        env = {
          NODE_ENV: "production", PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.followRedirects", GIT_CONFIG_VALUE_0: "false",
          GIT_CONFIG_KEY_1: "http.https://github.com/.extraHeader",
          GIT_CONFIG_VALUE_1: "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64"),
        };
      }
      await git(["fetch", "--quiet", "--no-tags", "--depth=1", remote, commit], undefined, env);
    }
    if ((await git(["rev-parse", "--verify", commit + "^{commit}"])).trim() !== commit) {
      throw new Error("Commit de production introuvable.");
    }
    const roots = new Set(services.filter(service => service.commit === commit).map(service => service.root ?? ""));
    for (const root of roots) {
      const path = [root.replace(/^\/+|\/+$/g, ""), "package.json"].filter(Boolean).join("/");
      await git(["cat-file", "-e", commit + ":" + path]);
    }
    const modes = await git(["ls-tree", "-r", "--format=%(objectmode)", commit]);
    const lfs = await git(["grep", "-l", "-E", "^version https://git-lfs[.]github[.]com/spec/v1$", commit, "--"], [0, 1]);
    if (modes.split(/\s+/).includes("160000") || lfs.trim()) {
      throw new Error("Les sous-modules ou fichiers Git LFS demandent une collecte dédiée.");
    }
    const filename = "app-" + commit + ".tar.gz";
    await git(["archive", "--format=tar.gz", "--output=" + join(folder, filename), commit]);
    archives[commit] = filename;
  }
  return archives;
}

async function captureDatabase(folder: string, database: Database, environment: NodeJS.ProcessEnv): Promise<Dump> {
  const windows = process.platform === "win32";
  const archive = join(folder, database.file);
  const output = windows
    ? (await runCommand("wsl.exe", ["-d", "Debian", "--", "wslpath", "-a", archive.replaceAll("\\", "/")], { timeout: 10_000 })).trim()
    : archive;
  const postgres = (tool: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv) => windows
    ? runCommand("wsl.exe", ["-d", "Debian", "--", "/usr/lib/postgresql/" + database.windowsClient + "/bin/" + tool, ...args], { env, timeout })
    : runCommand(tool, args, { env, timeout });
  await postgres("pg_dump", [
    "--no-password", "--format=custom", "--lock-wait-timeout=10s", ...(database.dumpOptions ?? []), "--file=" + output,
  ], 20 * 60_000, environment);
  const toc = await postgres("pg_restore", ["--list", output], 30_000);
  const tables = toc.split(/\r?\n/).filter(line => /^\d+; \d+ \d+ TABLE DATA /.test(line));
  if (!tables.length || database.requiredTables.some(table => !tables.some(line => line.includes(" TABLE DATA " + table + " ")))) {
    throw new Error("Données attendues absentes du dump PostgreSQL.");
  }
  await postgres("pg_restore", ["--exit-on-error", "--file=/dev/null", output], 10 * 60_000);
  return { file: database.file, tableDataEntries: tables.length };
}

export async function runPlatformBackup<T extends Service>(profile: Profile<T>, args: string[]) {
  const automatic = args.length === 1 && ["--automatic", "--automatic-verify"].includes(args[0]);
  const verify = args.length === 1 && ["--verify", "--automatic-verify"].includes(args[0]);
  const assertLinked = automatic ? profile.assertLinked : undefined;
  if (automatic && !assertLinked) throw new Error("Contrôle du lien automatique manquant.");
  async function collect(folder: string, output: string) {
    await assertLinked?.();
    const files = profile.databases.map(database => database.file);
    if (!files.length || new Set(files).size !== files.length ||
        files.some(file => !/^database(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.dump$/.test(file))) {
      throw new Error("Noms des dumps PostgreSQL invalides ou en double.");
    }
    const services = await profile.inventory();
    const databases = profile.databases.map(database => ({ database, env: database.environment() }));
    const identities = new Set(databases.map(({ env }) => JSON.stringify([
      env.PGHOSTADDR || env.PGHOST, env.PGPORT || "5432", env.PGDATABASE,
    ])));
    if (identities.size !== databases.length) throw new Error("Une base PostgreSQL est déclarée plusieurs fois.");
    const sources = await archiveSources(folder, services, profile.git);
    const dumps: Dump[] = [];
    for (const { database, env } of databases) dumps.push(await captureDatabase(folder, database, env));
    if (!(profile.sameInventory ?? isDeepStrictEqual)(services, await profile.inventory())) {
      throw new Error("Le périmètre de production a changé pendant la sauvegarde.");
    }
    const manifest = profile.manifest(services, sources, dumps);
    await writeFile(join(folder, "deployment.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    await runCommand(process.platform === "win32" ? "python" : "python3", [
      "scripts/pack-git-backup.py", folder, output, ...Object.values(sources), ...files.flatMap(file => ["--database", file]),
    ], { timeout: 10 * 60_000 });
    await assertLinked?.();
    const summary = dumps.map(dump => dump.file + " (" + dump.tableDataEntries + " tables ou partitions)").join(", ");
    console.log("ZIP contrôlé pour " + profile.name + " : " + summary + ".");
  }

  if (verify) {
    const scratch = process.env.VIGIE_BACKUP_SCRATCH_DIRECTORY;
    if (!scratch) throw new Error("Répertoire temporaire de vérification manquant.");
    const folder = await mkdtemp(join(resolve(scratch), ".platform-verify-"));
    try { await collect(folder, join(folder, "verify.zip")); }
    finally { await rm(folder, { recursive: true, force: true }); }
    return;
  }
  if (args.length && !automatic) throw new Error("Argument de sauvegarde inconnu.");
  await assertLinked?.();
  const saved = await runBackup(profile.projectId, collect);
  console.log(saved ? "ZIP publié pour " + profile.name + "." : "Le créneau possède déjà un ZIP vérifié ou réservé.");
}
