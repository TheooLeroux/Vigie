import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { authFixture } from "./auth-fixture";
import { GET as readWatch } from "../src/app/api/[...path]/route";
import { GET } from "../src/app/api/maintenance/security-watch/route";
import { loadSecurityWatchSnapshot, readSecurityWatchSnapshot, refreshSecurityWatchSnapshot } from "../src/lib/security-watch-cache";
import { sqliteDatabase } from "../src/lib/db-sqlite";
import { claimScheduledMaintenance } from "../src/lib/scheduled-maintenance";

test("Surveillance planifiée : authentification, déclenchement automatique et cache privé", async t => {
  const secret = randomBytes(32).toString("hex");
  process.env.CRON_SECRET = secret;
  process.env.VIGIE_UPDATES_RUNNER_REPOSITORY = "qa/vigie";
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = JSON.stringify({ qa: "unit-test-only" });
  const dispatches: unknown[] = [];
  let advisoryReads = 0;
  let rejectDispatch = false;
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
    if (rejectDispatch) return new Response(null, { status: 503 });
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
  assert.equal((await GET(request(`Bearer ${secret}`))).status, 204);
  assert.equal(dispatches.length, 1);
  t.mock.timers.tick(5 * 60_000);
  assert.equal((await GET(request(`Bearer ${secret}`))).status, 204);
  assert.equal(dispatches.length, 2);
  assert.equal(await claimScheduledMaintenance("fallback"), null);
  assert.deepEqual(await readSecurityWatchSnapshot(), snapshot);
  await refreshSecurityWatchSnapshot(AbortSignal.abort());
  assert.deepEqual(await readSecurityWatchSnapshot(), snapshot);
  t.mock.timers.tick(10 * 60_000);
  const entries = new Map<string, unknown>();
  const cache = {
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, value: unknown) => { entries.set(key, value); },
  };
  await Promise.all([
    refreshSecurityWatchSnapshot(new AbortController().signal, cache),
    refreshSecurityWatchSnapshot(new AbortController().signal, cache),
  ]);
  const updated = await readSecurityWatchSnapshot();
  assert.ok(updated && updated.savedAt > snapshot.savedAt);
  const database = sqliteDatabase();
  const prepare = t.mock.method(database, "prepare");
  assert.deepEqual(await loadSecurityWatchSnapshot(undefined, cache), { snapshot: updated, source: "cache" });
  assert.equal(prepare.mock.callCount(), 0);
  await refreshSecurityWatchSnapshot(new AbortController().signal, cache);
  assert.equal(prepare.mock.callCount(), 0);
  const unavailableCache = { ...cache, get: async () => { throw new Error("cache unavailable"); } };
  await refreshSecurityWatchSnapshot(new AbortController().signal, unavailableCache);
  assert.ok(prepare.mock.callCount() > 0);
  assert.deepEqual(await loadSecurityWatchSnapshot("2099-01-01T00:00:00.000Z", cache), { snapshot: updated, source: "neon" });
  assert.deepEqual(await loadSecurityWatchSnapshot(null, cache), { snapshot: updated, source: "neon" });
  assert.deepEqual(await loadSecurityWatchSnapshot(undefined, unavailableCache), { snapshot: updated, source: "neon" });
  prepare.mock.restore();
  assert.equal(advisoryReads, 2);
  const fallback = await claimScheduledMaintenance("fallback");
  assert.ok(fallback);
  assert.equal((await GET(request(`Bearer ${secret}`))).status, 204);
  assert.equal(dispatches.length, 2);
  t.mock.timers.tick(5 * 60_000);
  rejectDispatch = true;
  assert.equal((await GET(request(`Bearer ${secret}`))).status, 502);
  rejectDispatch = false;
  assert.equal((await GET(request(`Bearer ${secret}`))).status, 204);
  assert.equal(dispatches.length, 4);
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
