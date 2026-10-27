import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { wordpressWebSignature, verifyWordPressWebSignature, wordpressWebCheckBody } from "../src/lib/updates/wordpress-web-check";
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
