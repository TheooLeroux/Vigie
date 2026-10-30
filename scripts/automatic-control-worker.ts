import { appendFile } from "node:fs/promises";
import { automaticControlsNeeded, reconcileAutomaticControls } from "../src/lib/automatic-controls";
import { forcedControlRevision } from "../src/lib/control-force";
import { postgresPool } from "../src/lib/storage";

async function main() {
  if (!process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY) throw new Error("Configuration manquante.");
  const provider = process.env.VIGIE_CONTROL_PROVIDER;
  if (provider !== "o2switch" && provider !== "vercel" && provider !== "railway") throw new Error("Hébergeur non défini.");
  const force = ["1", "true"].includes(process.env.VIGIE_CONTROL_FORCE || "");
  // Push and deployment-success events for one engine commit must not scan
  // the same current deployment twice. Manual force remains unconditional.
  const forceRevision = forcedControlRevision(process.env);
  const projectId = process.env.VIGIE_CONTROL_PROJECT_ID || undefined;
  if (projectId && !/^[a-f0-9-]{36}$/i.test(projectId)) throw new Error("Projet invalide.");
  if (process.argv.includes("--plan")) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("Sortie GitHub manquante.");
    await appendFile(process.env.GITHUB_OUTPUT, `needed=${await automaticControlsNeeded(provider, force, projectId, forceRevision)}\n`);
    return;
  }
  const result = await reconcileAutomaticControls({ provider, force, forceRevision, projectId });
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
}
main().catch(() => { console.error("Contrôle automatique incomplet. Les résultats précédents restent datés et le prochain passage réessaiera."); process.exitCode = 1; }).finally(() => postgresPool().end());
