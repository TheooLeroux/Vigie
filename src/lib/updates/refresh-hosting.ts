import { requireProject } from "../db";
import { vercelState, synchronizeVercel } from "../vercel";
import { railwayState, synchronizeRailway } from "../railway";
import { mapConcurrent } from "./planning";

const pending = new Map<string, Promise<unknown>>();
const stale = (observedAt: string) => { const age = Date.now() - Date.parse(observedAt); return !Number.isFinite(age) || age < -30_000 || age > 10 * 60_000; };
// This only reads provider inventories. It never installs an agent or updates a site.
export async function refreshProjectHosting(projectId: string, dependencies = { project: requireProject, vercel: vercelState, railway: railwayState, syncVercel: synchronizeVercel, syncRailway: synchronizeRailway }) {
  await dependencies.project(projectId, "live");
  const [vercel, railway] = await Promise.all([dependencies.vercel(), dependencies.railway()]);
  const connections = new Map<string, () => Promise<unknown>>();
  for (const item of vercel.projects.filter(item => item.projectId === projectId && !item.excluded)) {
    if (item.connectionError || stale(item.observedAt)) connections.set(`vercel:${item.connectionId}`, () => dependencies.syncVercel(item.connectionId));
  }
  for (const item of railway.projects.filter(item => item.projectId === projectId)) {
    if (item.connectionError || stale(item.observedAt)) connections.set(`railway:${item.connectionId}`, () => dependencies.syncRailway(item.connectionId));
  }
  const errors: string[] = [];
  await mapConcurrent([...connections], 2, async ([key, synchronize]) => {
    let work = pending.get(key);
    if (!work) { work = synchronize(); pending.set(key, work); }
    try { await work; } catch { errors.push(`Actualisation ${key.split(":")[0]} non confirmée. Vérifiez la connexion ou réessayez après le traitement en cours.`); }
    finally { if (pending.get(key) === work) pending.delete(key); }
  });
  return { errors, refreshed: connections.size - errors.length };
}
