import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { ApiError } from "../src/lib/http";
import { planDailyAssessments } from "../src/lib/updates/daily-assessments";
import { postgresPool } from "../src/lib/storage";

async function main() {
  if (!process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || !process.env.GITHUB_OUTPUT) throw new Error("Configuration du bilan quotidien manquante.");
  const project = process.env.VIGIE_ASSESSMENT_PROJECT?.trim();
  const result = await planDailyAssessments(undefined, project ? z.uuid().parse(project) : undefined);
  await appendFile(process.env.GITHUB_OUTPUT, `runs=${JSON.stringify(result.runs)}\n`);
  console.log(JSON.stringify({ queued: result.runs.length, noEligibleTarget: result.noEligibleTarget, deferred: result.deferred, failed: result.failed }));
  if (result.failed) console.error("Certains projets n’ont pas pu être préparés ; les autres bilans seront exécutés.");
}
main().catch((error) => {
  console.error(error instanceof z.ZodError ? "L’identifiant du projet doit être un UUID." :
    error instanceof ApiError ? error.message : "Préparation des bilans interrompue. Vérifiez la configuration de l’exécuteur.");
  process.exitCode = 1;
}).finally(() => { if (process.env.DATABASE_URL) return postgresPool().end(); });
