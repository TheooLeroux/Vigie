import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import "./auth-fixture";
import { GET } from "../src/app/api/maintenance/security-watch/route";
import { readSecurityWatchSnapshot, refreshSecurityWatchSnapshot } from "../src/lib/security-watch-cache";

test("Surveillance planifiée : authentification, déclenchement automatique et cache privé", async t => {
  const secret = randomBytes(32).toString("hex");
  process.env.CRON_SECRET = secret;
  process.env.VIGIE_UPDATES_RUNNER_REPOSITORY = "qa/vigie";
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = JSON.stringify({ qa: "unit-test-only" });
  const dispatches: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, options?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, "api.github.com");
    if (url.pathname === "/advisories") return Response.json([]);
    assert.equal(url.pathname, "/repos/qa/vigie/actions/workflows/vigie-wordpress-agents.yml/dispatches");
    assert.equal(options?.method, "POST");
    dispatches.push(JSON.parse(options!.body as string));
    return new Response(null, { status: 204 });
  });
  const request = (authorization?: string) => new Request("http://127.0.0.1:3001/api/maintenance/security-watch", {
    headers: authorization ? { authorization } : {},
  });
  assert.equal((await GET(request())).status, 401);
  assert.equal((await GET(request("Bearer invalid"))).status, 401);
  assert.equal(dispatches.length, 0);
  assert.equal(await readSecurityWatchSnapshot(), null);

  const response = await GET(request(`Bearer ${secret}`));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(dispatches, [{ ref: "main", inputs: { security_only: true } }]);
  const snapshot = await readSecurityWatchSnapshot();
  assert.ok(snapshot);
  assert.deepEqual(snapshot.watch.coverage, { projects: 0, fullyCovered: 0 });
  await refreshSecurityWatchSnapshot(AbortSignal.abort());
  assert.deepEqual(await readSecurityWatchSnapshot(), snapshot);
});
