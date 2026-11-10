import { requireProject } from "../db";
import { vercelState, synchronizeVercel } from "../vercel";
import { railwayState, synchronizeRailway } from "../railway";
import { mapConcurrent } from "./planning";
import { projectHostingInstallations } from "../hosting-discovery";
import { collectHostingInventories } from "../hosting-inventory";
import { deploymentObservationNeedsRefresh, wordpressObservationNeedsRefresh } from "../observation-freshness";

const pending = new Map<string, Promise<unknown>>();
const providers = { project: requireProject, vercel: vercelState, railway: railwayState, syncVercel: synchronizeVercel, syncRailway: synchronizeRailway };

export async function refreshProjectHosting(projectId: string, dependencies = providers, options: { force?: boolean; wordpress?: boolean } = {}) {
  const project = await dependencies.project(projectId, "live");
  if (project.lifecycle !== "active") return { errors: [], refreshed: 0 };
  const [vercel, railway, hosting] = await Promise.all([dependencies.vercel(), dependencies.railway(), options.wordpress ? projectHostingInstallations(projectId) : []]);
  const connections = new Map<string, { label: string; synchronize: () => Promise<unknown> }>();
  for (const item of vercel.projects.filter(item => item.projectId === projectId && !item.excluded)) {
    if (item.configured !== false && (options.force || deploymentObservationNeedsRefresh(item))) connections.set(`vercel:${item.connectionId}`, { label: "Vercel", synchronize: () => dependencies.syncVercel(item.connectionId) });
  }
  for (const item of railway.projects.filter(item => item.projectId === projectId)) {
    if (item.configured !== false && (options.force || deploymentObservationNeedsRefresh(item))) connections.set(`railway:${item.connectionId}`, { label: "Railway", synchronize: () => dependencies.syncRailway(item.connectionId) });
  }
  for (const site of hosting) {
    if (site.kind !== "wordpress" || site.ignored || site.missingSince || !site.observerConfigured || (!options.force && !wordpressObservationNeedsRefresh(site))) continue;
    connections.set(`wordpress:${site.id}`, {
      label: `WordPress · ${site.domains[0] || site.connectionName}`,
      synchronize: async () => {
        const result = await collectHostingInventories(site.connectionId, fetch, fetch, site.id, undefined, { readOnlyProjectId: projectId });
        if (!result.success) throw new Error("Collecte non confirmée.");
      },
    });
  }
  const errors: string[] = [];
  await mapConcurrent([...connections], 2, async ([key, { label, synchronize }]) => {
    let work = pending.get(key);
    if (!work) { work = Promise.resolve().then(synchronize); pending.set(key, work); }
    try { await work; } catch { errors.push(`Actualisation ${label} non confirmée. Vérifiez la connexion ou réessayez dans quelques instants.`); }
    finally { if (pending.get(key) === work) pending.delete(key); }
  });
  return { errors, refreshed: connections.size - errors.length };
}
