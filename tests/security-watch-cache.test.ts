import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { authFixture } from "./auth-fixture";
import { GET as readWatch } from "../src/app/api/[...path]/route";
import { GET } from "../src/app/api/maintenance/security-watch/route";
import { loadSecurityWatchSnapshot, readSecurityWatchSnapshot, refreshSecurityWatchSnapshot } from "../src/lib/security-watch-cache";
import { sqliteDatabase } from "../src/lib/db-sqlite";
import { claimScheduledMaintenance, recentSuccessfulPrimaryCycle } from "../src/lib/scheduled-maintenance";
import { maintenanceCache } from "../src/lib/scheduled-maintenance-cache";
import { fullMaintenancePlan, maintenanceHasWork, maintenanceSignature } from "../src/lib/maintenance-plan";
import { securityWatchSnapshotKey } from "../src/lib/security-watch";
import { GET as readPlan, POST as publishWorkerSnapshot } from "../src/app/api/maintenance/plan/route";
import { readWorkerMaintenancePlan } from "../scripts/maintenance-plan";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Le cache donne aux workers un plan sans Neon et conserve la reprise par projet", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-13T13:00:00Z") });
  t.mock.method(console, "warn", () => {});
  const previousKey = process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY;
  process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = "b".repeat(64);
  t.after(() => {
    if (previousKey === undefined) delete process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY;
    else process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = previousKey;
  });
  const saved = new Map<string, unknown>();
  let probesRead = 0;
  const projectId = "a1234567-1111-4111-8111-123456789012";
  const dueAt = Date.now() + 6 * 60_000;
  const credentials = "existing-connector-credential";
  const store = {
    get: async (key: string) => saved.get(key) ?? null,
    set: async (key: string, value: unknown) => { saved.set(key, value); },
  };
  const checks = {
    deadlines: async () => [{ provider: "railway" as const, projectId, dueAt }],
    readProbes: async () => {
      probesRead++;
      return { vercel: [{ teamId: "team_example", token: credentials, digest: "example", observedAt: null, error: false }], railway: [], hosting: [] };
    },
    probe: async (probes: { vercel: ({ token: string } | null)[] }) => {
      assert.equal(probes.vercel[0]?.token, credentials);
    },
  };
  const runner = { repository: "qa/vigie", ref: "main", token: "existing-github-credential" };
  const cache = maintenanceCache(runner, "a".repeat(40), store, checks);
  assert.equal(await cache.plan(), null);
  await cache.refresh();
  assert.ok(!JSON.stringify([...saved]).includes(credentials));
  t.mock.timers.tick(5 * 60_000);
  const idle = await cache.plan();
  assert.ok(idle && !maintenanceHasWork(idle.plan));
  await cache.publishPlan("idle", idle);
  assert.deepEqual(await cache.readPlan("idle"), idle.plan);
  assert.equal(probesRead, 1);
  t.mock.timers.tick(60_000);
  const scheduled = await cache.plan();
  assert.deepEqual(scheduled?.plan.security, { vercel: [], railway: [projectId], o2switch: [] });
  t.mock.timers.tick(4 * 60_000);
  assert.deepEqual(await cache.readPlan("idle"), fullMaintenancePlan);
  await store.set("vigie:scheduled-maintenance:2:generation", "updated");
  assert.equal(await cache.plan(), null);
});

test("Un cycle planifié sans travail traverse le cron et le worker sans réservation SQL", async t => {
  const directory = await mkdtemp(join(tmpdir(), "vigie-maintenance-"));
  const eventPath = join(directory, "event.json");
  const environment = {
    CRON_SECRET: "cron-test",
    VERCEL: "1", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "d".repeat(40),
    VERCEL_URL: "vigie-deployment.vercel.app", BETTER_AUTH_URL: "https://vigie-azure.vercel.app",
    VIGIE_CONNECTOR_ENCRYPTION_KEY: "e".repeat(64), VIGIE_UPDATES_RUNNER_REPOSITORY: "qa/vigie",
    VIGIE_UPDATES_GITHUB_TOKENS: '{"qa":"unit-test"}', GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath,
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    sqliteDatabase().prepare("DELETE FROM wordpress_catalog WHERE cache_key IN (?,?,?)")
      .run(securityWatchSnapshotKey, "hosting:observation:lease:security-watch", "hosting:observation:lease:scheduled-maintenance");
    await rm(directory, { recursive: true, force: true });
  });
  const sent: { request_id?: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, options?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/advisories") return Response.json([]);
    assert.match(url.pathname, /\/dispatches$/);
    sent.push(JSON.parse(options!.body as string).inputs);
    return new Response(null, { status: 204 });
  });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 30 * 60_000 });
  const run = () => GET(new Request("https://vigie-deployment.vercel.app/api/maintenance/security-watch", {
    headers: { Authorization: "Bearer cron-test" },
  }));
  assert.equal((await run()).status, 204);
  const initialId = sent[0]?.request_id;
  assert.ok(initialId);
  assert.equal((await publishWorkerSnapshot(new Request(`https://vigie-azure.vercel.app/api/maintenance/plan?id=${initialId}`, {
    method: "POST", headers: { Authorization: `Bearer ${maintenanceSignature(initialId)}` },
  }))).status, 204);
  t.mock.timers.tick(5 * 60_000);
  const database = sqliteDatabase();
  const prepare = t.mock.method(database, "prepare");
  assert.equal((await run()).status, 204);
  assert.equal(prepare.mock.callCount(), 0);
  assert.equal(sent.length, 2);
  const id = sent[1].request_id;
  assert.ok(id && maintenanceSignature(id));
  await writeFile(eventPath, JSON.stringify({ inputs: { security_only: true, request_id: id } }));
  const transport: typeof fetch = async (input, options) => readPlan(new Request(input, options));
  const plan = await readWorkerMaintenancePlan(transport);
  assert.equal(maintenanceHasWork(plan), false);
  assert.equal(prepare.mock.callCount(), 0);
  assert.deepEqual(await (await readPlan(new Request("https://vigie-azure.vercel.app/api/maintenance/plan?fallback=1"))).json(), { recent: true });
  assert.equal((await readPlan(new Request(`https://vigie-azure.vercel.app/api/maintenance/plan?id=${id}`))).status, 401);
  assert.deepEqual(await readWorkerMaintenancePlan(async () => new Response(null, { status: 503 })), fullMaintenancePlan);
  t.mock.timers.tick(4 * 60_000);
  assert.deepEqual(await readWorkerMaintenancePlan(transport), fullMaintenancePlan);
});

test("Le secours GitHub passe son tour uniquement si le dernier cycle récent a couvert tout le parc", async () => {
  const completed = {
    event: "workflow_dispatch", head_branch: "main", display_title: "security-watch",
    id: 123, run_attempt: 2, created_at: new Date(Date.now() - 120_000).toISOString(),
    status: "completed", conclusion: "success",
  };
  const fleet = [
    "agents", "wordpress-observations", "wordpress-security",
    "observations (o2switch)", "observations (railway)", "observations (vercel)",
    "providers (railway)", "providers (vercel)",
  ].map(name => ({ name, conclusion: "success" }));
  const check = (runs: typeof completed[], jobs = fleet) =>
    recentSuccessfulPrimaryCycle("qa/vigie", "main", async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/jobs")) {
        assert.match(url.pathname, /\/runs\/123\/attempts\/2\/jobs$/);
        return Response.json({ jobs });
      }
      return Response.json({ workflow_runs: runs, total_count: runs.length });
    });
  assert.equal(await check([completed]), true);
  assert.equal(await check([completed], fleet.slice(1)), false);
  assert.equal(await check([completed], [...fleet.slice(1), { ...fleet[0], conclusion: "skipped" }]), false);
  assert.equal(await check([{ ...completed, created_at: new Date(Date.now() - 600_000).toISOString() }]), false);
  assert.equal(await check([completed, {
    ...completed, id: 124, created_at: new Date().toISOString(), status: "in_progress", conclusion: "",
  }]), false);
  assert.equal(await recentSuccessfulPrimaryCycle("qa/vigie", "main", async () => new Response(null, { status: 429 })), false);
});

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
