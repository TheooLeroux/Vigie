import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  database,
  list,
  get,
  save,
  transaction,
  log,
  createProject,
} from "./db";
import { createProjectSchema, accessSchema } from "./validation";
import { resolveProjectClient } from "./db";
import { ApiError } from "./http";
import { sealConnectorSecret, openConnectorSecret } from "./connector-secrets";
import { collectVercel } from "./connectors/vercel";
import type { Access, Project, Service, Environment, Client } from "./types";
import type {
  VercelConnection,
  VercelProject,
  VercelProjectView,
  VercelState,
} from "./vercel-types";
type ConnectionRow = {
  id: string;
  team_id: string;
  data: string;
  secret_cipher: string | null;
};
type ProjectRow = {
  connection_id: string;
  remote_id: string;
  project_id: string | null;
  link_method: VercelProjectView["linkMethod"];
  observed_at: string;
  missing_since: string | null;
  data: string;
};
async function storage() {
  const db = database();
  (await db.initialize(`CREATE TABLE IF NOT EXISTS vercel_connections(id TEXT PRIMARY KEY,team_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL,secret_cipher TEXT);
  CREATE TABLE IF NOT EXISTS vercel_projects(connection_id TEXT NOT NULL REFERENCES vercel_connections(id) ON DELETE CASCADE,remote_id TEXT NOT NULL,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,link_method TEXT,observed_at TEXT NOT NULL,missing_since TEXT,data TEXT NOT NULL,PRIMARY KEY(connection_id,remote_id));
  CREATE INDEX IF NOT EXISTS vercel_project_link ON vercel_projects(project_id);
  CREATE TABLE IF NOT EXISTS vercel_client_links(team_id TEXT NOT NULL,client_label TEXT NOT NULL,client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,PRIMARY KEY(team_id,client_label));
  CREATE TRIGGER IF NOT EXISTS vercel_link_insert BEFORE INSERT ON vercel_projects WHEN NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND workspace='live') BEGIN SELECT RAISE(ABORT,'Projet hors périmètre'); END;
  CREATE TRIGGER IF NOT EXISTS vercel_link_update BEFORE UPDATE OF project_id ON vercel_projects WHEN NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND workspace='live') BEGIN SELECT RAISE(ABORT,'Projet hors périmètre'); END;`));
  return db;
}
async function row(id: string) {
  const r = (await (await storage())
    .prepare("SELECT * FROM vercel_connections WHERE id=?")
    .get(id)) as ConnectionRow | undefined;
  if (!r) throw new ApiError("Connexion Vercel introuvable.", 404);
  return r;
}
function connection(r: ConnectionRow): VercelConnection {
  return {
    ...JSON.parse(r.data),
    id: r.id,
    teamId: r.team_id,
    configured: !!r.secret_cipher,
  };
}
const context = (r: { id: string; team_id: string }) =>
  `vigie:vercel:v1:${r.id}:${r.team_id}`;
export async function withVercelCredentials<T>(id: string, run: (token: string, teamId: string) => Promise<T>) {
  const stored = await row(id);
  if (!stored.secret_cipher) throw new ApiError("Jeton Vercel manquant.");
  return run(openConnectorSecret(stored.secret_cipher, context(stored)), stored.team_id);
}
const running = new Set<string>();
export async function vercelState(): Promise<VercelState> {
  const connections = (
    (await (await storage())
      .prepare("SELECT * FROM vercel_connections ORDER BY rowid")
      .all()) as ConnectionRow[]
  ).map(connection);
  const projects = (await Promise.all((
    (await (await storage())
      .prepare("SELECT * FROM vercel_projects ORDER BY rowid")
      .all()) as ProjectRow[]
  ).map(async (r) => {
    const c = connections.find((c) => c.id === r.connection_id)!,
      p = r.project_id ? (await get<Project>("projects", r.project_id, "live")) : null;
    const remote = JSON.parse(r.data) as VercelProject;
    return {
      ...remote,
      clientSuggestion: (await mappedClient(remote))?.name || remote.clientSuggestion,
      connectionId: r.connection_id,
      connectionName: c.name,
      configured: c.configured,
      connectionError: c.error,
      observedAt: r.observed_at,
      missingSince: r.missing_since,
      projectId: r.project_id,
      projectName: p?.name || null,
      clientName: p?.client || null,
      linkMethod: r.link_method,
    };
  })));
  return { connections, projects };
}
const inputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  teamId: z.string().regex(/^team_[a-zA-Z0-9]+$/),
  secret: z
    .string()
    .trim()
    .max(2000)
    .regex(/^[!-~]*$/)
    .optional(),
});
export async function saveVercelConnection(raw: unknown, id?: string) {
  const input = inputSchema.parse(raw),
    previous = id ? (await row(id)) : null;
  if (id && running.has(id))
    throw new ApiError("Attendez la fin de la synchronisation.", 409);
  if (previous && input.teamId !== previous.team_id)
    throw new ApiError("Ajoutez une autre connexion pour changer d’équipe.");
  if (!previous && !input.secret)
    throw new ApiError("Le jeton Vercel est obligatoire.");
  if (
    (await (await storage())
      .prepare("SELECT id FROM vercel_connections WHERE team_id=? AND id<>?")
      .get(input.teamId, id || ""))
  )
    throw new ApiError("Cette équipe Vercel est déjà connectée.", 409);
  const key = id || randomUUID(),
    c: VercelConnection = {
      ...(previous
        ? connection(previous)
        : { lastAttemptAt: null, lastSuccessAt: null, error: null }),
      id: key,
      name: input.name,
      teamId: input.teamId,
      configured: true,
    };
  if (input.secret) {
    c.error = null;
    c.lastAttemptAt = null;
  }
  const cipher = input.secret
    ? sealConnectorSecret(
        input.secret,
        context({ id: key, team_id: input.teamId }),
      )
    : previous!.secret_cipher;
  (await transaction(async () => {
    (await (await storage())
      .prepare(
        "INSERT INTO vercel_connections(id,team_id,data,secret_cipher) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,secret_cipher=excluded.secret_cipher",
      )
      .run(key, input.teamId, JSON.stringify(c), cipher));
    (await log(
      "live",
      previous ? "Connexion Vercel modifiée" : "Connexion Vercel ajoutée",
      input.name,
    ));
  }));
  return connection((await row(key)));
}
function host(value: string) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}
function explicitMatch(value: string, p: VercelProject) {
  try {
    const u = new URL(value);
    if (u.hostname !== "vercel.com" || u.username || u.password) return false;
    return (
      u.pathname.split("/").filter(Boolean).slice(0, 2).join("/") ===
      `${p.teamSlug}/${p.name}`
    );
  } catch {
    return false;
  }
}
export async function vercelMatches(remote: VercelProject) {
  const accesses = (await list<Access>("accesses", "live")),
    services = (await list<Service>("services", "live")),
    envs = (await list<Environment>("environments", "live")),
    domains = new Set(remote.domains.map((d) => d.name));
  const matches = (await list<Project>("projects", "live"))
    .filter((p) => p.lifecycle === "active")
    .map((p) => {
      const refs = accesses.filter(
        (a) => a.projectId === p.id && host(a.url) === "vercel.com",
      );
      if (refs.length)
        return {
          p,
          rank: refs.some((a) => explicitMatch(a.url, remote)) ? 2 : 0,
        };
      return {
        p,
        rank: [
          p.url,
          ...services.filter((s) => s.projectId === p.id).map((s) => s.url),
          ...envs.filter((e) => e.projectId === p.id).map((e) => e.url),
        ].some((url) => domains.has(host(url)))
          ? 1
          : 0,
      };
    })
    .filter((m) => m.rank > 0);
  const rank = Math.max(0, ...matches.map((m) => m.rank));
  return matches.filter((m) => m.rank === rank).map((m) => m.p);
}
export async function applyVercelSnapshot(
  id: string,
  projects: VercelProject[],
  observedAt = new Date().toISOString(),
) {
  const r = (await row(id));
  if (
    projects.some((p) => p.teamId !== r.team_id) ||
    new Set(projects.map((p) => p.id)).size !== projects.length
  )
    throw new ApiError("Périmètre Vercel incohérent.", 502);
  (await transaction(async () => {
    for (const p of projects) {
      const previous = (await (await storage())
          .prepare(
            "SELECT * FROM vercel_projects WHERE connection_id=? AND remote_id=?",
          )
          .get(id, p.id)) as ProjectRow | undefined,
        matches = previous?.project_id || p.excluded ? [] : (await vercelMatches(p)),
        linked =
          previous?.project_id || (matches.length === 1 ? matches[0].id : null),
        method = previous?.project_id
          ? previous.link_method
          : linked
            ? "automatic"
            : null;
      const old = previous
        ? (JSON.parse(previous.data) as VercelProject)
        : null;
      if (
        p.production?.analysis?.status === "unavailable" &&
        p.production.id === old?.production?.id &&
        old.production.analysis?.status === "observed"
      ) {
        p.production.analysis = {
          ...old.production.analysis,
          refreshFailed: true,
        };
      }
      (await (await storage())
        .prepare(
          "INSERT INTO vercel_projects(connection_id,remote_id,project_id,link_method,observed_at,missing_since,data) VALUES (?,?,?,?,?,NULL,?) ON CONFLICT(connection_id,remote_id) DO UPDATE SET project_id=excluded.project_id,link_method=excluded.link_method,observed_at=excluded.observed_at,missing_since=NULL,data=excluded.data",
        )
        .run(id, p.id, linked, method, observedAt, JSON.stringify(p)));
      if (linked && !previous?.project_id)
        (await log(
          "live",
          "Projet Vercel rattaché",
          `${p.name} · correspondance exacte`,
          linked,
        ));
    }
    for (const old of (await (await storage())
      .prepare("SELECT remote_id FROM vercel_projects WHERE connection_id=?")
      .all(id)) as { remote_id: string }[])
      if (!projects.some((p) => p.id === old.remote_id))
        (await (await storage())
          .prepare(
            "UPDATE vercel_projects SET missing_since=COALESCE(missing_since,?) WHERE connection_id=? AND remote_id=?",
          )
          .run(observedAt, id, old.remote_id));
    (await (await storage())
      .prepare("UPDATE vercel_connections SET data=? WHERE id=?")
      .run(
        JSON.stringify({
          ...connection(r),
          lastAttemptAt: observedAt,
          lastSuccessAt: observedAt,
          error: null,
        }),
        id,
      ));
    (await log(
      "live",
      "Vercel synchronisé",
      `${connection(r).name} · ${projects.length} projets découverts`,
    ));
  }));
  return vercelState();
}
export async function synchronizeVercel(
  id: string,
  transport: typeof fetch = fetch,
) {
  const r = (await row(id)),
    c = connection(r);
  if (!r.secret_cipher) throw new ApiError("Jeton Vercel manquant.");
  if (running.has(id))
    throw new ApiError("Une synchronisation Vercel est déjà en cours.", 409);
  if (c.lastAttemptAt && Date.now() - Date.parse(c.lastAttemptAt) < 30_000)
    throw new ApiError("Attendez 30 secondes entre deux relevés Vercel.", 429);
  running.add(id);
  (await (await storage())
    .prepare("UPDATE vercel_connections SET data=? WHERE id=?")
    .run(JSON.stringify({ ...c, lastAttemptAt: new Date().toISOString() }), id));
  try {
    return applyVercelSnapshot(
      id,
      await collectVercel(
        r.team_id,
        openConnectorSecret(r.secret_cipher, context(r)),
        transport,
      ),
    );
  } catch (e) {
    const message =
      e instanceof ApiError
        ? e.message
        : "Le relevé Vercel a échoué. Le dernier relevé est conservé.";
    (await (await storage())
      .prepare("UPDATE vercel_connections SET data=? WHERE id=?")
      .run(JSON.stringify({ ...connection((await row(id))), error: message }), id));
    throw new ApiError(message, e instanceof ApiError ? e.status : 502);
  } finally {
    running.delete(id);
  }
}
async function remoteRow(connectionId: string, remoteId: string) {
  (await row(connectionId));
  const r = (await (await storage())
    .prepare(
      "SELECT * FROM vercel_projects WHERE connection_id=? AND remote_id=?",
    )
    .get(connectionId, remoteId)) as ProjectRow | undefined;
  if (!r) throw new ApiError("Projet Vercel introuvable.", 404);
  return r;
}
async function mappedClient(remote: VercelProject) {
  if (!remote.clientSuggestion) return null;
  const link = (await (await storage())
    .prepare(
      "SELECT client_id FROM vercel_client_links WHERE team_id=? AND client_label=?",
    )
    .get(remote.teamId, remote.clientSuggestion)) as
    { client_id: string | null } | undefined;
  return link?.client_id
    ? (await get<Client>("clients", link.client_id, "live")) || null
    : null;
}
async function resolveMappedClient(remote: VercelProject) {
  if (!remote.clientSuggestion) return { clientId: null, client: "" };
  const existing = (await mappedClient(remote)),
    resolved = (await resolveProjectClient(
      "live",
      existing
        ? { clientId: existing.id }
        : { client: remote.clientSuggestion },
    ));
  (await (await storage())
    .prepare(
      "INSERT INTO vercel_client_links(team_id,client_label,client_id) VALUES(?,?,?) ON CONFLICT(team_id,client_label) DO UPDATE SET client_id=excluded.client_id",
    )
    .run(remote.teamId, remote.clientSuggestion, resolved.clientId));
  return resolved;
}
async function attachClient(p: Project, remote: VercelProject) {
  if (!p.clientId && remote.clientSuggestion)
    (await save("projects", "live", {
      ...p,
      ...(await resolveMappedClient(remote)),
    }));
}
async function addHostingAccess(p: Project, remote: VercelProject) {
  const url = `https://vercel.com/${remote.teamSlug}/${remote.name}`;
  if (!(await list<Access>("accesses", "live", p.id)).some((a) => a.url === url))
    (await save<Access>(
      "accesses",
      "live",
      {
        ...accessSchema.parse({ label: "Vercel", kind: "hosting", url }),
        id: randomUUID(),
        projectId: p.id,
      },
      p.id,
    ));
}
export async function createVercelProject(connectionId: string, remoteId: string) {
  return (await transaction(async () => {
    const r = (await remoteRow(connectionId, remoteId)),
      remote = JSON.parse(r.data) as VercelProject;
    if (remote.excluded)
      throw new ApiError(
        "Ce projet est exclu du suivi selon votre consigne.",
        409,
      );
    if (r.project_id) return { projectId: r.project_id };
    if (r.missing_since)
      throw new ApiError(
        "Ce projet n’est plus présent dans le dernier relevé.",
      );
    const matches = (await vercelMatches(remote));
    if (matches.length > 1)
      throw new ApiError(
        "Plusieurs fiches correspondent. Choisissez la fiche à rattacher.",
        409,
      );
    const domain =
      remote.domains.find(
        (d) =>
          d.environment === "production" &&
          d.verified &&
          !d.redirect &&
          !d.name.endsWith(".vercel.app"),
      ) ||
      remote.domains.find(
        (d) => d.environment === "production" && d.verified && !d.redirect,
      );
    const p =
      matches[0] ||
      (await createProject(
        "live",
        createProjectSchema.parse({
          name: remote.name,
          url: domain ? `https://${domain.name}` : remote.production?.url || "",
          provider: "Vercel",
          technology: remote.production?.framework || remote.framework || "",
          repository: remote.repository
            ? `https://github.com/${remote.repository}`
            : "",
          ...(await resolveMappedClient(remote)),
        }),
      ));
    (await attachClient(p, remote));
    (await addHostingAccess(p, remote));
    (await (await storage())
      .prepare(
        "UPDATE vercel_projects SET project_id=?,link_method=? WHERE connection_id=? AND remote_id=?",
      )
      .run(
        p.id,
        matches.length ? "automatic" : "created",
        connectionId,
        remoteId,
      ));
    (await log("live", "Projet Vercel ajouté au parc", remote.name, p.id));
    return { projectId: p.id };
  }));
}
export async function linkVercelProject(
  connectionId: string,
  remoteId: string,
  projectId: string,
) {
  return (await transaction(async () => {
    const r = (await remoteRow(connectionId, remoteId)),
      remote = JSON.parse(r.data) as VercelProject;
    if (remote.excluded)
      throw new ApiError(
        "Ce projet est exclu du suivi selon votre consigne.",
        409,
      );
    const p = (await get<Project>("projects", projectId, "live"));
    if (!p || p.lifecycle !== "active")
      throw new ApiError("Projet actif introuvable.", 404);
    (await attachClient(p, remote));
    (await addHostingAccess(p, remote));
    (await (await storage())
      .prepare(
        "UPDATE vercel_projects SET project_id=?,link_method='manual' WHERE connection_id=? AND remote_id=?",
      )
      .run(p.id, connectionId, remoteId));
    (await log("live", "Projet Vercel rattaché manuellement", remote.name, p.id));
    return vercelState();
  }));
}
export async function disconnectVercel(id: string) {
  if (running.has(id))
    throw new ApiError("Attendez la fin de la synchronisation.", 409);
  const r = (await row(id));
  (await transaction(async () => {
    (await (await storage())
      .prepare("UPDATE vercel_connections SET secret_cipher=NULL WHERE id=?")
      .run(id));
    (await log("live", "Jeton Vercel retiré de Vigie", connection(r).name));
  }));
  return vercelState();
}
