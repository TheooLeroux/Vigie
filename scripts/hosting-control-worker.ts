import { reconcileHostingConnections } from "../src/lib/hosting-controls";
import { postgresPool } from "../src/lib/storage";
import { hostingConnections } from "../src/lib/hosting-connections";
import { hostingDiscovery } from "../src/lib/hosting-discovery";
import { wordpressObservationNeedsRefresh } from "../src/lib/observation-freshness";
import { refreshWordPressWeb } from "../src/lib/updates/wordpress-web-check";
import { mapConcurrent } from "../src/lib/updates/planning";
import { readWorkerMaintenancePlan, refreshWorkerMaintenanceCache } from "./maintenance-plan";

async function refreshWordPressObservations(installationIds?: readonly string[]) {
  const projectId = process.env.VIGIE_CONTROL_PROJECT_ID;
  const connections = (await hostingConnections()).filter(connection => connection.configured);
  const sites = (await Promise.all(connections.map(async connection => (await hostingDiscovery(connection.id)).installations)))
    .flat().filter(site => site.project?.lifecycle === "active" && (!projectId || site.project.id === projectId) &&
      (installationIds ? installationIds.includes(site.id) && !site.ignored && !site.missingSince && site.observerConfigured && site.kind === "wordpress" : wordpressObservationNeedsRefresh(site)));
  const results = await mapConcurrent(sites, 3, async site => {
    try { await refreshWordPressWeb({ remoteId: site.id }, "observe"); return true; }
    catch { return false; }
  });
  return { checked: results.filter(Boolean).length, failed: results.filter(result => !result).length };
}

async function main() {
  const provider = process.env.VIGIE_CONTROL_PROVIDER;
  if (provider !== "o2switch" && provider !== "vercel" && provider !== "railway") throw new Error("Hébergeur non défini.");
  const plan = await readWorkerMaintenancePlan();
  const wordpress = process.argv.includes("--wordpress-observations");
  if (wordpress ? plan.wordpress !== "all" && !plan.wordpress.length : !plan.observations[provider]) {
    console.log("Vigie : relevé déjà couvert par le cache Vercel, aucune connexion Neon.");
    return;
  }
  if (!process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY) throw new Error("Configuration manquante.");
  try {
    if (wordpress) {
      const observations = await refreshWordPressObservations(plan.wordpress === "all" ? undefined : plan.wordpress);
      console.log(JSON.stringify(observations));
      if (observations.failed) process.exitCode = 1;
      return;
    }
    const result = await reconcileHostingConnections(provider);
    console.log(JSON.stringify(result));
    if (result.failed || result.deferred) process.exitCode = 1;
    else await refreshWorkerMaintenanceCache();
  } finally { await postgresPool().end(); }
}
main().catch(() => { console.error("Contrôle hébergeur incomplet. Consultez les connexions dans Vigie."); process.exitCode = 1; });
