import { z } from "zod";
import { ApiError } from "../http";
import type { RailwayProject } from "../railway-types";
import { deploymentEvidence } from "./railway-evidence";
import { enrichRailwayReleases } from "./software-releases";

// Fixed query only: no caller-provided GraphQL, variables, logs or commands.
// meta is a JSON scalar, filtered immediately by deploymentEvidence before it can leave this module.
export const RAILWAY_INVENTORY_QUERY = `query VigieInventory($workspaceId: String!, $after: String) {
  workspace(workspaceId: $workspaceId) { id name }
  projects(workspaceId: $workspaceId, first: 50, after: $after, includeDeleted: false) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id name workspaceId
      environments(first: 50) {
        pageInfo { hasNextPage }
        edges { node {
          id name isEphemeral
          serviceInstances(first: 100) {
            pageInfo { hasNextPage }
            edges { node {
              serviceId serviceName environmentId builder region numReplicas rootDirectory healthcheckPath cronSchedule
              source { repo image }
              domains { customDomains { domain } serviceDomains { domain } }
              latestDeployment { id status createdAt updatedAt meta }
              activeDeployments { id status createdAt updatedAt meta }
            } }
          }
        } }
      }
    } }
  }
}`;
const text = z.string().max(1000),
  id = z.string().uuid();
const deployment = z
  .object({
    id,
    status: text,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    meta: z.unknown().optional(),
  })
  .transform(({ meta, ...fields }) => ({
    ...fields,
    evidence: deploymentEvidence(meta),
  }));
const connection = <T extends z.ZodType>(node: T) =>
  z.object({
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable().optional(),
    }),
    edges: z.array(z.object({ node })).max(100),
  });
const instance = z.object({
  serviceId: id,
  serviceName: text,
  environmentId: id,
  builder: text,
  region: text.nullable(),
  numReplicas: z.number().int().min(0).max(10000).nullable(),
  rootDirectory: text.nullable(),
  healthcheckPath: text.nullable(),
  cronSchedule: text.nullable(),
  source: z
    .object({ repo: text.nullable(), image: text.nullable() })
    .nullable(),
  domains: z.object({
    customDomains: z.array(z.object({ domain: text })).max(1000),
    serviceDomains: z.array(z.object({ domain: text })).max(1000),
  }),
  latestDeployment: deployment.nullable(),
  activeDeployments: z.array(deployment).max(1000),
});
const responseSchema = z.object({
  workspace: z.object({ id, name: text }),
  projects: connection(
    z.object({
      id,
      name: text,
      workspaceId: id.nullable(),
      environments: connection(
        z.object({
          id,
          name: text,
          isEphemeral: z.boolean(),
          serviceInstances: connection(instance),
        }),
      ),
    }),
  ),
});
function publicDomain(value: string) {
  if (
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) ||
    !value.includes(".")
  )
    throw new ApiError("Un domaine Railway est invalide.", 502);
  return value.toLowerCase();
}
function sourceValue(value: string | null) {
  // Repository/image references only. Never persist credentials embedded in a URL.
  if (!value || /[\s@?#]/.test(value)) return null;
  if (value.includes("://")) {
    try {
      const u = new URL(value);
      if (u.username || u.password || u.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  return value;
}
async function readJson(response: Response) {
  if (!response.body) throw new ApiError("Réponse Railway vide.", 502);
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 8_000_000) {
      await reader.cancel();
      throw new ApiError("Réponse Railway trop volumineuse.", 502);
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("Réponse Railway illisible.", 502);
  }
}
export async function collectRailway(
  workspaceId: string,
  token: string,
  transport: typeof fetch = fetch,
): Promise<RailwayProject[]> {
  id.parse(workspaceId);
  const results: RailwayProject[] = [],
    seen = new Set<string>();
  let after: string | null = null;
  const signal = AbortSignal.timeout(90_000);
  try {
    for (let page = 0; page < 10; page++) {
      const response = await transport(
        "https://backboard.railway.com/graphql/v2",
        {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "Vigie/1.0",
          },
          body: JSON.stringify({
            query: RAILWAY_INVENTORY_QUERY,
            variables: { workspaceId, after },
          }),
        },
      );
      if (response.status === 401 || response.status === 403)
        throw new ApiError(
          "Railway refuse ce jeton ou l’accès à ce workspace.",
          502,
        );
      if (response.status === 429)
        throw new ApiError(
          "Limite API Railway atteinte. Réessayez dans quelques minutes.",
          429,
        );
      if (!response.ok)
        throw new ApiError(
          `Railway est indisponible (HTTP ${response.status}). Le dernier relevé est conservé.`,
          502,
        );
      const raw = await readJson(response);
      if (raw.errors?.length) {
        // Provider errors can echo input/credentials. Never relay the raw message.
        const refused = raw.errors.some(
          (e: { extensions?: { code?: string } }) =>
            ["UNAUTHENTICATED", "FORBIDDEN"].includes(e.extensions?.code || ""),
        );
        throw new ApiError(
          refused
            ? "Railway refuse ce jeton ou l’accès à ce workspace."
            : "Le relevé Railway est incomplet ou refusé. Vérifiez l’accès et l’état de Railway ; le dernier relevé est conservé.",
          502,
        );
      }
      const parsed = responseSchema.safeParse(raw.data);
      if (!parsed.success)
        throw new ApiError(
          "Le format de réponse Railway a changé. Le dernier relevé est conservé.",
          502,
        );
      const { workspace, projects } = parsed.data;
      if (workspace.id !== workspaceId)
        throw new ApiError("Railway a renvoyé un autre workspace.", 502);
      for (const { node: p } of projects.edges) {
        if (p.workspaceId !== workspaceId || seen.has(p.id))
          throw new ApiError(
            "Périmètre ou pagination Railway incohérent.",
            502,
          );
        if (
          p.environments.pageInfo.hasNextPage ||
          p.environments.edges.some(
            (e) => e.node.serviceInstances.pageInfo.hasNextPage,
          )
        )
          throw new ApiError(
            "Ce projet dépasse la limite de 50 environnements ou 100 services par environnement. Aucun relevé partiel n’a été enregistré.",
            502,
          );
        seen.add(p.id);
        results.push({
          id: p.id,
          name: p.name,
          workspaceId,
          workspaceName: workspace.name,
          environments: p.environments.edges.map(({ node: e }) => ({
            id: e.id,
            name: e.name,
            ephemeral: e.isEphemeral,
          })),
          services: p.environments.edges.flatMap(({ node: e }) =>
            e.serviceInstances.edges.map(({ node: s }) => {
              if (s.environmentId !== e.id)
                throw new ApiError("Environnement Railway incohérent.", 502);
              return {
                id: s.serviceId,
                name: s.serviceName,
                environmentId: e.id,
                environmentName: e.name,
                domains: [
                  ...new Set(
                    [
                      ...s.domains.customDomains,
                      ...s.domains.serviceDomains,
                    ].map((d) => publicDomain(d.domain)),
                  ),
                ],
                repository: sourceValue(s.source?.repo || null),
                image: sourceValue(s.source?.image || null),
                builder: s.builder,
                region: s.region,
                replicas: s.numReplicas,
                rootDirectory: s.rootDirectory,
                healthcheckPath: s.healthcheckPath,
                cronSchedule: s.cronSchedule,
                latestDeployment: s.latestDeployment,
                activeDeployments: s.activeDeployments,
              };
            }),
          ),
        });
      }
      if (!projects.pageInfo.hasNextPage)
        return enrichRailwayReleases(results, transport);
      const cursor = projects.pageInfo.endCursor;
      if (!cursor || cursor === after)
        throw new ApiError("Pagination Railway incohérente.", 502);
      after = cursor;
    }
    throw new ApiError("Le workspace dépasse la limite de 500 projets.", 502);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      "Connexion à Railway interrompue ou expirée. Le dernier relevé est conservé.",
      502,
    );
  }
}
