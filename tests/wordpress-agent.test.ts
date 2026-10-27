import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { agentBundle, agentDirectory, agentRequestId, assertAgentRunStopped, localAgentOperation, openAgentPayload, signAgentPayload, type AgentFiles, type LocalAgentSettings } from "../src/lib/updates/wordpress-agent";

const root = "/home/fixture/site";
const settings: LocalAgentSettings = { protocol: "vigie-local-v1", directory: agentDirectory(root, "fixture"), secret: randomBytes(32).toString("hex"), phpBinary: "/opt/alt/php83/usr/bin/php", wpBinary: "/usr/local/bin/wp", environment: "staging", ready: true };
test("Agent local : signature des deux sens, altération et clé d’inventaire refusées", () => {
  const body = { operation: "inspect", id: randomUUID(), root };
  const signed = signAgentPayload(body, settings.secret);
  assert.deepEqual(openAgentPayload(signed, settings.secret), body);
  assert.throws(() => openAgentPayload({ ...signed, payload: Buffer.from('{"operation":"update"}').toString("base64") }, settings.secret), /Signature/);
  assert.throws(() => openAgentPayload(signed, randomBytes(32).toString("hex")), /Signature/);
  assert.throws(() => agentDirectory("/home/fixture/../../public", "fixture"), /non autorisé/);
  assert.throws(() => agentDirectory("/home/other/site", "fixture"), /non autorisé/);
  assert.throws(() => agentDirectory("/home/fixture/.vigie-agent/site", "fixture"), /hors/);
});
test("Agent local : le paquet lie les sources, la racine et le PHP sans contenir de secret d’inventaire", async () => {
  const bundle = await agentBundle(root, "fixture", "8.3.30", "staging", settings);
  const config = JSON.parse(bundle.files["config.json"]);
  assert.equal(config.root, root);
  assert.equal(bundle.settings.ready, false);
  assert.match(bundle.cron, /\/opt\/alt\/php83\/usr\/bin\/php/);
  assert.match(config.workerSha256, /^[a-f0-9]{64}$/);
  assert.match(config.planSha256, /^[a-f0-9]{64}$/);
  assert.equal(bundle.files["agent.php"].includes(settings.secret), false);
});
test("Agent local : double envoi réutilisé, demande différente et résultat d’un autre site refusés", async () => {
  const runId = randomUUID(), data = new Map<string, string>(); let writes = 0;
  const files: AgentFiles = {
    read: async path => data.get(path) || null,
    write: async (path, content) => {
      writes++; data.set(path, content);
      const job = openAgentPayload(JSON.parse(content), settings.secret) as any;
      data.set(`results/${job.id}.json`, JSON.stringify(signAgentPayload({ id: job.id, runId, operation: "inspect", root, stage: "completed", startedAt: Math.floor(Date.now() / 1000), result: { marker: true } }, settings.secret)));
    },
  };
  assert.deepEqual(await localAgentOperation(files, settings, root, runId, "inspect"), { marker: true });
  assert.deepEqual(await localAgentOperation(files, settings, root, runId, "inspect"), { marker: true });
  assert.equal(writes, 1);
  await assert.rejects(localAgentOperation(files, settings, root, runId, "inspect", { webPhp: "8.3.30" }), /différente/);
  const resultPath = [...data.keys()].find(k => k.startsWith("results/"))!;
  const result = openAgentPayload(JSON.parse(data.get(resultPath)!), settings.secret) as any;
  data.set(resultPath, JSON.stringify(signAgentPayload({ ...result, root: "/home/fixture/other" }, settings.secret)));
  await assert.rejects(localAgentOperation(files, settings, root, runId, "inspect"), /ne correspond pas/);
});
test("Agent local : une opération interrompue n’est pas réémise après délai dépassé", async () => {
  let writes = 0; const data = new Map<string, string>();
  const files: AgentFiles = { read: async path => data.get(path) || null, write: async (path, content) => { writes++; data.set(path, content); } };
  const run = randomUUID();
  await assert.rejects(localAgentOperation(files, settings, root, run, "update", {}, { timeoutMs: 10, pollMs: 1 }), /Ne relancez pas/);
  await assert.rejects(localAgentOperation(files, settings, root, run, "update", {}, { timeoutMs: 10, pollMs: 1 }), /Ne relancez pas/);
  assert.equal(writes, 1);
});
test("Agent local : la fin de GitHub Actions ne suffit pas à clôturer une tâche locale encore en attente ou active", async () => {
  const run = randomUUID(), id = agentRequestId(run, "update"), data = new Map<string, string>();
  const files: AgentFiles = { read: async name => data.get(name) || null, write: async (name, value) => { data.set(name, value); } };
  data.set(`jobs/${id}.json`, "present");
  await assert.rejects(assertAgentRunStopped(files, settings, root, run), /attente/);
  const result = { id, runId: run, operation: "update", root, stage: "running", startedAt: Math.floor(Date.now()/1000) };
  data.set(`results/${id}.json`, JSON.stringify(signAgentPayload(result, settings.secret)));
  await assert.rejects(assertAgentRunStopped(files, settings, root, run), /verrou/);
  data.set(`results/${id}.json`, JSON.stringify(signAgentPayload({ ...result, stage: "failed" }, settings.secret)));
  await assertAgentRunStopped(files, settings, root, run);
});
