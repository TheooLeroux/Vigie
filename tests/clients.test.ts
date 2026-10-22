import { authFixture } from "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST, PATCH } from "../src/app/api/[...path]/route";
import { createClient, transaction, list, database } from "../src/lib/db";
import { clientSchema } from "../src/lib/validation";
import { parseSiteList } from "../src/lib/site-list";
import type { Client, Project } from "../src/lib/types";

process.env.VIGIE_DB_PATH = ":memory:";
async function call(
  method: "GET" | "POST" | "PATCH",
  path: string,
  input?: unknown,
) {
  const { cookie } = await authFixture();
  const request = new Request(`http://127.0.0.1:3001/api/${path}`, {
    method,
    headers: {
      cookie,
      origin: "http://127.0.0.1:3001",
      ...(input ? { "content-type": "application/json" } : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
  });
  return { GET, POST, PATCH }[method](request, {
    params: Promise.resolve({ path: path.split("/") }),
  });
}

test("clients : plusieurs sites, renommage, transfert, retrait et imports par nom", async () => {
  let response = await call("POST", "clients", {
    name: "  Société   A ",
    email: "contact@example.com",
  });
  assert.equal(response.status, 201);
  const client = await response.json();
  assert.equal(client.name, "Société A");
  response = await call("POST", "clients", { name: "société a" });
  assert.equal(response.status, 409);
  const first = await (
    await call("POST", "projects", {
      name: "Vitrine",
      clientId: client.id,
      url: "https://vitrine.example",
    })
  ).json();
  const second = await (
    await call("POST", "projects", {
      name: "Application",
      clientId: client.id,
      url: "https://app.example",
    })
  ).json();
  assert.equal(first.clientId, client.id);
  assert.equal(second.clientId, client.id);
  response = await call("PATCH", `clients/${client.id}`, {
    name: "Société renommée",
  });
  assert.equal(response.status, 200);
  let data = await (await call("GET", "workspace")).json();
  assert.equal(
    data.projects.filter((p: Project) => p.clientId === client.id).length,
    2,
  );
  assert.ok(
    data.projects.every((p: Project) => p.client === "Société renommée"),
  );
  assert.equal(
    data.clients[0].email,
    "contact@example.com",
    "une modification partielle conserve les coordonnées",
  );
  await call("PATCH", `projects/${first.id}`, { lifecycle: "archived" });
  let detail = await (await call("GET", `projects/${first.id}`)).json();
  assert.equal(
    detail.project.clientId,
    client.id,
    "archiver conserve le client",
  );
  assert.equal(detail.project.url, "https://vitrine.example");
  const other = await (
    await call("POST", "clients", { name: "Société B" })
  ).json();
  await call("PATCH", `projects/${second.id}`, { clientId: other.id });
  detail = await (await call("GET", `projects/${second.id}`)).json();
  assert.equal(detail.project.client, "Société B");
  await call("PATCH", `projects/${second.id}`, { clientId: null });
  detail = await (await call("GET", `projects/${second.id}`)).json();
  assert.equal(detail.project.clientId, null);
  assert.equal(detail.project.client, "");
  const outside = transaction(() =>
    createClient("demo", clientSchema.parse({ name: "Hors périmètre" })),
  );
  response = await call("POST", "projects", {
    name: "Refusé",
    clientId: outside.id,
  });
  assert.equal(response.status, 404);
  response = await call("PATCH", `projects/${second.id}`, {
    clientId: outside.id,
  });
  assert.equal(response.status, 404);
  response = await call("PATCH", `clients/${outside.id}`, { name: "Refusé" });
  assert.equal(response.status, 404);
  assert.throws(
    () =>
      database()
        .prepare("UPDATE projects SET client_id=? WHERE id=?")
        .run(outside.id, first.id),
    /périmètre/,
  );
  response = await call("POST", "import/confirm", {
    filename: "clients.csv",
    content:
      "name;url;client\nSite C;https://c.example;Société B\nSite D;https://d.example;société b",
  });
  assert.equal(response.status, 200);
  assert.equal(list<Client>("clients", "live").length, 2);
  assert.equal(
    list<Project>("projects", "live").filter((p) => p.clientId === other.id)
      .length,
    2,
  );
  const exported = await (await call("GET", "export")).json();
  assert.ok(
    exported.projects.every((p: Project) => !("clientId" in p)),
    "export portable par nom de client",
  );
  assert.ok(exported.projects.some((p: Project) => p.client === "Société B"));
  response = await call("POST", "clients", {
    name: "Invalide",
    email: "incorrect",
  });
  assert.equal(response.status, 400);
});

test("site.txt : uniquement WordPress/Railway, champs autorisés, aucune ligne d’identifiants", () => {
  const entries = parseSiteList(
    `O2switch 1 :\nhttps://host.example:2083\nprivate-user\nprivate-password\n- WordPress :\nsite : https://wp.example/\nchemin : /home/site\nbdd : site_wp\nRailway :\nhttps://railway.com/dashboard\nConnexion git\n- Application\nsite : https://app.example/login\ngit : https://github.com/org/app\nchemin : https://railway.com/project/abc\nbdd : Postgres sur Railway\ndown ?\nVercel :\n- Exclu\nsite : https://excluded.example/`,
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].technology, "WordPress");
  assert.equal(entries[1].provider, "Railway");
  assert.equal(entries[1].repository, "https://github.com/org/app");
  assert.match(entries[1].notes, /vérifier/);
  assert.ok(!JSON.stringify(entries).includes("private-"));
  assert.throws(() =>
    parseSiteList("Railway :\n- Invalide\nsite : javascript:bad"),
  );
});
