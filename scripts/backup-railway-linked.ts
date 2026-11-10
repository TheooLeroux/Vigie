import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { withRailwayInstances } from "../src/lib/updates/docker-node";
import { runCommand } from "../src/lib/updates/process";
import { railwayConnectionRequest } from "../src/lib/updates/providers";
import type { RailwayProject } from "../src/lib/railway-types";
import type { BackupDatabase } from "./platform-backup";

const uuid = z.uuid();
const page = <T extends z.ZodType>(node: T) => z.object({
  edges: z.array(z.object({ node })).max(50), pageInfo: z.object({ hasNextPage: z.literal(false) }),
});
const railwayInventory = z.object({
  environment: z.object({
    id: uuid, projectId: uuid, name: z.literal("production"), isEphemeral: z.literal(false),
    volumeInstances: page(z.object({ volumeId: uuid, serviceId: uuid, mountPath: z.string(), state: z.literal("READY") })),
    serviceInstances: page(z.object({
      serviceId: uuid, serviceName: z.string(), rootDirectory: z.string().nullable(),
      source: z.object({ repo: z.string().nullable(), image: z.string().nullable() }),
      activeDeployments: z.array(z.object({
        id: uuid, status: z.literal("SUCCESS"),
        meta: z.object({ commitHash: z.string().regex(/^[a-f0-9]{40}$/).optional(), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
      })).length(1),
    })),
  }),
});
const postgresImage = /^ghcr\.io\/railwayapp-templates\/postgres-ssl:(1[5-8])(?:\.\d+)?$/;
const dataVariable = /(?:^|_)(?:DATABASE|DB|POSTGRES|NEON|SUPABASE|MYSQL|MONGODB|REDIS|UPSTASH|BLOB|S3|R2|BUCKET|STORAGE|FIREBASE|TURSO|LIBSQL|KV)(?:_|$)/i;
const databaseName = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/;
const maxDumpBytes = 4 * 1024 ** 3;

type RailwayDatabase = { serviceId: string; deploymentId: string; environmentId: string };

export function railwayPostgresCommand(target: RailwayDatabase, database?: string) {
  for (const value of [target.serviceId, target.environmentId, target.deploymentId]) uuid.parse(value);
  if (database !== undefined && !databaseName.test(database)) throw new Error("Nom de base Railway non pris en charge.");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = database === undefined
    ? "psql --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --dbname=postgres --command=" +
      quote("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname")
    : "pg_dump --no-password --format=custom --no-owner --no-acl --lock-wait-timeout=10s --dbname=" + quote(database);
  return 'set -eu; test "${RAILWAY_SERVICE_ID:-}" = ' + quote(target.serviceId) +
    ' && test "${RAILWAY_ENVIRONMENT_ID:-}" = ' + quote(target.environmentId) +
    ' && test "${RAILWAY_DEPLOYMENT_ID:-}" = ' + quote(target.deploymentId) +
    ' && exec env -i PATH=/usr/local/bin:/usr/bin:/bin PGHOST=/var/run/postgresql PGPORT=5432 ' +
    'PGUSER="${POSTGRES_USER:-postgres}" PGPASSWORD="${POSTGRES_PASSWORD:?}" PGCONNECT_TIMEOUT=10 ' +
    'PGOPTIONS="-c default_transaction_read_only=on" PGAPPNAME=vigie-platform-backup ' + command;
}

async function transferDump(args: string[], archive: string, options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn("ssh", args, { ...options, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    timeout: 20 * 60_000, killSignal: "SIGKILL" });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("Le transfert PostgreSQL Railway n’a pas démarré.")));
    child.once("close", status => status === 0 ? resolve() : reject(new Error("Le transfert PostgreSQL Railway a échoué.")));
  });
  let bytes = 0;
  const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxDumpBytes) callback(new Error("Dump PostgreSQL Railway trop volumineux."));
    else callback(null, chunk);
  } });
  const streamed = pipeline(child.stdout, bound, createWriteStream(archive, { flags: "wx", mode: 0o600 }));
  try { await Promise.all([exited, streamed]); }
  catch (error) {
    child.kill("SIGKILL");
    await Promise.allSettled([exited, streamed]);
    throw error;
  }
}

export async function inspectLinkedRailway(connectionId: string, project: RailwayProject, metadataOnly = false) {
  const production = project.environments.filter(environment => environment.name === "production" && !environment.ephemeral);
  if (production.length !== 1) throw new Error("Environnement de production Railway ambigu.");
  const environmentId = uuid.parse(production[0].id);
  const target = { provider: "railway" as const, connectionId };
  const inventory = railwayInventory.parse(await railwayConnectionRequest(connectionId, `query LinkedBackup($id:String!){environment(id:$id){
    id projectId name isEphemeral
    volumeInstances(first:50){pageInfo{hasNextPage}edges{node{volumeId serviceId mountPath state}}}
    serviceInstances(first:50){pageInfo{hasNextPage}edges{node{serviceId serviceName rootDirectory source{repo image} activeDeployments{id status meta}}}}
  }}`, { id: environmentId })).environment;
  if (inventory.id !== environmentId || inventory.projectId !== project.id) throw new Error("Projet Railway de production non attesté.");
  const volumes = inventory.volumeInstances.edges.map(edge => edge.node);
  const instances = inventory.serviceInstances.edges.map(edge => edge.node)
    .sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  const native = instances.filter(service => !service.source.repo && postgresImage.test(service.source.image ?? ""));
  const apps = instances.filter(service => service.source.repo && !service.source.image && service.activeDeployments[0].meta.commitHash);
  if (!native.length || !apps.length || native.length + apps.length !== instances.length || native.length !== volumes.length ||
      native.some(service => volumes.filter(volume => volume.serviceId === service.serviceId && volume.mountPath === "/var/lib/postgresql/data").length !== 1)) {
    throw new Error("Volumes, sources ou services Railway non couverts par le collecteur PostgreSQL.");
  }
  const supportedNames = new Set(native.map(service => service.serviceName));
  let references = 0;
  for (const app of apps) {
    const result = await railwayConnectionRequest(connectionId, `query BackupDataReferences($project:String!,$env:String!,$service:String!){
      variables(projectId:$project,environmentId:$env,serviceId:$service,unrendered:true)
    }`, { project: project.id, env: environmentId, service: app.serviceId });
    const vars = z.record(z.string(), z.string()).parse(result.variables);
    for (const [key, value] of Object.entries(vars).filter(([name]) => dataVariable.test(name))) {
      const match = /^\$\{\{([\w-]+)\.(?:DATABASE_URL|DATABASE_PUBLIC_URL)\}\}$/.exec(value);
      if (!/^DATABASE_URL$/.test(key) || !match || !supportedNames.has(match[1])) {
        throw new Error("Une source de données Railway demande un autre collecteur.");
      }
      references++;
    }
  }
  if (!references) throw new Error("Aucune liaison entre l’application et les bases Railway n’a été confirmée.");
  const known = process.env.VIGIE_BACKUP_RAILWAY_KNOWN_HOST?.trim() ?? "";
  if (!metadataOnly && !/^ssh\.railway\.com ssh-ed25519 [A-Za-z0-9+/=]+$/.test(known)) {
    throw new Error("Clé d’hôte Railway SSH approuvée manquante.");
  }
  const databases: BackupDatabase[] = [];
  const services = [];
  for (const service of instances) {
    const deployment = service.activeDeployments[0];
    const volume = volumes.find(item => item.serviceId === service.serviceId);
    const names: string[] = [];
    if (volume && !metadataOnly) {
      const identity = { serviceId: service.serviceId, deploymentId: deployment.id, environmentId };
      function viaSsh<T extends object>(operation: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<T>, database?: string) {
        const command = railwayPostgresCommand(identity, database);
        return withRailwayInstances(target, deployment.id, 1, (id, args, options) =>
          operation(["-T", "-a", "-x", ...args, id + "@ssh.railway.com", command], options),
          undefined, known);
      }
      const [result] = await viaSsh(async (args, options) => ({ list: await runCommand("ssh", args, options) }));
      names.push(...result.list.trim().split(/\r?\n/));
      if (!names.length || names.length > 10 || new Set(names).size !== names.length || names.some(name => !databaseName.test(name))) {
        throw new Error("Périmètre PostgreSQL Railway invalide ou incomplet.");
      }
      for (const [index, name] of names.entries()) {
        const file = "database-" + volume.volumeId + "-" + index + ".dump";
        databases.push({ file, windowsClient: 18, requiredTables: [], allowEmpty: true,
          capture: async archive => { await viaSsh(async (args, options) => { await transferDump(args, archive, options); return {}; }, name); },
        });
      }
    }
    services.push({ service: service.serviceName, serviceId: service.serviceId, deploymentId: deployment.id,
      repository: service.source.repo, root: service.source.repo ? service.rootDirectory ?? "/" : null,
      commit: service.source.repo ? deployment.meta.commitHash ?? null : null, image: service.source.image, imageDigest: deployment.meta.imageDigest,
      requirePackageJson: false,
      volume: volume?.volumeId ?? null, databaseNames: names });
  }
  return { services, databases };
}
