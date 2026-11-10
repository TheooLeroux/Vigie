import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPostgres, postgresPool } from "../src/lib/storage";
import type { RailwayProject } from "../src/lib/railway-types";
import type { VercelProject } from "../src/lib/vercel-types";
import { platformBackupInventory } from "./platform-backup-inventory";

const commitHash = /^[0-9a-f]{40}$/;

function railwayReasons(project: RailwayProject) {
  const environments = project.environments.filter(environment => !environment.ephemeral && environment.name === "production");
  if (environments.length !== 1) return ["Environnement de production à identifier."];
  const services = project.services.filter(service => service.environmentId === environments[0].id);
  if (!services.length) return ["Aucun service de production observé."];
  return [
    ...services.flatMap(service => {
      if (service.image && !service.repository) return [`Image et données persistantes à vérifier pour ${service.name}.`];
      const active = service.activeDeployments ?? [];
      return active.length === 1 && active[0].status === "SUCCESS" && commitHash.test(active[0].evidence?.commit ?? "") &&
        (active[0].evidence?.repository || service.repository) ? [] : [`Source déployée à identifier pour ${service.name}.`];
    }),
    "Bases et volumes de production à qualifier.",
  ];
}

function vercelReasons(project: VercelProject) {
  return [
    ...(project.production?.state !== "READY" ? ["Déploiement de production à identifier."] :
      project.production.repository && commitHash.test(project.production.commit ?? "") ? [] :
        ["Source du déploiement à identifier."]),
    "Données persistantes à qualifier, y compris leur absence éventuelle.",
  ];
}

export async function planPlatformBackups() {
  return (await platformBackupInventory()).map(({ row, pilot, outOfScope, blocked }) => {
    const base = {
      provider: row.provider, name: row.projectName ?? row.remote.name, remoteId: row.remoteId,
      projectId: row.projectId, observedAt: row.observedAt,
    };
    if (outOfScope) return { ...base, status: "out-of-scope", reasons: [outOfScope] };
    if (!blocked && pilot) return { ...base, status: "capture-profile", verify: `node --import tsx ${pilot.entry} --verify` };
    const reasons = blocked ? [blocked] : row.provider === "railway" ? railwayReasons(row.remote) : vercelReasons(row.remote);
    return { ...base, status: "needs-qualification", reasons };
  });
}

async function main(args: string[]) {
  const github = args.length === 1 && args[0] === "--github";
  if (args.length && !github) throw new Error("Argument de planification inconnu.");
  if (github && !isPostgres()) throw new Error("Accès PostgreSQL à l’inventaire manquant.");
  const result = await planPlatformBackups();
  if (github) {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error("GITHUB_OUTPUT absent.");
    const ready = (provider: string) => result.some(row => row.provider === provider && row.status === "capture-profile");
    await appendFile(output, `railway=${ready("railway")}\nvercel=${ready("vercel")}\n`);
    for (const status of ["capture-profile", "needs-qualification", "out-of-scope"]) {
      console.log(status + " " + result.filter(row => row.status === status).length);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    console.error("Impossible de lire l’inventaire des sauvegardes Vercel et Railway.");
    process.exitCode = 1;
  }).finally(async () => {
    if (isPostgres()) await postgresPool().end();
  });
}
