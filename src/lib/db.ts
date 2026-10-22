import { auditActor } from "./audit-context";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "./http";
import { clientSchema } from "./validation";
import type {
  Workspace,
  Project,
  Service,
  Environment,
  Access,
  Resource,
  Inventory,
  Component,
  Activity,
  WorkspaceData,
  ProjectDetail,
  Client,
} from "./types";
import type { ParsedComponent } from "./inventory";

type Table =
  | "clients"
  | "projects"
  | "environments"
  | "services"
  | "accesses"
  | "resources"
  | "inventories"
  | "components"
  | "activity";
type Stored = {
  id: string;
  workspace: string;
  project_id: string | null;
  data: string;
};
const globalDb = globalThis as unknown as { vigieDb?: DatabaseSync };
export function database() {
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
export function transaction<T>(fn: () => T): T {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function list<T>(
  table: Table,
  workspace: Workspace,
  projectId?: string,
): T[] {
  const rows = (projectId
    ? database()
        .prepare(`SELECT data FROM ${table} WHERE workspace=? AND project_id=?`)
        .all(workspace, projectId)
    : database()
        .prepare(`SELECT data FROM ${table} WHERE workspace=?`)
        .all(workspace)) as unknown as { data: string }[];
  return rows.map((r) => JSON.parse(r.data));
}
export function get<T>(
  table: Table,
  id: string,
  workspace: Workspace,
): T | null {
  const row = database()
    .prepare(`SELECT * FROM ${table} WHERE id=? AND workspace=?`)
    .get(id, workspace) as Stored | undefined;
  return row ? JSON.parse(row.data) : null;
}
export function save<T extends { id: string }>(
  table: Table,
  workspace: Workspace,
  data: T,
  projectId: string | null = null,
): T {
  if (table === "clients") {
    const client = data as unknown as Client;
    database()
      .prepare(
        "INSERT INTO clients(id,workspace,name_key,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,name_key=excluded.name_key WHERE clients.workspace=excluded.workspace",
      )
      .run(
        client.id,
        workspace,
        clientKey(client.name),
        JSON.stringify(client),
      );
    return data;
  }
  if (table === "projects") {
    const project = data as unknown as Project;
    const client = project.clientId
      ? get<Client>("clients", project.clientId, workspace)
      : null;
    if (project.clientId && !client)
      throw new ApiError("Client introuvable.", 404);
    project.clientId = client?.id || null;
    project.client = client?.name || "";
    database()
      .prepare(
        "INSERT INTO projects(id,workspace,project_id,client_id,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,client_id=excluded.client_id WHERE projects.workspace=excluded.workspace",
      )
      .run(
        project.id,
        workspace,
        projectId,
        project.clientId,
        JSON.stringify(project),
      );
    return data;
  }
  database()
    .prepare(
      `INSERT INTO ${table}(id,workspace,project_id,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE ${table}.workspace=excluded.workspace`,
    )
    .run(data.id, workspace, projectId, JSON.stringify(data));
  return data;
}
export function remove(table: Table, id: string, workspace: Workspace) {
  database()
    .prepare(`DELETE FROM ${table} WHERE id=? AND workspace=?`)
    .run(id, workspace);
}
export function requireProject(id: string, workspace: Workspace): Project {
  const p = get<Project>("projects", id, workspace);
  if (!p) throw new Error("Projet introuvable.");
  return p;
}
export function createClient(
  workspace: Workspace,
  input: ReturnType<typeof clientSchema.parse>,
): Client {
  if (
    list<Client>("clients", workspace).some(
      (c) => clientKey(c.name) === clientKey(input.name),
    )
  )
    throw new ApiError(
      "Un client porte déjà ce nom. Sélectionnez sa fiche existante.",
      409,
    );
  const now = new Date().toISOString();
  const client = save<Client>("clients", workspace, {
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  log(workspace, "client.created", `Client « ${client.name} » ajouté.`);
  return client;
}
export function updateClient(
  workspace: Workspace,
  id: string,
  input: Partial<ReturnType<typeof clientSchema.parse>>,
) {
  const current = get<Client>("clients", id, workspace);
  if (!current) throw new ApiError("Client introuvable.", 404);
  if (
    input.name &&
    list<Client>("clients", workspace).some(
      (c) => c.id !== id && clientKey(c.name) === clientKey(input.name!),
    )
  )
    throw new ApiError("Un client porte déjà ce nom.", 409);
  const client = save<Client>("clients", workspace, {
    ...current,
    ...input,
    updatedAt: new Date().toISOString(),
  });
  for (const project of list<Project>("projects", workspace).filter(
    (p) => p.clientId === id,
  )) {
    save("projects", workspace, { ...project, client: client.name });
  }
  log(workspace, "client.updated", `Fiche client « ${client.name} » modifiée.`);
  return client;
}
export function resolveProjectClient(
  workspace: Workspace,
  input: { clientId?: string | null; client?: string },
): Pick<Project, "clientId" | "client"> {
  if (input.clientId) {
    const client = get<Client>("clients", input.clientId, workspace);
    if (!client) throw new ApiError("Client introuvable.", 404);
    return { clientId: client.id, client: client.name };
  }
  // Name-based CSV/JSON imports reuse the same client; interactive forms use its ID.
  if (input.client?.trim()) {
    const client =
      list<Client>("clients", workspace).find(
        (c) => clientKey(c.name) === clientKey(input.client!),
      ) || createClient(workspace, clientSchema.parse({ name: input.client }));
    return { clientId: client.id, client: client.name };
  }
  return { clientId: null, client: "" };
}
export function log(
  workspace: Workspace,
  action: string,
  detail: string,
  projectId: string | null = null,
) {
  const project = projectId
    ? get<Project>("projects", projectId, workspace)
    : null;
  if (project)
    save<Project>("projects", workspace, {
      ...project,
      updatedAt: new Date().toISOString(),
    });
  save<Activity>(
    "activity",
    workspace,
    {
      actorName: auditActor()?.name,
      actorEmail: auditActor()?.email,
      id: randomUUID(),
      projectId,
      projectName: project?.name || "Espace de travail",
      action,
      detail,
      createdAt: new Date().toISOString(),
    },
    projectId,
  );
}
export function createProject(
  workspace: Workspace,
  input: Omit<
    Project,
    "id" | "createdAt" | "updatedAt" | "reviewedAt" | "clientId"
  > & {
    clientId?: string | null;
    technology?: string;
    provider?: string;
    runtime?: string;
    version?: string;
    repository?: string;
  },
): Project {
  const { technology, provider, runtime, version, repository, ...fields } =
    input;
  const now = new Date().toISOString();
  const p = save<Project>("projects", workspace, {
    ...fields,
    ...resolveProjectClient(workspace, fields),
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    reviewedAt: null,
  });
  const env = save<Environment>(
    "environments",
    workspace,
    {
      id: randomUUID(),
      projectId: p.id,
      name: "Production",
      kind: "production",
      url: p.url,
    },
    p.id,
  );
  save<Service>(
    "services",
    workspace,
    {
      id: randomUUID(),
      projectId: p.id,
      environmentId: env.id,
      name: "Site principal",
      kind: "web",
      technology: technology || "",
      provider: provider || "",
      url: p.url,
      repository: repository || "",
      runtime: runtime || "",
      version: version || "",
    },
    p.id,
  );
  log(workspace, "project.created", "Projet ajouté à l’inventaire.", p.id);
  return p;
}
export function workspaceData(workspace: Workspace): WorkspaceData {
  return {
    clients: list<Client>("clients", workspace).sort((a, b) =>
      a.name.localeCompare(b.name, "fr"),
    ),
    projects: list<Project>("projects", workspace).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    ),
    services: list<Service>("services", workspace),
    environments: list<Environment>("environments", workspace),
    resources: list<Resource>("resources", workspace),
    accesses: list<Access>("accesses", workspace),
    inventories: list<Inventory>("inventories", workspace).sort((a, b) =>
      b.collectedAt.localeCompare(a.collectedAt),
    ),
    activity: list<Activity>("activity", workspace)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100),
  };
}
export function projectDetail(id: string, workspace: Workspace): ProjectDetail {
  const project = requireProject(id, workspace);
  const inventories = list<Inventory>("inventories", workspace, id).sort(
    (a, b) => b.collectedAt.localeCompare(a.collectedAt),
  );
  const latest = new Map<string, string>();
  for (const i of inventories)
    if (!latest.has(i.serviceId)) latest.set(i.serviceId, i.id);
  const latestIds = new Set(latest.values());
  return {
    project,
    services: list<Service>("services", workspace, id),
    environments: list<Environment>("environments", workspace, id),
    accesses: list<Access>("accesses", workspace, id),
    resources: list<Resource>("resources", workspace).filter((r) =>
      r.projectIds.includes(id),
    ),
    inventories,
    components: list<Component>("components", workspace, id).filter((c) =>
      latestIds.has(c.inventoryId),
    ),
    activity: list<Activity>("activity", workspace, id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100),
  };
}
export function saveInventory(
  workspace: Workspace,
  serviceId: string,
  source: Inventory["source"],
  filename: string,
  commitRef: string,
  components: ParsedComponent[],
) {
  const service = get<Service>("services", serviceId, workspace);
  if (!service) throw new Error("Service introuvable.");
  return transaction(() => {
    const inventory = save<Inventory>(
      "inventories",
      workspace,
      {
        id: randomUUID(),
        serviceId,
        source,
        filename,
        commitRef,
        collectedAt: new Date().toISOString(),
        componentCount: components.length,
      },
      service.projectId,
    );
    for (const component of components)
      save<Component>(
        "components",
        workspace,
        { ...component, id: randomUUID(), inventoryId: inventory.id },
        service.projectId,
      );
    log(
      workspace,
      "inventory.imported",
      `${components.length} composants ${source === "manual" ? "déclarés" : "importés"} pour ${service.name}.`,
      service.projectId,
    );
    return inventory;
  });
}
