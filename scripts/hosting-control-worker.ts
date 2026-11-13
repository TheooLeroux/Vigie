import { reconcileHostingConnections, type ControlProvider } from "../src/lib/hosting-controls";
import { postgresPool } from "../src/lib/storage";
import { hostingConnections } from "../src/lib/hosting-connections";
import { hostingDiscovery } from "../src/lib/hosting-discovery";
import { wordpressObservationNeedsRefresh } from "../src/lib/observation-freshness";
import { refreshWordPressWeb } from "../src/lib/updates/wordpress-web-check";
import { mapConcurrent } from "../src/lib/updates/planning";

async function refreshWordPressObservations() {
  const projectId = process.env.VIGIE_CONTROL_PROJECT_ID;
  const connections = (await hostingConnections()).filter(connection => connection.configured);
  const sites = (await Promise.all(connections.map(async connection => (await hostingDiscovery(connection.id)).installations)))
    .flat().filter(site => site.project?.lifecycle === "active" && (!projectId || site.project.id === projectId) && wordpressObservationNeedsRefresh(site));
  const results = await mapConcurrent(sites, 3, async site => {
    try { await refreshWordPressWeb({ remoteId: site.id }, "observe"); return true; }
    catch { return false; }
  });
  return { checked: results.filter(Boolean).length, failed: results.filter(result => !result).length };
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY) throw new Error("Configuration manquante.");
  const provider = process.env.VIGIE_CONTROL_PROVIDER;
  if (!["o2switch", "vercel", "railway"].includes(provider || "")) throw new Error("Hébergeur non défini.");
  if (process.argv.includes("--wordpress-observations")) {
    const observations = await refreshWordPressObservations();
    console.log(JSON.stringify(observations));
    if (observations.failed) process.exitCode = 1;
    return;
  }
  const result = await reconcileHostingConnections(provider as ControlProvider);
  console.log(JSON.stringify(result));
  if (result.failed || result.deferred) process.exitCode = 1;
}
main().catch(() => { console.error("Contrôle hébergeur incomplet. Consultez les connexions dans Vigie."); process.exitCode = 1; }).finally(() => postgresPool().end());
