import { list } from "../src/lib/db";
import { railwayState } from "../src/lib/railway";
import type { RailwayProject } from "../src/lib/railway-types";
import { isPostgres, postgresPool } from "../src/lib/storage";
import type { Project } from "../src/lib/types";
import { vercelState } from "../src/lib/vercel";
import type { VercelProject } from "../src/lib/vercel-types";
import { platformBackupTargets } from "./platform-backup-targets";

type Observation = {
  remoteId: string;
  connectionId: string;
  projectId: string | null;
  projectName: string | null;
  active: boolean | null;
  observedAt: string;
  missingSince: string | null;
  configured: boolean;
  connectionError: boolean;
} & ({ provider: "railway"; remote: RailwayProject } | { provider: "vercel"; remote: VercelProject });

async function readObservations(): Promise<Observation[]> {
  if (isPostgres()) {
    const { rows } = await postgresPool().query<Observation>(`
      SELECT provider, remote_id AS "remoteId", connection_id AS "connectionId", remote,
        project_id AS "projectId", project_name AS "projectName", active, observed_at AS "observedAt",
        missing_since AS "missingSince", configured, connection_error AS "connectionError"
      FROM backup_platform_inventory ORDER BY provider, remote_id, connection_id
    `);
    return rows;
  }
  const [railway, vercel, projects] = await Promise.all([railwayState(), vercelState(), list<Project>("projects", "live")]);
  const active = new Set(projects.filter(project => project.lifecycle === "active").map(project => project.id));
  const observation = (remote: typeof railway.projects[number] | typeof vercel.projects[number]) => ({
    remoteId: remote.id, connectionId: remote.connectionId, projectId: remote.projectId, projectName: remote.projectName,
    active: !!remote.projectId && active.has(remote.projectId), observedAt: remote.observedAt, missingSince: remote.missingSince,
    configured: remote.configured, connectionError: Boolean(remote.connectionError),
  });
  return [
    ...railway.projects.map(remote => ({ ...observation(remote), provider: "railway" as const, remote })),
    ...vercel.projects.map(remote => ({ ...observation(remote), provider: "vercel" as const, remote })),
  ];
}

export async function platformBackupInventory() {
  const observations = await readObservations();
  const connectionCounts = new Map<string, number>();
  const key = (row: Observation) => row.provider + ":" + row.remoteId;
  for (const row of observations) {
    if (row.configured && !row.missingSince) connectionCounts.set(key(row), (connectionCounts.get(key(row)) ?? 0) + 1);
  }

  return observations.map(row => {
    const pilot = platformBackupTargets.find(target => target.provider === row.provider && target.remoteId === row.remoteId);
    const outOfScope = row.provider === "vercel" && row.remote.excluded ? "Projet exclu dans Vigie." :
      !row.projectId ? "Projet non lié dans Vigie." :
        !row.active ? "Projet inactif dans Vigie." :
          row.missingSince ? "Projet absent du dernier inventaire." : null;
    const blocked = pilot && pilot.projectId !== row.projectId ? "Le lien Vigie diffère du profil de capture." :
      !row.configured || row.connectionError ? "Inventaire du fournisseur à actualiser." :
        connectionCounts.get(key(row)) !== 1 ? "La connexion au projet de production est absente ou ambiguë." : null;
    return { row, pilot, outOfScope, blocked };
  });
}
