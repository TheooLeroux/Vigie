import { database } from "../db";
import { openConnectorSecret, sealConnectorSecret } from "../connector-secrets";
import type { SourceSettings, UpdateRun } from "./types";

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
export async function writeUpdateRun(run: UpdateRun) {
  run.updatedAt = new Date().toISOString();
  await (await updateStorage()).prepare("UPDATE update_runs SET stage=?,data=? WHERE id=?").run(run.stage, JSON.stringify(run), run.id);
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
