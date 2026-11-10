import { resolve } from "node:path";

import { z } from "zod";
import { runPlatformBackup } from "./platform-backup";
import { nesRailway } from "./platform-backup-targets";
import { assertPlatformBackupLink } from "./check-platform-backup-link";

const { remoteId: projectId, projectId: vigieProjectId } = nesRailway;
const environmentId = "b3ca01d9-0295-4dab-ac62-7860ba87df95";
const backendId = "0bcc758c-7650-4500-9388-54b5fecbe170";
const repository = "TheooLeroux/NesAppli";
const githubApp = Boolean(process.env.VIGIE_BACKUP_GITHUB_APP_ID || process.env.VIGIE_BACKUP_GITHUB_APP_KEY);
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

runPlatformBackup({
  projectId: vigieProjectId,
  name: "NES App",
  inventory,
  assertLinked: () => assertPlatformBackupLink(nesRailway),
  git: { repository, transport: githubApp ? "github-app" : "ssh", directory: githubApp ? undefined : process.env.VIGIE_NES_GIT_DIRECTORY },
  databases: [{
    file: "database.dump",
    windowsClient: 17,
    environment: postgresEnvironment,
    dumpOptions: ["--no-owner", "--no-acl", "--schema=public", "--schema=auth", "--schema=storage", "--schema=supabase_migrations"],
    requiredTables: ["public profiles", "auth users", "auth identities", "storage objects"],
  }],
  manifest: (services, sources, [{ tableDataEntries }]) => ({
    format: "vigie.railway-backup", version: 1, project: "NES App", projectId, environmentId,
    capturedAt: new Date().toISOString(), services, sources,
    database: { provider: "supabase", projectRef: supabaseRef, format: "pg_dump custom", tableDataEntries },
  }),
}, process.argv.slice(2)).catch(error => {
  console.error("Sauvegarde NES App en échec.", error instanceof Error ? error.message : "");
  process.exitCode = 1;
});
