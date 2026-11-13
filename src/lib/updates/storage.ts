import { database } from "../db";
import { openConnectorSecret, sealConnectorSecret } from "../connector-secrets";
import { isPostgres } from "../storage";
import type { SourceSettings, UpdateRun } from "./types";
import { railpackImageReport, type RailpackImageIdentity } from "./railpack-image-report";

export async function updateStorage() {
  const db = database();
  await db.initialize(`CREATE TABLE IF NOT EXISTS update_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,stage TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS update_runs_project ON update_runs(project_id);
    CREATE TABLE IF NOT EXISTS update_locks(scope TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES update_runs(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS update_sources(target_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 1,secret_cipher TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS update_snapshots(run_id TEXT NOT NULL REFERENCES update_runs(id) ON DELETE CASCADE,target_id TEXT NOT NULL,secret_cipher TEXT NOT NULL,PRIMARY KEY(run_id,target_id));`);
  return db;
}
export async function readUpdateRun(id: string) {
  const row = await (await updateStorage()).prepare("SELECT data FROM update_runs WHERE id=?").get(id) as { data: string } | undefined;
  return row ? JSON.parse(row.data) as UpdateRun : null;
}
export type UpdateHistory = { runs: UpdateRun[]; assessment: UpdateRun | null };
export async function readConfiguredUpdateTargets(projectIds: string[]) {
  const configured = new Map<string, Set<string>>(projectIds.map(id => [id, new Set()]));
  if (!configured.size) return configured;
  const rows = await (await updateStorage())
    .prepare(`SELECT project_id,target_id FROM update_sources WHERE project_id IN (${[...configured].map(() => "?").join(",")})`)
    .all(...configured.keys()) as { project_id: string; target_id: string }[];
  for (const row of rows) configured.get(row.project_id)!.add(row.target_id);
  return configured;
}

export async function readUpdateHistory(projectIds: string[]) {
  const history = new Map<string, UpdateHistory>(projectIds.map(id => [id, { runs: [], assessment: null }]));
  if (!history.size) return history;
  const withoutReceipts = isPostgres() ? "(data::jsonb - 'nodeReceipts')::text" : "json_remove(data,'$.nodeReceipts')";
  const rows = await (await updateStorage()).prepare(`
    SELECT project_id, CASE WHEN assessment THEN data ELSE ${withoutReceipts} END AS data, assessment FROM (
      SELECT project_id, data, COALESCE(json_extract(data,'$.purpose'),'update')='assessment' AS assessment,
        ROW_NUMBER() OVER (
          PARTITION BY project_id, COALESCE(json_extract(data,'$.purpose'),'update')='assessment'
          ORDER BY json_extract(data,'$.createdAt') DESC
        ) AS position
      FROM update_runs WHERE project_id IN (${[...history].map(() => "?").join(",")})
    ) ranked
    WHERE position <= CASE WHEN assessment THEN 1 ELSE 5 END
    ORDER BY project_id, position
  `).all(...history.keys()) as { project_id: string; data: string; assessment: boolean | number }[];
  for (const row of rows) {
    const run = JSON.parse(row.data) as UpdateRun;
    const projectHistory = history.get(row.project_id)!;
    if (row.assessment) projectHistory.assessment = run;
    else projectHistory.runs.push(run);
  }
  return history;
}
export async function writeUpdateRun(run: UpdateRun) {
  run.updatedAt = new Date().toISOString();
  await (await updateStorage()).prepare("UPDATE update_runs SET stage=?,data=? WHERE id=?").run(run.stage, JSON.stringify(run), run.id);
}
export async function nodeRunsWithReceipts(projectId: string, hashes: string[]) {
  const rows = await (await updateStorage()).prepare("SELECT data FROM update_runs WHERE project_id=? AND stage IN ('completed','failed','attention') AND data LIKE ? AND data LIKE ? AND data LIKE ? ORDER BY json_extract(data,'$.updatedAt') DESC LIMIT 10").all(projectId, ...hashes.map(hash => `%${hash}%`)) as { data: string }[];
  return rows.flatMap(row => { try { return [JSON.parse(row.data) as UpdateRun]; } catch { return []; } });
}
export async function readRailpackImageReports(projectId: string, identities: RailpackImageIdentity[]) {
  if (!identities.length) return [];
  // Find the report for the active deployment even after no-op runs push it
  // out of the maintenance history returned to the project view.
  const db = await updateStorage();
  const filters = [...new Set(identities.map(identity => `%"deploymentId":"${identity.deploymentId}"%`))];
  const rows = await db.prepare(`SELECT data FROM update_runs WHERE project_id=? AND stage IN ('completed','failed','attention') AND data LIKE ? AND (${filters.map(() => "data LIKE ?").join(" OR ")}) ORDER BY json_extract(data,'$.updatedAt') DESC`).all(
    projectId, '%"caddyEvidence":%', ...filters,
  ) as { data: string }[];
  const runs = rows.map(row => JSON.parse(row.data) as UpdateRun);
  return identities.flatMap(identity => {
    for (const run of runs) {
      const report = railpackImageReport(run, identity);
      if (report) return [report];
    }
    return [];
  });
}
export async function readUpdateSource(targetId: string) {
  const row = await (await updateStorage()).prepare("SELECT secret_cipher,revision FROM update_sources WHERE target_id=?").get(targetId) as { secret_cipher: string; revision: number } | undefined;
  return row ? { settings: JSON.parse(openConnectorSecret(row.secret_cipher, `vigie:updates:source:${targetId}`)) as SourceSettings, revision: row.revision } : null;
}
export async function writeUpdateSource(targetId: string, projectId: string, settings: SourceSettings) {
  const cipher = sealConnectorSecret(JSON.stringify(settings), `vigie:updates:source:${targetId}`);
  await (await updateStorage()).prepare("INSERT INTO update_sources(target_id,project_id,secret_cipher) VALUES(?,?,?) ON CONFLICT(target_id) DO UPDATE SET secret_cipher=excluded.secret_cipher,revision=update_sources.revision+1").run(targetId, projectId, cipher);
}
export async function saveUpdateSnapshot(runId: string, targetId: string, data: unknown) {
  const cipher = sealConnectorSecret(JSON.stringify(data), `vigie:updates:snapshot:${runId}:${targetId}`);
  await (await updateStorage()).prepare("INSERT INTO update_snapshots(run_id,target_id,secret_cipher) VALUES(?,?,?) ON CONFLICT(run_id,target_id) DO UPDATE SET secret_cipher=excluded.secret_cipher").run(runId, targetId, cipher);
}
