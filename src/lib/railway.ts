import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database, list, get, transaction, log, createProject } from "./db";
import { ApiError } from "./http";
import { sealConnectorSecret, openConnectorSecret } from "./connector-secrets";
import { collectRailway } from "./connectors/railway";
import { createProjectSchema } from "./validation";
import type { Access, Project, Service, Environment } from "./types";
import type {
  RailwayConnection,
  RailwayProject,
  RailwayProjectView,
  RailwayState,
} from "./railway-types";
type ConnectionRow = {
  id: string;
  workspace_id: string;
  data: string;
  secret_cipher: string | null;
};
type ProjectRow = {
  connection_id: string;
  remote_id: string;
  project_id: string | null;
  link_method: RailwayProjectView["linkMethod"];
  observed_at: string;
  missing_since: string | null;
  data: string;
};
async function storage() {
  const db = database();
  (await db.initialize(`CREATE TABLE IF NOT EXISTS railway_connections(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL,secret_cipher TEXT);
    CREATE TABLE IF NOT EXISTS railway_projects(connection_id TEXT NOT NULL REFERENCES railway_connections(id) ON DELETE CASCADE,remote_id TEXT NOT NULL,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,workspace TEXT NOT NULL DEFAULT 'live' CHECK(workspace='live'),link_method TEXT,observed_at TEXT NOT NULL,missing_since TEXT,data TEXT NOT NULL,PRIMARY KEY(connection_id,remote_id));
    CREATE TRIGGER IF NOT EXISTS railway_link_insert BEFORE INSERT ON railway_projects WHEN NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND workspace='live') BEGIN SELECT RAISE(ABORT,'Projet hors périmètre'); END;
    CREATE TRIGGER IF NOT EXISTS railway_link_update BEFORE UPDATE OF project_id ON railway_projects WHEN NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND workspace='live') BEGIN SELECT RAISE(ABORT,'Projet hors périmètre'); END;
    CREATE INDEX IF NOT EXISTS railway_project_link ON railway_projects(project_id);`));
  return db;
}
const inputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  workspaceId: z.string().uuid(),
  secret: z
    .string()
    .trim()
    .max(2000)
    .regex(/^[!-~]*$/)
    .optional(),
});
async function row(id: string) {
  const value = (await (await storage())
    .prepare("SELECT * FROM railway_connections WHERE id=?")
    .get(id)) as ConnectionRow | undefined;
  if (!value) throw new ApiError("Connexion Railway introuvable.", 404);
  return value;
}
function publicConnection(r: ConnectionRow): RailwayConnection {
  return {
    ...JSON.parse(r.data),
    id: r.id,
    workspaceId: r.workspace_id,
    configured: !!r.secret_cipher,
  };
}
const context = (r: { id: string; workspace_id: string }) =>
  `vigie:railway:v1:${r.id}:${r.workspace_id}`;
export async function withRailwayCredentials<T>(id: string, run: (token: string, workspaceId: string) => Promise<T>) {
  const stored = await row(id);
  if (!stored.secret_cipher) throw new ApiError("Jeton Railway manquant.");
  return run(openConnectorSecret(stored.secret_cipher, context(stored)), stored.workspace_id);
}
export async function railwayState(): Promise<RailwayState> {
  const connections = (
    (await (await storage())
      .prepare("SELECT * FROM railway_connections ORDER BY rowid")
      .all()) as ConnectionRow[]
  ).map(publicConnection);
  const names = new Map(connections.map((c) => [c.id, c.name]));
  const projects = (await Promise.all((
    (await (await storage())
      .prepare("SELECT * FROM railway_projects ORDER BY rowid")
      .all()) as ProjectRow[]
  ).map(async (r) => ({
    ...(JSON.parse(r.data) as RailwayProject),
    connectionId: r.connection_id,
    connectionName: names.get(r.connection_id) || "Railway",
    observedAt: r.observed_at,
    missingSince: r.missing_since,
    projectId: r.project_id,
    connectionError:
      connections.find((c) => c.id === r.connection_id)?.error || null,
    configured:
      connections.find((c) => c.id === r.connection_id)?.configured || false,
    projectName: r.project_id
      ? (await get<Project>("projects", r.project_id, "live"))?.name || null
      : null,
    linkMethod: r.link_method,
  }))));
  return { connections, projects };
}
export async function saveRailwayConnection(raw: unknown, existingId?: string) {
  const input = inputSchema.parse(raw),
    previous = existingId ? (await row(existingId)) : null;
  if (existingId && running.has(existingId))
    throw new ApiError("Attendez la fin de la synchronisation.", 409);
  if (previous && previous.workspace_id !== input.workspaceId)
    throw new ApiError(
      "Pour changer de workspace, ajoutez une autre connexion.",
    );
  if (!previous && !input.secret)
    throw new ApiError("Le jeton Railway est obligatoire.");
  const duplicate = (await (await storage())
    .prepare(
      "SELECT id FROM railway_connections WHERE workspace_id=? AND id<>?",
    )
    .get(input.workspaceId, existingId || ""));
  if (duplicate)
    throw new ApiError("Ce workspace Railway est déjà connecté.", 409);
  const id = existingId || randomUUID(),
    changed = !!input.secret;
  const c: RailwayConnection = {
    ...(previous
      ? publicConnection(previous)
      : { lastAttemptAt: null, lastSuccessAt: null, error: null }),
    id,
    name: input.name,
    workspaceId: input.workspaceId,
    configured: true,
  };
  if (changed) {
    c.error = null;
    c.lastAttemptAt = null;
  }
  const cipher = changed
    ? sealConnectorSecret(
        input.secret!,
        context({ id, workspace_id: input.workspaceId }),
      )
    : previous!.secret_cipher;
  (await transaction(async () => {
    (await (await storage())
      .prepare(
        "INSERT INTO railway_connections(id,workspace_id,data,secret_cipher) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,secret_cipher=excluded.secret_cipher",
      )
      .run(id, input.workspaceId, JSON.stringify(c), cipher));
    (await log(
      "live",
      previous ? "Connexion Railway modifiée" : "Connexion Railway ajoutée",
      input.name,
    ));
  }));
  return publicConnection((await row(id)));
}
function railwayId(value: string) {
  try {
    const u = new URL(value);
    return /^(www\.)?railway\.(app|com)$/.test(u.hostname)
      ? u.pathname
          .match(/^\/project\/([a-f0-9-]{36})(?:\/|$)/i)?.[1]
          ?.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}
function host(value: string) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}
export async function railwayMatches(remote: RailwayProject) {
  const accesses = (await list<Access>("accesses", "live")),
    services = (await list<Service>("services", "live")),
    environments = (await list<Environment>("environments", "live"));
  const domains = new Set(remote.services.flatMap((s) => s.domains));
  const matches = (await list<Project>("projects", "live"))
    .filter((p) => p.lifecycle === "active")
    .map((p) => {
      const explicit = accesses
        .filter((a) => a.projectId === p.id)
        .map((a) => railwayId(a.url))
        .filter(Boolean);
      if (explicit.length)
        return { p, rank: explicit.includes(remote.id) ? 2 : 0 };
      const urls = [
        p.url,
        ...services.filter((s) => s.projectId === p.id).map((s) => s.url),
        ...environments.filter((e) => e.projectId === p.id).map((e) => e.url),
      ];
      return { p, rank: urls.some((u) => domains.has(host(u))) ? 1 : 0 };
    })
    .filter((m) => m.rank > 0);
  const top = Math.max(0, ...matches.map((m) => m.rank));
  return matches.filter((m) => m.rank === top).map((m) => m.p);
}
export async function applyRailwaySnapshot(
  connectionId: string,
  projects: RailwayProject[],
  observedAt = new Date().toISOString(),
) {
  const connection = (await row(connectionId));
  if (
    new Set(projects.map((p) => p.id)).size !== projects.length ||
    projects.some((p) => p.workspaceId !== connection.workspace_id)
  )
    throw new ApiError("Périmètre Railway incohérent.", 502);
  (await transaction(async () => {
    for (const remote of projects) {
      const previous = (await (await storage())
        .prepare(
          "SELECT * FROM railway_projects WHERE connection_id=? AND remote_id=?",
        )
        .get(connectionId, remote.id)) as ProjectRow | undefined;
      const matches = previous?.project_id ? [] : (await railwayMatches(remote));
      const linked =
        previous?.project_id || (matches.length === 1 ? matches[0].id : null);
      const method = previous?.link_method || (linked ? "automatic" : null);
      (await (await storage())
        .prepare(
          "INSERT INTO railway_projects(connection_id,remote_id,project_id,link_method,observed_at,missing_since,data) VALUES (?,?,?,?,?,NULL,?) ON CONFLICT(connection_id,remote_id) DO UPDATE SET project_id=excluded.project_id,link_method=excluded.link_method,observed_at=excluded.observed_at,missing_since=NULL,data=excluded.data",
        )
        .run(
          connectionId,
          remote.id,
          linked,
          method,
          observedAt,
          JSON.stringify(remote),
        ));
      if (linked && !previous?.project_id)
        (await log(
          "live",
          "Projet Railway rattaché",
          `${remote.name} · correspondance exacte`,
          linked,
        ));
    }
    for (const previous of (await (await storage())
      .prepare("SELECT remote_id FROM railway_projects WHERE connection_id=?")
      .all(connectionId)) as { remote_id: string }[]) {
      if (!projects.some((p) => p.id === previous.remote_id))
        (await (await storage())
          .prepare(
            "UPDATE railway_projects SET missing_since=COALESCE(missing_since,?) WHERE connection_id=? AND remote_id=?",
          )
          .run(observedAt, connectionId, previous.remote_id));
    }
    const value = {
      ...publicConnection(connection),
      lastAttemptAt: observedAt,
      lastSuccessAt: observedAt,
      error: null,
    };
    (await (await storage())
      .prepare("UPDATE railway_connections SET data=? WHERE id=?")
      .run(JSON.stringify(value), connectionId));
    (await log(
      "live",
      "Railway synchronisé",
      `${value.name} · ${projects.length} projets`,
    ));
  }));
  return railwayState();
}
const running = new Set<string>();
export async function synchronizeRailway(
  id: string,
  transport: typeof fetch = fetch,
) {
  const r = (await row(id));
  if (!r.secret_cipher) throw new ApiError("Jeton Railway manquant.");
  if (running.has(id))
    throw new ApiError("Une synchronisation Railway est déjà en cours.", 409);
  const c = publicConnection(r);
  if (c.lastAttemptAt && Date.now() - Date.parse(c.lastAttemptAt) < 30_000)
    throw new ApiError("Attendez 30 secondes entre deux relevés Railway.", 429);
  running.add(id);
  (await (await storage())
    .prepare("UPDATE railway_connections SET data=? WHERE id=?")
    .run(JSON.stringify({ ...c, lastAttemptAt: new Date().toISOString() }), id));
  try {
    return applyRailwaySnapshot(
      id,
      await collectRailway(
        r.workspace_id,
        openConnectorSecret(r.secret_cipher, context(r)),
        transport,
      ),
    );
  } catch (e) {
    const message =
      e instanceof ApiError
        ? e.message
        : "Le relevé Railway a échoué. Le dernier relevé est conservé.";
    (await (await storage())
      .prepare("UPDATE railway_connections SET data=? WHERE id=?")
      .run(
        JSON.stringify({ ...publicConnection((await row(id))), error: message }),
        id,
      ));
    throw new ApiError(message, e instanceof ApiError ? e.status : 502);
  } finally {
    running.delete(id);
  }
}
async function remoteRow(connectionId: string, remoteId: string) {
  (await row(connectionId));
  const r = (await (await storage())
    .prepare(
      "SELECT * FROM railway_projects WHERE connection_id=? AND remote_id=?",
    )
    .get(connectionId, remoteId)) as ProjectRow | undefined;
  if (!r) throw new ApiError("Projet Railway introuvable.", 404);
  return r;
}
export async function linkRailwayProject(
  connectionId: string,
  remoteId: string,
  projectId: string,
) {
  (await remoteRow(connectionId, remoteId));
  const p = (await get<Project>("projects", projectId, "live"));
  if (!p || p.lifecycle !== "active")
    throw new ApiError("Projet actif introuvable.", 404);
  (await transaction(async () => {
    (await (await storage())
      .prepare(
        "UPDATE railway_projects SET project_id=?,link_method='manual' WHERE connection_id=? AND remote_id=?",
      )
      .run(projectId, connectionId, remoteId));
    (await log("live", "Projet Railway rattaché manuellement", remoteId, projectId));
  }));
  return railwayState();
}
export async function createRailwayProject(connectionId: string, remoteId: string) {
  return (await transaction(async () => {
    const r = (await remoteRow(connectionId, remoteId));
    if (r.project_id) return { projectId: r.project_id };
    if (r.missing_since)
      throw new ApiError(
        "Ce projet n’est plus présent dans le dernier relevé.",
      );
    const remote = JSON.parse(r.data) as RailwayProject;
    const domains = [...new Set(remote.services.flatMap((s) => s.domains))];
    const p = (await createProject(
      "live",
      createProjectSchema.parse({
        name: remote.name,
        url: domains.length === 1 ? `https://${domains[0]}` : "",
        provider: "Railway",
      }),
    ));
    (await (await storage())
      .prepare(
        "UPDATE railway_projects SET project_id=?,link_method='created' WHERE connection_id=? AND remote_id=?",
      )
      .run(p.id, connectionId, remoteId));
    return { projectId: p.id };
  }));
}
export async function disconnectRailway(id: string) {
  if (running.has(id))
    throw new ApiError("Attendez la fin de la synchronisation.", 409);
  const r = (await row(id));
  (await (await storage())
    .prepare("UPDATE railway_connections SET secret_cipher=NULL WHERE id=?")
    .run(id));
  (await log("live", "Jeton Railway retiré de Vigie", publicConnection(r).name));
  return railwayState();
}
