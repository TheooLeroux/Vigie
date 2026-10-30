import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import YAML from "yaml";
import { controlSource } from "../src/lib/automatic-control-state";
import { projectHealth } from "../src/lib/project-health";
import { currentAssessmentResults, assessmentInterval, nodeAssessmentChanges } from "../src/lib/updates/assessment";
import { planDailyAssessments } from "../src/lib/updates/daily-assessments";
import { recordAssessmentAfterUpdate } from "../src/lib/updates/assessment-after-update";
import { executeLocalWordPress } from "../src/lib/updates/wordpress-agent-execution";
import { wordpressPlanSchema } from "../src/lib/updates/wordpress-security";
import { agentDirectory } from "../src/lib/updates/wordpress-agent";
import type { SiteInventory } from "../src/lib/types";
import type { UpdateResult } from "../src/lib/updates/types";
import { ProjectHealthSummary } from "../src/components/project-health-summary";
import type { UpdateRun } from "../src/lib/updates/types";
import { healthFixture, healthUpdates, healthRelease } from "./project-health-fixture";

function fixture(changes: string[] = []) {
  const detail = healthFixture(), now = new Date().toISOString();
  detail.railway![0].observedAt = now;
  const pkg = detail.railway![0].services[0].activeDeployments[0].evidence!.packages[0];
  pkg.version = "24.21.0"; pkg.release = { ...healthRelease, state: "available" };
  const state = healthUpdates();
  state.targets = state.runs[0].targets; state.runs = [];
  const identity = controlSource(state.targets[0], detail)!.identity;
  state.automaticControls = [{ targetId: state.targets[0].id, identity, attemptedAt: now, checkedAt: now, checks: [], warnings: [], updates: ["library : 1.0.0 → 9.0.0 (catalogue)"] }];
  state.assessment = { id: "assessment", purpose: "assessment", projectId: detail.project.id, stage: "completed", createdAt: now, updatedAt: now, actor: { name: "Bilan", email: "" }, targets: state.targets, assessmentSources: { [state.targets[0].id]: identity }, results: [{ targetId: state.targets[0].id, name: "Backend", stage: "completed", message: "Proposition testée.", warnings: [], assessment: { changes } }], message: "Aucune installation." };
  return { detail, state, now };
}

test("Bilan : une combinaison actuelle validée remplace les estimations du catalogue sans annoncer une installation", () => {
  const { detail, state } = fixture();
  assert.equal(currentAssessmentResults(detail, state).length, 1);
  assert.equal(projectHealth(detail, state).updates.length, 0);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /Aucune meilleure version validée/);
  assert.doesNotMatch(html, /Mises à jour disponibles|9\.0\.0/);
  assert.match(html, /Aucune installation ni publication automatique/);
});

test("Bilan : seules les propositions testées sont comptées pour le bloc validé", () => {
  const { detail, state } = fixture(["library : 1.0.0 → 1.2.0"]);
  assert.deepEqual(projectHealth(detail, state).updates, ["Backend · library : 1.0.0 → 1.2.0"]);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /Propositions validées avant installation/);
  assert.doesNotMatch(html, /9\.0\.0/);
});

test("Bilan : expiration, déploiement différent et maintenance plus récente invalident la proposition", () => {
  for (const change of ["age", "deployment", "update", "source", "failed"] as const) {
    const { detail, state, now } = fixture(["library : 1.0.0 → 1.2.0"]);
    if (change === "age") state.assessment!.updatedAt = new Date(Date.now() - assessmentInterval - 1).toISOString();
    if (change === "deployment") detail.railway![0].services[0].activeDeployments[0].id = "different";
    if (change === "update") state.runs.push({ ...state.assessment!, purpose: undefined, id: "installation", updatedAt: new Date(Date.parse(now) + 1000).toISOString() });
    if (change === "source") state.assessment!.results[0].assessment!.sourceCommit = "c".repeat(40);
    if (change === "failed") state.assessment!.results[0].stage = "failed";
    assert.equal(currentAssessmentResults(detail, state).length, 0, change);
    assert.ok(!projectHealth(detail, state).updates.some(update => update.includes("1.2.0")), change);
  }
});

test("Bilan : un rapport partiel ne valide pas les autres blocs", () => {
  const { detail, state } = fixture();
  state.assessment!.stage = "failed";
  const second = structuredClone(detail.railway![0].services[0]);
  second.id = "second"; second.name = "Second";
  detail.railway![0].services.push(second);
  state.targets.push({ ...state.targets[0], id: "second", remoteId: second.id, name: second.name });
  state.assessment!.results.push({ targetId: "second", name: "Second", stage: "failed", warnings: [], message: "Tests en échec." });
  assert.equal(projectHealth(detail, state).assessedServices, 1);
  assert.ok(projectHealth(detail, state).updates.some(update => update.includes("Second")));
  assert.match(renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state })), /Bilan partiel|À actualiser/);
});

test("Plan quotidien : projets archivés exclus, installation en cours différée, échec isolé", async () => {
  const projects = ["ready", "busy", "broken", "archived"].map(id => ({ ...healthFixture().project, id, lifecycle: id === "archived" ? "archived" as const : "active" as const }));
  const seen: string[] = [];
  const result = await planDailyAssessments({ projects: async () => projects, expire: async () => {}, start: async (raw, dispatch, options) => {
    const id = (raw as { projectId: string }).projectId;
    seen.push(id); assert.equal(options?.assessment, true);
    if (id === "broken") throw new Error("isolated");
    return { ...fixture().state.assessment!, id, purpose: id === "busy" ? undefined : "assessment", stage: id === "busy" ? "checking" : "queued" } as UpdateRun;
  } });
  assert.deepEqual(seen, ["ready", "busy", "broken"]);
  assert.deepEqual(result, { runs: ["ready"], deferred: 1, failed: 1 });
});

test("Workflow quotidien : une exécution journalière réutilise les validations avec la finalité obligatoire assessment", async () => {
  const daily = YAML.parse(await readFile(".github/workflows/vigie-daily-assessments.yml", "utf8"));
  const update = YAML.parse(await readFile(".github/workflows/vigie-updates.yml", "utf8"));
  assert.equal(daily.on.schedule[0].cron, "17 3 * * *");
  assert.equal(daily.jobs.assess.with.assessment, true);
  assert.equal(daily.jobs.assess.strategy["max-parallel"], 2);
  assert.equal(update.on.workflow_call.inputs.assessment.default, false);
  assert.match(update.jobs.update.steps.at(-1).env.VIGIE_UPDATE_EXPECT_PURPOSE, /assessment/);
});

test("Propositions : un verrou changé sans version directe modifiée reste une amélioration, seules les versions du bloc sont exposées", () => {
  const target = healthUpdates().runs[0].targets[0];
  const result = nodeAssessmentChanges(target, { dependencies: { lib: "1.0.0" } }, { dependencies: { lib: "1.0.0" } }, ["backend/package-lock.json", "frontend/package.json"]);
  assert.deepEqual(result, ["Verrou des dépendances actualisé et validé."]);
});

test("Après maintenance : seule l’observation du déploiement réellement contrôlé produit un bilan actuel", async () => {
  for (const changed of [false, true]) {
    const detail = healthFixture(); detail.railway![0].observedAt = new Date().toISOString();
    const run = healthUpdates().runs[0];
    if (changed) detail.railway![0].services[0].activeDeployments[0].id = "different";
    const reports: UpdateRun[] = [];
    await recordAssessmentAfterUpdate(run, { detail: async () => detail, targets: async () => run.targets, save: async report => { reports.push(report); } });
    assert.equal(reports.length, changed ? 0 : 1);
    if (!changed) {
      assert.equal(reports[0].assessmentOrigin, "maintenance");
      assert.deepEqual(reports[0].results[0].assessment!.changes, []);
      assert.equal(currentAssessmentResults(detail, { ...healthUpdates(), targets: run.targets, runs: [run], assessment: reports[0] }).length, 1);
    }
  }
});

test("Bilan WordPress : inspection et scans des candidates, aucune demande de sauvegarde ou d’installation", async () => {
  const run = healthUpdates().runs[0]; run.purpose = "assessment";
  const target = { ...run.targets[0], root: "/home/fixture/site", mode: "wordpress" as const };
  const plan = wordpressPlanSchema.parse({ wordpress: { current: "7.1.3", target: "7.1.4", integrity: "verified" }, php: "8.3.0", plugins: [], themes: [] });
  const operations: string[] = [], scans: boolean[] = [];
  const inventory: SiteInventory = { source: "wordpress-observer", observedAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(), error: null, wordpress: null, php: { version: "8.3.0", scope: "web", sapi: "fpm", limits: {}, extensions: [] }, site: null, configuration: null, database: null, plugins: [], themes: [], warnings: [] };
  const result: UpdateResult = { targetId: target.id, name: "WordPress", stage: "checking", message: "", warnings: [] };
  await executeLocalWordPress(run, target, result, inventory, async () => {}, {
    agent: async (_target, callback) => callback(async (_id, operation) => {
      operations.push(operation); assert.equal(operation, "inspect");
      return { plan, eligibility: { multisite: false, fileModsDisabled: false, home: target.url! } };
    }, { protocol: "vigie-local-v1", directory: agentDirectory(target.root, "fixture"), secret: "a".repeat(64), phpBinary: "/php", wpBinary: "/wp", environment: "staging", ready: true }),
    scanner: () => Object.assign(async (_plan: unknown, candidate: boolean) => { scans.push(candidate); return []; }, { prepare: async () => plan, warnings: [] as string[] }),
  });
  assert.deepEqual(operations, ["inspect"]);
  assert.deepEqual(scans, [false, true]);
  assert.deepEqual(result.assessment!.changes, ["WordPress : 7.1.3 → 7.1.4"]);
  assert.equal(result.backup, undefined);
  assert.equal(result.stage, "completed");
});
