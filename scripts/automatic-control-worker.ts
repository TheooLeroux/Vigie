import { appendFile } from "node:fs/promises";
import { automaticControlsNeeded, reconcileAutomaticControls } from "../src/lib/automatic-controls";
import { forcedControlRevision } from "../src/lib/control-force";
import { postgresPool } from "../src/lib/storage";
import { readWorkerMaintenancePlan } from "./maintenance-plan";

async function main() {
  const provider = process.env.VIGIE_CONTROL_PROVIDER;
  if (provider !== "o2switch" && provider !== "vercel" && provider !== "railway") throw new Error("Hébergeur non défini.");
  const force = ["1", "true"].includes(process.env.VIGIE_CONTROL_FORCE || "");
  // Push and deployment-success events for one engine commit must not scan
  // the same current deployment twice. Manual force remains unconditional.
  const forceRevision = forcedControlRevision(process.env);
  const projectId = process.env.VIGIE_CONTROL_PROJECT_ID || undefined;
  if (projectId && !/^[a-f0-9-]{36}$/i.test(projectId)) throw new Error("Projet invalide.");
  const scope = (await readWorkerMaintenancePlan()).security[provider];
  const projectIds = force || scope === "all" ? undefined : scope;
  // In-place edits can leave the stored cPanel discovery timestamp unchanged.
  const scanDue = force || (provider === "o2switch" && !!projectIds);
  const planning = process.argv.includes("--plan");
  const output = process.env.GITHUB_OUTPUT;
  if (planning && !output) throw new Error("Sortie GitHub manquante.");
  if (!projectId && projectIds?.length === 0) {
    if (planning) await appendFile(output!, "needed=false\n");
    console.log("Vigie : analyses déjà couvertes par le cache Vercel, aucune connexion Neon.");
    return;
  }
  if (!process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY) throw new Error("Configuration manquante.");
  try {
    if (planning) {
      await appendFile(output!, `needed=${await automaticControlsNeeded(provider, scanDue, projectId, forceRevision, projectIds)}\n`);
      return;
    }
    const result = await reconcileAutomaticControls({ provider, force: scanDue, forceRevision, projectId, projectIds });
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } finally { await postgresPool().end(); }
}
main().catch(() => { console.error("Contrôle automatique incomplet. Les résultats précédents restent datés et le prochain passage réessaiera."); process.exitCode = 1; });
