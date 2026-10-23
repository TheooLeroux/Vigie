import { randomUUID } from "node:crypto";
import { maintenanceState, inspectMaintenance, packageRelease, createMaintenancePlan, updateLatestMaintenance, approveMaintenance, refreshMaintenance, mergeMaintenance, closeMaintenance } from "@/lib/maintenance";
import {
  vercelState,
  saveVercelConnection,
  synchronizeVercel,
  createVercelProject,
  linkVercelProject,
  disconnectVercel,
} from "@/lib/vercel";
import {
  railwayState,
  saveRailwayConnection,
  synchronizeRailway,
  linkRailwayProject,
  createRailwayProject,
  disconnectRailway,
} from "@/lib/railway";
import { requireSession } from "@/lib/auth";
import {
  hostingConnections,
  saveHostingConnection,
  testHostingConnection,
  disconnectHostingConnection,
  discoverHostingConnection,
} from "@/lib/hosting-connections";
import {
  hostingDiscovery,
  projectHostingInstallations,
  linkHostingInstallation,
  createProjectFromInstallation,
  ignoreHostingInstallation,
} from "@/lib/hosting-discovery";
import { withAuditActor } from "@/lib/audit-context";
import {
  collectHostingInventories,
  observerPlan,
  installObserver,
  provisionLinkedObserver,
  provisionLinkedObservers,
} from "@/lib/hosting-inventory";
import { hostingInstallation } from "@/lib/hosting-discovery";
import { z } from "zod";
import {
  database,
  get,
  list,
  save,
  remove,
  transaction,
  createProject,
  requireProject,
  workspaceData,
  projectDetail,
  saveInventory,
  log,
  createClient,
  updateClient,
  resolveProjectClient,
} from "@/lib/db";
import {
  projectSchema,
  clientSchema,
  createProjectSchema,
  environmentSchema,
  serviceSchema,
  accessSchema,
  resourceSchema,
  inventorySchema,
  manualInventorySchema,
} from "@/lib/validation";
import { parseLockfile, parseCsv, escapeCsv } from "@/lib/inventory";
import { assertLocal, body, ApiError, errorResponse } from "@/lib/http";
import type {
  Workspace,
  Project,
  Service,
  Environment,
  Access,
  Resource,
  Inventory,
  Component,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Context = { params: Promise<{ path: string[] }> };

function parseImport(data: { filename: string; content: string }) {
  if (data.content.length > 5_000_000)
    throw new ApiError("Le fichier dépasse 5 Mo.");
  let raw: unknown[];
  if (data.filename.toLowerCase().endsWith(".csv")) {
    raw = parseCsv(data.content).map((row) => ({
      ...row,
      criticality: row.criticality || "standard",
      lifecycle: row.lifecycle || "active",
      tags: row.tags
        ? row.tags
            .split("|")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    }));
  } else {
    let parsed;
    try {
      parsed = JSON.parse(data.content);
    } catch {
      throw new ApiError("JSON invalide.");
    }
    if (
      !parsed ||
      parsed.format !== "vigie.inventory" ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.projects)
    )
      throw new ApiError(
        "Format JSON non reconnu. Utilisez un export d’inventaire Vigie ou un CSV.",
      );
    raw = parsed.projects;
  }
  if (!raw.length || raw.length > 1000)
    throw new ApiError(
      "Import limité à 1 000 projets, avec au moins une ligne.",
    );
  return raw.map((r, index) => {
    const parsed = createProjectSchema.omit({ clientId: true }).safeParse(r);
    if (!parsed.success)
      throw new ApiError(
        `Import : ligne ${index + 2}, ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" · ")}`,
      );
    return parsed.data;
  });
}
async function handleRequest(request: Request, context: Context) {
  try {
    assertLocal(request);
    const url = new URL(request.url);
    const workspace = z
      .literal("live")
      .parse(url.searchParams.get("workspace") || "live") as Workspace;
    const { path } = await context.params;
    const [root, id, child] = path;
    const method = request.method;
    if (root === "maintenance") {
      if (method === "GET" && path.length === 1) return Response.json(await maintenanceState());
      if (method === "POST" && id === "inspect" && path.length === 2) {
        const input = z.object({ targetId: z.string().max(500) }).strict().parse(await body(request));
        return Response.json(await inspectMaintenance(input.targetId));
      }
      if (method === "POST" && id === "package" && path.length === 2) return Response.json(await packageRelease(await body(request)));
      if (method === "POST" && id === "plans" && path.length === 2) return Response.json(await createMaintenancePlan(await body(request)));
      if (method === "POST" && id === "latest" && path.length === 2) return Response.json(await updateLatestMaintenance(await body(request)));
      if (method === "POST" && id && child && path.length === 3) {
        if (child === "approve") return Response.json(await approveMaintenance(id, await body(request)));
        if (child === "refresh") return Response.json(await refreshMaintenance(id));
        if (child === "merge") return Response.json(await mergeMaintenance(id, await body(request)));
        if (child === "close") {
          z.object({ confirmed: z.literal(true) }).strict().parse(await body(request));
          return Response.json(await closeMaintenance(id));
        }
      }
      throw new ApiError("Route de maintenance introuvable.", 404);
    }
    if (method === "GET") {
      if (root === "vercel" && path.length === 1)
        return Response.json((await vercelState()));
      if (root === "railway" && path.length === 1)
        return Response.json((await railwayState()));
      if (
        root === "installations" &&
        id &&
        child === "observer-plan" &&
        path.length === 3
      )
        return Response.json((await observerPlan(id)));
      if (root === "connections" && path.length === 1) {
        const connections = (await hostingConnections());
        return Response.json({
          connections,
          discoveries: Object.fromEntries(
            (await Promise.all(connections.map(async (c) => [c.id, (await hostingDiscovery(c.id))]))),
          ),
        });
      }
      if (
        root === "connections" &&
        id &&
        child === "discovery" &&
        path.length === 3
      )
        return Response.json((await hostingDiscovery(id)));
      if (root === "workspace" && path.length === 1)
        return Response.json((await workspaceData(workspace)));
      if (root === "projects" && id && path.length === 2)
        return Response.json({
          ...(await projectDetail(id, workspace)),
          hosting: (await projectHostingInstallations(id)),
          railway: (await railwayState()).projects.filter((p) => p.projectId === id),
          vercel: (await vercelState()).projects.filter((p) => p.projectId === id),
        });
      if (root === "export" && path.length === 1) {
        const data = (await workspaceData(workspace));
        const projects = data.projects.map((p) => {
          const service =
            data.services.find(
              (s) =>
                s.projectId === p.id &&
                data.environments.find((e) => e.id === s.environmentId)
                  ?.kind === "production",
            ) || data.services.find((s) => s.projectId === p.id);
          return {
            ...p,
            clientId: undefined,
            technology: service?.technology || "",
            provider: service?.provider || "",
            runtime: service?.runtime || "",
            version: service?.version || "",
            repository: service?.repository || "",
          };
        });
        const date = new Date().toISOString().slice(0, 10);
        if (url.searchParams.get("format") === "csv") {
          const columns = [
            "name",
            "url",
            "client",
            "owner",
            "criticality",
            "lifecycle",
            "technology",
            "provider",
            "runtime",
            "version",
            "repository",
            "tags",
            "description",
          ] as const;
          const csv =
            "\uFEFF" +
            [
              columns.join(";"),
              ...projects.map((p) =>
                columns
                  .map((c) => escapeCsv(c === "tags" ? p.tags.join("|") : p[c]))
                  .join(";"),
              ),
            ].join("\r\n");
          return new Response(csv, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="vigie-${workspace}-${date}.csv"`,
            },
          });
        }
        return new Response(
          JSON.stringify(
            {
              format: "vigie.inventory",
              version: 1,
              exportedAt: new Date().toISOString(),
              workspace,
              scope: "projects-and-primary-service",
              projects,
            },
            null,
            2,
          ),
          {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition": `attachment; filename="vigie-${workspace}-${date}.json"`,
            },
          },
        );
      }
      if (root === "health")
        return Response.json({
          status: "ok",
          mode: "local",
          database: !!database(),
          version: "0.1.0",
        });
    }
    if (method === "POST") {
      const raw = await body(request);
      if (root === "vercel" && path.length === 1)
        return Response.json((await saveVercelConnection(raw)), { status: 201 });
      if (root === "vercel" && id && child === "sync" && path.length === 3)
        return Response.json(await synchronizeVercel(id));
      if (
        root === "vercel" &&
        id &&
        child === "projects" &&
        path.length === 5
      ) {
        const remote = z
          .string()
          .regex(/^prj_[a-zA-Z0-9]+$/)
          .parse(path[3]);
        if (path[4] === "create")
          return Response.json((await createVercelProject(id, remote)));
        if (path[4] === "link")
          return Response.json(
            (await linkVercelProject(
              id,
              remote,
              z.object({ projectId: z.string().uuid() }).parse(raw).projectId,
            )),
          );
      }
      if (root === "railway" && path.length === 1)
        return Response.json((await saveRailwayConnection(raw)), { status: 201 });
      if (root === "railway" && id && child === "sync" && path.length === 3)
        return Response.json(await synchronizeRailway(id));
      if (
        root === "railway" &&
        id &&
        child === "projects" &&
        path.length === 5
      ) {
        const remoteId = z.string().uuid().parse(path[3]);
        if (path[4] === "link")
          return Response.json(
            (await linkRailwayProject(
              id,
              remoteId,
              z.object({ projectId: z.string().uuid() }).parse(raw).projectId,
            )),
          );
        if (path[4] === "create")
          return Response.json((await createRailwayProject(id, remoteId)));
      }
      if (
        root === "connections" &&
        id &&
        child === "inventory" &&
        path.length === 3
      )
        return Response.json(await collectHostingInventories(id));
      if (root === "installations" && id && path.length === 3) {
        if (child === "inventory") {
          const item = (await hostingInstallation(id));
          return Response.json(
            await collectHostingInventories(
              item.connectionId,
              fetch,
              fetch,
              id,
            ),
          );
        }
        if (child === "observer") {
          const input = z.object({ confirm: z.literal(true) }).parse(raw);
          return Response.json(await installObserver(id, input.confirm));
        }
      }
      if (
        root === "connections" &&
        id &&
        child === "discover" &&
        path.length === 3
      ) {
        const result = await discoverHostingConnection(id);
        const provisioned = await provisionLinkedObservers(id);
        return Response.json({
          ...result,
          discovery: provisioned.discovery,
          observerIssues: provisioned.issues,
        });
      }
      if (root === "installations" && id && path.length === 3) {
        if (child === "link") {
          (await linkHostingInstallation(id, raw));
          await provisionLinkedObserver(id);
          return Response.json(
            (await hostingDiscovery((await hostingInstallation(id)).connectionId)),
          );
        }
        if (child === "create") {
          const result = (await createProjectFromInstallation(id));
          await provisionLinkedObserver(id);
          return Response.json({
            ...result,
            discovery: (await hostingDiscovery((await hostingInstallation(id)).connectionId)),
          });
        }
        if (child === "ignore")
          return Response.json((await ignoreHostingInstallation(id, raw)));
      }
      if (root === "connections" && path.length === 1)
        return Response.json((await saveHostingConnection(raw)), { status: 201 });
      if (root === "connections" && id && child === "test" && path.length === 3)
        return Response.json(await testHostingConnection(id));
      if (root === "clients" && !id) {
        const input = clientSchema.parse(raw);
        return Response.json(
          (await transaction(async () => (await createClient(workspace, input)))),
          { status: 201 },
        );
      }

      if (root === "projects" && !id) {
        const input = createProjectSchema.parse(raw);
        const p = (await transaction(async () => (await createProject(workspace, input))));
        return Response.json(p, { status: 201 });
      }
      if (root === "projects" && id && child === "environments") {
        (await requireProject(id, workspace));
        const input = environmentSchema.parse(raw);
        const env = (await transaction(async () => {
          const env = (await save<Environment>(
            "environments",
            workspace,
            { ...input, id: randomUUID(), projectId: id },
            id,
          ));
          (await log(
            workspace,
            "environment.created",
            `Environnement « ${env.name} » ajouté.`,
            id,
          ));
          return env;
        }));
        return Response.json(env, { status: 201 });
      }
      if (root === "projects" && id && child === "services") {
        (await requireProject(id, workspace));
        const input = serviceSchema.parse(raw);
        const env = (await get<Environment>(
          "environments",
          input.environmentId,
          workspace,
        ));
        if (!env || env.projectId !== id)
          throw new ApiError("Environnement introuvable pour ce projet.");
        const s = (await transaction(async () => {
          const s = (await save<Service>(
            "services",
            workspace,
            { ...input, id: randomUUID(), projectId: id },
            id,
          ));
          (await log(
            workspace,
            "service.created",
            `Service « ${s.name} » ajouté.`,
            id,
          ));
          return s;
        }));
        return Response.json(s, { status: 201 });
      }
      if (root === "projects" && id && child === "accesses") {
        (await requireProject(id, workspace));
        const input = accessSchema.parse(raw);
        const a = (await transaction(async () => {
          const a = (await save<Access>(
            "accesses",
            workspace,
            { ...input, id: randomUUID(), projectId: id },
            id,
          ));
          (await log(
            workspace,
            "access.created",
            `Référence d’accès « ${a.label} » ajoutée.`,
            id,
          ));
          return a;
        }));
        return Response.json(a, { status: 201 });
      }
      if (root === "projects" && id && child === "review") {
        const p = (await requireProject(id, workspace));
        const next = (await transaction(async () => {
          const next = (await save<Project>("projects", workspace, {
            ...p,
            reviewedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
          (await log(
            workspace,
            "project.reviewed",
            "Documentation relue manuellement. Ce n’est pas un contrôle de sécurité.",
            id,
          ));
          return next;
        }));
        return Response.json(next);
      }
      if (root === "resources" && !id) {
        const input = resourceSchema.parse(raw);
        input.projectIds = [...new Set(input.projectIds)];
        for (const p of input.projectIds) (await requireProject(p, workspace));
        const r = (await transaction(async () => {
          const r = (await save<Resource>("resources", workspace, {
            ...input,
            id: randomUUID(),
          }));
          (await log(
            workspace,
            "resource.created",
            `Ressource « ${r.name} » ajoutée.`,
          ));
          return r;
        }));
        return Response.json(r, { status: 201 });
      }
      if (root === "inventories" && !id) {
        const input = inventorySchema.parse(raw);
        const parsed = parseLockfile(input.filename, input.content);
        return Response.json(
          (await saveInventory(
            workspace,
            input.serviceId,
            "lockfile",
            input.filename,
            input.commitRef,
            parsed,
          )),
          { status: 201 },
        );
      }
      if (root === "inventories" && id === "manual") {
        const input = manualInventorySchema.parse(raw);
        return Response.json(
          (await saveInventory(
            workspace,
            input.serviceId,
            "manual",
            "Saisie manuelle",
            "",
            input.components,
          )),
          { status: 201 },
        );
      }
      if (root === "import" && (id === "preview" || id === "confirm")) {
        const input = z
          .object({
            filename: z.string().max(200),
            content: z.string().max(5_000_000),
          })
          .parse(raw);
        const rows = parseImport(input);
        const existing = (await list<Project>("projects", workspace));
        const key = (p: { name: string; url: string }) =>
          `${p.name.toLowerCase()}|${p.url.replace(/\/$/, "").toLowerCase()}`;
        const keys = new Set(existing.map(key));
        let skipped = 0;
        const additions = rows.filter((r) => {
          const k = key(r);
          if (keys.has(k)) {
            skipped++;
            return false;
          }
          keys.add(k);
          return true;
        });
        if (id === "preview")
          return Response.json({
            count: additions.length,
            skipped,
            projects: additions.map((p) => ({
              name: p.name,
              url: p.url,
              technology: p.technology,
              provider: p.provider,
            })),
          });
        (await transaction(async () => {
          for (const project of additions) (await createProject(workspace, project));
          if (additions.length)
            (await log(
              workspace,
              "projects.imported",
              `${additions.length} projets importés.`,
            ));
        }));
        return Response.json({ count: additions.length, skipped });
      }
    }
    if (method === "PATCH") {
      const raw = await body(request);
      if (root === "vercel" && id && path.length === 2)
        return Response.json((await saveVercelConnection(raw, id)));
      if (root === "railway" && id && path.length === 2)
        return Response.json((await saveRailwayConnection(raw, id)));
      if (root === "connections" && id && path.length === 2)
        return Response.json((await saveHostingConnection(raw, id)));
      if (root === "clients" && id && path.length === 2) {
        const input = clientSchema.partial().parse(raw);
        for (const key of Object.keys(input) as (keyof typeof input)[])
          if (!Object.hasOwn(raw, key)) delete input[key];
        return Response.json(
          (await transaction(async () => (await updateClient(workspace, id, input)))),
        );
      }
      if (root === "projects" && id) {
        const current = (await requireProject(id, workspace));
        const patch = projectSchema.partial().parse(raw);
        for (const key of Object.keys(patch) as (keyof typeof patch)[])
          if (!Object.hasOwn(raw, key)) delete patch[key];
        const next = (await transaction(async () => {
          const next = (await save<Project>("projects", workspace, {
            ...current,
            ...patch,
            ...("clientId" in patch || "client" in patch
              ? (await resolveProjectClient(workspace, patch))
              : {}),
            updatedAt: new Date().toISOString(),
          }));
          (await log(
            workspace,
            patch.lifecycle && patch.lifecycle !== current.lifecycle
              ? "project.archived"
              : "project.updated",
            patch.lifecycle === "archived"
              ? "Projet archivé."
              : patch.lifecycle === "active" && current.lifecycle === "archived"
                ? "Projet réactivé."
                : "Informations du projet modifiées.",
            id,
          ));
          return next;
        }));
        return Response.json(next);
      }
      if (root === "services" && id) {
        const current = (await get<Service>("services", id, workspace));
        if (!current) throw new ApiError("Service introuvable.", 404);
        const patch = serviceSchema.parse(raw);
        const env = (await get<Environment>(
          "environments",
          patch.environmentId,
          workspace,
        ));
        if (!env || env.projectId !== current.projectId)
          throw new ApiError("Environnement introuvable pour ce projet.");
        return Response.json(
          (await transaction(async () => {
            const s = (await save<Service>(
              "services",
              workspace,
              { ...current, ...patch },
              current.projectId,
            ));
            (await log(
              workspace,
              "service.updated",
              `Service « ${s.name} » modifié.`,
              s.projectId,
            ));
            return s;
          })),
        );
      }
      if (root === "resources" && id) {
        const current = (await get<Resource>("resources", id, workspace));
        if (!current) throw new ApiError("Ressource introuvable.", 404);
        const input = resourceSchema.parse(raw);
        input.projectIds = [...new Set(input.projectIds)];
        for (const p of input.projectIds) (await requireProject(p, workspace));
        return Response.json(
          (await transaction(async () => {
            const r = (await save<Resource>("resources", workspace, { ...input, id }));
            (await log(
              workspace,
              "resource.updated",
              `Ressource « ${r.name} » modifiée.`,
            ));
            return r;
          })),
        );
      }
    }
    if (
      method === "DELETE" &&
      root === "vercel" &&
      id &&
      child === "token" &&
      path.length === 3
    )
      return Response.json((await disconnectVercel(id)));
    if (
      method === "DELETE" &&
      root === "railway" &&
      id &&
      child === "token" &&
      path.length === 3
    )
      return Response.json((await disconnectRailway(id)));
    if (
      method === "DELETE" &&
      root === "connections" &&
      id &&
      path.length === 2
    )
      return Response.json((await disconnectHostingConnection(id)));
    if (method === "DELETE" && root === "accesses" && id) {
      const a = (await get<Access>("accesses", id, workspace));
      if (!a) throw new ApiError("Accès introuvable.", 404);
      (await transaction(async () => {
        (await remove("accesses", id, workspace));
        (await log(
          workspace,
          "access.removed",
          `Référence d’accès « ${a.label} » retirée.`,
          a.projectId,
        ));
      }));
      return Response.json({ ok: true });
    }
    throw new ApiError("Route introuvable.", 404);
  } catch (error) {
    return errorResponse(error);
  }
}
async function handler(request: Request, context: Context) {
  try {
    assertLocal(request);
    const session = await requireSession(request.headers);
    return withAuditActor(
      { name: session.user.name, email: session.user.email },
      async () => (await handleRequest(request, context)),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
