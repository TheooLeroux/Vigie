import { authFixture } from "./auth-fixture";
import { createProject, list, transaction, workspaceData } from "../src/lib/db";
import test from "node:test";
import assert from "node:assert/strict";
import { parseLockfile, parseCsv, escapeCsv } from "../src/lib/inventory";
import { safeUrl } from "../src/lib/validation";
import { assertLocal } from "../src/lib/http";
import { GET, POST, PATCH } from "../src/app/api/[...path]/route";

process.env.VIGIE_DB_PATH = ":memory:";
const origin = "http://127.0.0.1:3001";
async function call(
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload?: unknown,
  workspace = "live",
) {
  const { cookie } = await authFixture();
  const request = new Request(`${origin}/api/${path}?workspace=${workspace}`, {
    method,
    headers: {
      cookie,
      ...(payload ? { "content-type": "application/json", origin } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { GET, POST, PATCH }[method](request, {
    params: Promise.resolve({ path: path.split("/") }),
  });
}

test("npm: versions résolues, dépendances imbriquées, workspace links et portée dev", () => {
  const components = parseLockfile(
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { next: "^16" },
          devDependencies: { typescript: "~5" },
        },
        "node_modules/next": { version: "16.4.2" },
        "node_modules/typescript": { version: "5.9.3", dev: true },
        "node_modules/app": { link: true, resolved: "apps/app" },
        "node_modules/next/node_modules/other": { version: "1.2.3" },
      },
    }),
  );
  assert.equal(components.length, 3);
  assert.equal(components[0].direct, true);
  assert.equal(
    components.find((p) => p.name === "typescript")?.scope,
    "development",
  );
  assert.equal(components.find((p) => p.name === "other")?.direct, false);
});
test("npm: les contraintes ne deviennent pas des versions installées", () => {
  const components = parseLockfile(
    "package-lock.json",
    JSON.stringify({
      dependencies: {
        a: { version: "^1.0.0" },
        b: { version: "1.2.3" },
        local: { version: "file:../local" },
      },
    }),
  );
  assert.deepEqual(
    components.map((c) => c.name),
    ["b"],
  );
});
test("Composer: paquets production et développement", () => {
  const components = parseLockfile(
    "composer.lock",
    JSON.stringify({
      packages: [{ name: "vendor/prod", version: "v1.2.3" }],
      "packages-dev": [{ name: "vendor/dev", version: "2.0.0" }],
    }),
  );
  assert.equal(components[0].ecosystem, "Packagist");
  assert.equal(components[1].scope, "development");
  assert.equal(components[0].direct, false);
});
test("lockfile: format non supporté, données malformées et inventaire vide rejetés", () => {
  assert.throws(() => parseLockfile("package.json", "{}"), /Formats/);
  assert.throws(() => parseLockfile("package-lock.json", "null"), /invalide/);
  assert.throws(
    () => parseLockfile("composer.lock", '{"packages":[]}'),
    /Aucun composant/,
  );
});
test("CSV: BOM, séparateur français, guillemets et retours à la ligne", () => {
  const rows = parseCsv(
    '\uFEFFnom;url;description\r\n"Site; A";https://a.example;"Une ligne\nune autre avec ""citation"""\r\n',
  );
  assert.equal(rows[0].name, "Site; A");
  assert.equal(rows[0].description, 'Une ligne\nune autre avec "citation"');
  assert.equal(rows.length, 1);
});
test("CSV: erreurs de colonnes et formules Excel", () => {
  assert.throws(() => parseCsv("name;url\nA;B;C"), /colonnes/);
  assert.throws(() => parseCsv('name;url\n"A;B'), /guillemets/);
  assert.equal(
    escapeCsv('=HYPERLINK("https://x")'),
    '"\'=HYPERLINK(""https://x"")"',
  );
});
test("URL: javascript, identifiants et chaînes de connexion refusés", () => {
  assert.equal(safeUrl.safeParse("javascript:alert(1)").success, false);
  assert.equal(
    safeUrl.safeParse("https://user:secret@example.com").success,
    false,
  );
  assert.equal(
    safeUrl.safeParse("postgres://user:secret@host/db").success,
    false,
  );
  assert.equal(safeUrl.safeParse("https://example.com/admin").success, true);
});
test("garde locale: origines externes, proxy et DNS rebinding refusés", () => {
  assert.throws(
    () =>
      assertLocal(
        new Request(origin, { headers: { origin: "https://evil.example" } }),
      ),
    /Origine/,
  );
  assert.throws(
    () =>
      assertLocal(new Request(origin, { headers: { host: "evil.example" } })),
    /local/,
  );
  assert.throws(
    () =>
      assertLocal(
        new Request(origin, { headers: { "x-forwarded-host": "example.com" } }),
      ),
    /local/,
  );
  assert.throws(
    () =>
      assertLocal(
        new Request(origin, { headers: { "sec-fetch-site": "cross-site" } }),
      ),
    /externe/,
  );
});

test("API: contrôle du périmètre, relations, historique, imports atomiques et archivage", async () => {
  let response = await call("GET", "workspace");
  let data = await response.json();
  assert.equal(data.projects.length, 0);
  response = await call("GET", "workspace", undefined, "demo");
  assert.equal(response.status, 400);
  transaction(() =>
    createProject("demo", {
      name: "Scope test only",
      url: "",
      description: "",
      client: "",
      owner: "",
      criticality: "standard",
      lifecycle: "active",
      tags: [],
    }),
  );
  const demo = workspaceData("demo");
  response = await call("POST", "projects", {
    name: "Projet réel",
    url: "https://real.example",
    owner: "Camille",
    technology: "WordPress",
    provider: "o2switch",
  });
  assert.equal(response.status, 201);
  const project = await response.json();
  response = await call("GET", `projects/${project.id}`);
  let detail = await response.json();
  assert.equal(detail.environments.length, 1);
  assert.equal(detail.services.length, 1);
  assert.equal(detail.activity[0].action, "project.created");
  assert.equal(detail.activity[0].actorEmail, "qa@reborn-france.test");
  response = await call("GET", `projects/${project.id}`, undefined, "demo");
  assert.equal(response.status, 400);
  response = await call("POST", `projects/${project.id}/services`, {
    name: "Wrong scope",
    kind: "api",
    environmentId: demo.environments[0].id,
  });
  assert.equal(response.status, 400);
  response = await call("POST", "resources", {
    name: "Wrong resource",
    kind: "database",
    projectIds: [demo.projects[0].id],
  });
  assert.equal(response.status, 404);
  response = await call("POST", `projects/${project.id}/environments`, {
    name: "Préproduction",
    kind: "staging",
  });
  assert.equal(response.status, 201);
  const shared = await call("POST", "resources", {
    name: "Base partagée",
    kind: "database",
    provider: "Neon",
    projectIds: [project.id],
  });
  assert.equal(shared.status, 201);
  const payload = {
    serviceId: detail.services[0].id,
    filename: "package-lock.json",
    content: JSON.stringify({ dependencies: { next: { version: "16.4.2" } } }),
  };
  response = await call("POST", "inventories", payload);
  assert.equal(response.status, 201);
  response = await call("POST", "inventories", {
    ...payload,
    content: JSON.stringify({ dependencies: { next: { version: "16.4.3" } } }),
  });
  assert.equal(response.status, 201);
  response = await call("GET", `projects/${project.id}`);
  detail = await response.json();
  assert.equal(detail.inventories.length, 2);
  assert.equal(detail.components.length, 1);
  assert.equal(detail.components[0].version, "16.4.3");
  assert.equal(detail.resources.length, 1);
  const invalidImport = {
    filename: "test.csv",
    content: "name;url\nValide;https://valid.example\nInvalide;javascript:bad",
  };
  response = await call("POST", "import/confirm", invalidImport);
  assert.equal(response.status, 400);
  data = await (await call("GET", "workspace")).json();
  assert.equal(
    data.projects.length,
    1,
    "aucune écriture partielle en cas de ligne invalide",
  );
  const goodImport = {
    filename: "test.csv",
    content:
      "name;url\nNouveau;https://new.example\nNouveau;https://new.example",
  };
  let preview = await (await call("POST", "import/preview", goodImport)).json();
  assert.equal(preview.count, 1);
  assert.equal(preview.skipped, 1);
  data = await (await call("GET", "workspace")).json();
  assert.equal(data.projects.length, 1, "un aperçu n’écrit aucune donnée");
  await call("POST", "import/confirm", goodImport);
  preview = await (await call("POST", "import/preview", goodImport)).json();
  assert.equal(preview.count, 0);
  assert.equal(preview.skipped, 2);
  response = await call("PATCH", `projects/${project.id}`, {
    lifecycle: "archived",
  });
  assert.equal(response.status, 200);
  detail = await (await call("GET", `projects/${project.id}`)).json();
  assert.equal(detail.project.lifecycle, "archived");
  assert.equal(detail.services.length, 1, "archivage sans perte de services");
  response = await call("PATCH", `projects/${project.id}`, {
    lifecycle: "active",
  });
  assert.equal(response.status, 200);
  response = await call("POST", `projects/${project.id}/review`, {});
  assert.equal(response.status, 200);
  detail = await response.json();
  assert.ok(detail.reviewedAt);
});
