import { appendFile } from "node:fs/promises";
import { planDailyAssessments } from "../src/lib/updates/daily-assessments";
import { postgresPool } from "../src/lib/storage";

async function main() {
  if (!process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || !process.env.GITHUB_OUTPUT) throw new Error("Configuration du bilan quotidien manquante.");
  const result = await planDailyAssessments();
  await appendFile(process.env.GITHUB_OUTPUT, `runs=${JSON.stringify(result.runs)}\n`);
  console.log(JSON.stringify({ queued: result.runs.length, deferred: result.deferred, failed: result.failed }));
  if (result.failed) console.error("Certains projets n’ont pas pu être préparés ; les autres bilans seront exécutés.");
}
main().catch(() => { console.error("Préparation des bilans quotidiens interrompue. Aucune installation demandée."); process.exitCode = 1; }).finally(() => postgresPool().end());
