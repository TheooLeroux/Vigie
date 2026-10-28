import { reconcileHostingConnections, type ControlProvider } from "../src/lib/hosting-controls";
import { postgresPool } from "../src/lib/storage";

async function main() {
  if (!process.env.DATABASE_URL || !process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY) throw new Error("Configuration manquante.");
  const provider = process.env.VIGIE_CONTROL_PROVIDER;
  if (!["o2switch", "vercel", "railway"].includes(provider || "")) throw new Error("Hébergeur non défini.");
  const result = await reconcileHostingConnections(provider as ControlProvider);
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
}
main().catch(() => { console.error("Contrôle hébergeur incomplet. Consultez les connexions dans Vigie."); process.exitCode = 1; }).finally(() => postgresPool().end());
