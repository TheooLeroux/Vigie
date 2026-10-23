CREATE TABLE update_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX update_runs_project ON update_runs(project_id);
CREATE TRIGGER update_runs_scope BEFORE INSERT OR UPDATE OF project_id ON update_runs FOR EACH ROW EXECUTE FUNCTION vigie_live_project();
CREATE TABLE update_locks (
  scope TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES update_runs(id) ON DELETE CASCADE
);
CREATE TABLE update_sources (
  target_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  secret_cipher TEXT NOT NULL
);
CREATE TRIGGER update_sources_scope BEFORE INSERT OR UPDATE OF project_id ON update_sources FOR EACH ROW EXECUTE FUNCTION vigie_live_project();
CREATE TABLE update_snapshots (
  run_id TEXT NOT NULL REFERENCES update_runs(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  PRIMARY KEY(run_id,target_id)
);
