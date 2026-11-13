import { appendFile } from "node:fs/promises";
import { claimScheduledMaintenance, recentSuccessfulPrimaryCycle } from "../src/lib/scheduled-maintenance";
import { isPostgres, postgresPool } from "../src/lib/storage";

async function main() {
  if (!process.env.GITHUB_OUTPUT || !isPostgres()) {
    throw new Error("La vérification du planning de secours exige PostgreSQL et GITHUB_OUTPUT.");
  }
  if (await recentSuccessfulPrimaryCycle(process.env.GITHUB_REPOSITORY || "", process.env.GITHUB_REF_NAME || "")) {
    await appendFile(process.env.GITHUB_OUTPUT, "run=false\n");
    console.log("Cycle complet récent confirmé par GitHub : secours ignoré.");
    return;
  }
  if (await recentIdleCycle()) {
    await appendFile(process.env.GITHUB_OUTPUT, "run=false\n");
    console.log("Vigie : le dernier relevé ne demande aucun contrôle, secours sans Neon.");
    return;
  }
  try {
    const lease = await claimScheduledMaintenance("fallback");
    await appendFile(process.env.GITHUB_OUTPUT, `run=${Boolean(lease)}\n`);
    console.log(lease ? "Cycle de secours réservé." : "Cycle récent : contrôles de secours ignorés.");
  } finally {
    await postgresPool().end();
  }
}

async function recentIdleCycle() {
  try {
    const response = await fetch("https://vigie-azure.vercel.app/api/maintenance/plan?fallback=1", {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    return response.ok && (await response.json())?.recent === true;
  } catch { return false; }
}

void main().catch(() => {
  console.error("Vigie : réservation du cycle de secours indisponible.");
  process.exitCode = 1;
});
