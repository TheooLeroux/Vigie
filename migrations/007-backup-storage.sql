ALTER TABLE project_backups ADD COLUMN storage_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE project_backups ADD COLUMN sha256 TEXT;
CREATE TABLE backup_pending_uploads (
  owner TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL,
  discard_after TEXT NOT NULL
);
CREATE INDEX backup_pending_uploads_due ON backup_pending_uploads(storage_id, discard_after);
