import { createHash } from "node:crypto";
import { z } from "zod";
import { withVercelCredentials } from "../src/lib/vercel";
import type { BackupDatabase } from "./platform-backup";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const deploymentId = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const repoPart = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);
const gitId = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String);
const production = z.object({
  id: z.string(), targets: z.object({ production: z.object({ id: deploymentId }) }),
  link: z.object({ type: z.literal("github"), org: repoPart, repo: repoPart, repoId: gitId }),
});
const deployment = z.object({
  id: deploymentId, projectId: z.string(), target: z.literal("production"), readyState: z.literal("READY"),
  createdAt: z.number(), env: z.array(z.string()),
  gitSource: z.object({ type: z.literal("github"), sha, repoId: gitId }),
  meta: z.object({ gitDirty: z.string().optional() }).optional(),
  projectSettings: z.object({ rootDirectory: z.string().nullable().optional() }),
});
const variables = z.object({
  envs: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_]+$/), key: z.string(), type: z.string(),
    target: z.array(z.string()), updatedAt: z.number().nullish(), createdAt: z.number(),
  })),
  pagination: z.object({ next: z.number().nullish() }).optional(),
});
const stores = z.object({
  stores: z.array(z.object({
    id: z.string(), product: z.object({ slug: z.string() }).nullish(),
    projectsMetadata: z.array(z.object({ projectId: z.string(), environments: z.array(z.string()) })).nullish(),
  })),
  pagination: z.object({ next: z.number().nullish() }).optional(),
});

const postgresUrl = /^(DATABASE_URL(?:_UNPOOLED)?|POSTGRES_URL(?:_NON_POOLING|_NO_SSL)?|POSTGRES_PRISMA_URL)$/;
const postgresAlias = /^(NEON_PROJECT_ID|PG(?:HOST(?:_UNPOOLED)?|DATABASE|PASSWORD|USER|PORT)|POSTGRES_(?:HOST|DATABASE|PASSWORD|USER|PORT))$/;
const persistence = /(?:^|_)(?:DATABASE|DB|POSTGRES|NEON|SUPABASE|MYSQL|MONGODB|REDIS|UPSTASH|BLOB|S3|R2|BUCKET|STORAGE|FIREBASE|TURSO|LIBSQL|KV)(?:_|$)/i;
const persistentKey = (key: string) => !key.startsWith("VERCEL_") && (persistence.test(key) || postgresAlias.test(key));

export function neonBackupConnection(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Adresse PostgreSQL de production indisponible."); }
  const host = url.hostname.replace("-pooler.", ".");
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^ep-[a-z0-9.-]+\.neon\.tech$/.test(host) ||
      (url.port && url.port !== "5432") || !url.username || !url.password || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
      url.hash || [...url.searchParams.keys()].some(key => !["sslmode", "channel_binding", "connect_timeout", "pgbouncer"].includes(key))) {
    throw new Error("Connexion PostgreSQL Neon de production non reconnue.");
  }
  let user: string, password: string;
  try { user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { throw new Error("Connexion PostgreSQL de production invalide."); }
  if (/[\x00-\x1f]/.test(user + password)) throw new Error("Connexion PostgreSQL de production invalide.");
  const database = url.pathname.slice(1);
  return {
    identity: host + "/" + database,
    environment: (): NodeJS.ProcessEnv => ({
      NODE_ENV: "production", PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
      PGHOST: host, PGPORT: "5432", PGDATABASE: database, PGUSER: user, PGPASSWORD: password,
      PGSSLMODE: "verify-full", PGSSLROOTCERT: "system", PGCHANNELBINDING: "require", PGCONNECT_TIMEOUT: "15",
      PGOPTIONS: "-c default_transaction_read_only=on", PGAPPNAME: "vigie-platform-backup",
      WSLENV: "PGHOST:PGPORT:PGDATABASE:PGUSER:PGPASSWORD:PGSSLMODE:PGSSLROOTCERT:PGCHANNELBINDING:PGCONNECT_TIMEOUT:PGOPTIONS:PGAPPNAME",
    }),
  };
}

export function vercelBackupVariables(active: string[], envs: z.infer<typeof variables>["envs"], deployedAt: number) {
  const activeKeys = new Set(active.filter(persistentKey));
  if ([...activeKeys].some(key => !postgresUrl.test(key) && !postgresAlias.test(key))) {
    throw new Error("Une source de données du déploiement Vercel demande un autre collecteur.");
  }
  const production = envs.filter(variable => variable.target.includes("production") && persistentKey(variable.key));
  if (production.some(variable => !activeKeys.has(variable.key) || (variable.updatedAt ?? variable.createdAt) > deployedAt) ||
      [...activeKeys].some(key => production.filter(variable => variable.key === key).length !== 1)) {
    throw new Error("La configuration des données Vercel ne correspond pas au déploiement actif.");
  }
  const urls = production.filter(variable => postgresUrl.test(variable.key))
    .sort((left, right) => Number(/UNPOOLED|NON_POOLING/.test(right.key)) - Number(/UNPOOLED|NON_POOLING/.test(left.key)));
  if (!urls.length || urls.some(variable => variable.type === "sensitive")) {
    throw new Error("Une URL PostgreSQL de production lisible est nécessaire.");
  }
  return urls;
}

export async function inspectLinkedVercel(connectionId: string, projectId: string) {
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) throw new Error("Identifiant Vercel invalide.");
  return withVercelCredentials(connectionId, async (token, teamId) => {
    async function get(path: string) {
      const url = new URL("https://api.vercel.com" + path);
      url.searchParams.set("teamId", teamId);
      const response = await fetch(url, { headers: { Authorization: "Bearer " + token }, redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error("Accès Vercel de sauvegarde refusé (" + response.status + ").");
      return response.json();
    }
    const project = production.parse(await get("/v9/projects/" + projectId));
    const current = deployment.parse(await get("/v13/deployments/" + project.targets.production.id));
    if (project.id !== projectId || current.projectId !== projectId || current.id !== project.targets.production.id ||
        current.gitSource.repoId !== project.link.repoId || current.meta?.gitDirty === "true") {
      throw new Error("Dépôt ou déploiement Vercel de production non attesté.");
    }
    const [projectVariables, storage] = await Promise.all([
      get("/v10/projects/" + projectId + "/env").then(body => variables.parse(body)),
      get("/v1/storage/stores").then(body => stores.parse(body)),
    ]);
    const attached = storage.stores.filter(store => store.projectsMetadata?.some(item =>
      item.projectId === projectId && item.environments.includes("production")));
    if (projectVariables.pagination?.next != null || storage.pagination?.next != null ||
        attached.length > 1 || attached.some(store => store.product?.slug !== "neon")) {
      throw new Error("Le périmètre des ressources Vercel n’est pas couvert par le collecteur PostgreSQL.");
    }
    const urls = vercelBackupVariables(current.env, projectVariables.envs, current.createdAt);
    const connections = await Promise.all(urls.map(async variable => {
      const value = z.object({ id: z.literal(variable.id), key: z.literal(variable.key), value: z.string() })
        .parse(await get("/v1/projects/" + projectId + "/env/" + variable.id));
      return neonBackupConnection(value.value);
    }));
    const grouped = new Map<string, typeof connections[number]>();
    for (const connection of connections) if (!grouped.has(connection.identity)) grouped.set(connection.identity, connection);
    if (attached.length && grouped.size !== attached.length) throw new Error("La base Vercel attachée reste ambiguë.");
    const databases: BackupDatabase[] = [...grouped.values()].map(connection => ({
      file: "database-" + createHash("sha256").update(connection.identity).digest("hex").slice(0, 16) + ".dump",
      windowsClient: 18, environment: connection.environment, requiredTables: [], dumpOptions: ["--no-owner", "--no-acl"],
    }));
    const repository = project.link.org + "/" + project.link.repo;
    return {
      services: [{ service: "application", deploymentId: current.id, commit: current.gitSource.sha, repository,
        root: current.projectSettings.rootDirectory ?? "/", requirePackageJson: false, resources: attached.map(resource => resource.id).sort(),
        databases: [...grouped.keys()].sort(),
        variables: urls.map(item => ({ id: item.id, revision: item.updatedAt ?? item.createdAt })).sort((a, b) => a.id.localeCompare(b.id)),
      }],
      databases,
    };
  });
}
