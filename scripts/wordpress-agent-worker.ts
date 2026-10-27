import { processAgentInstallation, reconcileAgentInstallations } from "../src/lib/updates/wordpress-agent-setup";
import { postgresPool } from "../src/lib/storage";
import { readUpdateSource } from "../src/lib/updates/storage";

async function main() {
  if (!process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY) throw new Error("Configuration de l’exécuteur manquante.");
  const id = process.env.VIGIE_AGENT_INSTALLATION_ID;
  const result = id ? { ready: await processAgentInstallation(id, process.env.VIGIE_AGENT_REQUEST_ID || undefined) } : await reconcileAgentInstallations();
  console.log(JSON.stringify(result));
  if (("failed" in result && result.failed > 0) || (id && (await readUpdateSource(`wordpress:${id}`))?.settings.agentInstallation?.state === "failed")) throw new Error("Installation à vérifier.");
}
main().catch(() => { console.error("L’installation des agents doit être vérifiée dans Vigie. Aucun ordre de mise à jour n’a été envoyé."); process.exitCode = 1; }).finally(() => postgresPool().end());
