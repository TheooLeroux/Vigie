import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database, transaction, createClient, get, workspaceData } from "../src/lib/db";
import { clientSchema } from "../src/lib/validation";
import { hostingConnections, withHostingCredentials } from "../src/lib/hosting-connections";
import { hostingDiscovery } from "../src/lib/hosting-discovery";
import { vercelState } from "../src/lib/vercel";
import { railwayState } from "../src/lib/railway";
import { getAuth } from "../src/lib/auth";
import { makeSignature } from "better-auth/crypto";
import { GET } from "../src/app/api/[...path]/route";
import type { Client } from "../src/lib/types";

test("PostgreSQL : lectures réelles, secrets, authentification, transactions et périmètres", {
  skip: process.env.VIGIE_POSTGRES_TEST !== "1" || !process.env.DATABASE_URL,
}, async () => {
  const data = await workspaceData("live");
  assert.ok(data.projects.length);
  assert.ok((await vercelState()).connections.length);
  assert.ok((await railwayState()).connections.length);
  for (const connection of await hostingConnections()) {
    if (connection.configured) await withHostingCredentials(connection.id, async value => {
      assert.ok(value.secret.length);
    });
    assert.ok((await hostingDiscovery(connection.id)).installations);
  }
  const auth = await getAuth();
  const context = await auth.$context;
  const users = await context.adapter.findMany({ model: "user", limit: 1 });
  assert.ok(users.length);
  const session = await database().prepare('SELECT token FROM "session" WHERE "expiresAt">now() LIMIT 1').get();
  assert.ok(session);
  const signature = await makeSignature(session.token, process.env.BETTER_AUTH_SECRET!);
  const cookie = `vigie.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
  const origin = process.env.BETTER_AUTH_URL!;
  for (const path of ["workspace", "connections", "vercel", "railway"]) {
    const response = await GET(new Request(`${origin}/api/${path}?workspace=live`, { headers: { cookie } }), {
      params: Promise.resolve({ path: [path] }),
    });
    assert.equal(response.status, 200, path);
    const payload = await response.json();
    assert.ok(Object.keys(payload).length, path);
    if (path === "workspace") assert.equal(payload.projects.length, data.projects.length);
    if (path === "connections") assert.ok(Object.values(payload.discoveries).every(value => Array.isArray((value as { installations: unknown[] }).installations)));
  }
  const rollback = new Error("rollback de vérification");
  let clientId = "";
  await assert.rejects(transaction(async () => {
    const client = await createClient("live", clientSchema.parse({ name: `Test Neon ${randomUUID()}` }));
    clientId = client.id;
    assert.equal((await get<Client>("clients", client.id, "live"))?.name, client.name);
    await transaction(async () => assert.ok(await get("clients", client.id, "live")));
    throw rollback;
  }), error => error === rollback);
  assert.equal(await get("clients", clientId, "live"), null);
  await assert.rejects(transaction(async () => {
    const client = await createClient("demo", clientSchema.parse({ name: `Scope Neon ${randomUUID()}` }));
    await database().prepare("UPDATE projects SET client_id=? WHERE id=?").run(client.id, data.projects[0].id);
  }), /foreign key constraint/);
  const ids = [randomUUID(), randomUUID()];
  await Promise.all(ids.map(async id => {
    await assert.rejects(transaction(async () => {
      await database().prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(id, "test");
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal((await database().prepare("SELECT value FROM metadata WHERE key=?").get(id))?.value, "test");
      throw rollback;
    }), error => error === rollback);
    assert.equal(await database().prepare("SELECT value FROM metadata WHERE key=?").get(id), undefined);
  }));
});
