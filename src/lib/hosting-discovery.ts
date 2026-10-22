import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hostingStorage } from "./hosting-storage";
import { createProject, get, list, log, save, transaction } from "./db";
import { createProjectSchema, accessSchema } from "./validation";
import { ApiError } from "./http";
import {
  canonicalHostname,
  isAddableInstallation,
  normalizeDocumentRoot,
  type DiscoveryResult,
} from "./connectors/o2switch-discovery";
import type {
  Project,
  Service,
  Environment,
  Access,
  HostingConnection,
  HostingDiscovery,
  HostingInstallation,
  HostingInstallationView,
} from "./types";
type Row = {
  id: string;
  connection_id: string;
  scope: string;
  document_root: string;
  project_id: string | null;
  link_method: HostingInstallationView["linkMethod"];
  match_reason: string | null;
  data: string;
};
type ConnectionIdentity = Pick<
  HostingConnection,
  "id" | "name" | "endpoint" | "username"
>;
type Run = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
};
function scope(connection: ConnectionIdentity) {
  return `${connection.endpoint}|${connection.username}`;
}
function connection(id: string): ConnectionIdentity {
  const row = hostingStorage()
    .prepare(
      "SELECT data FROM hosting_connections WHERE workspace='live' AND id=?",
    )
    .get(id) as { data: string } | undefined;
  if (!row) throw new ApiError("Connexion introuvable.", 404);
  return JSON.parse(row.data);
}
function rows(connectionId?: string): Row[] {
  return hostingStorage()
    .prepare(
      `SELECT i.* FROM hosting_installations i JOIN hosting_connections c ON c.id=i.connection_id WHERE i.workspace='live' AND i.scope=json_extract(c.data,'$.endpoint')||'|'||json_extract(c.data,'$.username') ${connectionId ? "AND i.connection_id=?" : ""}`,
    )
    .all(...(connectionId ? [connectionId] : [])) as Row[];
}
function requireInstallation(id: string): Row {
  const row = rows().find((r) => r.id === id);
  if (!row) throw new ApiError("Installation introuvable.", 404);
  return row;
}
export function hostingInstallation(id: string): HostingInstallationView {
  const row = requireInstallation(id);
  return view(row, connection(row.connection_id), projectData());
}
function projectData() {
  return {
    projects: list<Project>("projects", "live"),
    services: list<Service>("services", "live"),
    environments: list<Environment>("environments", "live"),
    accesses: list<Access>("accesses", "live"),
  };
}
export function findInstallationMatches(
  installation: Pick<
    HostingInstallation,
    "documentRoot" | "domains" | "aliases"
  >,
  host: ConnectionIdentity,
  data: ReturnType<typeof projectData>,
) {
  const names = new Set(
    [...installation.domains, ...installation.aliases].map((name) =>
      name
        .toLowerCase()
        .replace(/^www\./, "")
        .replace(/\.$/, ""),
    ),
  );
  return data.projects.flatMap((project) => {
    const urls = [
      project.url,
      ...data.services
        .filter((s) => s.projectId === project.id)
        .map((s) => s.url),
      ...data.environments
        .filter((e) => e.projectId === project.id)
        .map((e) => e.url),
    ];
    const domainMatch = urls.some((url) => {
      const name = canonicalHostname(url);
      return name && names.has(name);
    });
    const documentedRoot = project.description
      .match(/^Répertoire\s*:\s*(.+)$/im)?.[1]
      ?.trim();
    const accountMatch = data.accesses.some(
      (a) =>
        a.projectId === project.id &&
        a.kind === "hosting" &&
        a.account === host.username &&
        (() => {
          try {
            return new URL(a.url).origin === host.endpoint;
          } catch {
            return false;
          }
        })(),
    );
    const pathMatch = Boolean(
      documentedRoot &&
      accountMatch &&
      normalizeDocumentRoot(documentedRoot) === installation.documentRoot,
    );
    return domainMatch || pathMatch
      ? [
          {
            id: project.id,
            name: project.name,
            lifecycle: project.lifecycle,
            reason:
              domainMatch && pathMatch
                ? "Même domaine et même répertoire"
                : domainMatch
                  ? "Même domaine"
                  : "Même répertoire sur ce compte",
          },
        ]
      : [];
  });
}
function view(
  row: Row,
  host: ConnectionIdentity,
  data: ReturnType<typeof projectData>,
): HostingInstallationView {
  const item = JSON.parse(row.data) as HostingInstallation;
  const project = data.projects.find((p) => p.id === row.project_id);
  const inventory = hostingStorage()
    .prepare(
      "SELECT data FROM hosting_site_inventories WHERE installation_id=?",
    )
    .get(row.id) as { data: string } | undefined;
  const observer = hostingStorage()
    .prepare("SELECT data FROM hosting_observers WHERE installation_id=?")
    .get(row.id) as { data: string } | undefined;
  return {
    ...item,
    inventory: inventory ? JSON.parse(inventory.data) : null,
    observerConfigured: Boolean(
      observer && JSON.parse(observer.data).status === "installed",
    ),
    project: project
      ? { id: project.id, name: project.name, lifecycle: project.lifecycle }
      : null,
    linkMethod: row.link_method,
    candidates: findInstallationMatches(item, host, data),
  };
}
export function hostingDiscovery(connectionId: string): HostingDiscovery {
  const host = connection(connectionId),
    data = projectData();
  const record = hostingStorage()
    .prepare(
      "SELECT data FROM hosting_discovery_runs WHERE connection_id=? AND scope=?",
    )
    .get(host.id, scope(host)) as { data: string } | undefined;
  const run: Run = record
    ? JSON.parse(record.data)
    : { lastAttemptAt: null, lastSuccessAt: null, error: null };
  const installations = rows(connectionId)
    .map((row) => view(row, host, data))
    .sort((a, b) =>
      (a.domains[0] || a.documentRoot).localeCompare(
        b.domains[0] || b.documentRoot,
        "fr",
      ),
    );
  const summary = {
    linked: 0,
    new: 0,
    review: 0,
    other: 0,
    ignored: 0,
    missing: 0,
  };
  for (const item of installations) {
    if (item.missingSince) summary.missing++;
    else if (item.ignored) summary.ignored++;
    else if (item.project) summary.linked++;
    else if (
      item.inspectionError ||
      item.kind === "wordpress-incomplete" ||
      item.candidates.length
    )
      summary.review++;
    else if (isAddableInstallation(item.kind)) summary.new++;
    else summary.other++;
  }
  return { connectionId, ...run, installations, summary };
}
export function projectHostingInstallations(projectId: string) {
  const data = projectData();
  return rows()
    .filter((row) => row.project_id === projectId)
    .map((row) => ({
      ...view(row, connection(row.connection_id), data),
      connectionName: connection(row.connection_id).name,
    }));
}
function saveRow(row: Row, item: HostingInstallation) {
  hostingStorage()
    .prepare("UPDATE hosting_installations SET data=? WHERE id=?")
    .run(JSON.stringify(item), row.id);
}
function addHostingAccess(projectId: string, host: ConnectionIdentity) {
  if (
    list<Access>("accesses", "live", projectId).some(
      (a) => a.kind === "hosting" && a.url.replace(/\/$/, "") === host.endpoint,
    )
  )
    return;
  const input = accessSchema.parse({
    label: `cPanel · ${host.name}`,
    kind: "hosting",
    url: host.endpoint,
    account: host.username,
    notes:
      "Compte associé par la découverte o2switch. Le secret est conservé dans la connexion, côté serveur.",
  });
  save<Access>(
    "accesses",
    "live",
    { ...input, id: randomUUID(), projectId },
    projectId,
  );
}
function link(
  row: Row,
  projectId: string,
  method: NonNullable<Row["link_method"]>,
  reason: string,
) {
  const project = get<Project>("projects", projectId, "live");
  if (!project) throw new ApiError("Projet introuvable.", 404);
  if (row.project_id === projectId && row.link_method === method) return;
  hostingStorage()
    .prepare(
      "UPDATE hosting_installations SET project_id=?,link_method=?,match_reason=? WHERE id=?",
    )
    .run(projectId, method, reason, row.id);
  const item = JSON.parse(row.data) as HostingInstallation;
  addHostingAccess(projectId, connection(row.connection_id));
  log(
    "live",
    "hosting.linked",
    `Installation ${item.domains[0] || item.documentRoot} rattachée ${method === "automatic" ? "automatiquement " : ""}à la fiche (${reason.toLowerCase()}).`,
    projectId,
  );
}
// Caller commits the connection verification and this snapshot in the same transaction.
export function applyDiscoverySnapshot(
  host: ConnectionIdentity,
  result: DiscoveryResult,
) {
  const db = hostingStorage(),
    before = rows(host.id),
    seen = new Set<string>();
  for (const incoming of result.installations) {
    const previous = before.find(
      (row) =>
        row.scope === scope(host) &&
        row.document_root === incoming.documentRoot,
    );
    const old = previous
      ? (JSON.parse(previous.data) as HostingInstallation)
      : null;
    const item: HostingInstallation = {
      ...incoming,
      id: previous?.id || randomUUID(),
      connectionId: host.id,
      firstSeenAt: old?.firstSeenAt || result.observedAt,
      lastSeenAt: result.observedAt,
      missingSince: null,
      ignored: old?.ignored || false,
      observedAt: incoming.inspectionError
        ? old?.observedAt || null
        : result.observedAt,
    };
    if (incoming.inspectionError && old) {
      item.kind = old.kind;
      item.version = old.version;
    }
    db.prepare(
      "INSERT INTO hosting_installations(id,workspace,connection_id,scope,document_root,data) VALUES (?,'live',?,?,?,?) ON CONFLICT(connection_id,scope,document_root) DO UPDATE SET data=excluded.data",
    ).run(
      item.id,
      host.id,
      scope(host),
      item.documentRoot,
      JSON.stringify(item),
    );
    seen.add(item.id);
  }
  for (const row of before)
    if (!seen.has(row.id)) {
      const item = JSON.parse(row.data) as HostingInstallation;
      saveRow(row, {
        ...item,
        missingSince: item.missingSince || result.observedAt,
      });
    }
  const data = projectData();
  for (const row of rows(host.id)) {
    const item = JSON.parse(row.data) as HostingInstallation;
    if (
      row.project_id ||
      item.ignored ||
      item.missingSince ||
      item.inspectionError ||
      !isAddableInstallation(item.kind)
    )
      continue;
    const candidates = findInstallationMatches(item, host, data);
    if (candidates.length === 1 && candidates[0].lifecycle === "active")
      link(row, candidates[0].id, "automatic", candidates[0].reason);
  }
  const run: Run = {
    lastAttemptAt: result.observedAt,
    lastSuccessAt: result.observedAt,
    error: null,
  };
  db.prepare(
    "INSERT INTO hosting_discovery_runs VALUES (?,?,?) ON CONFLICT(connection_id,scope) DO UPDATE SET data=excluded.data",
  ).run(host.id, scope(host), JSON.stringify(run));
  log(
    "live",
    "hosting.discovered",
    `${result.installations.length} racines inspectées sur « ${host.name} » ; rapprochement des fiches terminé.`,
  );
}
export function recordDiscoveryFailure(
  host: ConnectionIdentity,
  message: string,
) {
  const record = hostingStorage()
    .prepare(
      "SELECT data FROM hosting_discovery_runs WHERE connection_id=? AND scope=?",
    )
    .get(host.id, scope(host)) as { data: string } | undefined;
  const previous = record ? (JSON.parse(record.data) as Run) : null;
  hostingStorage()
    .prepare(
      "INSERT INTO hosting_discovery_runs VALUES (?,?,?) ON CONFLICT(connection_id,scope) DO UPDATE SET data=excluded.data",
    )
    .run(
      host.id,
      scope(host),
      JSON.stringify({
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: previous?.lastSuccessAt || null,
        error: message,
      }),
    );
}
export const installationLinkSchema = z.object({
  projectId: z.string().min(1),
});
export function linkHostingInstallation(id: string, raw: unknown) {
  const input = installationLinkSchema.parse(raw);
  return transaction(() => {
    const row = requireInstallation(id);
    const item = JSON.parse(row.data) as HostingInstallation;
    if (item.missingSince)
      throw new ApiError(
        "Cette installation n’a pas été retrouvée lors du dernier relevé.",
      );
    link(row, input.projectId, "manual", "Rattachement choisi dans le plateau");
    if (item.ignored) saveRow(row, { ...item, ignored: false });
    return hostingDiscovery(row.connection_id);
  });
}
export function ignoreHostingInstallation(id: string, raw: unknown) {
  const input = z.object({ ignored: z.boolean() }).parse(raw);
  return transaction(() => {
    const row = requireInstallation(id),
      item = JSON.parse(row.data) as HostingInstallation;
    if (row.project_id)
      throw new ApiError(
        "Une installation déjà rattachée reste visible dans sa fiche.",
      );
    saveRow(row, { ...item, ignored: input.ignored });
    log(
      "live",
      "hosting.visibility",
      `Installation ${item.domains[0] || item.documentRoot} ${input.ignored ? "masquée" : "réaffichée"}.`,
    );
    return hostingDiscovery(row.connection_id);
  });
}
export function createProjectFromInstallation(id: string) {
  return transaction(() => {
    const row = requireInstallation(id),
      host = connection(row.connection_id),
      item = JSON.parse(row.data) as HostingInstallation;
    if (row.project_id)
      return {
        projectId: row.project_id,
        created: false,
        discovery: hostingDiscovery(row.connection_id),
      };
    if (
      item.missingSince ||
      item.inspectionError ||
      !isAddableInstallation(item.kind)
    )
      throw new ApiError(
        "Cette installation doit être vérifiée avant son ajout.",
      );
    if (findInstallationMatches(item, host, projectData()).length)
      throw new ApiError(
        "Une fiche correspond déjà à cette installation. Rattachez-la à cette fiche pour éviter un doublon.",
        409,
      );
    const name = item.domains[0];
    if (!name)
      throw new ApiError("Aucun domaine utilisable pour créer la fiche.");
    const technology = (
      {
        wordpress: "WordPress",
        dolibarr: "Dolibarr",
        "next-static": "Next.js (export statique)",
        static: "HTML / CSS",
        php: "PHP",
      } as Record<string, string>
    )[item.kind];
    const project = createProject(
      "live",
      createProjectSchema.parse({
        name,
        url: `https://${name}/`,
        technology,
        provider: "o2switch",
      }),
    );
    if (item.suggestedEnvironment === "staging")
      for (const environment of list<Environment>(
        "environments",
        "live",
        project.id,
      ))
        save(
          "environments",
          "live",
          { ...environment, name: "Préproduction", kind: "staging" },
          project.id,
        );
    link(
      requireInstallation(id),
      project.id,
      "created",
      "Fiche créée depuis la découverte o2switch",
    );
    if (item.ignored)
      saveRow(requireInstallation(id), { ...item, ignored: false });
    return {
      projectId: project.id,
      created: true,
      discovery: hostingDiscovery(row.connection_id),
    };
  });
}
