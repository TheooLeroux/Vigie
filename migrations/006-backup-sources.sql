ALTER TABLE project_backups ADD COLUMN source_id TEXT;
ALTER TABLE project_backups ADD COLUMN source_name TEXT;
UPDATE project_backups SET source_id = 'project:' || project_id;
ALTER TABLE project_backups ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE project_backups ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE project_backups DROP CONSTRAINT project_backups_project_id_slot_key;
CREATE UNIQUE INDEX project_backups_source_slot ON project_backups(source_id, slot);
DROP INDEX project_backups_state;
CREATE INDEX project_backups_state ON project_backups(source_id, state, created_at);
