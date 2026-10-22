import { authFixture } from "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { GET, POST } from "../src/app/api/[...path]/route";
import {
  createClient,
  createProject,
  get,
  list,
  save,
  transaction,
} from "../src/lib/db";
import {
  clientSchema,
  createProjectSchema,
  accessSchema,
} from "../src/lib/validation";
import {
  saveHostingConnection,
  discoverHostingConnection,
  hostingConnections,
} from "../src/lib/hosting-connections";
import {
  applyDiscoverySnapshot,
  hostingDiscovery,
  projectHostingInstallations,
  findInstallationMatches,
  createProjectFromInstallation,
  linkHostingInstallation,
  ignoreHostingInstallation,
} from "../src/lib/hosting-discovery";
import {
  collectO2switchInstallations,
  type DiscoveredInstallation,
} from "../src/lib/connectors/o2switch-discovery";
import type { Access, Project, Service, Environment } from "../src/lib/types";

process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const credentials = {
  name: "Découverte test",
  endpoint: "https://gaz.o2switch.net:2083",
  username: "scanuser",
  authMode: "token" as const,
  secret: "private-test-only",
};
function item(
  domain: string,
  kind: DiscoveredInstallation["kind"] = "wordpress",
): DiscoveredInstallation {
  return {
    domains: [domain],
    aliases: [`www.${domain}`],
    documentRoot: `/home/scanuser/${domain}`,
    kind,
    version: kind === "wordpress" ? "6.7.2" : null,
    inspectionError: null,
    suggestedEnvironment: "production",
  };
}
const result = (
  installations: DiscoveredInstallation[],
  observedAt = "2026-10-22T12:00:00.000Z",
) => ({ observedAt, installations });
const data = async () => ({
  projects: (await list<Project>("projects", "live")),
  accesses: (await list<Access>("accesses", "live")),
  services: (await list<Service>("services", "live")),
  environments: (await list<Environment>("environments", "live")),
});
const project = async (name: string, url: string) =>
  (await transaction(async () =>
    (await createProject("live", createProjectSchema.parse({ name, url }))),
  ));
function transport(
  domains: unknown[],
  listing: (dir: string) => string[] | Response = () => [
    "wp-admin",
    "wp-content",
    "wp-includes",
  ],
  calls: URL[] = [],
) {
  return (async (url, options) => {
    const u = new URL(String(url));
    calls.push(u);
    assert.equal(options?.method, "GET");
    assert.equal(options?.redirect, "manual");
    assert.equal(
      (options!.headers as Record<string, string>).Authorization,
      `cpanel ${credentials.username}:${credentials.secret}`,
    );
    let value: unknown;
    if (u.pathname === "/execute/DomainInfo/domains_data") {
      assert.equal(u.searchParams.get("format"), "list");
      value = domains;
    } else if (u.pathname === "/execute/Fileman/list_files") {
      const found = listing(u.searchParams.get("dir")!);
      if (found instanceof Response) return found;
      value = found.map((file) => ({
        file,
        type: file.includes(".") ? "file" : "dir",
      }));
    } else if (u.pathname === "/execute/Fileman/get_file_content") {
      assert.ok(
        ["version.php", "filefunc.inc.php"].includes(
          u.searchParams.get("file")!,
        ),
      );
      value = {
        content:
          u.searchParams.get("file") === "version.php"
            ? "<?php $wp_version = '6.7.2';"
            : "<?php define('DOL_VERSION', '15.0.2');",
      };
    } else assert.fail("Opération distante imprévue");
    return Response.json({ result: { status: 1, errors: null, data: value } });
  }) as typeof fetch;
}

test("découverte : racines regroupées, alias, versions et lectures fixes sans exécution distante", async () => {
  const domains = [
    {
      domain: "site.example.org",
      documentroot: "/home/scanuser/site",
      serveralias: "www.site.example.org",
    },
    { domain: "alias.example.org", documentroot: "/home/scanuser/site/" },
    { domain: "partial.example.org", documentroot: "/home/scanuser/partial" },
    { domain: "html.example.org", documentroot: "/home/scanuser/html" },
    { domain: "crm.example.org", documentroot: "/home/scanuser/crm" },
    { domain: "empty.example.org", documentroot: "/home/scanuser/empty" },
    { domain: "stage.wptiger.fr", documentroot: "/home/scanuser/stage" },
    { domain: "outside.example.org", documentroot: "/home/scanuser/../../etc" },
  ];
  const calls: URL[] = [];
  const found = await collectO2switchInstallations(
    credentials,
    transport(
      domains,
      (dir) =>
        dir.endsWith("partial")
          ? ["wp-admin", "wp-content"]
          : dir.endsWith("html")
            ? ["index.html", "_next"]
            : dir.endsWith("crm")
              ? ["htdocs", "composer.json"]
              : dir.endsWith("empty")
                ? []
                : ["wp-admin", "wp-content", "wp-includes"],
      calls,
    ),
  );
  assert.equal(found.installations.length, 7);
  const byDomain = (name: string) =>
    found.installations.find((i) => i.domains.includes(name))!;
  assert.deepEqual(byDomain("site.example.org").domains, [
    "alias.example.org",
    "site.example.org",
  ]);
  assert.equal(byDomain("site.example.org").version, "6.7.2");
  assert.equal(byDomain("partial.example.org").kind, "wordpress-incomplete");
  assert.equal(byDomain("html.example.org").kind, "next-static");
  assert.equal(byDomain("crm.example.org").kind, "dolibarr");
  assert.equal(byDomain("crm.example.org").version, "15.0.2");
  assert.equal(byDomain("empty.example.org").kind, "empty");
  assert.equal(byDomain("stage.wptiger.fr").suggestedEnvironment, "staging");
  assert.match(
    byDomain("outside.example.org").inspectionError!,
    /hors du dossier/,
  );
  assert.ok(
    calls
      .filter((u) => u.searchParams.has("dir"))
      .every((u) => u.searchParams.get("dir")!.startsWith("/home/scanuser/")),
  );
  assert.ok(!calls.some((u) => u.searchParams.get("file") === "wp-config.php"));
});

test("découverte : refus et réponses invalides ne deviennent pas un inventaire vide", async () => {
  for (const response of [
    new Response(credentials.secret, { status: 401 }),
    new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.test" },
    }),
    Response.json({ result: { status: 1, data: [] } }),
    Response.json({
      result: {
        status: 1,
        data: [{ domain: "bad/domain", documentroot: "/home/scanuser/site" }],
      },
    }),
  ]) {
    await assert.rejects(
      collectO2switchInstallations(
        credentials,
        (async () => response) as typeof fetch,
      ),
      (error) => {
        assert.ok(!String(error).includes(credentials.secret));
        return true;
      },
    );
  }
});

test("rapprochement : domaine exact, URL des services et chemin limité au bon compte", async () => {
  const host = { ...credentials, id: "host" };
  const p = (await project("Matching", "https://www.match.example.org/"));
  assert.equal(
    findInstallationMatches(item("match.example.org"), host, (await data()))[0].id,
    p.id,
  );
  const service = (await list<Service>("services", "live", p.id))[0];
  (await save(
    "services",
    "live",
    { ...service, url: "https://api.match.example.org/" },
    p.id,
  ));
  assert.equal(
    findInstallationMatches(item("api.match.example.org"), host, (await data()))[0].id,
    p.id,
  );
  (await save("projects", "live", {
    ...p,
    url: "",
    description: "Répertoire : /home/scanuser/path.example.org",
  }));
  assert.equal(
    findInstallationMatches(item("path.example.org"), host, (await data())).length,
    0,
  );
  (await save<Access>(
    "accesses",
    "live",
    {
      ...accessSchema.parse({
        label: "Compte",
        kind: "hosting",
        url: credentials.endpoint,
        account: "anotheruser",
      }),
      id: randomUUID(),
      projectId: p.id,
    },
    p.id,
  ));
  assert.equal(
    findInstallationMatches(item("path.example.org"), host, (await data())).length,
    0,
  );
  (await save<Access>(
    "accesses",
    "live",
    {
      ...accessSchema.parse({
        label: "Compte",
        kind: "hosting",
        url: credentials.endpoint,
        account: credentials.username,
      }),
      id: randomUUID(),
      projectId: p.id,
    },
    p.id,
  ));
  assert.equal(
    findInstallationMatches(item("path.example.org"), host, (await data()))[0].id,
    p.id,
  );
  assert.equal(
    findInstallationMatches(
      item("matching-but-different.example.org"),
      host,
      (await data()),
    ).length,
    0,
  );
});

test("synchronisation : rattachement unique, client conservé, ambiguïtés et archives à choisir", async () => {
  const host = (await saveHostingConnection({ ...credentials, username: "matchuser" }));
  const client = (await transaction(async () =>
    (await createClient("live", clientSchema.parse({ name: "Client réel de test" }))),
  ));
  const p = (await project("Unique", "https://unique.example.org/"));
  (await save("projects", "live", { ...p, clientId: client.id }));
  (await project("Ambigu A", "https://ambiguous.example.org/"));
  (await project("Ambigu B", "https://ambiguous.example.org/"));
  const archived = (await project("Archive", "https://archived.example.org/"));
  (await save("projects", "live", { ...archived, lifecycle: "archived" }));
  const snapshot = result([
    item("unique.example.org"),
    item("ambiguous.example.org"),
    item("archived.example.org"),
    item("empty-only.example.org", "empty"),
  ]);
  (await transaction(async () => (await applyDiscoverySnapshot(host, snapshot))));
  let found = (await hostingDiscovery(host.id));
  assert.equal(found.summary.linked, 1);
  assert.equal(found.summary.review, 2);
  assert.equal(found.summary.other, 1);
  assert.equal((await get<Project>("projects", p.id, "live"))!.clientId, client.id);
  const linkedId = found.installations.find((i) => i.project?.id === p.id)!.id;
  await assert.rejects(
    async () =>
      (await createProjectFromInstallation(
        found.installations.find(
          (i) => i.domains[0] === "ambiguous.example.org",
        )!.id,
      )),
    /doublon/,
  );
  await assert.rejects(
    async () =>
      (await createProjectFromInstallation(
        found.installations.find((i) => i.kind === "empty")!.id,
      )),
    /vérifiée/,
  );
  const count = (await list("projects", "live")).length;
  (await transaction(async () => (await applyDiscoverySnapshot(host, snapshot))));
  found = (await hostingDiscovery(host.id));
  assert.equal(
    found.installations.find((i) => i.project?.id === p.id)!.id,
    linkedId,
  );
  assert.equal((await list("projects", "live")).length, count);
  assert.equal((await list<Access>("accesses", "live", p.id)).length, 1);
  assert.equal((await projectHostingInstallations(p.id))[0].connectionName, host.name);
});

test("création en un clic idempotente ; choix manuel, masquage et dernière observation conservés", async () => {
  const host = (await saveHostingConnection({
    ...credentials,
    username: "createuser",
  }));
  const sites = [
    item("new.example.org"),
    item("manual.example.org"),
    item("hidden.example.org"),
  ];
  sites[0].suggestedEnvironment = "staging";
  (await transaction(async () => (await applyDiscoverySnapshot(host, result(sites)))));
  const found = (await hostingDiscovery(host.id)),
    createdItem = found.installations.find(
      (i) => i.domains[0] === "new.example.org",
    )!;
  const created = (await createProjectFromInstallation(createdItem.id));
  assert.equal(created.created, true);
  assert.equal((await createProjectFromInstallation(createdItem.id)).created, false);
  assert.equal(
    (await list<Environment>("environments", "live", created.projectId))[0].kind,
    "staging",
  );
  const manual = found.installations.find(
      (i) => i.domains[0] === "manual.example.org",
    )!,
    hidden = found.installations.find(
      (i) => i.domains[0] === "hidden.example.org",
    )!;
  (await linkHostingInstallation(manual.id, { projectId: created.projectId }));
  (await ignoreHostingInstallation(hidden.id, { ignored: true }));
  const bad = sites.map((i) =>
    i.domains[0] === "new.example.org"
      ? {
          ...i,
          kind: "unknown" as const,
          version: null,
          inspectionError: "Lecture indisponible",
        }
      : i,
  );
  (await transaction(async () =>
    (await applyDiscoverySnapshot(host, result(bad, "2026-10-23T12:00:00.000Z"))),
  ));
  const refreshed = (await hostingDiscovery(host.id));
  assert.equal(
    refreshed.installations.find((i) => i.id === manual.id)!.linkMethod,
    "manual",
  );
  assert.equal(
    refreshed.installations.find((i) => i.id === hidden.id)!.ignored,
    true,
  );
  assert.equal(
    refreshed.installations.find((i) => i.id === createdItem.id)!.version,
    "6.7.2",
  );
  assert.equal(
    refreshed.installations.find((i) => i.id === createdItem.id)!.observedAt,
    "2026-10-22T12:00:00.000Z",
  );
  (await transaction(async () =>
    (await applyDiscoverySnapshot(host, result([], "2026-10-24T12:00:00.000Z"))),
  ));
  assert.equal((await hostingDiscovery(host.id)).summary.missing, 3);
  assert.equal((await projectHostingInstallations(created.projectId)).length, 2);
  await assert.rejects(
    async () => (await linkHostingInstallation(manual.id, { projectId: created.projectId })),
    /pas été retrouvée/,
  );
  (await saveHostingConnection({ ...credentials, username: "rotateduser" }, host.id));
  assert.equal((await hostingDiscovery(host.id)).installations.length, 0);
  assert.equal((await projectHostingInstallations(created.projectId)).length, 0);
  await assert.rejects(
    async () => (await createProjectFromInstallation(createdItem.id)),
    /introuvable/,
  );
});

test("collecte connectée : chiffrement, instantané réel, concurrence et échec sans perte", async () => {
  const host = (await saveHostingConnection(credentials)),
    p = (await project("Connected", "https://connected.example.org/"));
  const domains = [
    {
      domain: "connected.example.org",
      documentroot: "/home/scanuser/connected",
    },
  ];
  const found = await discoverHostingConnection(host.id, transport(domains));
  assert.equal(found.connection.status, "connected");
  assert.equal(found.discovery.installations[0].project?.id, p.id);
  await assert.rejects(
    discoverHostingConnection(host.id, transport(domains)),
    /Attendez/,
  );
  // Older observation for the next attempt; leave the successful installation untouched.
  const { hostingStorage } = await import("../src/lib/hosting-storage");
  (await (await hostingStorage())
    .prepare(
      "UPDATE hosting_discovery_runs SET data=json_set(data,'$.lastAttemptAt','2020-01-01T00:00:00.000Z') WHERE connection_id=?",
    )
    .run(host.id));
  await assert.rejects(
    discoverHostingConnection(
      host.id,
      (async () =>
        new Response(credentials.secret, { status: 401 })) as typeof fetch,
    ),
    /refuse/,
  );
  const after = (await hostingDiscovery(host.id));
  assert.equal(
    (await hostingConnections()).find((c) => c.id === host.id)!.status,
    "error",
  );
  assert.equal(after.installations[0].id, found.discovery.installations[0].id);
  assert.equal(after.lastSuccessAt, found.discovery.lastSuccessAt);
  assert.ok(after.error);
  assert.ok(!JSON.stringify(after).includes(credentials.secret));
});

test("routes de découverte : session Google et périmètre requis, détail lié et erreurs contrôlées", async () => {
  const host = (await saveHostingConnection({ ...credentials, username: "routeuser" }));
  const p = (await project("Route", "https://route.example.org/"));
  (await transaction(async () =>
    (await applyDiscoverySnapshot(host, result([item("route.example.org")]))),
  ));
  const id = (await hostingDiscovery(host.id)).installations[0].id;
  async function call(
    method: "GET" | "POST",
    path: string,
    body: unknown = {},
    auth = true,
  ) {
    return { GET, POST }[method](
      new Request(`http://127.0.0.1:3001/api/${path}`, {
        method,
        headers: {
          origin: "http://127.0.0.1:3001",
          cookie: auth ? (await authFixture()).cookie : "",
          "content-type": "application/json",
        },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
  }
  for (const path of [
    `connections/${host.id}/discover`,
    `installations/${id}/link`,
    `installations/${id}/create`,
    `installations/${id}/ignore`,
  ])
    assert.equal((await call("POST", path, {}, false)).status, 401);
  assert.equal(
    (await call("GET", `connections/${host.id}/discovery`, {}, false)).status,
    401,
  );
  const detail = await (await call("GET", `projects/${p.id}`)).json();
  assert.equal(detail.hosting[0].connectionName, host.name);
  const outsider = (await transaction(async () =>
    (await createProject("demo", createProjectSchema.parse({ name: "Other scope" }))),
  ));
  assert.equal(
    (await call("POST", `installations/${id}/link`, { projectId: outsider.id }))
      .status,
    404,
  );
  assert.equal(
    (await call("POST", `installations/${id}/link`, {})).status,
    400,
  );
  assert.equal(
    (await call("POST", `installations/${id}/create?workspace=demo`)).status,
    400,
  );
});
