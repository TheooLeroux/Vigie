import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseSiteList } from "../src/lib/site-list";
import {
  createProjectSchema,
  accessSchema,
  resourceSchema,
} from "../src/lib/validation";
import {
  createProject,
  list,
  log,
  save,
  transaction,
  workspaceData,
} from "../src/lib/db";
import { withAuditActor } from "../src/lib/audit-context";
import type { Access, Project, Resource, Service } from "../src/lib/types";

const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage : npx tsx scripts/import-site-list.ts <site.txt> [--apply]",
  );
const entries = parseSiteList(readFileSync(file, "utf8"));
const canonical = (value: string) => new URL(value).href.replace(/\/$/, "");
const existing = list<Project>("projects", "live");
console.log(
  JSON.stringify(
    {
      mode: process.argv.includes("--apply") ? "apply" : "preview",
      sites: entries.map((e) => ({
        name: e.name,
        provider: e.provider,
        existing: existing.some(
          (p) => p.url && canonical(p.url) === canonical(e.url),
        ),
      })),
      vercel: "excluded",
    },
    null,
    2,
  ),
);
if (process.argv.includes("--apply")) {
  const result = withAuditActor({ name: "Import site.txt", email: "" }, () =>
    transaction(() => {
      let added = 0,
        updated = 0;
      for (const entry of entries) {
        let project = list<Project>("projects", "live").find(
          (p) => p.url && canonical(p.url) === canonical(entry.url),
        );
        if (!project) {
          project = createProject(
            "live",
            createProjectSchema.parse({
              name: entry.name,
              url: entry.url,
              technology: entry.technology,
              provider: entry.provider,
              repository: entry.repository,
              tags: [entry.accountLabel],
              description: entry.notes,
            }),
          );
          added++;
        } else updated++;
        const id = project.id;
        const service = list<Service>("services", "live", id)[0];
        if (service)
          save(
            "services",
            "live",
            {
              ...service,
              technology: service.technology || entry.technology,
              provider: entry.provider,
              repository: entry.repository || service.repository,
            },
            id,
          );
        const upsertAccess = (
          label: string,
          kind: Access["kind"],
          url: string,
        ) => {
          if (
            !url ||
            list<Access>("accesses", "live", id).some(
              (a) =>
                a.kind === kind &&
                a.url.replace(/\?$/, "") === url.replace(/\?$/, ""),
            )
          )
            return;
          const input = accessSchema.parse({
            label,
            kind,
            url,
            notes: "Référence fournie dans site.txt. Connexion non testée.",
          });
          save<Access>(
            "accesses",
            "live",
            { ...input, id: randomUUID(), projectId: id },
            id,
          );
        };
        if (entry.provider === "Railway")
          upsertAccess(
            "Projet Railway",
            "hosting",
            entry.hostingUrl.replace(/\?$/, ""),
          );
        if (entry.repository)
          upsertAccess("Dépôt Git", "git", entry.repository);
        if (entry.database) {
          const url = entry.database.startsWith("https://")
            ? entry.database
            : "";
          const provider =
            url && new URL(url).hostname === "supabase.com"
              ? "Supabase"
              : entry.provider;
          const reference = url
            ? new URL(url).pathname.match(/\/project\/([^/]+)/)?.[1] || ""
            : entry.database;
          if (
            !list<Resource>("resources", "live").some(
              (r) =>
                r.kind === "database" &&
                r.projectIds.includes(id) &&
                r.reference === reference &&
                r.url === url,
            )
          ) {
            const input = resourceSchema.parse({
              name: `${project.name} · BDD`,
              kind: "database",
              provider,
              url,
              reference,
              projectIds: [id],
            });
            save<Resource>("resources", "live", { ...input, id: randomUUID() });
          }
          if (url) upsertAccess("Console base de données", "database", url);
        }
        log(
          "live",
          "project.imported",
          `Informations ${entry.provider} relues depuis site.txt.`,
          id,
        );
      }
      const railway = list<Resource>("resources", "live").find(
        (r) => r.provider === "Railway" && r.name === "Railway",
      );
      if (railway)
        save("resources", "live", {
          ...railway,
          notes: "Connexion via Git. Projets référencés depuis site.txt.",
          projectIds: [
            ...new Set([
              ...railway.projectIds,
              ...list<Project>("projects", "live")
                .filter(
                  (p) =>
                    p.url &&
                    entries.some(
                      (e) =>
                        e.provider === "Railway" &&
                        canonical(e.url) === canonical(p.url),
                    ),
                )
                .map((p) => p.id),
            ]),
          ],
        });
      return { added, updated, total: workspaceData("live").projects.length };
    }),
  );
  console.log(JSON.stringify(result));
}
