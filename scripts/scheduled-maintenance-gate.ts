import { appendFile } from "node:fs/promises";
import { claimScheduledMaintenance } from "../src/lib/scheduled-maintenance";
import { isPostgres, postgresPool } from "../src/lib/storage";

async function main() {
  if (!process.env.GITHUB_OUTPUT || !isPostgres()) {
    throw new Error("La vérification du planning de secours exige PostgreSQL et GITHUB_OUTPUT.");
  }
  try {
    const lease = await claimScheduledMaintenance("fallback");
    await appendFile(process.env.GITHUB_OUTPUT, `run=${Boolean(lease)}\n`);
    console.log(lease ? "Cycle de secours réservé." : "Cycle récent : contrôles de secours ignorés.");
  } finally {
    await postgresPool().end();
  }
}

void main().catch(() => {
  console.error("Vigie : réservation du cycle de secours indisponible.");
  process.exitCode = 1;
});
