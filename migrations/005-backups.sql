CREATE TABLE IF NOT EXISTS project_backups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','failed','ready','expired')),
  owner TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT,
  bytes BIGINT,
  UNIQUE(project_id, slot)
);
CREATE INDEX IF NOT EXISTS project_backups_state ON project_backups(project_id, state, created_at);
