import { z } from "zod";
import { railwayState, withRailwayCredentials } from "../src/lib/railway";
import { isPostgres, postgresPool } from "../src/lib/storage";
import { vercelState, withVercelCredentials } from "../src/lib/vercel";
import { githubBackupToken } from "./backup-github-app";
import { planPlatformBackups } from "./plan-platform-backups";

const page = <T extends z.ZodType>(node: T) => z.object({
  edges: z.array(z.object({ node })),
  pageInfo: z.object({ hasNextPage: z.literal(false) }),
});
const railwayInventory = z.object({
  environment: z.object({
    id: z.uuid(), projectId: z.uuid(), name: z.literal("production"), isEphemeral: z.literal(false),
    volumeInstances: page(z.object({ volumeId: z.uuid(), serviceId: z.uuid().nullable(), mountPath: z.string(), state: z.string() })),
    serviceInstances: page(z.object({ serviceId: z.uuid(), source: z.object({ repo: z.string().nullable(), image: z.string().nullable() }) })),
  }),
});
const vercelStores = z.object({
  stores: z.array(z.object({
    id: z.string(), type: z.string(), product: z.object({ slug: z.string().optional() }).nullish(),
    projectsMetadata: z.array(z.object({ projectId: z.string(), environments: z.array(z.string()) })).nullish(),
  })),
});

async function main() {
  if (!isPostgres()) throw new Error("Connectez l’inventaire PostgreSQL de Vigie.");
  const [plan, railway, vercel] = await Promise.all([planPlatformBackups(), railwayState(), vercelState()]);
  const repositoryAccess = new Map<string, Promise<string>>();
  const storageByConnection = new Map<string, Promise<z.infer<typeof vercelStores>>>();
  async function git(repositories: (string | null)[]) {
    const names = [...new Set(repositories.filter((repo): repo is string => Boolean(repo)))];
    return Promise.all(names.map(async repository => {
      if (!process.env.VIGIE_BACKUP_GITHUB_APP_ID || !process.env.VIGIE_BACKUP_GITHUB_APP_KEY) {
        return { repository, access: "github-app-missing" };
      }
      const access = repositoryAccess.get(repository) ?? githubBackupToken(repository).then(() => "read", () => "unavailable");
      repositoryAccess.set(repository, access);
      return { repository, access: await access };
    }));
  }
  for (const candidate of plan.filter(row => row.status !== "out-of-scope")) {
    try {
      if (candidate.provider === "railway") {
        const remote = railway.projects.find(project => project.id === candidate.remoteId && project.projectId === candidate.projectId);
        const environments = remote?.environments.filter(environment => !environment.ephemeral && environment.name === "production");
        if (!remote || environments?.length !== 1) throw new Error("Production Railway ambiguë.");
        const { id } = environments[0];
        const environment = await withRailwayCredentials(remote.connectionId, async token => {
          const response = await fetch("https://backboard.railway.com/graphql/v2", {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
            headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ query: `query BackupDiscovery($id:String!) { environment(id:$id) {
              id projectId name isEphemeral
              volumeInstances(first:100) { pageInfo { hasNextPage } edges { node { volumeId serviceId mountPath state } } }
              serviceInstances(first:100) { pageInfo { hasNextPage } edges { node { serviceId source { repo image } } } }
            } }`, variables: { id } }),
          });
          if (!response.ok) throw new Error("Inventaire Railway inaccessible.");
          const body = await response.json();
          if (body.errors) throw new Error("Inventaire Railway incomplet.");
          const result = railwayInventory.parse(body.data).environment;
          if (result.id !== id || result.projectId !== remote.id) throw new Error("La production Railway a changé.");
          return result;
        });
        const services = environment.serviceInstances.edges.map(edge => edge.node);
        const volumes = environment.volumeInstances.edges.map(({ node }) => {
          const image = services.find(service => service.serviceId === node.serviceId)?.source.image;
          return { ...node, kind: node.mountPath === "/var/lib/postgresql/data" &&
            /^ghcr\.io\/railwayapp-templates\/postgres-ssl:/.test(image ?? "") ? "railway-postgresql" : "volume" };
        });
        console.log(JSON.stringify({ name: candidate.name, provider: candidate.provider,
          sources: await git(services.map(service => service.source.repo)), volumes }));
      } else {
        const remote = vercel.projects.find(project => project.id === candidate.remoteId && project.projectId === candidate.projectId);
        if (!remote) throw new Error("Production Vercel introuvable.");
        const stores = storageByConnection.get(remote.connectionId) ?? withVercelCredentials(remote.connectionId, async (token, teamId) => {
          const url = new URL("https://api.vercel.com/v1/storage/stores");
          url.searchParams.set("teamId", teamId);
          const response = await fetch(url, { headers: { Authorization: "Bearer " + token },
            redirect: "error", signal: AbortSignal.timeout(20_000) });
          if (!response.ok) throw new Error("Inventaire des intégrations Vercel inaccessible.");
          return vercelStores.parse(await response.json());
        });
        storageByConnection.set(remote.connectionId, stores);
        const resources = (await stores).stores.filter(store => store.projectsMetadata?.some(project =>
          project.projectId === remote.id && project.environments.includes("production")))
          .map(store => ({ id: store.id, type: store.type, product: store.product?.slug }));
        console.log(JSON.stringify({ name: candidate.name, provider: candidate.provider,
          sources: await git([remote.production?.repository ?? null]), attachedResources: resources }));
      }
    } catch {
      console.log(JSON.stringify({ name: candidate.name, provider: candidate.provider, status: "inventory-unavailable" }));
    }
  }
}

main().catch(() => {
  console.error("Impossible de découvrir les ressources de production.");
  process.exitCode = 1;
}).finally(async () => {
  if (isPostgres()) await postgresPool().end();
});
