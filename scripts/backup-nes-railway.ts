import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";
import { runBackup } from "../src/lib/backups";
import { runCommand } from "../src/lib/updates/process";

const projectId = "b318d717-ef03-44ca-8feb-f4e9eb6d6fe2";
const environmentId = "b3ca01d9-0295-4dab-ac62-7860ba87df95";
const vigieProjectId = "f458d781-18cd-48d3-b65b-42372755dd04";
const backendId = "0bcc758c-7650-4500-9388-54b5fecbe170";
const repository = "TheooLeroux/NesAppli";
const supabaseRef = "yaakyyvqcdsizchkiozq";
const roots = ["/backend", "/docs-site", "/frontend"];
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const commitHash = z.string().regex(/^[0-9a-f]{40}$/);
const serviceSchema = z.object({
  serviceId: z.uuid(),
  serviceName: z.string(),
  rootDirectory: z.string().nullable(),
  builder: z.string().nullable(),
  dockerfilePath: z.string().nullable(),
  source: z.object({ repo: z.string().nullable(), image: z.string().nullable() }),
  activeDeployments: z.array(z.object({
    id: z.uuid(), status: z.literal("SUCCESS"),
    meta: z.object({ commitHash: commitHash.optional(), imageDigest: digest }),
  })).length(1),
});

async function inventory() {
  const token = process.env.VIGIE_NES_RAILWAY_TOKEN;
  if (!token) throw new Error("Jeton Railway NES App absent.");
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "Project-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query BackupNesApp($id:String!,$project:String!,$backend:String!) {
        projectToken { projectId environmentId }
        variables(projectId:$project,environmentId:$id,serviceId:$backend)
        environment(id:$id) {
          id
          volumeInstances(first:20) { edges { node { volumeId } } pageInfo { hasNextPage } }
          serviceInstances(first:20) {
            pageInfo { hasNextPage }
            edges { node {
              serviceId serviceName rootDirectory builder dockerfilePath source { repo image }
              activeDeployments { id status meta }
            } }
          }
        }
      }`,
      variables: { id: environmentId, project: projectId, backend: backendId },
    }),
  });
  if (!response.ok) throw new Error("Inventaire de production Railway indisponible.");
  const body = await response.json();
  const parsed = z.object({
    projectToken: z.object({ projectId: z.literal(projectId), environmentId: z.literal(environmentId) }),
    variables: z.object({ SUPABASE_URL: z.string().regex(new RegExp("^https://" + supabaseRef + "\\.supabase\\.co/?$")) }),
    environment: z.object({
      id: z.literal(environmentId),
      volumeInstances: z.object({ edges: z.array(z.unknown()).length(0), pageInfo: z.object({ hasNextPage: z.literal(false) }) }),
      serviceInstances: z.object({
        pageInfo: z.object({ hasNextPage: z.literal(false) }),
        edges: z.array(z.object({ node: serviceSchema })).length(4),
      }),
    }),
  }).safeParse(body.data);
  if (body.errors || !parsed.success) throw new Error("Le périmètre Railway a changé ou contient un volume à qualifier.");
  const services = parsed.data.environment.serviceInstances.edges.map(({ node }) => node)
    .sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  const app = services.filter(service => service.source.repo === repository);
  if (JSON.stringify(app.map(service => service.rootDirectory).sort()) !== JSON.stringify(roots) ||
      !app.some(service => service.rootDirectory === "/backend" && service.serviceId === backendId) ||
      app.some(service => !service.activeDeployments[0].meta.commitHash) ||
      services.filter(service => service.serviceName === "tailscale" && service.source.image?.startsWith("docker.io/tailscale/tailscale@sha256:")).length !== 1) {
    throw new Error("Sources de NES App différentes du périmètre validé.");
  }
  return services.map(service => {
    const [{ id: deploymentId, meta }] = service.activeDeployments;
    return {
      service: service.serviceName, serviceId: service.serviceId, deploymentId, root: service.rootDirectory,
      builder: service.builder, dockerfile: service.dockerfilePath, image: service.source.image,
      imageDigest: meta.imageDigest, repository: service.source.repo, commit: meta.commitHash ?? null,
    };
  });
}

function postgresEnvironment() {
  const password = process.env.VIGIE_NES_DATABASE_PASSWORD;
  const ca = process.env.VIGIE_NES_SUPABASE_CA;
  if (!password || !ca) throw new Error("Accès Supabase du worker incomplet.");
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production", PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
    PGHOST: "aws-0-eu-west-3.pooler.supabase.com", PGPORT: "5432",
    PGUSER: "vigie_nes_backup." + supabaseRef, PGPASSWORD: password, PGDATABASE: "postgres",
    PGSSLMODE: "verify-full", PGSSLROOTCERT: resolve(ca), PGCONNECT_TIMEOUT: "15",
    PGAPPNAME: "vigie-nes-backup",
  };
  if (process.platform === "win32") env.WSLENV = "PGHOST:PGPORT:PGUSER:PGPASSWORD:PGDATABASE:PGSSLMODE:PGSSLROOTCERT/p:PGCONNECT_TIMEOUT:PGAPPNAME";
  return env;
}

function postgresCommand(tool: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout: number }) {
  return process.platform === "win32"
    ? runCommand("wsl.exe", ["-d", "Debian", "--", tool, ...args], options)
    : runCommand(tool, args, options);
}

async function captureDatabase(folder: string) {
  const database = join(folder, "database.dump");
  const output = process.platform === "win32"
    ? (await postgresCommand("wslpath", ["-a", database.replaceAll("\\", "/")], { timeout: 10_000 })).trim()
    : database;
  await postgresCommand("pg_dump", [
    "--no-password", "--format=custom", "--no-owner", "--no-acl", "--lock-wait-timeout=10s",
    "--schema=public", "--schema=auth", "--schema=storage", "--schema=supabase_migrations", "--file=" + output,
  ], { env: postgresEnvironment(), timeout: 20 * 60_000 });
  const toc = await postgresCommand("pg_restore", ["--list", output], { timeout: 30_000 });
  for (const table of ["public profiles", "auth users", "auth identities", "storage objects"]) {
    if (!toc.includes("TABLE DATA " + table + " ")) throw new Error("Données attendues absentes du dump PostgreSQL.");
  }
  await postgresCommand("pg_restore", ["--exit-on-error", "--file=/dev/null", output], { timeout: 10 * 60_000 });
  return toc.split("\n").filter(line => / TABLE DATA /.test(line)).length;
}

async function collect(folder: string, output: string) {
  const services = await inventory();
  const gitDirectory = process.env.VIGIE_NES_GIT_DIRECTORY ?? join(folder, "source.git");
  const gitOptions = { timeout: 180_000 };
  const git = (args: string[], acceptedExitCodes?: number[]) =>
    runCommand("git", ["--git-dir", gitDirectory, ...args], { ...gitOptions, acceptedExitCodes });
  if (!process.env.VIGIE_NES_GIT_DIRECTORY) await git(["init", "--bare"]);
  const sources = new Map<string, string>();
  for (const service of services) {
    if (!service.commit) continue;
    if (!process.env.VIGIE_NES_GIT_DIRECTORY && !sources.has(service.commit)) {
      await git(["fetch", "--quiet", "--no-tags", "--depth=1", "ssh://git@github.com/" + repository + ".git", service.commit]);
    }
    const path = (service.root ?? "").slice(1) + "/package.json";
    await git(["cat-file", "-e", service.commit + ":" + path]);
    if (sources.has(service.commit)) continue;
    const modes = await git(["ls-tree", "-r", "--format=%(objectmode)", service.commit]);
    const lfs = await git(["grep", "-l", "-F", "version https://git-lfs.github.com/spec/v1", service.commit, "--"], [0, 1]);
    if (modes.split(/\s+/).includes("160000") || lfs.trim()) throw new Error("Les sous-modules ou fichiers Git LFS de NES App demandent une collecte dédiée.");
    const source = "app-" + service.commit + ".tar.gz";
    await git(["archive", "--format=tar.gz", "--output=" + join(folder, source), service.commit]);
    sources.set(service.commit, source);
  }
  const tableDataEntries = await captureDatabase(folder);
  if (JSON.stringify(services) !== JSON.stringify(await inventory())) throw new Error("Un déploiement Railway a changé pendant la sauvegarde.");
  const manifest = {
    format: "vigie.railway-backup", version: 1, project: "NES App", projectId, environmentId,
    capturedAt: new Date().toISOString(), services, sources: Object.fromEntries(sources),
    database: { provider: "supabase", projectRef: supabaseRef, format: "pg_dump custom", tableDataEntries },
  };
  await writeFile(join(folder, "deployment.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await runCommand(process.platform === "win32" ? "python" : "python3",
    ["scripts/pack-git-backup.py", folder, output, ...sources.values()], { timeout: 10 * 60_000 });
  console.log("Dump validé pour " + tableDataEntries + " tables ou partitions.");
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--verify") {
    const scratch = process.env.VIGIE_BACKUP_SCRATCH_DIRECTORY;
    if (!scratch) throw new Error("Répertoire temporaire de vérification manquant.");
    const folder = await mkdtemp(join(resolve(scratch), "nes-verify-"));
    try {
      await collect(folder, join(folder, "verify.zip"));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
    return;
  }
  if (args.length) throw new Error("Argument de sauvegarde inconnu.");
  const saved = await runBackup(vigieProjectId, collect);
  console.log(saved ? "ZIP vérifié pour NES App." : "Le créneau NES App possède déjà un ZIP vérifié ou réservé.");
}

main(process.argv.slice(2)).catch(error => {
  console.error("Sauvegarde NES App en échec.", error instanceof Error ? error.message : "");
  process.exitCode = 1;
});
