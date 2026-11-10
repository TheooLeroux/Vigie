import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBackup } from "../src/lib/backups";
import { runCommand } from "../src/lib/updates/process";
import {
  neonDatabaseFingerprint, runtimeProofSchema, runtimeSignature, vercelRuntimePath, verifyRuntimeSignature,
} from "../src/lib/updates/vercel-runtime-protocol";

const vigieProjectId = "8f19124d-6da3-466b-9c44-ac385bf060a7";
const vercelProjectId = "prj_r43pgnpxl2UeE9yrz8l8Y6OuEdXo";
const origin = "https://vigie-azure.vercel.app";
const repository = "TheooLeroux/Vigie";
const serviceRoot = "/";

async function productionDeployment() {
  const options = { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(25_000) } as const;
  const page = await fetch(origin + "/connexion", options);
  if (!page.ok) throw new Error("Page de production de Vigie indisponible.");
  const ids = new Set(Array.from((await page.text()).matchAll(/data-dpl-id="(dpl_[a-zA-Z0-9]+)"/g), match => match[1]));
  if (ids.size !== 1) throw new Error("Identifiant du déploiement Vercel introuvable ou ambigu.");
  const [deploymentId] = ids;
  const nonce = randomBytes(32).toString("hex");
  const body = JSON.stringify({ projectId: vercelProjectId, deploymentId, nonce, database: true });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(origin + vercelRuntimePath, {
    ...options,
    method: "POST", body,
    headers: {
      "Content-Type": "application/json", "X-Vigie-Time": timestamp,
      "X-Vigie-Signature": runtimeSignature(vercelProjectId, "request", body, timestamp),
    },
  });
  if (!response.ok) throw new Error("Le déploiement de production n’a pas pu être attesté.");
  const proof = await response.json();
  const payload = runtimeProofSchema.parse(proof.payload);
  verifyRuntimeSignature(vercelProjectId, "response", JSON.stringify(payload), proof.timestamp, proof.signature);
  if (payload.nonce !== nonce || payload.projectId !== vercelProjectId || payload.deploymentId !== deploymentId ||
      payload.repository !== repository || !payload.commit) {
    throw new Error("Le déploiement de Vigie ne correspond pas au dépôt attendu.");
  }
  const sourceDatabase = neonDatabaseFingerprint(vercelProjectId, process.env.VIGIE_SELF_SOURCE_DATABASE_URL);
  const catalogDatabase = neonDatabaseFingerprint(vercelProjectId, process.env.DATABASE_URL);
  if (payload.databaseFingerprint !== sourceDatabase || catalogDatabase !== sourceDatabase) {
    throw new Error("La base à sauvegarder et le catalogue doivent correspondre à la base de production de Vigie.");
  }
  return { service: "Vigie", root: serviceRoot, deploymentId, commit: payload.commit,
    repository, branch: payload.branch, node: payload.node, region: payload.region };
}

function postgresEnvironment() {
  const source = new URL(process.env.VIGIE_SELF_SOURCE_DATABASE_URL ?? "");
  if (source.protocol !== "postgresql:" || !source.hostname.endsWith(".neon.tech") ||
      source.hostname.includes("-pooler.") || source.username !== "vigie_self_dump" ||
      !source.password || (source.port && source.port !== "5432") || source.pathname.length <= 1) {
    throw new Error("Connexion directe Neon de sauvegarde invalide.");
  }
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production", PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
    PGHOST: source.hostname, PGPORT: "5432", PGDATABASE: decodeURIComponent(source.pathname.slice(1)),
    PGUSER: source.username, PGPASSWORD: decodeURIComponent(source.password), PGCONNECT_TIMEOUT: "15",
    PGSSLMODE: "verify-full", PGSSLROOTCERT: "system", PGCHANNELBINDING: "require", PGAPPNAME: "vigie-self-backup",
  };
  if (process.platform === "win32") {
    env.WSLENV = Object.keys(env).filter(name => name.startsWith("PG")).join(":");
  }
  return env;
}

async function captureDatabase(folder: string) {
  const windows = process.platform === "win32";
  const archive = join(folder, "database.dump");
  const output = windows
    ? (await runCommand("wsl.exe", ["-d", "Debian", "--", "wslpath", "-a", archive.replaceAll("\\", "/")], { timeout: 10_000 })).trim()
    : archive;
  const postgres = (tool: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv) => windows
    ? runCommand("wsl.exe", ["-d", "Debian", "--", "/usr/lib/postgresql/18/bin/" + tool, ...args], { env, timeout })
    : runCommand(tool, args, { env, timeout });
  await postgres("pg_dump", ["--no-password", "--format=custom", "--lock-wait-timeout=10s", "--file=" + output],
    20 * 60_000, postgresEnvironment());
  const toc = await postgres("pg_restore", ["--list", output], 30_000);
  for (const table of ["projects", "project_backups", "session", "hosting_connections", "vercel_connections"]) {
    if (!toc.includes("TABLE DATA public " + table + " ")) throw new Error("Données attendues absentes du dump Neon.");
  }
  await postgres("pg_restore", ["--exit-on-error", "--file=/dev/null", output], 10 * 60_000);
  return toc.split("\n").filter(line => line.includes(" TABLE DATA ")).length;
}

async function collect(folder: string, output: string) {
  const deployment = await productionDeployment();
  const commit = deployment.commit;
  const git = (args: string[], acceptedExitCodes?: number[]) =>
    runCommand("git", args, { timeout: 180_000, acceptedExitCodes });
  if (!(await git(["rev-parse", "--verify", "--quiet", commit + "^{commit}"], [0, 1])).trim()) {
    await git(["fetch", "--quiet", "--no-tags", "--depth=1", "https://github.com/" + repository + ".git", commit]);
  }
  const modes = await git(["ls-tree", "-r", "--format=%(objectmode)", commit]);
  if (modes.split(/\s+/).includes("160000")) throw new Error("Un sous-module Git requiert une collecte dédiée.");
  const lfs = await git(["grep", "-l", "-E", "^version https://git-lfs.github.com/spec/v1$", commit, "--"], [0, 1]);
  if (lfs.trim()) throw new Error("Un fichier Git LFS requiert une collecte dédiée.");
  const source = "app-" + commit + ".tar.gz";
  await git(["archive", "--format=tar.gz", "--output=" + join(folder, source), commit]);
  const tableDataEntries = await captureDatabase(folder);
  if ((await productionDeployment()).deploymentId !== deployment.deploymentId) {
    throw new Error("Le déploiement de production a changé pendant la sauvegarde.");
  }
  const manifest = {
    format: "vigie.vercel-backup", version: 1, project: "Vigie", vercelProjectId, origin,
    capturedAt: new Date().toISOString(), services: [deployment], sources: { [commit]: source },
    database: { provider: "neon", format: "pg_dump custom", tableDataEntries },
  };
  await writeFile(join(folder, "deployment.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await runCommand(process.platform === "win32" ? "python" : "python3",
    ["scripts/pack-git-backup.py", folder, output, source], { timeout: 10 * 60_000 });
  console.log("Dump Neon validé pour " + tableDataEntries + " tables ou partitions.");
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--verify") {
    const scratch = process.env.VIGIE_BACKUP_SCRATCH_DIRECTORY;
    if (!scratch) throw new Error("Répertoire temporaire de vérification manquant.");
    const folder = await mkdtemp(join(resolve(scratch), "vigie-verify-"));
    try { await collect(folder, join(folder, "verify.zip")); }
    finally { await rm(folder, { recursive: true, force: true }); }
    return;
  }
  if (args.length) throw new Error("Argument de sauvegarde inconnu.");
  const saved = await runBackup(vigieProjectId, collect);
  console.log(saved ? "ZIP vérifié pour Vigie." : "Le créneau Vigie possède déjà un ZIP vérifié ou réservé.");
}

main(process.argv.slice(2)).catch(error => {
  console.error("Sauvegarde Vigie en échec.", error instanceof Error ? error.message : "");
  process.exitCode = 1;
});
