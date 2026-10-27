import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "../src/lib/http";
import { createProject, transaction } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import { saveHostingConnection } from "../src/lib/hosting-connections";
import { applyDiscoverySnapshot, hostingDiscovery, hostingInstallation } from "../src/lib/hosting-discovery";
import { hostingStorage } from "../src/lib/hosting-storage";
import { processAgentInstallation, requestAgentInstallation, requestLinkedAgents, reconcileAgentInstallations } from "../src/lib/updates/wordpress-agent-setup";
import { readUpdateSource, writeUpdateSource, updateStorage } from "../src/lib/updates/storage";

process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
async function fixture() {
  const domain = `${randomUUID()}.example.test`;
  const username = "a" + randomUUID().replaceAll("-", "").slice(0, 10);
  const host = await saveHostingConnection({ name: domain, endpoint: "https://gaz.o2switch.net:2083", username, authMode: "token", secret: "fixture-only" });
  const project = await transaction(() => createProject("live", createProjectSchema.parse({ name: "Automatic agent", url: `https://${domain}` })));
  await applyDiscoverySnapshot(host, { observedAt: new Date().toISOString(), installations: [{ documentRoot: `/home/${username}/${domain}`, domains: [domain], aliases: [], kind: "wordpress", version: "6.8.3", inspectionError: null, suggestedEnvironment: "production" }] });
  const site = (await hostingDiscovery(host.id)).installations[0];
  await (await hostingStorage()).prepare("INSERT INTO hosting_site_inventories(installation_id,data) VALUES(?,?)").run(site.id, JSON.stringify({ source: "wordpress-observer", observedAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(), error: null, php: { version: "8.2.35" }, plugins: [], themes: [] }));
  return { host, project, site, targetId: `wordpress:${site.id}` };
}

test("Installation automatique : demande durable, déduplication et un seul propriétaire actif", async () => {
  const f = await fixture(); let dispatched = 0, provisions = 0;
  const dispatch = async () => { dispatched++; };
  assert.equal((await requestAgentInstallation(f.site.id, dispatch)).queued, true);
  const requestId = (await readUpdateSource(f.targetId))!.settings.agentInstallation!.requestId;
  assert.equal((await requestAgentInstallation(f.site.id, dispatch)).queued, false);
  assert.equal(dispatched, 1);
  let release!: () => void, signal!: () => void;
  const started = new Promise<void>(resolve => { signal = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const deps = { prepare: hostingInstallation, provision: async () => { provisions++; signal(); await blocked; } };
  const first = processAgentInstallation(f.site.id, requestId, deps);
  await started;
  assert.equal(await processAgentInstallation(f.site.id, requestId, deps), false);
  assert.equal((await requestAgentInstallation(f.site.id, dispatch, true)).queued, false);
  assert.equal((await readUpdateSource(f.targetId))!.settings.agentInstallation!.state, "installing");
  release(); assert.equal(await first, true);
  assert.equal((await readUpdateSource(f.targetId))!.settings.agentInstallation!.state, "ready");
  assert.equal((await requestAgentInstallation(f.site.id, dispatch)).queued, false);
  assert.equal(provisions, 1);
});

test("Installation automatique : panne du déclencheur, reprise temporisée et clé conservée", async () => {
  const f = await fixture(); let provisions = 0;
  assert.equal((await requestAgentInstallation(f.site.id, async () => { throw new Error("fixture-private-token"); })).queued, true);
  let source = (await readUpdateSource(f.targetId))!;
  assert.equal(source.settings.agentInstallation!.state, "queued");
  assert.equal(JSON.stringify(source.settings.agentInstallation).includes("fixture-private-token"), false);
  const deps = { prepare: hostingInstallation, provision: async () => { provisions++; throw new ApiError("fixture_failed"); } };
  assert.equal(await processAgentInstallation(f.site.id, undefined, deps), false);
  source = (await readUpdateSource(f.targetId))!;
  const secret = source.settings.localAgent!.secret;
  assert.equal(source.settings.agentInstallation!.state, "failed");
  assert.ok(Date.parse(source.settings.agentInstallation!.nextAttemptAt!) > Date.now());
  assert.equal((await requestAgentInstallation(f.site.id, async () => {})).queued, false);
  assert.equal(await processAgentInstallation(f.site.id, undefined, deps), false);
  assert.equal(provisions, 1);
  await requestAgentInstallation(f.site.id, async () => {}, true);
  assert.equal(await processAgentInstallation(f.site.id, source.settings.agentInstallation!.requestId, deps), false);
  assert.equal(await processAgentInstallation(f.site.id, undefined, { prepare: hostingInstallation, provision: async () => {} }), true);
  assert.equal((await readUpdateSource(f.targetId))!.settings.localAgent!.secret, secret);
});

test("Installation automatique : rattrapage des sites existants et ajout ultérieur, sans site non rattaché", async () => {
  const f = await fixture(); let dispatched = 0;
  const dispatch = async () => { dispatched++; };
  assert.deepEqual(await requestLinkedAgents(f.host.id, dispatch), { queued: 1 });
  const domain = `${randomUUID()}.example.test`, unlinked = `${randomUUID()}.example.test`;
  await transaction(() => createProject("live", createProjectSchema.parse({ name: "New WordPress", url: `https://${domain}` })));
  await applyDiscoverySnapshot(f.host, { observedAt: new Date().toISOString(), installations: [
    ...[f.site.domains[0], domain, unlinked].map(name => ({ documentRoot: `/home/${f.host.username}/${name}`, domains: [name], aliases: [], kind: "wordpress" as const, version: "6.8.3", inspectionError: null, suggestedEnvironment: "production" as const })),
  ] });
  assert.deepEqual(await requestLinkedAgents(f.host.id, dispatch), { queued: 1 });
  assert.equal(dispatched, 2);
  const site = (await hostingDiscovery(f.host.id)).installations.find(site => site.domains.includes(unlinked))!;
  assert.equal((await requestAgentInstallation(site.id, dispatch)).queued, false);
  assert.equal(await readUpdateSource(`wordpress:${site.id}`), null);
});

test("Installation automatique : un ancien worker ne publie pas le résultat d’une demande remplacée", async () => {
  const f = await fixture(); await requestAgentInstallation(f.site.id, async () => {});
  let release!: () => void, signal!: () => void;
  const started = new Promise<void>(resolve => { signal = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = processAgentInstallation(f.site.id, undefined, { prepare: hostingInstallation, provision: async () => { signal(); await blocked; } });
  await started;
  const source = (await readUpdateSource(f.targetId))!;
  await writeUpdateSource(f.targetId, f.project.id, { ...source.settings, agentInstallation: { ...source.settings.agentInstallation!, leaseUntil: new Date(0).toISOString() } });
  await requestAgentInstallation(f.site.id, async () => {}, true);
  const requestId = (await readUpdateSource(f.targetId))!.settings.agentInstallation!.requestId;
  release(); assert.equal(await first, false);
  const current = (await readUpdateSource(f.targetId))!.settings;
  assert.equal(current.agentInstallation!.requestId, requestId);
  assert.equal(current.agentInstallation!.state, "queued");
  assert.equal(current.localAgent!.ready, false);
});

test("Installation automatique : aucune installation pendant une maintenance verrouillée", async () => {
  const f = await fixture(), db = await updateStorage(), runId = randomUUID(), scope = `o2switch:${f.host.id}:${f.site.id}:`;
  await db.prepare("INSERT INTO update_runs(id,project_id,stage,data) VALUES(?,?,?,?)").run(runId, f.project.id, "queued", "{}");
  await db.prepare("INSERT INTO update_locks(scope,run_id) VALUES(?,?)").run(scope, runId);
  assert.equal((await requestAgentInstallation(f.site.id, async () => {})).queued, false);
  await db.prepare("DELETE FROM update_locks WHERE run_id=?").run(runId);
  await requestAgentInstallation(f.site.id, async () => {});
  await db.prepare("INSERT INTO update_locks(scope,run_id) VALUES(?,?)").run(scope, runId);
  assert.equal(await processAgentInstallation(f.site.id, undefined, { prepare: hostingInstallation, provision: async () => { throw new Error("Must not install"); } }), false);
  assert.equal((await readUpdateSource(f.targetId))!.settings.agentInstallation!.state, "queued");
  await db.prepare("DELETE FROM update_locks WHERE run_id=?").run(runId);
  assert.equal(await processAgentInstallation(f.site.id, undefined, { prepare: hostingInstallation, provision: async () => {} }), true);
});

test("Installation automatique : un agent arrêté est réparé par le contrôle du parc, sans changer sa clé", async () => {
  const f = await fixture(); await requestAgentInstallation(f.site.id, async () => {});
  await processAgentInstallation(f.site.id, undefined, { prepare: hostingInstallation, provision: async () => {} });
  const secret = (await readUpdateSource(f.targetId))!.settings.localAgent!.secret;
  let repairs = 0;
  const deps = { prepare: hostingInstallation, healthy: async (site: typeof f.site) => site.id !== f.site.id, provision: async (target: { remoteId: string }) => { if (target.remoteId === f.site.id) repairs++; } };
  await reconcileAgentInstallations(deps);
  assert.equal(repairs, 1);
  assert.equal((await readUpdateSource(f.targetId))!.settings.localAgent!.secret, secret);
  assert.equal((await readUpdateSource(f.targetId))!.settings.agentInstallation!.state, "ready");
  await reconcileAgentInstallations({ ...deps, healthy: async () => true });
  assert.equal(repairs, 1);
});
