import { auditActor } from "./audit-context";
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
export { database, transaction } from "./storage";
import { database, transaction } from "./storage";
function clientKey(name: string) {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("fr");
}
export async function list<T>(
  table: Table,
  workspace: Workspace,
  projectId?: string,
): Promise<T[]> {
  const rows = (projectId
    ? (await database()
        .prepare(`SELECT data FROM ${table} WHERE workspace=? AND project_id=?`)
        .all(workspace, projectId))
    : (await database()
        .prepare(`SELECT data FROM ${table} WHERE workspace=?`)
        .all(workspace))) as unknown as { data: string }[];
  return rows.map((r) => JSON.parse(r.data));
}
export async function get<T>(
  table: Table,
  id: string,
  workspace: Workspace,
): Promise<T | null> {
  const row = (await database()
    .prepare(`SELECT * FROM ${table} WHERE id=? AND workspace=?`)
    .get(id, workspace)) as Stored | undefined;
  return row ? JSON.parse(row.data) : null;
}
export async function save<T extends { id: string }>(
  table: Table,
  workspace: Workspace,
  data: T,
  projectId: string | null = null,
): Promise<T> {
  if (table === "clients") {
    const client = data as unknown as Client;
    (await database()
      .prepare(
        "INSERT INTO clients(id,workspace,name_key,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,name_key=excluded.name_key WHERE clients.workspace=excluded.workspace",
      )
      .run(
        client.id,
        workspace,
        clientKey(client.name),
        JSON.stringify(client),
      ));
    return data;
  }
  if (table === "projects") {
    const project = data as unknown as Project;
    const client = project.clientId
      ? (await get<Client>("clients", project.clientId, workspace))
      : null;
    if (project.clientId && !client)
      throw new ApiError("Client introuvable.", 404);
    project.clientId = client?.id || null;
    project.client = client?.name || "";
    (await database()
      .prepare(
        "INSERT INTO projects(id,workspace,project_id,client_id,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,client_id=excluded.client_id WHERE projects.workspace=excluded.workspace",
      )
      .run(
        project.id,
        workspace,
        projectId,
        project.clientId,
        JSON.stringify(project),
      ));
    return data;
  }
  (await database()
    .prepare(
      `INSERT INTO ${table}(id,workspace,project_id,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE ${table}.workspace=excluded.workspace`,
    )
    .run(data.id, workspace, projectId, JSON.stringify(data)));
  return data;
}
export async function remove(table: Table, id: string, workspace: Workspace) {
  (await database()
    .prepare(`DELETE FROM ${table} WHERE id=? AND workspace=?`)
    .run(id, workspace));
}
export async function requireProject(id: string, workspace: Workspace): Promise<Project> {
  const p = (await get<Project>("projects", id, workspace));
  if (!p) throw new Error("Projet introuvable.");
  return p;
}
export async function createClient(
  workspace: Workspace,
  input: ReturnType<typeof clientSchema.parse>,
): Promise<Client> {
  if (
    (await list<Client>("clients", workspace)).some(
      (c) => clientKey(c.name) === clientKey(input.name),
    )
  )
    throw new ApiError(
      "Un client porte déjà ce nom. Sélectionnez sa fiche existante.",
      409,
    );
  const now = new Date().toISOString();
  const client = (await save<Client>("clients", workspace, {
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  }));
  (await log(workspace, "client.created", `Client « ${client.name} » ajouté.`));
  return client;
}
export async function updateClient(
  workspace: Workspace,
  id: string,
  input: Partial<ReturnType<typeof clientSchema.parse>>,
) {
  const current = (await get<Client>("clients", id, workspace));
  if (!current) throw new ApiError("Client introuvable.", 404);
  if (
    input.name &&
    (await list<Client>("clients", workspace)).some(
      (c) => c.id !== id && clientKey(c.name) === clientKey(input.name!),
    )
  )
    throw new ApiError("Un client porte déjà ce nom.", 409);
  const client = (await save<Client>("clients", workspace, {
    ...current,
    ...input,
    updatedAt: new Date().toISOString(),
  }));
  for (const project of (await list<Project>("projects", workspace)).filter(
    (p) => p.clientId === id,
  )) {
    (await save("projects", workspace, { ...project, client: client.name }));
  }
  (await log(workspace, "client.updated", `Fiche client « ${client.name} » modifiée.`));
  return client;
}
export async function resolveProjectClient(
  workspace: Workspace,
  input: { clientId?: string | null; client?: string },
): Promise<Pick<Project, "clientId" | "client">> {
  if (input.clientId) {
    const client = (await get<Client>("clients", input.clientId, workspace));
    if (!client) throw new ApiError("Client introuvable.", 404);
    return { clientId: client.id, client: client.name };
  }
  // Name-based CSV/JSON imports reuse the same client; interactive forms use its ID.
  if (input.client?.trim()) {
    const client =
      (await list<Client>("clients", workspace)).find(
        (c) => clientKey(c.name) === clientKey(input.client!),
      ) || (await createClient(workspace, clientSchema.parse({ name: input.client })));
    return { clientId: client.id, client: client.name };
  }
  return { clientId: null, client: "" };
}
export async function log(
  workspace: Workspace,
  action: string,
  detail: string,
  projectId: string | null = null,
) {
  const project = projectId
    ? (await get<Project>("projects", projectId, workspace))
    : null;
  if (project)
    (await save<Project>("projects", workspace, {
      ...project,
      updatedAt: new Date().toISOString(),
    }));
  (await save<Activity>(
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
  ));
}
export async function createProject(
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
): Promise<Project> {
  const { technology, provider, runtime, version, repository, ...fields } =
    input;
  const now = new Date().toISOString();
  const p = (await save<Project>("projects", workspace, {
    ...fields,
    ...(await resolveProjectClient(workspace, fields)),
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    reviewedAt: null,
  }));
  const env = (await save<Environment>(
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
  ));
  (await save<Service>(
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
  ));
  (await log(workspace, "project.created", "Projet ajouté à l’inventaire.", p.id));
  return p;
}
export async function workspaceData(workspace: Workspace): Promise<WorkspaceData> {
  return {
    clients: (await list<Client>("clients", workspace)).sort((a, b) =>
      a.name.localeCompare(b.name, "fr"),
    ),
    projects: (await list<Project>("projects", workspace)).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    ),
    services: (await list<Service>("services", workspace)),
    environments: (await list<Environment>("environments", workspace)),
    resources: (await list<Resource>("resources", workspace)),
    accesses: (await list<Access>("accesses", workspace)),
    inventories: (await list<Inventory>("inventories", workspace)).sort((a, b) =>
      b.collectedAt.localeCompare(a.collectedAt),
    ),
    activity: (await list<Activity>("activity", workspace))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100),
  };
}
export async function projectDetail(id: string, workspace: Workspace): Promise<ProjectDetail> {
  const project = (await requireProject(id, workspace));
  const inventories = (await list<Inventory>("inventories", workspace, id)).sort(
    (a, b) => b.collectedAt.localeCompare(a.collectedAt),
  );
  const latest = new Map<string, string>();
  for (const i of inventories)
    if (!latest.has(i.serviceId)) latest.set(i.serviceId, i.id);
  const latestIds = new Set(latest.values());
  return {
    project,
    services: (await list<Service>("services", workspace, id)),
    environments: (await list<Environment>("environments", workspace, id)),
    accesses: (await list<Access>("accesses", workspace, id)),
    resources: (await list<Resource>("resources", workspace)).filter((r) =>
      r.projectIds.includes(id),
    ),
    inventories,
    components: (await list<Component>("components", workspace, id)).filter((c) =>
      latestIds.has(c.inventoryId),
    ),
    activity: (await list<Activity>("activity", workspace, id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100),
  };
}
export async function saveInventory(
  workspace: Workspace,
  serviceId: string,
  source: Inventory["source"],
  filename: string,
  commitRef: string,
  components: ParsedComponent[],
) {
  const service = (await get<Service>("services", serviceId, workspace));
  if (!service) throw new Error("Service introuvable.");
  return (await transaction(async () => {
    const inventory = (await save<Inventory>(
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
    ));
    for (const component of components)
      (await save<Component>(
        "components",
        workspace,
        { ...component, id: randomUUID(), inventoryId: inventory.id },
        service.projectId,
      ));
    (await log(
      workspace,
      "inventory.imported",
      `${components.length} composants ${source === "manual" ? "déclarés" : "importés"} pour ${service.name}.`,
      service.projectId,
    ));
    return inventory;
  }));
}
