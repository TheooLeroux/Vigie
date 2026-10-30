import { executeUpdate } from "../src/lib/updates/executor";
import { postgresPool } from "../src/lib/storage";
import { readUpdateRun } from "../src/lib/updates/storage";

const id = process.env.VIGIE_UPDATE_RUN_ID || process.argv[2];
if (!id || process.env.VIGIE_UPDATES_ENABLED !== "1" || !process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY) {
  console.error("L’exécuteur exige un identifiant de mise à jour, DATABASE_URL, VIGIE_CONNECTOR_ENCRYPTION_KEY et VIGIE_UPDATES_ENABLED=1.");
  process.exitCode = 1;
} else {
  Promise.resolve().then(async () => {
    const run = await readUpdateRun(id);
    const expected = process.env.VIGIE_UPDATE_EXPECT_PURPOSE || "update";
    if (!run || (run.purpose || "update") !== expected || !["update", "assessment"].includes(expected)) throw new Error("Le type du traitement ne correspond pas au workflow.");
    return executeUpdate(id);
  }).then(async claimed => {
    const run = await readUpdateRun(id);
    if (claimed && run?.stage !== "completed") {
      console.error("La mise à jour exige une vérification. Le résultat et les références de récupération sont disponibles dans Vigie.");
      process.exitCode = 1;
    } else console.log(claimed ? run?.purpose === "assessment" ? "Bilan préalable terminé, sans installation. Résultat disponible dans Vigie." : "Mise à jour terminée. Le résultat est disponible dans Vigie." : "Ce traitement est déjà pris en charge ou n’est plus en attente.");
  }).catch(() => {
    console.error("Le traitement n’a pas pu être confirmé. Consultez Vigie avant de relancer.");
    process.exitCode = 1;
  }).finally(() => postgresPool().end());
}
