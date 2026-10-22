CREATE UNIQUE INDEX IF NOT EXISTS clients_scope ON clients(id,workspace);
ALTER TABLE projects ADD CONSTRAINT projects_client_scope FOREIGN KEY(client_id,workspace) REFERENCES clients(id,workspace) ON DELETE RESTRICT;
CREATE FUNCTION vigie_live_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id AND workspace='live') THEN
    RAISE EXCEPTION 'Projet hors périmètre';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vercel_link_scope BEFORE INSERT OR UPDATE OF project_id ON vercel_projects FOR EACH ROW EXECUTE FUNCTION vigie_live_project();
CREATE TRIGGER railway_link_scope BEFORE INSERT OR UPDATE OF project_id ON railway_projects FOR EACH ROW EXECUTE FUNCTION vigie_live_project();
