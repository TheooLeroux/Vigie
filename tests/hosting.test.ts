import { authFixture } from "./auth-fixture";
import { randomBytes } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "../src/app/api/[...path]/route";
import { database } from "../src/lib/db";
import {
  saveHostingConnection,
  hostingConnections,
  testHostingConnection,
  disconnectHostingConnection,
} from "../src/lib/hosting-connections";
import {
  hostingConnectionSchema,
  parseDomainResponse,
  probeO2switch,
} from "../src/lib/connectors/o2switch";

process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const input = {
  name: "Compte de test",
  endpoint: "https://gaz.o2switch.net:2083",
  username: "testuser",
  authMode: "token" as const,
  secret: "test-only-private-token",
};
const success = {
  result: {
    status: 1,
    errors: null,
    data: {
      main_domain: "example.org",
      addon_domains: ["app.example.org"],
      parked_domains: [],
      sub_domains: ["sub.example.org", "APP.example.org"],
    },
  },
};
const fake = (response: Response) => (async () => response) as typeof fetch;
async function call(
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
  auth = true,
) {
  const cookie = auth ? (await authFixture()).cookie : "";
  return { GET, POST }[method](
    new Request(`http://127.0.0.1:3001/api/${path}`, {
      method,
      headers: {
        cookie,
        origin: "http://127.0.0.1:3001",
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    }),
    { params: Promise.resolve({ path: path.split("/") }) },
  );
}
async function expireCooldown(id: string) {
  const row = (await database()
    .prepare("SELECT data FROM hosting_connections WHERE id=?")
    .get(id)) as { data: string };
  (await database()
    .prepare("UPDATE hosting_connections SET data=? WHERE id=?")
    .run(
      JSON.stringify({
        ...JSON.parse(row.data),
        lastCheckedAt: "2020-01-01T00:00:00.000Z",
      }),
      id,
    ));
}
test("o2switch : adresses autorisées, fonction fixe, jeton et Basic sans redirection", async () => {
  for (const endpoint of [
    "http://gaz.o2switch.net:2083",
    "https://gaz.o2switch.net.evil.example:2083",
    "https://127.0.0.1:2083",
    "https://gaz.o2switch.net:443",
    "https://gaz.o2switch.net:2083/execute/Tokens/create_full_access",
    "https://user:pass@gaz.o2switch.net:2083",
  ])
    assert.equal(
      hostingConnectionSchema.safeParse({ ...input, endpoint }).success,
      false,
    );
  let calls = 0;
  const transport = (async (url, options) => {
    calls++;
    assert.equal(
      url,
      "https://gaz.o2switch.net:2083/execute/DomainInfo/list_domains",
    );
    assert.equal(options?.method, "GET");
    assert.equal(options?.redirect, "manual");
    assert.equal(
      (options!.headers as Record<string, string>).Authorization,
      "cpanel testuser:test-only-private-token",
    );
    return Response.json(success);
  }) as typeof fetch;
  const result = await probeO2switch(input, transport);
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  if (result.ok) assert.equal(result.domains.length, 3);
  const basic = (async (_url, options) => {
    assert.equal(
      (options!.headers as Record<string, string>).Authorization,
      `Basic ${Buffer.from("testuser:test-only-private-token").toString("base64")}`,
    );
    return Response.json(success);
  }) as typeof fetch;
  assert.equal(
    (await probeO2switch({ ...input, authMode: "password" }, basic)).ok,
    true,
  );
  const redirect = await probeO2switch(
    input,
    fake(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example" },
      }),
    ),
  );
  assert.equal(redirect.ok, false);
});
test("o2switch : aucune réussite sur HTTP seul, réponse vide, refus API ou JSON invalide", async () => {
  assert.equal(parseDomainResponse(success).ok, true);
  assert.equal(
    parseDomainResponse({ status: 1, errors: null, data: { main_domain: "" } })
      .ok,
    false,
  );
  assert.equal(
    parseDomainResponse({ result: { status: 0, errors: [input.secret] } }).ok,
    false,
  );
  for (const status of [401, 403, 429, 500]) {
    const result = await probeO2switch(
      input,
      fake(new Response(input.secret, { status })),
    );
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(input.secret));
  }
  const invalid = await probeO2switch(
    input,
    fake(new Response("<html>login</html>")),
  );
  assert.equal(invalid.ok, false);
  const oversized = await probeO2switch(
    input,
    fake(new Response("x".repeat(1_000_001))),
  );
  assert.equal(oversized.ok, false);
  const timeout = await probeO2switch(input, (async () => {
    throw new DOMException("private debug info", "TimeoutError");
  }) as typeof fetch);
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.code, "timeout");
});
test("connexions : secrets chiffrés, API Google obligatoire, statuts réels et déconnexion", async () => {
  assert.equal(
    (await call("GET", "connections", undefined, false)).status,
    401,
  );
  assert.equal((await call("POST", "connections", input, false)).status, 401);
  const created = await call("POST", "connections", input);
  assert.equal(created.status, 201);
  let connection = await created.json();
  assert.equal(connection.status, "untested");
  assert.equal(connection.configured, true);
  assert.ok(!JSON.stringify(connection).includes(input.secret));
  let stored = (await database()
    .prepare("SELECT * FROM hosting_connections WHERE id=?")
    .get(connection.id)) as Record<string, string>;
  assert.ok(!JSON.stringify(stored).includes(input.secret));
  assert.ok(stored.secret_cipher.includes('"tag"'));
  assert.equal((await call("POST", "connections", input)).status, 409);
  assert.ok(
    !JSON.stringify(await (await call("GET", "connections")).json()).includes(
      "secret_cipher",
    ),
  );
  assert.equal(
    (await call("POST", `connections/${connection.id}/test`, {}, false)).status,
    401,
  );
  await assert.rejects(
    async () =>
      (await saveHostingConnection(
        { ...input, secret: "", username: "different" },
        connection.id,
      )),
    /Renseignez le secret/,
  );
  connection = await testHostingConnection(
    connection.id,
    fake(Response.json(success)),
  );
  assert.equal(connection.status, "connected");
  assert.equal(connection.domains.length, 3);
  const lastSuccess = connection.lastSuccessAt;
  await assert.rejects(
    testHostingConnection(connection.id, fake(Response.json(success))),
    /Attendez/,
  );
  (await expireCooldown(connection.id));
  connection = await testHostingConnection(
    connection.id,
    fake(new Response("secret-debug", { status: 401 })),
  );
  assert.equal(connection.status, "error");
  assert.equal(connection.error.code, "authentication");
  assert.equal(connection.lastSuccessAt, lastSuccess);
  assert.equal(
    connection.domains.length,
    3,
    "dernier relevé réussi conservé avec sa date",
  );
  let release!: (response: Response) => void;
  (await expireCooldown(connection.id));
  const pending = testHostingConnection(
    connection.id,
    (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as typeof fetch,
  );
  await assert.rejects(
    testHostingConnection(connection.id, fake(Response.json(success))),
    /déjà en cours/,
  );
  (await saveHostingConnection(
    { ...input, name: "Renommé", secret: "" },
    connection.id,
  ));
  release(Response.json(success));
  await assert.rejects(pending, /configuration a changé/);
  const rotated = (await saveHostingConnection(
    { ...input, secret: "replacement-token" },
    connection.id,
  ));
  assert.equal(rotated.status, "untested");
  stored = (await database()
    .prepare("SELECT * FROM hosting_connections WHERE id=?")
    .get(connection.id)) as Record<string, string>;
  const encrypted = JSON.parse(stored.secret_cipher);
  encrypted.tag = Buffer.alloc(16).toString("base64");
  (await database()
    .prepare("UPDATE hosting_connections SET secret_cipher=? WHERE id=?")
    .run(JSON.stringify(encrypted), connection.id));
  await assert.rejects(
    testHostingConnection(connection.id, fake(Response.json(success))),
    /déchiffré/,
  );
  connection = (await disconnectHostingConnection(connection.id));
  assert.equal(connection.configured, false);
  assert.equal(connection.status, "unconfigured");
  assert.equal(connection.domains.length, 0);
  assert.equal((await hostingConnections()).length, 1);
  const events = (await database().prepare("SELECT data FROM activity").all());
  assert.ok(!JSON.stringify(events).includes(input.secret));
  assert.ok(!JSON.stringify(events).includes("replacement-token"));
});
