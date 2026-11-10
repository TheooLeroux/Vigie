import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { authFixture } from "./auth-fixture";
import { GET as readWatch } from "../src/app/api/[...path]/route";
import { GET } from "../src/app/api/maintenance/security-watch/route";
import { readSecurityWatchSnapshot, refreshSecurityWatchSnapshot } from "../src/lib/security-watch-cache";

test("Surveillance planifiée : authentification, déclenchement automatique et cache privé", async t => {
  const secret = randomBytes(32).toString("hex");
  process.env.CRON_SECRET = secret;
  process.env.VIGIE_UPDATES_RUNNER_REPOSITORY = "qa/vigie";
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = JSON.stringify({ qa: "unit-test-only" });
  const dispatches: unknown[] = [];
  let advisoryReads = 0;
  t.mock.method(globalThis, "fetch", async (input: string, options?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, "api.github.com");
    if (url.pathname === "/advisories") {
      advisoryReads++;
      return Response.json([]);
    }
    assert.equal(url.pathname, "/repos/qa/vigie/actions/workflows/vigie-wordpress-agents.yml/dispatches");
    assert.equal(options?.method, "POST");
    dispatches.push(JSON.parse(options!.body as string));
    return new Response(null, { status: 204 });
  });
  const request = (authorization?: string) => new Request("http://127.0.0.1:3001/api/maintenance/security-watch", {
    headers: authorization ? { authorization } : {},
  });
  const { cookie } = await authFixture();
  const readDashboard = () => readWatch(new Request("http://127.0.0.1:3001/api/security-watch", { headers: { cookie } }), {
    params: Promise.resolve({ path: ["security-watch"] }),
  });
  assert.equal((await GET(request())).status, 401);
  assert.equal((await GET(request("Bearer invalid"))).status, 401);
  assert.equal(dispatches.length, 0);
  assert.equal(await readSecurityWatchSnapshot(), null);
  assert.equal((await readDashboard()).status, 503);
  assert.equal(advisoryReads, 0);

  const response = await GET(request(`Bearer ${secret}`));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(dispatches, [{ ref: "main", inputs: { security_only: true } }]);
  const snapshot = await readSecurityWatchSnapshot();
  assert.ok(snapshot);
  assert.deepEqual(snapshot.watch.coverage, { projects: 0, fullyCovered: 0 });
  const dashboard = await readDashboard();
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await dashboard.json(), { ...snapshot.watch, savedAt: snapshot.savedAt });
  assert.equal(advisoryReads, 1);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(5 * 60_000);
  assert.equal((await GET(request(`Bearer ${secret}`))).status, 204);
  assert.deepEqual(await readSecurityWatchSnapshot(), snapshot);
  await refreshSecurityWatchSnapshot(AbortSignal.abort());
  assert.deepEqual(await readSecurityWatchSnapshot(), snapshot);
  t.mock.timers.tick(10 * 60_000);
  await Promise.all([
    refreshSecurityWatchSnapshot(new AbortController().signal),
    refreshSecurityWatchSnapshot(new AbortController().signal),
  ]);
  const updated = await readSecurityWatchSnapshot();
  assert.ok(updated && updated.savedAt > snapshot.savedAt);
  assert.equal(advisoryReads, 2);
  t.mock.timers.reset();

  process.env.BETTER_AUTH_URL = "https://vigie.example.test";
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "production";
  process.env.VERCEL_URL = "vigie-deployment.vercel.app";
  const deployment = (host: string, authorization?: string) => new Request(`https://${host}/api/maintenance/security-watch`, {
    headers: authorization ? { authorization } : {},
  });
  assert.equal((await GET(deployment(process.env.VERCEL_URL))).status, 401);
  assert.equal((await GET(deployment("another-deployment.vercel.app", `Bearer ${secret}`))).status, 403);
  assert.equal((await GET(deployment(process.env.VERCEL_URL, `Bearer ${secret}`))).status, 204);
});
