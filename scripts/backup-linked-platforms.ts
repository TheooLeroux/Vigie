import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";
import { postgresPool, isPostgres } from "../src/lib/storage";
import type { RailwayProject } from "../src/lib/railway-types";
import { githubBackupToken } from "./backup-github-app";
import { inspectLinkedRailway } from "./backup-railway-linked";
import { inspectLinkedVercel } from "./backup-vercel-linked";
import { assertPlatformBackupLink } from "./check-platform-backup-link";
import { runPlatformBackup } from "./platform-backup";
import { platformBackupTargets } from "./platform-backup-targets";

type Target = {
  provider: "railway" | "vercel";
  remoteId: string;
  connectionId: string;
  projectId: string;
  name: string;
  remote: RailwayProject;
};

async function linkedTargets(projectId?: string) {
  const { rows } = await postgresPool().query<Target>(`
    SELECT provider, remote_id AS "remoteId", connection_id AS "connectionId",
      project_id AS "projectId", project_name AS name, remote
    FROM backup_platform_inventory
    WHERE configured AND active AND NOT connection_error AND missing_since IS NULL
      AND (provider = 'railway' OR COALESCE(remote->>'excluded', 'false') = 'false')
      AND ($1::text IS NULL OR project_id = $1)
    ORDER BY provider, remote_id, connection_id
  `, [projectId ?? null]);
  return rows.filter(row => !platformBackupTargets.some(pilot => pilot.provider === row.provider && pilot.remoteId === row.remoteId));
}

async function main(args: string[]) {
  const { values } = parseArgs({ args, options: {
    mode: { type: "string", default: "plan" }, project: { type: "string" },
  } });
  const mode = z.enum(["plan", "capture", "verify-r2"]).parse(values.mode);
  const project = values.project ? z.uuid().parse(values.project) : undefined;
  if (!isPostgres()) throw new Error("Accès PostgreSQL au catalogue Vigie manquant.");
  const targets = await linkedTargets(project);
  if (project && !targets.length) throw new Error("Projet lié éligible introuvable pour le collecteur commun.");
  const totals = { candidates: targets.length, qualified: 0, blocked: 0, failed: 0 };
  for (const target of targets) {
    const inspect = () => target.provider === "railway"
      ? inspectLinkedRailway(target.connectionId, target.remote, mode === "plan")
      : inspectLinkedVercel(target.connectionId, target.remoteId);
    let startingCapture = false;
    try {
      await assertPlatformBackupLink(target);
      const first = await inspect();
      const repositories = [...new Set(first.services.flatMap(service => service.repository ? [service.repository] : []))];
      for (const repository of repositories) await githubBackupToken(repository);
      if (!repositories.length) throw new Error("Aucune source Git de production couverte.");
      if (mode === "plan" && target.provider === "railway") {
        if (!process.env.VIGIE_BACKUP_RAILWAY_KNOWN_HOST) throw new Error("Clé d’hôte Railway SSH approuvée manquante.");
      } else if (!first.databases.length) {
        throw new Error("Aucune base de production couverte.");
      }
      totals.qualified++;
      if (mode === "plan") {
        if (!process.env.GITHUB_ACTIONS) console.log(JSON.stringify({ name: target.name, provider: target.provider, status: "qualified" }));
        continue;
      }
      startingCapture = true;
      const name = process.env.GITHUB_ACTIONS ? target.provider : target.name;
      await runPlatformBackup<(typeof first.services)[number]>({
        projectId: target.projectId, linkedSource: target, name,
        assertLinked: () => assertPlatformBackupLink(target),
        inventory: async () => {
          const current = await inspect();
          if (!isDeepStrictEqual(first.services, current.services)) throw new Error("Le périmètre de production a changé.");
          return first.services;
        },
        git: repositories.map(repository => ({ repository, transport: "github-app" })),
        databases: first.databases,
        manifest: (services, sources, databases) => ({
          format: "vigie.linked-platform-backup", version: 1, provider: target.provider, remoteId: target.remoteId,
          capturedAt: new Date().toISOString(), services, sources, databases,
        }),
      }, [mode === "capture" ? "--automatic" : "--verify-r2"]);
    } catch (error) {
      totals[startingCapture ? "failed" : "blocked"]++;
      if (!process.env.GITHUB_ACTIONS) {
        const reason = error instanceof z.ZodError ? "Métadonnées fournisseur incomplètes ou non prises en charge." :
          error instanceof Error ? error.message : "Collecte indisponible.";
        console.log(JSON.stringify({ name: target.name, provider: target.provider, status: "blocked", reason }));
      }
    }
  }
  console.log(JSON.stringify(totals));
  if (totals.failed || (project && totals.blocked)) process.exitCode = 1;
}

main(process.argv.slice(2)).catch(() => {
  console.error("Le collecteur des projets liés n’a pas pu démarrer.");
  process.exitCode = 1;
}).finally(async () => {
  if (isPostgres()) await postgresPool().end();
});
