import { isDeepStrictEqual, parseArgs } from "node:util";
import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { postgresPool, isPostgres } from "../src/lib/storage";
import { githubBackupToken } from "./backup-github-app";
import { inspectLinkedRailway } from "./backup-railway-linked";
import { inspectLinkedVercel } from "./backup-vercel-linked";
import { assertPlatformBackupLink } from "./check-platform-backup-link";
import { runPlatformBackup } from "./platform-backup";
import { platformBackupInventory } from "./platform-backup-inventory";

type Phase = "link" | "inventory" | "sources" | "persistence" | "capture";
const phaseMessages: Record<Phase, string> = {
  link: "Vérifier le rattachement et le projet actif.",
  inventory: "Vérifier le déploiement, les services et le périmètre de données pris en charge.",
  sources: "Vérifier le dépôt déployé et l’accès en lecture de l’application GitHub de sauvegarde.",
  persistence: "Vérifier le collecteur de données et ses paramètres pour ce projet.",
  capture: "Vérifier la capture, son stockage et le périmètre de production.",
};

async function linkedTargets(projectId?: string) {
  return (await platformBackupInventory()).flatMap(({ row, pilot, outOfScope, blocked }) =>
    !pilot && !outOfScope && !blocked && row.projectId && (!projectId || row.projectId === projectId)
      ? [{ ...row, projectId: row.projectId, name: row.projectName ?? row.remote.name }]
      : []);
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
  const report: string[] = [];
  for (const target of targets) {
    const inspect = () => target.provider === "railway"
      ? inspectLinkedRailway(target.connectionId, target.remote, mode === "plan")
      : inspectLinkedVercel(target.connectionId, target.remoteId);
    let phase: Phase = "link";
    try {
      if (mode !== "plan") await assertPlatformBackupLink(target);
      phase = "inventory";
      const first = await inspect();
      phase = "sources";
      const repositories = [...new Set(first.services.flatMap(service => service.repository ? [service.repository] : []))];
      if (!repositories.length) throw new Error("Aucune source Git de production couverte.");
      const git = await Promise.all(repositories.map(async repository => ({
        repository, transport: "github-app" as const, accessToken: await githubBackupToken(repository),
      })));
      phase = "persistence";
      if (mode === "plan" && target.provider === "railway") {
        if (!process.env.VIGIE_BACKUP_RAILWAY_KNOWN_HOST) throw new Error("Clé d’hôte Railway SSH approuvée manquante.");
      } else if (!first.databases.length) {
        throw new Error("Aucune base de production couverte.");
      }
      totals.qualified++;
      if (mode === "plan") {
        report.push(`| \`${target.projectId}\` | ${target.provider} | Qualifié | |`);
        if (!process.env.GITHUB_ACTIONS) console.log(JSON.stringify({ name: target.name, provider: target.provider, status: "qualified" }));
        continue;
      }
      phase = "capture";
      const name = process.env.GITHUB_ACTIONS ? target.provider : target.name;
      const result = await runPlatformBackup<(typeof first.services)[number]>({
        projectId: target.projectId, linkedSource: target, name,
        assertLinked: () => assertPlatformBackupLink(target),
        inventory: async () => {
          const current = await inspect();
          if (!isDeepStrictEqual(first.services, current.services)) throw new Error("Le périmètre de production a changé.");
          return first.services;
        },
        git,
        databases: first.databases,
        manifest: (services, sources, databases) => ({
          format: "vigie.linked-platform-backup", version: 1, provider: target.provider, remoteId: target.remoteId,
          capturedAt: new Date().toISOString(), services, sources, databases,
        }),
      }, [mode === "capture" ? "--automatic" : "--verify-r2"]);
      const status = mode === "verify-r2" ? "Téléchargement R2 vérifié" : result ? "Copie publiée" : "Créneau déjà couvert ou réservé";
      report.push(`| \`${target.projectId}\` | ${target.provider} | ${status} | |`);
    } catch (error) {
      const failed = phase === "capture";
      totals[failed ? "failed" : "blocked"]++;
      report.push(`| \`${target.projectId}\` | ${target.provider} | ${failed ? "Échec" : "Bloqué"} | ${phaseMessages[phase]} |`);
      if (!process.env.GITHUB_ACTIONS) {
        const reason = error instanceof z.ZodError ? "Métadonnées fournisseur incomplètes ou non prises en charge." :
          error instanceof Error ? error.message : "Collecte indisponible.";
        console.log(JSON.stringify({ name: target.name, provider: target.provider, status: failed ? "failed" : "blocked", reason }));
      }
    }
  }
  console.log(JSON.stringify(totals));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, [
      "## Sauvegardes des projets liés",
      "",
      `${totals.candidates} candidat(s) · ${totals.qualified} qualifié(s) · ${totals.blocked} bloqué(s) · ${totals.failed} collecte(s) en échec`,
      "",
      "| Projet Vigie | Hébergeur | État | Action suivante |",
      "| --- | --- | --- | --- |",
      ...report,
      "",
    ].join("\n"));
  }
  if (totals.failed || (totals.candidates > 0 && totals.qualified === 0) || (project && totals.blocked)) process.exitCode = 1;
}

main(process.argv.slice(2)).catch(() => {
  console.error("Le collecteur des projets liés n’a pas pu démarrer.");
  process.exitCode = 1;
}).finally(async () => {
  if (isPostgres()) await postgresPool().end();
});
