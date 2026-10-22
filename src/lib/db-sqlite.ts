import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { clientSchema } from "./validation";
import type { Client, Project } from "./types";
const globalDb = globalThis as unknown as { vigieDb?: DatabaseSync };
export function sqliteDatabase() {
  if (globalDb.vigieDb) {
    migrateClients(globalDb.vigieDb);
    return globalDb.vigieDb;
  }
  const path =
    process.env.VIGIE_DB_PATH || join(process.cwd(), ".data", "vigie.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, workspace TEXT NOT NULL CHECK(workspace IN ('demo','live')), project_id TEXT, data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS projects_scope ON projects(id, workspace);`);
  for (const table of [
    "environments",
    "services",
    "accesses",
    "resources",
    "inventories",
    "components",
    "activity",
  ]) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, workspace TEXT NOT NULL CHECK(workspace IN ('demo','live')), project_id TEXT, data TEXT NOT NULL, FOREIGN KEY(project_id,workspace) REFERENCES projects(id,workspace) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS ${table}_workspace_project ON ${table}(workspace,project_id);`);
  }
  db.prepare("INSERT OR IGNORE INTO migrations VALUES (1, ?)").run(
    new Date().toISOString(),
  );
  migrateClients(db);
  globalDb.vigieDb = db;
  return db;
}
function clientKey(name: string) {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("fr");
}
function migrateClients(db: DatabaseSync) {
  if (db.prepare("SELECT version FROM migrations WHERE version=2").get())
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT version FROM migrations WHERE version=2").get()) {
      db.exec(`CREATE TABLE clients (id TEXT PRIMARY KEY, workspace TEXT NOT NULL CHECK(workspace IN ('demo','live')), project_id TEXT, name_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(workspace,name_key));
        ALTER TABLE projects ADD COLUMN client_id TEXT REFERENCES clients(id) ON DELETE RESTRICT;
        CREATE INDEX projects_client ON projects(workspace,client_id);
        CREATE TRIGGER projects_client_scope_insert BEFORE INSERT ON projects WHEN NEW.client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clients WHERE id=NEW.client_id AND workspace=NEW.workspace) BEGIN SELECT RAISE(ABORT,'Client hors périmètre'); END;
        CREATE TRIGGER projects_client_scope_update BEFORE UPDATE OF client_id,workspace ON projects WHEN NEW.client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clients WHERE id=NEW.client_id AND workspace=NEW.workspace) BEGIN SELECT RAISE(ABORT,'Client hors périmètre'); END;`);
      const now = new Date().toISOString();
      const known = new Map<string, Client>();
      for (const row of db
        .prepare("SELECT id,workspace,data FROM projects")
        .all() as { id: string; workspace: string; data: string }[]) {
        const project = JSON.parse(row.data) as Project;
        let client: Client | undefined;
        if (project.client?.trim()) {
          const key = `${row.workspace}|${clientKey(project.client)}`;
          client = known.get(key);
          if (!client) {
            client = {
              ...clientSchema.parse({ name: project.client }),
              id: randomUUID(),
              createdAt: now,
              updatedAt: now,
            };
            db.prepare(
              "INSERT INTO clients(id,workspace,name_key,data) VALUES (?,?,?,?)",
            ).run(
              client.id,
              row.workspace,
              clientKey(client.name),
              JSON.stringify(client),
            );
            known.set(key, client);
          }
        }
        project.clientId = client?.id || null;
        project.client = client?.name || "";
        db.prepare("UPDATE projects SET client_id=?,data=? WHERE id=?").run(
          project.clientId,
          JSON.stringify(project),
          row.id,
        );
      }
      db.prepare("INSERT INTO migrations VALUES (2,?)").run(now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
