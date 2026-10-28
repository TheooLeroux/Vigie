import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { maintenanceCapability, matchingQualification, qualifySources, sourceFamily, SourceQualificationError } from "../src/lib/updates/capabilities";
import { checkNodeEndpoint, nodeCompletionMessage } from "../src/lib/updates/executor";
import { sourceImpact } from "../src/lib/updates/source-impact";
import { MaintenanceScope } from "../src/components/project-updates";
import { scanCurrentNode } from "../src/lib/updates/node-monitor";
import type { UpdateTarget } from "../src/lib/updates/types";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNodeSources } from "../src/lib/updates/node";

const commit = "c".repeat(40);
const target: UpdateTarget = { id: "railway:test:worker:prod", projectId: "p", name: "Traitement", provider: "railway", connectionId: "test", remoteId: "worker", environmentId: "prod", repository: "qa/worker", branch: "main", root: "worker", url: null, mode: "git", configured: true, unavailable: null };
const source = () => qualifySources(target, commit, ["package.json", "package-lock.json"], { scripts: { start: "node worker.js", test: "node --test" } });
test("Qualification : un outil frontend ne transforme pas WordPress, Dolibarr ou un projet mixte en Node", () => {
  assert.equal(sourceFamily(["package.json", "wp-includes", "wp-admin"]), "wordpress");
  assert.equal(sourceFamily(["package.json", "main.inc.php", "core"]), "dolibarr");
  assert.equal(sourceFamily(["package.json", "composer.json"]), "mixed");
  assert.equal(sourceFamily(["package.json", "requirements.txt"]), "mixed");
  for (const [marker, family] of [["pyproject.toml", "python"], ["go.mod", "go"], ["Cargo.toml", "rust"], ["Gemfile", "ruby"], ["pom.xml", "java"], ["index.html", "static"]]) assert.equal(sourceFamily([marker]), family);
  assert.equal(sourceFamily(["package.json", "bun.lock"]), "bun");
  assert.equal(sourceFamily(["__proto__", "constructor", "toString"]), "unknown");
});
test("Qualification : une preuve de sources ne vaut que pour le dépôt, la racine et le commit exacts", () => {
  assert.ok(matchingQualification(source(), target.repository, target.root, commit));
  assert.equal(matchingQualification(source(), "qa/other", target.root, commit), null);
  assert.equal(matchingQualification(source(), target.repository, "other", commit), null);
  assert.equal(matchingQualification(source(), target.repository, target.root, "d".repeat(40)), null);
  const php = qualifySources(target, commit, ["composer.json"]);
  assert.equal(maintenanceCapability(target, { framework: "node", source: php, commit }).status, "manual");
});
test("Worker : absence d’URL admise seulement avec sources qualifiées ; le parcours web garde son contrôle HTTPS", async () => {
  const cap = maintenanceCapability(target, { commit, source: source() });
  assert.equal(cap.adapter, "node-worker");
  const workerMessage = nodeCompletionMessage({ ...target, capability: cap }, { targetId: target.id, name: target.name, stage: "completed", message: "", warnings: [] });
  assert.doesNotMatch(workerMessage, /HTTPS/);
  assert.match(workerMessage, /résultats métier restent à contrôler/);
  let calls = 0;
  await checkNodeEndpoint({ ...target, capability: cap }, async () => { calls++; });
  assert.equal(calls, 0);
  await assert.rejects(checkNodeEndpoint(target, async () => { calls++; }), /URL publique/);
  await checkNodeEndpoint({ ...target, url: "https://web.example/", capability: { ...cap, adapter: "node-web", workload: "web" } }, async () => { calls++; });
  assert.equal(calls, 1);
  assert.equal(maintenanceCapability(target, { framework: "node" }).status, "qualify");
  const noStart = source(); noStart.scripts = ["build"];
  assert.equal(maintenanceCapability(target, { commit, source: noStart }).status, "qualify");
  const shared = source(); shared.sharedLock = true;
  assert.equal(maintenanceCapability(target, { commit, source: shared }).status, "qualify");
  assert.equal(maintenanceCapability(target, { image: "postgres:18" }).adapter, null);
  assert.equal(maintenanceCapability(target, { cron: "0 * * * *", source: source(), commit }).adapter, null);
});
test("Docker réel : un worker sans HTTP valide ses tests sous le Node exact sans exécuter sa tâche métier", { skip: process.env.VIGIE_TEST_DOCKER !== "1", timeout: 240_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-worker-capability-"));
  try {
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: "isolated-worker-fixture", private: true, version: "1.0.0", scripts: { start: "node job.cjs", test: "node check.cjs" } }));
    await writeFile(join(folder, "package-lock.json"), JSON.stringify({ name: "isolated-worker-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "isolated-worker-fixture", version: "1.0.0" } } }));
    await writeFile(join(folder, "job.cjs"), "require('node:fs').writeFileSync('job-ran.txt','must not run during validation');");
    await writeFile(join(folder, "check.cjs"), "require('node:assert/strict').equal(process.versions.node,'24.14.0'); if(process.env.DATABASE_URL||process.env.GITHUB_TOKEN||process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY)process.exit(1);");
    await prepareNodeSources(folder, [""], ["package.json", "package-lock.json", "job.cjs", "check.cjs"], "24.14.0");
    assert.equal(JSON.parse(await readFile(join(folder, "package.json"), "utf8")).engines.node, "24.14.0");
    await assert.rejects(access(join(folder, "job-ran.txt")));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test("Statique : la preuve de build Railway et l’absence de fonctions Vercel restent distinctes", () => {
  assert.equal(maintenanceCapability(target, { framework: "node", staticSite: true }).adapter, "node-static");
  const vercel = { ...target, provider: "vercel" as const, url: "https://site.example/" };
  const cap = maintenanceCapability(vercel, { framework: "vite", runtimes: [] });
  assert.equal(cap.status, "qualify"); assert.equal(cap.adapter, null);
  assert.equal(maintenanceCapability(vercel, { framework: "vite", runtimes: ["nodejs24.x"] }).adapter, "node-web");
  assert.equal(maintenanceCapability(vercel, { framework: "nextjs", runtimes: ["nodejs24.x", "python3.13"] }).status, "qualify");
  assert.equal(maintenanceCapability(vercel, { framework: "nextjs", runtimes: ["edge"] }).adapter, null);
  assert.equal(maintenanceCapability(vercel, { commit, source: source(), runtimes: [] }).status, "qualify");
  assert.equal(maintenanceCapability({ ...target, provider: "o2switch" }, { installation: "dolibarr" }).family, "dolibarr");
});
test("Sources partagées : verrou parent et racine commune incluent aussi les consommateurs non rattachés", () => {
  const selected = { ...target, root: "apps/api" };
  const consumers = [{ id: "unlinked", name: "Staff non rattaché", repository: target.repository!, branch: "main", root: "apps/staff" }, { id: "otherbranch", name: "Preview", repository: target.repository!, branch: "preview", root: "apps/staff" }];
  assert.deepEqual(sourceImpact([selected], ["apps/api/package.json"], consumers), []);
  assert.deepEqual(sourceImpact([selected], ["pnpm-lock.yaml"], consumers).map(item => item.id), ["unlinked"]);
  assert.deepEqual(sourceImpact([selected], ["apps/package.json"], consumers).map(item => item.id), ["unlinked"]);
  assert.equal(sourceImpact([selected], ["apps/api/package.json"], [{ ...consumers[0], root: "" }]).length, 1);
});
test("Inventaire de sources : un projet PHP est reconnu sans lancer le scanner Node ni exécuter de script", async () => {
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = JSON.stringify({ qa: "fake-test-token" });
  let scans = 0;
  await assert.rejects(scanCurrentNode(target, commit, {
    github: async path => { assert.ok(path.endsWith(`?ref=${commit}`)); return [{ name: "composer.json", type: "file" }]; },
    scan: async () => { scans++; return []; }, latest: async () => "1.0.0",
  }), error => error instanceof SourceQualificationError && error.sourceQualification.family === "php");
  assert.equal(scans, 0);
});
test("Interface : service manuel et périmètre automatique sont expliqués sans faux statut prêt", () => {
  const manual = maintenanceCapability({ ...target, provider: "o2switch" }, { installation: "dolibarr" });
  const markup = renderToStaticMarkup(createElement(MaintenanceScope, { targets: [{ ...target, capability: manual, unavailable: manual.reason }] }));
  assert.match(markup, /Dolibarr/); assert.match(markup, /Intervention séparée/); assert.match(markup, /autres services admissibles/);
  assert.doesNotMatch(markup, /Parcours automatique disponible/);
});
