import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createProject, transaction } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import { saveHostingConnection } from "../src/lib/hosting-connections";
import { applyDiscoverySnapshot, hostingDiscovery } from "../src/lib/hosting-discovery";
import { refreshWordPressWeb, wordpressWebSignature, verifyWordPressWebSignature, wordpressWebCheckBody } from "../src/lib/updates/wordpress-web-check";
import { POST } from "../src/app/api/maintenance/wordpress/route";

process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
test("Contrôle web distant : signature liée au corps, fraîcheur et actions strictement limitées à la lecture", () => {
  const body = JSON.stringify({ installationId: randomUUID(), action: "preflight" });
  const time = String(Math.floor(Date.now() / 1000)), signature = wordpressWebSignature(body, time);
  assert.doesNotThrow(() => verifyWordPressWebSignature(body, time, signature));
  assert.throws(() => verifyWordPressWebSignature(body + " ", time, signature), /non autorisé/);
  assert.throws(() => verifyWordPressWebSignature(body, String(Number(time) - 120), signature), /non autorisé/);
  assert.throws(() => verifyWordPressWebSignature(body, time, "0".repeat(64)), /non autorisé/);
  assert.throws(() => wordpressWebCheckBody.parse({ installationId: randomUUID(), action: "update" }));
  assert.throws(() => wordpressWebCheckBody.parse({ installationId: randomUUID(), action: "inventory", url: "https://another-site.test" }));
});
test("Route de contrôle : refus des appels anonymes et des corps excessifs avant tout accès à un site", async () => {
  const r = await POST(new Request("https://vigie.example.test/api/maintenance/wordpress", { method: "POST", body: "{}" }));
  assert.equal(r.status, 401);
  const large = await POST(new Request("https://vigie.example.test/api/maintenance/wordpress", { method: "POST", body: "x".repeat(2049) }));
  assert.equal(large.status, 413);
});

test("Route de contrôle : un corps signé mais mal formé donne une erreur de saisie", async () => {
  const body = "{";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await POST(new Request("https://vigie.example.test/api/maintenance/wordpress", {
    method: "POST",
    body,
    headers: { "X-Vigie-Time": timestamp, "X-Vigie-Signature": wordpressWebSignature(body, timestamp) },
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "JSON invalide.");
});

test("Contrôle local : les actions de maintenance vérifient le rattachement avant de contacter le site", async () => {
  const controlUrl = process.env.VIGIE_WORDPRESS_CONTROL_URL;
  delete process.env.VIGIE_WORDPRESS_CONTROL_URL;
  try {
    for (const action of ["preflight", "postflight", "inventory"] as const) {
      await assert.rejects(refreshWordPressWeb({ remoteId: randomUUID() }, action), /Installation introuvable/);
    }
  } finally {
    if (controlUrl !== undefined) process.env.VIGIE_WORDPRESS_CONTROL_URL = controlUrl;
  }
});

test("Contrôle WordPress : une tâche liée à un autre projet ou compte est refusée en local et à distance", async t => {
  const domain = "audit-wordpress.example.test";
  const root = "/home/auditwp/site";
  const host = await saveHostingConnection({ name: "Contrôle WordPress", endpoint: "https://gaz.o2switch.net:2083", username: "auditwp", secret: "fixture" });
  const project = await transaction(async () => {
    const item = await createProject("live", createProjectSchema.parse({ name: "Contrôle WordPress", url: "https://" + domain }));
    await applyDiscoverySnapshot(host, {
      observedAt: new Date().toISOString(),
      installations: [{ documentRoot: root, domains: [domain], aliases: [], kind: "wordpress", version: "6.8.3", inspectionError: null, suggestedEnvironment: "production" }],
    });
    return item;
  });
  const [site] = (await hostingDiscovery(host.id)).installations;
  assert.equal(site.project?.id, project.id);
  const target = { remoteId: site.id, projectId: project.id, connectionId: host.id, root };
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Aucun appel attendu"); });
  const previous = process.env.VIGIE_WORDPRESS_CONTROL_URL;
  try {
    for (const controlUrl of [undefined, "https://vigie.example.test"]) {
      if (controlUrl) process.env.VIGIE_WORDPRESS_CONTROL_URL = controlUrl;
      else delete process.env.VIGIE_WORDPRESS_CONTROL_URL;
      for (const difference of [{ projectId: randomUUID() }, { connectionId: randomUUID() }, { root: root + "-other" }]) {
        await assert.rejects(refreshWordPressWeb({ ...target, ...difference }, "preflight"), /rattachement WordPress a changé/);
      }
    }
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    if (previous === undefined) delete process.env.VIGIE_WORDPRESS_CONTROL_URL;
    else process.env.VIGIE_WORDPRESS_CONTROL_URL = previous;
  }
});
