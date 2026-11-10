import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { list } from "../src/lib/db";
import { railwayState } from "../src/lib/railway";
import { isPostgres, postgresPool } from "../src/lib/storage";
import type { Project } from "../src/lib/types";
import { vercelState } from "../src/lib/vercel";
import type { RailwayProject } from "../src/lib/railway-types";
import type { VercelProject } from "../src/lib/vercel-types";
import { platformBackupTargets } from "./platform-backup-targets";

const commitHash = /^[0-9a-f]{40}$/;

type Inventory = {
  projectId: string | null;
  projectName: string | null;
  active: boolean | null;
  observedAt: string;
  missingSince: string | null;
  configured: boolean;
  connectionError: boolean;
};

async function observations() {
  if (isPostgres()) {
    const { rows } = await postgresPool().query<Inventory & (
      { provider: "railway"; remote: RailwayProject } | { provider: "vercel"; remote: VercelProject }
    )>(`SELECT provider, remote, project_id AS "projectId", project_name AS "projectName",
      active, observed_at AS "observedAt", missing_since AS "missingSince", configured, connection_error AS "connectionError"
      FROM backup_platform_inventory ORDER BY provider, remote_id`);
    return {
      railway: rows.flatMap(row => row.provider === "railway" ? [{ ...row.remote, ...row }] : []),
      vercel: rows.flatMap(row => row.provider === "vercel" ? [{ ...row.remote, ...row }] : []),
    };
  }
  const [railway, vercel, projects] = await Promise.all([
    railwayState(), vercelState(), list<Project>("projects", "live"),
  ]);
  const active = new Set(projects.filter(project => project.lifecycle === "active").map(project => project.id));
  const mark = <T extends { projectId: string | null }>(project: T) => ({
    ...project, active: !!project.projectId && active.has(project.projectId),
  });
  return { railway: railway.projects.map(mark), vercel: vercel.projects.map(mark) };
}

export async function planPlatformBackups() {
  const { railway, vercel } = await observations();
  const candidates = [
    ...railway.map(project => ({
      provider: "railway" as const,
      project,
      excluded: false,
      inspect: () => {
        const environments = project.environments.filter(environment => !environment.ephemeral && environment.name === "production");
        if (environments.length !== 1) return ["Environnement de production à identifier."];
        const services = project.services.filter(service => service.environmentId === environments[0].id);
        if (!services.length) return ["Aucun service de production observé."];
        return [
          ...services.flatMap(service => {
            if (service.image && !service.repository) return [`Image et données persistantes à vérifier pour ${service.name}.`];
            const active = service.activeDeployments ?? [];
            const commit = active[0]?.evidence?.commit;
            return active.length === 1 && active[0].status === "SUCCESS" && commitHash.test(commit ?? "") &&
              (active[0].evidence?.repository || service.repository) ? [] : [`Source déployée à identifier pour ${service.name}.`];
          }),
          "Bases et volumes de production à qualifier.",
        ];
      },
    })),
    ...vercel.map(project => ({
      provider: "vercel" as const,
      project,
      excluded: project.excluded,
      inspect: () => [
        ...(project.production?.state !== "READY" ? ["Déploiement de production à identifier."] :
          project.production.repository && commitHash.test(project.production.commit ?? "") ? [] :
            ["Source du déploiement à identifier."]),
        "Données persistantes à qualifier, y compris leur absence éventuelle.",
      ],
    })),
  ];

  return candidates.map(({ provider, project, excluded, inspect }) => {
    const target = platformBackupTargets.find(target => target.provider === provider && target.remoteId === project.id);
    const base = {
      provider, name: project.projectName ?? project.name, remoteId: project.id,
      projectId: project.projectId, observedAt: project.observedAt,
    };
    const skip = excluded ? "Projet exclu dans Vigie." :
      !project.projectId ? "Projet non lié dans Vigie." :
        !project.active ? "Projet inactif dans Vigie." :
          project.missingSince ? "Projet absent du dernier inventaire." : null;
    if (skip) return { ...base, status: "out-of-scope", reasons: [skip] };
    if (target && target.projectId !== project.projectId) {
      return { ...base, status: "needs-qualification", reasons: ["Le lien Vigie diffère du profil de capture."] };
    }
    if (target && candidates.filter(candidate => candidate.provider === provider && candidate.project.id === project.id &&
      !candidate.project.missingSince && candidate.project.configured).length !== 1) {
      return { ...base, status: "needs-qualification", reasons: ["La connexion au projet de production est absente ou ambiguë."] };
    }
    if (target && project.configured && !project.connectionError) {
      return { ...base, status: "capture-profile", verify: `node --import tsx ${target.entry} --verify` };
    }
    return {
      ...base, status: "needs-qualification",
      reasons: !project.configured || project.connectionError ? ["Inventaire du fournisseur à actualiser."] : inspect(),
    };
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
