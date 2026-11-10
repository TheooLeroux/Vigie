import { randomBytes } from "node:crypto";
import { runPlatformBackup } from "./platform-backup";
import { vigieVercel } from "./platform-backup-targets";
import { assertPlatformBackupLink } from "./check-platform-backup-link";
import {
  neonDatabaseFingerprint, runtimeProofSchema, runtimeSignature, vercelRuntimePath, verifyRuntimeSignature,
} from "../src/lib/updates/vercel-runtime-protocol";

const { remoteId: vercelProjectId, projectId: vigieProjectId } = vigieVercel;
const origin = "https://vigie-azure.vercel.app";
const repository = "TheooLeroux/Vigie";
const serviceRoot = "/";

async function productionDeployment() {
  const options = { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(25_000) } as const;
  const page = await fetch(origin + "/connexion", options);
  if (!page.ok) throw new Error("Page de production de Vigie indisponible.");
  const ids = new Set(Array.from((await page.text()).matchAll(/data-dpl-id="(dpl_[a-zA-Z0-9]+)"/g), match => match[1]));
  if (ids.size !== 1) throw new Error("Identifiant du déploiement Vercel introuvable ou ambigu.");
  const [deploymentId] = ids;
  const nonce = randomBytes(32).toString("hex");
  const body = JSON.stringify({ projectId: vercelProjectId, deploymentId, nonce, database: true });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(origin + vercelRuntimePath, {
    ...options,
    method: "POST", body,
    headers: {
      "Content-Type": "application/json", "X-Vigie-Time": timestamp,
      "X-Vigie-Signature": runtimeSignature(vercelProjectId, "request", body, timestamp),
    },
  });
  if (!response.ok) throw new Error("Le déploiement de production n’a pas pu être attesté.");
  const proof = await response.json();
  const payload = runtimeProofSchema.parse(proof.payload);
  verifyRuntimeSignature(vercelProjectId, "response", JSON.stringify(payload), proof.timestamp, proof.signature);
  if (payload.nonce !== nonce || payload.projectId !== vercelProjectId || payload.deploymentId !== deploymentId ||
      payload.repository !== repository || !payload.commit) {
    throw new Error("Le déploiement de Vigie ne correspond pas au dépôt attendu.");
  }
  const sourceDatabase = neonDatabaseFingerprint(vercelProjectId, process.env.VIGIE_SELF_SOURCE_DATABASE_URL);
  const catalogDatabase = neonDatabaseFingerprint(vercelProjectId, process.env.DATABASE_URL);
  if (payload.databaseFingerprint !== sourceDatabase || catalogDatabase !== sourceDatabase) {
    throw new Error("La base à sauvegarder et le catalogue doivent correspondre à la base de production de Vigie.");
  }
  return { service: "Vigie", root: serviceRoot, deploymentId, commit: payload.commit,
    repository, branch: payload.branch, node: payload.node, region: payload.region };
}

function postgresEnvironment() {
  const source = new URL(process.env.VIGIE_SELF_SOURCE_DATABASE_URL ?? "");
  if (source.protocol !== "postgresql:" || !source.hostname.endsWith(".neon.tech") ||
      source.hostname.includes("-pooler.") || source.username !== "vigie_self_dump" ||
      !source.password || (source.port && source.port !== "5432") || source.pathname.length <= 1) {
    throw new Error("Connexion directe Neon de sauvegarde invalide.");
  }
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production", PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
    PGHOST: source.hostname, PGPORT: "5432", PGDATABASE: decodeURIComponent(source.pathname.slice(1)),
    PGUSER: source.username, PGPASSWORD: decodeURIComponent(source.password), PGCONNECT_TIMEOUT: "15",
    PGSSLMODE: "verify-full", PGSSLROOTCERT: "system", PGCHANNELBINDING: "require", PGAPPNAME: "vigie-self-backup",
  };
  if (process.platform === "win32") {
    env.WSLENV = Object.keys(env).filter(name => name.startsWith("PG")).join(":");
  }
  return env;
}

runPlatformBackup({
  projectId: vigieProjectId,
  name: "Vigie",
  inventory: async () => [await productionDeployment()],
  assertLinked: () => assertPlatformBackupLink(vigieVercel),
  sameInventory: ([before], [after]) => before.deploymentId === after.deploymentId && before.commit === after.commit,
  git: { repository, transport: "https", checkout: true },
  databases: [{
    file: "database.dump",
    windowsClient: 18,
    environment: postgresEnvironment,
    requiredTables: ["public projects", "public project_backups", "public session", "public hosting_connections", "public vercel_connections"],
  }],
  manifest: (services, sources, [{ tableDataEntries }]) => ({
    format: "vigie.vercel-backup", version: 1, project: "Vigie", vercelProjectId, origin,
    capturedAt: new Date().toISOString(), services, sources,
    database: { provider: "neon", format: "pg_dump custom", tableDataEntries },
  }),
}, process.argv.slice(2)).catch(error => {
  console.error("Sauvegarde Vigie en échec.", error instanceof Error ? error.message : "");
  process.exitCode = 1;
});
