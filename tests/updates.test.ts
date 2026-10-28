import { authFixture } from "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GET, POST } from "../src/app/api/[...path]/route";
import { createProject, transaction, database } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import { saveVercelConnection, applyVercelSnapshot, linkVercelProject } from "../src/lib/vercel";
import { projectUpdates, startProjectUpdate, configureUpdateSource } from "../src/lib/updates/service";
import { updateTargets, sourceRoot } from "../src/lib/updates/targets";
import { completedNodeRuns, readUpdateRun, readUpdateSource, updateStorage } from "../src/lib/updates/storage";
import { executeUpdate, publishGitVersions } from "../src/lib/updates/executor";
import { latestNode, upgradeManifest, managerCommands, snapshotSources, changedSources, prepareNodeSources } from "../src/lib/updates/node";
import { runCommand, DependencyValidationError } from "../src/lib/updates/process";
import { wordpressBackupScript, wordpressUpdateScript, shellQuote } from "../src/lib/updates/wordpress";
import { wordpressPlanSchema } from "../src/lib/updates/wordpress-security";
import { githubUpdateToken, repositoryAllowed } from "../src/lib/updates/github";
import { waitForDeployment, checkPublicSite } from "../src/lib/updates/providers";
import { confirmDeployedNode, verifyNodeServices } from "../src/lib/updates/node-deployment";
import { UpdateProgress } from "../src/components/project-updates";
import { ApiError } from "../src/lib/http";
import type { VercelProject } from "../src/lib/vercel-types";

process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.VIGIE_UPDATES_ENABLED = "1";
process.env.VIGIE_UPDATES_RUNNER_REPOSITORY = "qa/runner";
process.env.VIGIE_UPDATES_GITHUB_TOKENS = JSON.stringify({ qa: "qa-fake-token", other: "other-fake-token" });
const noRefresh = async () => {};
const json = (data: unknown) => Response.json(data);
async function fixture(mode: "git" | "archive" = "git", repository = `qa/app-${randomUUID()}`) {
  const project = await transaction(() => createProject("live", createProjectSchema.parse({ name: `App ${randomUUID()}`, url: `https://${randomUUID()}.example.test/` })));
  const connection = await saveVercelConnection({ name: "Vercel test", teamId: `team_${randomUUID().replaceAll("-", "")}`, secret: "vercel-test-no-real-access" });
  const remote: VercelProject = { id: `prj_${randomUUID().replaceAll("-", "")}`, name: project.name, teamId: connection.teamId, teamSlug: "qa", teamName: "QA", framework: "nextjs", nodeBranch: "24.x", rootDirectory: null, repository: mode === "git" ? repository : null, productionBranch: mode === "git" ? "main" : null, domains: [{ name: new URL(project.url).hostname, verified: true, redirect: null, environment: "production" }], production: null, latest: null, excluded: false, clientSuggestion: null };
  await applyVercelSnapshot(connection.id, [remote]);
  await linkVercelProject(connection.id, remote.id, project.id);
  process.env.VIGIE_UPDATES_REPOSITORIES = [process.env.VIGIE_UPDATES_REPOSITORIES, repository].filter(Boolean).join(",");
  const target = (await updateTargets(project.id))[0];
  return { project, connection, remote, target };
}

test("Mises à jour : authentification, origine et périmètre obligatoires", async () => {
  const context = { params: Promise.resolve({ path: ["updates"] }) };
  assert.equal((await GET(new Request("http://127.0.0.1:3001/api/updates"), context)).status, 401);
  const { cookie } = await authFixture();
  assert.equal((await POST(new Request("http://127.0.0.1:3001/api/updates", { method: "POST", headers: { cookie, origin: "https://evil.test", "content-type": "application/json" }, body: "{}" }), context)).status, 403);
  assert.equal((await GET(new Request(`http://127.0.0.1:3001/api/updates?projectId=${randomUUID()}`, { headers: { cookie } }), context)).status, 404);
  const first = await fixture(), second = await fixture();
  await assert.rejects(startProjectUpdate({ projectId: first.project.id, targetIds: [second.target.id] }, async () => {}), /ne fait pas partie/);
});
test("Mises à jour : un double clic ne crée qu’un traitement et un seul envoi", async () => {
  const { project } = await fixture();
  let calls = 0;
  const dispatch = async () => { calls++; };
  const first = await startProjectUpdate({ projectId: project.id }, dispatch);
  const second = await startProjectUpdate({ projectId: project.id }, dispatch);
  assert.equal(first.id, second.id);
  assert.equal(calls, 1);
  assert.equal((await projectUpdates(project.id)).runs.length, 1);
});
test("Reprises Node : seuls les traitements terminés du bon projet sont éligibles, les références restent internes", async () => {
  const { project } = await fixture(), other = await fixture();
  const db = await updateStorage(), hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  for (const [projectId, stage] of [[project.id, "completed"], [project.id, "attention"], [project.id, "failed"], [other.project.id, "completed"]]) {
    const id = randomUUID();
    const data = { id, projectId, stage, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodeReceipts: [{ sourceHash: hashes[0], targetsHash: hashes[1], policyHash: hashes[2] }] };
    await db.prepare("INSERT INTO update_runs(id,project_id,stage,data) VALUES(?,?,?,?)").run(id, projectId, stage, JSON.stringify(data));
  }
  const runs = await completedNodeRuns(project.id, hashes);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].stage, "completed");
  assert.equal((await projectUpdates(project.id)).runs.some(run => "nodeReceipts" in run), false);
});
test("Mises à jour : le verrou couvre le dépôt partagé et pas seulement le service", async () => {
  const repository = `qa/shared-${randomUUID()}`;
  const first = await fixture("git", repository), second = await fixture("git", repository);
  await startProjectUpdate({ projectId: first.project.id }, async () => {});
  await assert.rejects(startProjectUpdate({ projectId: second.project.id }, async () => {}), /déjà ces sources/);
  assert.equal((await projectUpdates(second.project.id)).runs.length, 0);
});
test("Mises à jour : refus confirmé de l’exécuteur libère le verrou ; résultat inconnu le conserve", async () => {
  const first = await fixture();
  const refused = await startProjectUpdate({ projectId: first.project.id }, async () => { throw new ApiError("GitHub refuse l’opération (403).", 502); });
  assert.equal(refused.stage, "failed");
  const retry = await startProjectUpdate({ projectId: first.project.id }, async () => {});
  assert.notEqual(retry.id, refused.id);
  const second = await fixture();
  const unknown = await startProjectUpdate({ projectId: second.project.id }, async () => { throw new Error("network"); });
  assert.equal(unknown.stage, "queued");
  assert.equal((await startProjectUpdate({ projectId: second.project.id }, async () => { throw Error("must not dispatch twice"); })).id, unknown.id);
});
test("Mises à jour : un seul exécuteur, échec avant publication sans toucher à Git", async () => {
  const { project } = await fixture();
  const run = await startProjectUpdate({ projectId: project.id }, async () => {});
  let calls = 0;
  const executor = async () => { calls++; throw new ApiError("Les tests ne passent pas."); };
  assert.equal(await executeUpdate(run.id, executor, undefined, noRefresh), true);
  assert.equal(await executeUpdate(run.id, executor, undefined, noRefresh), false);
  assert.equal(calls, 1);
  assert.equal((await readUpdateRun(run.id))?.stage, "failed");
  assert.equal((await (await updateStorage()).prepare("SELECT scope FROM update_locks WHERE run_id=?").all(run.id)).length, 0);
});
test("Objectif zéro faille : le garde final refuse un résultat terminé avec alerte, avant ou après publication", async () => {
  for (const published of [false, true]) {
    const { project } = await fixture();
    const run = await startProjectUpdate({ projectId: project.id }, async () => {});
    await executeUpdate(run.id, async (_run, _targets, results) => {
      const result = results[0];
      result.stage = "completed";
      if (published) result.deploymentId = "published-fixture";
      result.checks = [{ tool: "OSV", phase: "candidate", scope: "fixture", checkedAt: new Date().toISOString(), status: "warning", message: "Ancien comportement permissif", findings: [{ id: "GHSA-existing-low", aliases: [], package: "library", version: "1.0.0", severity: "low" }] }];
    }, undefined, noRefresh);
    const saved = await readUpdateRun(run.id);
    assert.equal(saved?.stage, published ? "attention" : "failed");
    assert.equal(saved?.results[0].stage, published ? "attention" : "failed");
    assert.match(saved!.message, /non résolue/);
  }
});
test("Mises à jour : une installation des scanners en échec est enregistrée et libère le verrou", async () => {
  const { project } = await fixture();
  const run = await startProjectUpdate({ projectId: project.id }, async () => {});
  const previous = process.env.VIGIE_UPDATES_RUNNER_SETUP_OK;
  process.env.VIGIE_UPDATES_RUNNER_SETUP_OK = "false";
  let called = false;
  try {
    await executeUpdate(run.id, async () => { called = true; }, undefined, noRefresh);
    assert.equal(called, false);
    assert.equal((await readUpdateRun(run.id))?.stage, "failed");
    assert.match((await readUpdateRun(run.id))!.message, /outils de sécurité/);
    assert.equal((await (await updateStorage()).prepare("SELECT scope FROM update_locks WHERE run_id=?").all(run.id)).length, 0);
  } finally {
    if (previous === undefined) delete process.env.VIGIE_UPDATES_RUNNER_SETUP_OK;
    else process.env.VIGIE_UPDATES_RUNNER_SETUP_OK = previous;
  }
});
test("Mises à jour : échec après publication conserve les références et interdit une relance aveugle", async () => {
  const { project } = await fixture();
  const run = await startProjectUpdate({ projectId: project.id }, async () => {});
  await executeUpdate(run.id, async (_run, _targets, results, progress) => {
    results[0].commit = "a".repeat(40);
    results[0].stage = "verifying";
    await progress("verifying", "Attente du déploiement.");
    throw new ApiError("Déploiement non confirmé.");
  }, undefined, noRefresh);
  const stored = await readUpdateRun(run.id);
  assert.equal(stored?.stage, "attention");
  assert.equal(stored?.results[0].commit, "a".repeat(40));
  assert.equal((await (await updateStorage()).prepare("SELECT scope FROM update_locks WHERE run_id=?").all(run.id)).length, 1);
});
test("Mises à jour : un conflit avant changement de référence ne laisse pas un verrou inutile", async () => {
  const { project } = await fixture();
  const run = await startProjectUpdate({ projectId: project.id }, async () => {});
  await executeUpdate(run.id, async (_run, _targets, results) => {
    results[0].stage = "publishing";
    throw new ApiError("Le dépôt a changé pendant les tests.", 409);
  }, undefined, noRefresh);
  assert.equal((await readUpdateRun(run.id))?.stage, "failed");
  assert.equal((await (await updateStorage()).prepare("SELECT scope FROM update_locks WHERE run_id=?").all(run.id)).length, 0);
});

test("Mises à jour : Node non attesté reste à vérifier, après publication ou sans aucun fichier à modifier", async () => {
  for (const published of [true, false]) {
    const { project, target } = await fixture();
    const run = await startProjectUpdate({ projectId: project.id }, async () => {});
    let refreshed = false;
    await executeUpdate(run.id, async (_run, _targets, results, progress) => {
      const result = results[0];
      if (published) result.commit = "a".repeat(40);
      result.previousDeploymentId = "old";
      await verifyNodeServices(results, async () => { await confirmDeployedNode(target, result, { deploymentId: "current", commit: result.commit }, "24.22.1", progress, async () => ({ tool: "Node", phase: "after", scope: "app", checkedAt: new Date().toISOString(), status: "blocked", message: "Node 24.22.1 attendu : correctif déployé non attesté.", findings: [] })); });
      result.stage = "completed";
    }, undefined, async () => { refreshed = true; });
    const stored = (await readUpdateRun(run.id))!;
    assert.equal(stored.stage, "attention");
    assert.equal(stored.results[0].stage, "attention");
    assert.equal(stored.results[0].checks?.[0].status, "blocked");
    assert.equal(stored.results[0].previousDeploymentId, "old");
    assert.equal(refreshed, false);
    assert.equal((await (await updateStorage()).prepare("SELECT scope FROM update_locks WHERE run_id=?").all(run.id)).length, 1);
  }
});
test("Mises à jour : une réponse de lancement perdue ne remplace pas le résultat de l’exécuteur", async () => {
  const { project } = await fixture();
  const result = await startProjectUpdate({ projectId: project.id }, async id => {
    await executeUpdate(id, async (_run, _targets, results) => { results[0].stage = "completed"; }, undefined, noRefresh);
    throw new Error("Response lost after execution");
  });
  assert.equal(result.stage, "completed");
});

test("Vercel : dépendances validées avec réserve Node explicite libèrent le verrou sans annoncer un site entièrement corrigé",async()=>{
  const {project}=await fixture();
  const run=await startProjectUpdate({projectId:project.id},async()=>{});
  await executeUpdate(run.id,async(_run,_targets,results)=>{
    results[0].stage="completed";
    results[0].managedNode={provider:"vercel",version:"24.21.0",latestLts:"24.22.1",updatePending:true,securityUpdate:true,checkedAt:new Date().toISOString()};
  },undefined,noRefresh);
  const result=(await readUpdateRun(run.id))!;
  assert.equal(result.stage,"completed");
  assert.match(result.message,/dépendances terminée avec réserves/);
  assert.match(result.message,/pas déclaré entièrement corrigé/);
  assert.equal((await (await updateStorage()).prepare("SELECT scope FROM update_locks WHERE run_id=?").all(run.id)).length,0);
});
test("Mises à jour : les sources sans Git sont configurables, chiffrées et téléchargeables sans exposer les clés", async () => {
  const { project, target } = await fixture("archive");
  assert.match(target.unavailable!, /sources/);
  const archive = Buffer.from("PK-test-archive").toString("base64");
  await configureUpdateSource(project.id, { targetId: target.id, archive, filename: "source.zip" }, async () => "dpl_original");
  assert.equal((await updateTargets(project.id))[0].unavailable, null);
  assert.equal((await readUpdateSource(target.id))?.settings.archive, archive);
  const row = await database().prepare("SELECT secret_cipher FROM update_sources WHERE target_id=?").get(target.id) as { secret_cipher: string };
  assert.ok(!row.secret_cipher.includes(archive));
  assert.ok(!JSON.stringify(await projectUpdates(project.id)).includes(archive));
  const { cookie } = await authFixture();
  const download = await GET(new Request(`http://127.0.0.1:3001/api/updates/${project.id}/source?targetId=${encodeURIComponent(target.id)}`, { headers: { cookie } }), { params: Promise.resolve({ path: ["updates", project.id, "source"] }) });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/zip");
  assert.equal(Buffer.from(await download.arrayBuffer()).toString("base64"), archive);
  const run = await startProjectUpdate({ projectId: project.id }, async () => {});
  await assert.rejects(configureUpdateSource(project.id, { targetId: target.id, archive }, async () => "dpl_original"), /Attendez la fin/);
  await executeUpdate(run.id, async (_run, _targets, results) => { results[0].stage = "completed"; results[0].message = "Déployé."; }, undefined, noRefresh);
  assert.equal((await readUpdateRun(run.id))?.stage, "completed");
});
test("Mises à jour : l’activation et les accès propriétaires restent explicites", async () => {
  assert.equal(githubUpdateToken("qa/app"), "qa-fake-token");
  assert.equal(githubUpdateToken("other/app"), "other-fake-token");
  assert.equal(githubUpdateToken("unknown/app"), "");
  assert.equal(repositoryAllowed("qa/not-authorized"), false);
  const { project } = await fixture();
  process.env.VIGIE_UPDATES_ENABLED = "0";
  try { await assert.rejects(startProjectUpdate({ projectId: project.id }), /pas encore activé/); }
  finally { process.env.VIGIE_UPDATES_ENABLED = "1"; }
});
test("Git : un changement concurrent ne peut pas être écrasé ; publication sans force ni PR", async () => {
  const repository = "qa/commit-test";
  process.env.VIGIE_UPDATES_REPOSITORIES += `,${repository}`;
  const expected = "a".repeat(40), published = "b".repeat(40), calls: { path: string; method?: string; body?: any }[] = [];
  const transport: typeof fetch = async (input, options) => {
    const path = String(input);
    calls.push({ path, method: options?.method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (path.includes("/git/ref/heads/")) return json({ object: { sha: expected } });
    if (path.endsWith(`/git/commits/${expected}`)) return json({ tree: { sha: "old-tree" } });
    if (path.endsWith("/git/trees")) return json({ sha: "new-tree" });
    if (path.endsWith("/git/commits")) return json({ sha: published });
    return json({});
  };
  assert.equal(await publishGitVersions(repository, "main", expected, [{ path: "package.json", content: "{}" }], transport), published);
  assert.deepEqual(calls.at(-1)?.body, { sha: published, force: false });
  assert.ok(calls.every(call => !call.path.includes("pulls")));
  let writes = 0;
  await assert.rejects(publishGitVersions(repository, "main", expected, [{ path: "package.json", content: "{}" }], async (_input, options) => { if (options?.method !== "GET") writes++; return json({ object: { sha: "c".repeat(40) } }); }), /a changé/);
  assert.equal(writes, 0);
  await assert.rejects(publishGitVersions(repository, "main", expected, [{ path: ".github/workflows/other.yml", content: "{}" }], transport), /limiter aux versions/);
});
test("Node : dernière LTS maintenue et dernières dépendances stables ; les paquets dépréciés ne bloquent pas les autres", async () => {
  const transport: typeof fetch = async input => {
    const url = String(input);
    if (url.includes("dist/index")) return json([{ version: "v30.0.0", lts: false }, { version: "v24.10.1", lts: "Krypton" }, { version: "v22.9.0", lts: "Jod" }]);
    if (url.includes("schedule.json")) return json({ v24: { end: "2099-01-01" }, v22: { end: "2020-01-01" } });
    if (url.endsWith("/oldtypes")) return json({ versions: { "2.0.0": { version: "2.0.0", deprecated: "built in" }, "1.0.0": { version: "1.0.0" } } });
    return json(url.includes("oldtypes") ? { version: "2.0.0", deprecated: "built in" } : { version: "19.2.1" });
  };
  assert.equal(await latestNode(transport), "24.10.1");
  const source = { dependencies: { react: "^18.0.0", oldtypes: "1.0.0", local: "workspace:*" }, engines: { node: "20.x" } };
  const next = await upgradeManifest(source, "24.10.1", transport);
  assert.equal(next.manifest.dependencies.react, "19.2.1");
  assert.equal(next.manifest.dependencies.oldtypes, "1.0.0");
  assert.equal(next.manifest.dependencies.local, "workspace:*");
  assert.equal(next.manifest.engines.node, "24.10.1");
  assert.equal(source.engines.node, "20.x");
  assert.equal(next.warnings.length, 2);
});

test("Git : un Dockerfile ne peut publier que des changements de versions vérifiés contre le commit source", async () => {
  const { target } = await fixture();
  const expected = "a".repeat(40), original = 'FROM node:20-slim\nEXPOSE 8080\nCMD ["node","server.js"]\n';
  let writes = 0;
  const transport: typeof fetch = async (input, options) => {
    const path = String(input);
    if (options?.method !== "GET") writes++;
    if (path.includes("/git/ref/heads/")) return json({ object: { sha: expected } });
    if (path.includes("/contents/")) { assert.ok(path.endsWith(`?ref=${expected}`)); return json({ type: "file", encoding: "base64", size: original.length, content: Buffer.from(original).toString("base64") }); }
    if (path.endsWith(`/git/commits/${expected}`)) return json({ tree: { sha: "tree" } });
    return json({ sha: "b".repeat(40) });
  };
  const candidate = original.replace("node:20-slim", "node:24.14.0-slim");
  assert.equal(await publishGitVersions(target.repository!, "main", expected, [{ path: "docs/Dockerfile", content: candidate }], transport), "b".repeat(40));
  assert.equal(writes, 3);
  writes = 0;
  await assert.rejects(publishGitVersions(target.repository!, "main", expected, [{ path: "docs/Dockerfile", content: candidate + "RUN echo unexpected\n" }], transport), /uniquement modifier les versions/);
  assert.equal(writes, 0);
});
test("Node : gestionnaires identifiés, références non stables et chemins dangereux refusés", () => {
  assert.equal(managerCommands({}, ["package-lock.json"]).lock, "package-lock.json");
  assert.equal(managerCommands({ packageManager: "pnpm@10.1.0" }, ["pnpm-lock.yaml"]).lock, "pnpm-lock.yaml");
  assert.match(managerCommands({ packageManager: "yarn@4.18.1", scripts: { build: "next build" } }, ["yarn.lock"]).validate, /--immutable/);
  assert.match(managerCommands({ packageManager: "yarn@4.9.2" }, []).resolve, /--mode=skip-build(?:\s|$)/);
  assert.throws(() => managerCommands({ packageManager: "pnpm@latest;echo nope" }, []), /non stable/);
  assert.throws(() => managerCommands({}, ["bun.lock"]), /Bun/);
  assert.throws(() => sourceRoot("/web/../private"), /répertoire/);
  assert.equal(sourceRoot("/frontend/"), "frontend");
});
test("Node : la construction ne peut pas modifier un fichier source hors des versions", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-test-source-"));
  try {
    await writeFile(join(folder, "package.json"), "{}"); await writeFile(join(folder, "index.js"), "original");
    const before = await snapshotSources(folder, ["package.json", "index.js"]);
    await writeFile(join(folder, "package.json"), '{"version":"2"}');
    assert.equal((await changedSources(folder, before, new Set(["package.json"]))).length, 1);
    await writeFile(join(folder, "index.js"), "changed");
    await assert.rejects(changedSources(folder, before, new Set(["package.json"])), /hors du périmètre/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test("WordPress : sauvegarde vérifiée avant les mutations, emplacements distincts et absence de restauration automatique", () => {
  const id = randomUUID();
  const first = wordpressBackupScript("/home/test/site-a", "test", id), second = wordpressBackupScript("/home/test/site-b", "test", id);
  assert.notEqual(first.match(/backup='([^']+)'/)?.[1], second.match(/backup='([^']+)'/)?.[1]);
  assert.ok(first.includes("db export") && first.includes("tar -tzf") && first.includes("sha256sum -c"));
  assert.ok(!first.includes("core update"));
  assert.ok(wordpressBackupScript("/home/test/site-a", "test", id, "https://example.test", "8.3.1").includes("PHP_VERSION"));
  const plan = wordpressPlanSchema.parse({ wordpress: { current: "6.8.3", target: "6.8.4" }, php: "8.3.30", plugins: [{ slug: "public", current: "1", target: "2", requiresPhp: "", requiresWordPress: "" }], themes: [] });
  const script = wordpressUpdateScript("/home/test/site-a", `/home/test/.vigie-backups/${id}/abcd`, plan);
  assert.ok(script.indexOf("sha256sum -c") < script.indexOf("core update"));
  assert.ok(script.includes("trap '") && script.includes("plugin update 'public' --version='2'"));
  assert.equal(script.includes("plugin update --all"), false);
  assert.equal(script.includes("theme update"), false);
  assert.ok(script.includes('if test -f "$root/.maintenance"; then'));
  assert.ok(!script.includes("db import"));
  assert.throws(() => wordpressBackupScript("/var/www/site", "test", id), /non autorisé/);
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});

test("Exécuteur : les erreurs connues restent lisibles sans exposer les journaux ni les secrets", async () => {
  const args = ["-e", "console.error('ERESOLVE secret-fixture-never-returned'); process.exit(1)"];
  await assert.rejects(runCommand(process.execPath, args, { errorPatterns: [{ pattern: /ERESOLVE/, message: "Dépendances incompatibles." }] }), error => error instanceof Error && error.message === "Dépendances incompatibles.");
  await assert.rejects(runCommand(process.execPath, args), error => error instanceof Error && !error.message.includes("secret-fixture") && !error.message.includes("ERESOLVE"));
  await assert.rejects(runCommand(process.execPath, ["-e", "console.error('error TS2614: Module \\\"safe-package\\\" secret-fixture');process.exit(1)"], { diagnosticPackages: ["safe-package"] }), error => error instanceof DependencyValidationError && error.packages.join(",") === "safe-package" && !error.message.includes("secret-fixture"));
});
test("Déploiement : un ancien déploiement READY ne suffit pas à déclarer le nouveau terminé", async () => {
  const { target } = await fixture();
  const originalFetch = globalThis.fetch;
  let notified = "", rounds = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("v6/deployments")) { rounds++; return json({ deployments: [{ id: "dpl_old", target: "production", state: "READY", meta: { githubCommitSha: "old" } }, ...(rounds > 1 ? [{ id: "dpl_new", target: "production", state: "READY", meta: { githubCommitSha: "new" } }] : [])] }); }
    return json({ targets: { production: { id: "dpl_new" } } });
  };
  try { assert.equal(await waitForDeployment(target, { commit: "new", runId: randomUUID() }, async id => { notified = id; }, async () => {}), "dpl_new"); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(notified, "dpl_new"); assert.equal(rounds, 2);
  await assert.rejects(checkPublicSite("http://127.0.0.1/"), /HTTPS/);
  await assert.rejects(checkPublicSite("https://127.0.0.1/"), /privées/);
});
test("Interface : état simple et pas de faux succès après une publication non confirmée", async () => {
  const { project } = await fixture();
  const run = await startProjectUpdate({ projectId: project.id }, async () => {});
  const pending = renderToStaticMarkup(createElement(UpdateProgress, { run }));
  assert.match(pending, /En attente/);
  assert.ok(!pending.includes("PR"));
  const attention = renderToStaticMarkup(createElement(UpdateProgress, { run: { ...run, stage: "attention", message: "Déploiement non confirmé." } }));
  assert.match(attention, /À vérifier/); assert.match(attention, /Déploiement non confirmé/);
});
test("Archive sans Git : extraction, reconditionnement, traversée et liens refusés", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-test-archive-"));
  const archive = join(folder, "source.zip"), destination = join(folder, "source"), script = join(process.cwd(), "scripts", "update-archive.py");
  try {
    await runCommand("python3", ["-c", "import sys,zipfile; archive=zipfile.ZipFile(sys.argv[1],'w'); archive.writestr('package.json','{}'); archive.close()", archive]);
    assert.deepEqual(JSON.parse(await runCommand("python3", [script, "extract", archive, destination])), ["package.json"]);
    await runCommand("python3", [script, "pack", join(folder, "updated.zip"), destination], { input: '["package.json"]' });
    for (const name of ["../escaped", "/absolute", ".env", "sub/../../private", "id_rsa"]) {
      await runCommand("python3", ["-c", "import sys,zipfile; archive=zipfile.ZipFile(sys.argv[1],'w'); archive.writestr(sys.argv[2],'bad'); archive.close()", archive, name]);
      await assert.rejects(runCommand("python3", [script, "extract", archive, destination]), /échoué/);
    }
    await runCommand("python3", ["-c", "import sys,zipfile; archive=zipfile.ZipFile(sys.argv[1],'w'); info=zipfile.ZipInfo('link'); info.create_system=3; info.external_attr=(0o120777 << 16); archive.writestr(info,'/etc/passwd'); archive.close()", archive]);
    await assert.rejects(runCommand("python3", [script, "extract", archive, destination]), /échoué/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test("Docker : installation et validation réelles sans secrets du worker", { skip: process.env.VIGIE_TEST_DOCKER !== "1" }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-test-docker-"));
  try {
    const manifest = { name: "vigie-fixture", version: "1.0.0", private: true, scripts: { test: `node -e "if(process.env.DATABASE_URL || process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || process.env.GITHUB_TOKEN) process.exit(1)"` } };
    await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
    await writeFile(join(folder, "package-lock.json"), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: { "": { name: manifest.name, version: manifest.version } } }));
    const prepared = await prepareNodeSources(folder, [""], ["package.json", "package-lock.json"], "24.14.0");
    assert.ok(prepared.allowed.has("package-lock.json"));
    assert.equal(JSON.parse(await readFile(join(folder, "package.json"), "utf8")).engines.node, "24.14.0");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
