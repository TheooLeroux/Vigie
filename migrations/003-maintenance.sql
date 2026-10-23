CREATE TABLE maintenance_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('planned','dispatching','queued','pull_request','merging','merged','closed','failed')),
  data TEXT NOT NULL
);
CREATE INDEX maintenance_project ON maintenance_jobs(project_id);
CREATE TABLE maintenance_locks (
  repository TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES maintenance_jobs(id) ON DELETE CASCADE
);
CREATE TRIGGER maintenance_scope BEFORE INSERT OR UPDATE OF project_id ON maintenance_jobs FOR EACH ROW EXECUTE FUNCTION vigie_live_project();
