import { checkRequestedAgentInstallation, reconcileAgentInstallations } from "../src/lib/updates/wordpress-agent-setup";
import { postgresPool } from "../src/lib/storage";
import { readWorkerMaintenancePlan } from "./maintenance-plan";

async function main() {
  const id = process.env.VIGIE_AGENT_INSTALLATION_ID;
  const { agents } = await readWorkerMaintenancePlan();
  if (!id && agents !== "all" && !agents.length) {
    console.log("Vigie : agents déjà contrôlés, aucune connexion Neon.");
    return;
  }
  if (!process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY) throw new Error("Configuration de l’exécuteur manquante.");
  try {
    const result = id ? await checkRequestedAgentInstallation(id, process.env.VIGIE_AGENT_REQUEST_ID || undefined)
      : await reconcileAgentInstallations({}, agents === "all" ? undefined : agents);
    console.log(JSON.stringify(result));
    if (result.newFailures > 0) throw new Error("Installation à vérifier.");
  } finally { await postgresPool().end(); }
}
main().catch(() => { console.error("L’installation des agents doit être vérifiée dans Vigie. Aucun ordre de mise à jour n’a été envoyé."); process.exitCode = 1; });
