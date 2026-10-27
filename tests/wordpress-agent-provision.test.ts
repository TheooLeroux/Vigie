import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { saveHostingConnection } from "../src/lib/hosting-connections";
import { applyDiscoverySnapshot, hostingDiscovery, hostingInstallation } from "../src/lib/hosting-discovery";
import { createProject, transaction } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import { configureUpdateSource } from "../src/lib/updates/service";
import { updateTargets } from "../src/lib/updates/targets";
import { readUpdateSource, writeUpdateSource } from "../src/lib/updates/storage";
import { agentDirectory, openAgentPayload, signAgentPayload, withLocalWordPressAgent } from "../src/lib/updates/wordpress-agent";
import { hostingStorage } from "../src/lib/hosting-storage";
import { processAgentInstallation, requestAgentInstallation } from "../src/lib/updates/wordpress-agent-setup";

process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
test("Agent local : installation de production mise en attente automatiquement sans autoriser les mises à jour", async () => {
  const domain = `${randomUUID()}.example.test`, root = `/home/agenttest/${domain}`;
  const host = await saveHostingConnection({ name: "Agent fixture", endpoint: "https://gaz.o2switch.net:2083", username: "agenttest", authMode: "token", secret: "fixture-no-real-secret" });
  const project = await transaction(async () => {
    const project = await createProject("live", createProjectSchema.parse({ name: "Agent fixture", url: `https://${domain}` }));
    await applyDiscoverySnapshot(host, { observedAt: new Date().toISOString(), installations: [{ documentRoot: root, domains: [domain], aliases: [], kind: "wordpress", version: "6.8.3", inspectionError: null, suggestedEnvironment: "production" }] });
    return project;
  });
  const item = (await hostingDiscovery(host.id)).installations[0]; assert.equal(item.project?.id, project.id);
  const target = (await updateTargets(project.id))[0];
  const before = process.env.VIGIE_WORDPRESS_AGENT_PRODUCTION_ENABLED; delete process.env.VIGIE_WORDPRESS_AGENT_PRODUCTION_ENABLED;
  const fetchBefore = globalThis.fetch; let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("No network expected"); }) as typeof fetch;
  try {
    const requested = await configureUpdateSource(project.id, { targetId: target.id, localAgent: true });
    assert.equal(requested.configured, false);
    assert.equal((await readUpdateSource(target.id))?.settings.agentInstallation?.state, "queued");
    assert.equal(networkCalls, 0);
    await writeUpdateSource(target.id, project.id, { localAgent: { protocol: "vigie-local-v1", directory: agentDirectory(root, "agenttest"), secret: randomBytes(32).toString("hex"), phpBinary: "/opt/alt/php83/usr/bin/php", wpBinary: "/usr/local/bin/wp", environment: "production", ready: false } });
    assert.equal((await updateTargets(project.id))[0].configured, false);
    await assert.rejects(withLocalWordPressAgent(target, async () => { throw new Error("Must not execute"); }), /n’est pas configuré/);
    const pending = (await readUpdateSource(target.id))!.settings;
    await writeUpdateSource(target.id, project.id, { ...pending, localAgent: { ...pending.localAgent!, ready: true } });
    await assert.rejects(withLocalWordPressAgent(target, async () => { throw new Error("Must not execute"); }), /production.*pas encore activées/);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = fetchBefore;
    if (before === undefined) delete process.env.VIGIE_WORDPRESS_AGENT_PRODUCTION_ENABLED; else process.env.VIGIE_WORDPRESS_AGENT_PRODUCTION_ENABLED = before;
  }
});
test("Agent local : provisionnement cPanel, battement et inspection obligatoires ; refus d’un agent altéré", async () => {
  const domain = `${randomUUID()}.example.test`, root = `/home/agentstage/myTiger-Preprod/${domain}`, php = "8.3.36";
  const host = await saveHostingConnection({ name: "Agent stage fixture", endpoint: "https://gaz.o2switch.net:2083", username: "agentstage", authMode: "token", secret: "fixture-no-real-secret" });
  const project = await transaction(async () => {
    const project = await createProject("live", createProjectSchema.parse({ name: "Agent stage fixture", url: `https://${domain}` }));
    await applyDiscoverySnapshot(host, { observedAt: new Date().toISOString(), installations: [{ documentRoot: root, domains: [domain], aliases: [], kind: "wordpress", version: "6.8.3", inspectionError: null, suggestedEnvironment: "staging" }] });
    return project;
  });
  const item = (await hostingDiscovery(host.id)).installations[0];
  await (await hostingStorage()).prepare("INSERT INTO hosting_site_inventories(installation_id,data) VALUES(?,?)").run(item.id, JSON.stringify({ source: "wordpress-observer", collectionMode: "normal", observedAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(), error: null, php: { version: php }, site: { home: `https://${domain}`, multisite: false }, configuration: { fileModsDisabled: false }, plugins: [], themes: [] }));
  const target = (await updateTargets(project.id))[0];
  const directory = agentDirectory(root, "agentstage"), dirs = new Set(["/home/agentstage"]), files = new Map<string, string>();
  const oldCron = `/opt/alt/php83/usr/bin/php '${directory}/agent.php' '${directory}/config.json' >/dev/null 2>&1`;
  const crons: { command: string }[] = [{ command: "unrelated-account-job" }, { command: oldCron }];
  let uploads = 0, inspections = 0;
  const ok = (data: unknown) => Response.json({ status: 1, data });
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "gaz.o2switch.net");
    if (url.pathname === "/execute/DomainInfo/domains_data") return ok([{ documentroot: root }]);
    if (url.pathname === "/execute/Fileman/list_files") {
      const dir = url.searchParams.get("dir")!;
      const rows = [...dirs].filter(path => path !== dir && path.slice(0, path.lastIndexOf("/")) === dir).map(path => ({ file: path.split("/").at(-1), type: "dir", mode: 16832 }));
      return ok([...rows, ...[...files.keys()].filter(path => path.slice(0, path.lastIndexOf("/")) === dir).map(path => ({ file: path.split("/").at(-1), type: "file" }))]);
    }
    if (url.pathname === "/execute/Fileman/get_file_content") return ok({ content: files.get(`${url.searchParams.get("dir")}/${url.searchParams.get("file")}`) });
    if (url.pathname === "/execute/Fileman/upload_files") {
      const form = init!.body as FormData, file = form.get("file-1") as File, dir = String(form.get("dir")); const text = await file.text();
      uploads++; files.set(`${dir}/${file.name}`, text);
      if (dir === `${directory}/jobs`) {
        const config = JSON.parse(files.get(`${directory}/config.json`)!);
        const job = openAgentPayload(JSON.parse(text), config.secret) as any;
        assert.equal(job.operation, "inspect"); inspections++;
        files.set(`${directory}/results/${job.id}.json`, JSON.stringify(signAgentPayload({ id: job.id, runId: job.runId, root, operation: "inspect", stage: "completed", startedAt: Math.floor(Date.now()/1000), result: { plan: { wordpress: { current: "6.8.3", target: "6.8.3", requiresPhp: "" }, php, plugins: [], themes: [] }, eligibility: { multisite: false, fileModsDisabled: false, home: `https://${domain}` } } }, config.secret)));
      }
      return ok({});
    }
    if (url.pathname === "/json-api/cpanel") {
      const params = init!.body as URLSearchParams, module = params.get("cpanel_jsonapi_module"), fn = params.get("cpanel_jsonapi_func");
      if (module === "Fileman" && fn === "mkdir") { dirs.add(`${params.get("path")}/${params.get("name")}`); return ok([]); }
      if (module === "Cron" && fn === "listcron") return ok([...crons.map((cron, i) => ({ ...cron, count: i + 1 })), { count: crons.length + 1 }]);
      if (module === "Cron" && fn === "remove_line") { crons.splice(Number(params.get("line")) - 1, 1); return ok([]); }
      if (module === "Cron" && fn === "add_line") {
        crons.push({ command: params.get("command")! });
        const config = JSON.parse(files.get(`${directory}/config.json`)!);
        files.set(`${directory}/heartbeat.json`, JSON.stringify(signAgentPayload({ protocol: "vigie-local-v1", root, php, time: Math.floor(Date.now()/1000) }, config.secret)));
        files.set(`${directory}/readiness.json`, JSON.stringify(signAgentPayload({ protocol: "vigie-local-v1", root, php, ready: true, time: Math.floor(Date.now()/1000), eligibility: { multisite: false, fileModsDisabled: false, home: `https://${domain}` } }, config.secret)));
        return ok([]);
      }
    }
    throw new Error(`Unexpected fixture operation ${url.pathname}`);
  }) as typeof fetch;
  try {
    await requestAgentInstallation(item.id, async () => {});
    assert.equal((await updateTargets(project.id))[0].configured, false);
    assert.equal(await processAgentInstallation(item.id, undefined, { prepare: () => hostingInstallation(item.id) }), true);
    assert.equal(inspections, 0); assert.equal(crons.length, 2);
    assert.equal(crons[0].command, "unrelated-account-job");
    assert.equal(crons.some(row => row.command === oldCron), false);
    assert.ok(crons[1].command.includes("/bootstrap.php"));
    const source = await readUpdateSource(target.id); assert.equal(source?.settings.localAgent?.ready, true);
    const targets = await updateTargets(project.id); assert.equal(targets[0].configured, true);
    assert.equal(JSON.stringify(targets).includes(source!.settings.localAgent!.secret), false);
    files.set(`${directory}/readiness.json`, JSON.stringify(signAgentPayload({ protocol: "vigie-local-v1", root, php, ready: true, time: Math.floor(Date.now()/1000), eligibility: { multisite: false, fileModsDisabled: false, home: "https://another-site.example.test" } }, source!.settings.localAgent!.secret)));
    await writeUpdateSource(target.id, project.id, { ...source!.settings, localAgent: { ...source!.settings.localAgent!, ready: false }, agentInstallation: { ...source!.settings.agentInstallation!, state: "failed" } });
    await requestAgentInstallation(item.id, async () => {}, true);
    assert.equal(await processAgentInstallation(item.id, undefined, { prepare: () => hostingInstallation(item.id) }), false);
    assert.match((await readUpdateSource(target.id))?.settings.agentInstallation?.error || "", /contrôle initial/);
    const uploadsBefore = uploads;
    files.set(`${directory}/agent.php`, files.get(`${directory}/agent.php`)! + "\n// Altered fixture\n");
    // A failed durable request retries without changing its key or overwriting remote code.
    const readySource = (await readUpdateSource(target.id))!.settings;
    await writeUpdateSource(target.id, project.id, { ...readySource, localAgent: { ...readySource.localAgent!, ready: false }, agentInstallation: { ...readySource.agentInstallation!, state: "failed", nextAttemptAt: undefined } });
    await requestAgentInstallation(item.id, async () => {}, true);
    assert.equal(await processAgentInstallation(item.id, undefined, { prepare: () => hostingInstallation(item.id) }), false);
    assert.match((await readUpdateSource(target.id))?.settings.agentInstallation?.error || "", /aucun écrasement/);
    assert.equal(uploads, uploadsBefore); assert.equal(crons.length, 2);
    assert.equal((await readUpdateSource(target.id))?.settings.localAgent?.ready, false);
    assert.match(files.get(`${directory}/agent.php`)!, /Altered fixture/);
  } finally { globalThis.fetch = fetchBefore; }
});
