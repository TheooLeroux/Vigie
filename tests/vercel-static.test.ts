import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { maintenanceCapability, qualifySources } from "../src/lib/updates/capabilities";
import { nodeValidationPlan } from "../src/lib/updates/managed-node";
import { assertStaticDeployment, buildStaticCandidate, inspectStaticOutput, qualifyStaticSources, staticProfile, verifyStaticDeployment, type StaticBuild } from "../src/lib/updates/vercel-static";
import { nodeValidationRuntime } from "../src/lib/updates/node";
import { runCommand } from "../src/lib/updates/process";
import type { UpdateTarget } from "../src/lib/updates/types";
import { projectHealth } from "../src/lib/project-health";
import { healthAt, healthFixture, healthUpdates, healthRelease } from "./project-health-fixture";

const commit = "c".repeat(40);
const target: UpdateTarget = { id: "vercel:test:static", projectId: "test", name: "Pilote", provider: "vercel", connectionId: "test", remoteId: "prj_static", environmentId: null, repository: "qa/static", branch: "main", root: "", url: "https://static.example/", mode: "git", configured: true, unavailable: null };
const manifest = { scripts: { build: "vite build" }, devDependencies: { vite: "7.0.0" } };
const profile = staticProfile("vite", manifest, ["package.json", "index.html"]);
const deployment = () => ({ id: "dpl_static", projectId: target.remoteId, readyState: "READY", target: "production", url: "static-fixture.vercel.app", alias: ["static.example"], projectSettings: { framework: "vite" }, meta: { githubCommitSha: commit, githubCommitOrg: "qa", githubCommitRepo: "static", githubCommitRef: "main" }, lambdas: [{ readyState: "READY", output: [] }], crons: [] });
const project = () => ({ id: target.remoteId, framework: "vite", targets: { production: { id: "dpl_static" } }, link: { type: "github", org: "qa", repo: "static", productionBranch: "main" } });
const content = new Map([["index.html", Buffer.from('<html><script src="/assets/app.js"></script></html>')], ["assets/app.js", Buffer.from("console.log('fixture')")]]);
const build = (): StaticBuild => ({ profile, nodeVersion: "24.22.1", hash: "a".repeat(64), checkedAt: new Date().toISOString(), files: [...content].map(([path, data]) => ({ path, size: data.length, hash: createHash("sha256").update(data).digest("hex") })) });
const readers = () => ({ read: async (_target: UpdateTarget, path: string) => path.includes("/projects/") ? project() : deployment(), file: async (url: URL) => content.get(url.pathname === "/" || url.pathname.startsWith("/vigie-static-route-check/") ? "index.html" : url.pathname.slice(1))! });

test("Statique Vercel : l’absence de runtime seule ne qualifie pas les sources ; verrou, build, framework et commit concordent", () => {
  const source = qualifySources(target, commit, ["package.json", "package-lock.json"], manifest);
  const evidence = { framework: "vite", runtimes: [], source, commit };
  assert.equal(maintenanceCapability(target, evidence).adapter, "node-static");
  assert.equal(maintenanceCapability(target, { ...evidence, source: undefined }).status, "qualify");
  assert.equal(maintenanceCapability(target, { ...evidence, commit: "d".repeat(40) }).status, "qualify");
  assert.equal(maintenanceCapability(target, { ...evidence, source: { ...source, sharedLock: true } }).status, "qualify");
  assert.equal(maintenanceCapability(target, { ...evidence, source: { ...source, lock: null } }).status, "qualify");
  assert.equal(maintenanceCapability(target, { ...evidence, runtimes: ["edge"] }).status, "qualify");
  assert.equal(maintenanceCapability(target, { ...evidence, framework: "nextjs" }).status, "qualify");
});

test("Statique Vercel : Node est choisi pour le build isolé sans inventer une preuve de runtime serveur", async () => {
  const capability = maintenanceCapability(target, { framework: "vite", runtimes: [], source: qualifySources(target, commit, ["package.json", "package-lock.json"], manifest), commit });
  const plan = await nodeValidationPlan([{ ...target, capability }], [null], "24.22.1", async () => { throw Error("ne pas interroger un runtime inexistant"); });
  assert.equal(plan.version, "24.22.1"); assert.equal(plan.managed.size, 0);
  await assert.rejects(nodeValidationPlan([{ ...target, capability }, target], [null, null], "24.22.1"), /mesurée/);
});

test("Qualification statique : serveur, adaptateur SSR, sortie committée et sortie personnalisée demandent un autre parcours", () => {
  for (const path of ["api/hello.ts", "functions/test.js", "server/main.js", "dist/index.html", "middleware.ts", ".vercel/output/config.json"]) assert.throws(() => staticProfile("vite", manifest, [path]), /présent/);
  assert.throws(() => staticProfile("astro", { ...manifest, dependencies: { astro: "1", "@astrojs/vercel": "1" } }, []), /adaptateurs/);
  assert.throws(() => staticProfile("vite", manifest, [], { config: "export default {build:{outDir:'custom'}}" }), /configuration/);
  assert.throws(() => staticProfile("astro", { dependencies: { astro: "1" }, scripts: { build: "astro build" } }, [], { config: "output: 'server'" }), /configuration/);
  assert.doesNotThrow(() => staticProfile("vite", manifest, [], { config: "export default {server:{host:'localhost'}}" }));
});

test("Qualification statique : variables externes et règles Vercel particulières arrêtent avant l’installation", async () => {
  const folder = await mkdtemp(join(tmpdir(), "static-source-"));
  try {
    await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
    await writeFile(join(folder, "main.js"), "console.log(import.meta.env.VITE_API_URL)");
    await assert.rejects(qualifyStaticSources(folder, target, ["package.json", "main.js"], "vite"), /variables externes/);
    await writeFile(join(folder, "main.js"), "console.log(import.meta.env.PROD, process.env.NODE_ENV)");
    assert.equal((await qualifyStaticSources(folder, target, ["package.json", "main.js"], "vite")).routing, "files");
    await writeFile(join(folder, "vercel.json"), JSON.stringify({ rewrites: [{ source: "/(.*)", destination: "/index.html" }] }));
    assert.equal((await qualifyStaticSources(folder, target, ["package.json", "main.js", "vercel.json"], "vite")).routing, "spa");
    await writeFile(join(folder, "vercel.json"), JSON.stringify({ rewrites: [{ source: "/api/:path*", destination: "https://other.example/:path*" }] }));
    await assert.rejects(qualifyStaticSources(folder, target, ["package.json", "vercel.json"], "vite"), /SPA locale/);
    for (const config of [{ cleanUrls: "true" }, { rewrites: null }, null]) {
      await writeFile(join(folder, "vercel.json"), JSON.stringify(config));
      await assert.rejects(qualifyStaticSources(folder, target, ["package.json", "vercel.json"], "vite"));
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Sortie statique : ressources locales manquantes, fichiers privés et liens hors du build ne sont pas publiables", async () => {
  const folder = await mkdtemp(join(tmpdir(), "static-output-"));
  try {
    await writeFile(join(folder, "index.html"), '<script src="/missing.js"></script>');
    await assert.rejects(inspectStaticOutput(folder, profile, "24.22.1"), /ressource locale/);
    await writeFile(join(folder, "index.html"), "<html>Fixture</html>");
    await writeFile(join(folder, ".env"), "PRIVATE=fixture");
    await assert.rejects(inspectStaticOutput(folder, profile, "24.22.1"), /privé/);
    await rm(join(folder, ".env"));
    await writeFile(join(folder, "server.php"), "<?php echo 'fixture';");
    await assert.rejects(inspectStaticOutput(folder, profile, "24.22.1"), /type de fichier/);
    await rm(join(folder, "server.php"));
    const other = await mkdtemp(join(tmpdir(), "static-outside-"));
    try {
      await symlink(other, join(folder, "escape"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(inspectStaticOutput(folder, profile, "24.22.1"), /lien/);
      await assert.rejects(inspectStaticOutput(join(folder, "escape"), profile, "24.22.1"), /lien/);
    } finally { await rm(other, { recursive: true, force: true }); }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Déploiement statique : identité, commit et absence explicite de fonctions sont obligatoires", () => {
  const reference = { deploymentId: "dpl_static", commit };
  assert.equal(assertStaticDeployment(deployment(), target, reference).hostname, "static-fixture.vercel.app");
  for (const changed of [{ projectId: "foreign" }, { target: "preview" }, { meta: { ...deployment().meta, githubCommitSha: "other" } }, { projectSettings: { rootDirectory: "other" } }, { lambdas: undefined }, { lambdas: [{ readyState: "READY", output: [{ path: "api/index", functionName: "fn" }] }] }, { meta: { ...deployment().meta, lambdaRuntimeStats: { nodejs: 1 } } }, { functions: { "api/index": {} } }, { crons: [{ path: "/job" }] }, { url: "127.0.0.1" }]) assert.throws(() => assertStaticDeployment({ ...deployment(), ...changed }, target, reference));
});

test("Publication statique : tous les fichiers et le domaine actif sont comparés ; une route SPA est contrôlée séparément", async () => {
  const calls: string[] = [], dependencies = readers();
  const result = await verifyStaticDeployment(target, { deploymentId: "dpl_static", commit }, { ...build(), profile: { ...profile, routing: "spa" } }, { ...dependencies, file: async url => { calls.push(url.href); return dependencies.file(url); } });
  assert.equal(result.status, "passed"); assert.equal(result.tool, "Static");
  assert.equal(result.nodeEvidence, undefined); assert.equal(result.staticEvidence?.fileCount, 2);
  assert.ok(calls.some(url => url.includes("/assets/app.js")));
  assert.ok(calls.some(url => url.includes("/vigie-static-route-check/")));
  assert.ok(calls.includes("https://static.example/"));
  assert.ok(calls.every(url => new URL(url).hostname === "static.example"), "les URL techniques protégées ne sont pas nécessaires");
  assert.equal((await verifyStaticDeployment(target, { deploymentId: "dpl_static", commit }, build(), { ...dependencies, read: async (t, path) => path.includes("/projects/") ? { ...project(), outputDirectory: "dist" } : dependencies.read(t, path) })).status, "passed");
});

test("Publication statique : un asset différent, une promotion concurrente ou une protection HTTP empêchent le succès", async () => {
  const reference = { deploymentId: "dpl_static", commit }, dependencies = readers();
  await assert.rejects(verifyStaticDeployment(target, reference, build(), { ...dependencies, file: async url => url.pathname.endsWith("app.js") ? Buffer.from("different") : dependencies.file(url) }), /ne correspond pas/);
  let projects = 0;
  await assert.rejects(verifyStaticDeployment(target, reference, build(), { ...dependencies, read: async (t, path) => path.includes("/projects/") && ++projects === 2 ? { ...project(), targets: { production: { id: "dpl_other" } } } : dependencies.read(t, path) }), /actif a changé/);
  await assert.rejects(verifyStaticDeployment(target, reference, build(), { ...dependencies, file: async () => { throw Error("HTTP 401 protégé"); } }), /HTTP 401/);
  await assert.rejects(verifyStaticDeployment(target, reference, build(), { ...dependencies, read: async (t, path) => path.includes("/projects/") ? { ...project(), framework: "nextjs" } : dependencies.read(t, path) }), /paramètres de build/);
  await assert.rejects(verifyStaticDeployment(target, reference, build(), { ...dependencies, read: async (t, path) => path.includes("/deployments/") ? { ...deployment(), alias: ["foreign.example"] } : dependencies.read(t, path) }), /domaine public/);
});

test("Résumé statique : le scan accepté est lié au déploiement actif, sans transformer le Node local en runtime Vercel", async () => {
  const detail = healthFixture(); detail.railway = [];
  detail.vercel = [{ id: target.remoteId, name: "Frontend", teamId: "team", teamSlug: "team", teamName: "Team", framework: "vite", nodeBranch: "24.x", rootDirectory: null, repository: target.repository, productionBranch: "main", domains: [], latest: null, excluded: false, clientSuggestion: null, connectionId: target.connectionId, connectionName: "Vercel", configured: true, connectionError: null, observedAt: healthAt, missingSince: null, projectId: "project", projectName: "Frontend", clientName: null, linkMethod: "manual", production: { id: "dpl_static", url: "static.example", state: "READY", target: "production", createdAt: healthAt, framework: "vite", nodeBranch: "24.x", repository: target.repository, branch: "main", commit, regions: [], nodeRelease: { ...healthRelease, state: "unknown", securityUpdate: null, supported: null }, analysis: { status: "observed", checkedAt: healthAt, truncated: false, languages: [], runtimes: [], technologies: [] } } }];
  const state = healthUpdates([]), run = state.runs[0];
  const capability = maintenanceCapability(target, { framework: "vite", runtimes: [], source: qualifySources(target, commit, ["package.json", "package-lock.json"], manifest), commit });
  run.targets = [{ ...target, projectId: "project", capability }]; run.results[0].targetId = target.id;
  const staticCheck = await verifyStaticDeployment(target, { deploymentId: "dpl_static", commit }, build(), readers());
  run.results[0].checks = [{ tool: "OSV", phase: "candidate", checkedAt: healthAt, scope: "", status: "passed", message: "Dépendances", findings: [] }, { tool: "Trivy", phase: "candidate", checkedAt: healthAt, scope: "", status: "warning", message: "Image de build uniquement", findings: [{ id: "BUILD-ONLY", aliases: [], package: "build-image", version: "1", severity: "low" }] }, staticCheck];
  assert.equal(projectHealth(detail, state).securityKnown, true);
  assert.equal(projectHealth(detail, state).security.length, 0, "l’image locale du build n’est pas le serveur de production");
  assert.equal(run.results[0].checks.some(check => check.nodeEvidence), false);
  detail.vercel[0].production!.commit = "d".repeat(40);
  assert.equal(projectHealth(detail, state).securityKnown, false);
  detail.vercel[0].production!.commit = commit;
  staticCheck.staticEvidence!.projectId = "foreign";
  assert.equal(projectHealth(detail, state).securityKnown, false);
});

test("Docker réel : Vite est construit dans une copie propre et les fichiers réellement produits sont qualifiés", { skip: process.env.VIGIE_TEST_DOCKER !== "1", timeout: 300_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-static-real-")), nodeVersion = process.env.VIGIE_TEST_NODE_VERSION || "24.22.1";
  const runtime = nodeValidationRuntime(nodeVersion);
  try {
    const response = await fetch("https://registry.npmjs.org/vite/latest", { signal: AbortSignal.timeout(20_000) });
    assert.equal(response.ok, true);
    const vite = (await response.json()).version;
    assert.match(vite, /^\d+\.\d+\.\d+$/);
    t.diagnostic(`Vite ${vite}, Node ${nodeVersion}, conteneur isolé réel`);
    const realManifest = { name: "vigie-static-fixture", version: "1.0.0", private: true, type: "module", engines: { node: nodeVersion }, scripts: { build: "vite build" }, devDependencies: { vite } };
    await writeFile(join(folder, "package.json"), JSON.stringify(realManifest));
    await mkdir(join(folder, "src"));
    await writeFile(join(folder, "index.html"), '<!doctype html><html><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>');
    await writeFile(join(folder, "src/main.js"), "import './style.css'; document.querySelector('#app').textContent='Pilote statique Vigie';");
    await writeFile(join(folder, "src/style.css"), "body { font-family: sans-serif; }");
    await runCommand("docker", ["run", "--rm", "--volume", `${folder}:/workspace`, "--workdir", "/workspace", `node:${nodeVersion}-bookworm`, "npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { timeout: 180_000 });
    const names = ["package.json", "package-lock.json", "index.html", "src/main.js", "src/style.css"];
    const before = await readFile(join(folder, "package-lock.json"), "utf8");
    const actualProfile = await qualifyStaticSources(folder, target, names, "vite");
    const result = await buildStaticCandidate(folder, target, names, actualProfile, nodeVersion, () => ({ resolved: async () => {}, image: async () => {}, validated: async (_root, scripts) => assert.ok(scripts.includes("build")) }), runtime);
    assert.ok(result.files.some(file => /^assets\/.+\.js$/.test(file.path)));
    assert.ok(result.files.some(file => /^assets\/.+\.css$/.test(file.path)));
    assert.equal(result.nodeVersion, nodeVersion);
    await assert.rejects(access(join(folder, "dist")), /ENOENT/);
    assert.equal(await readFile(join(folder, "package-lock.json"), "utf8"), before);
  } finally { await runtime.dispose?.(); await rm(folder, { recursive: true, force: true }); }
});
