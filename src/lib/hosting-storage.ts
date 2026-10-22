import { database } from "./db";
export async function hostingStorage() {
  const db = database();
  (await db.initialize(`CREATE TABLE IF NOT EXISTS hosting_connections (id TEXT PRIMARY KEY,workspace TEXT NOT NULL CHECK(workspace='live'),endpoint TEXT NOT NULL,username TEXT NOT NULL,data TEXT NOT NULL,secret_cipher TEXT,UNIQUE(workspace,endpoint,username));
    CREATE TABLE IF NOT EXISTS hosting_installations (id TEXT PRIMARY KEY,workspace TEXT NOT NULL CHECK(workspace='live'),connection_id TEXT NOT NULL REFERENCES hosting_connections(id) ON DELETE CASCADE,scope TEXT NOT NULL,document_root TEXT NOT NULL,project_id TEXT,link_method TEXT,match_reason TEXT,data TEXT NOT NULL,UNIQUE(connection_id,scope,document_root),FOREIGN KEY(project_id,workspace) REFERENCES projects(id,workspace));
    CREATE INDEX IF NOT EXISTS hosting_installations_project ON hosting_installations(project_id);
    CREATE TABLE IF NOT EXISTS hosting_discovery_runs (connection_id TEXT NOT NULL REFERENCES hosting_connections(id) ON DELETE CASCADE,scope TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(connection_id,scope));
    CREATE TABLE IF NOT EXISTS hosting_site_inventories (installation_id TEXT PRIMARY KEY REFERENCES hosting_installations(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hosting_observers (installation_id TEXT PRIMARY KEY REFERENCES hosting_installations(id) ON DELETE CASCADE,secret_cipher TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wordpress_catalog (cache_key TEXT PRIMARY KEY,data TEXT NOT NULL,expires_at TEXT NOT NULL);`));
  return db;
}
