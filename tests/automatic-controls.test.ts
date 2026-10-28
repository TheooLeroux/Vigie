import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { automaticControlDue, automaticControlFresh, controlInterval, controlSource, type AutomaticControl } from "../src/lib/automatic-control-state";
import { claimAutomaticControl, readAutomaticControl, reconcileAutomaticControls, writeAutomaticControl } from "../src/lib/automatic-controls";
import { healthCheck, healthFixture, healthUpdates } from "./project-health-fixture";
import { projectHealth } from "../src/lib/project-health";
import type { UpdateTarget } from "../src/lib/updates/types";
import { randomBytes, randomUUID } from "node:crypto";
import { createProject } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import { applyVercelSnapshot, linkVercelProject, saveVercelConnection } from "../src/lib/vercel";
import { observedProjectDetail } from "../src/lib/project-observations";
import { updateTargets } from "../src/lib/updates/targets";
import type { VercelProject } from "../src/lib/vercel-types";

function fixture() {
  const detail = healthFixture(), target = healthUpdates().runs[0].targets[0];
  detail.railway![0].observedAt = new Date().toISOString();
  const source = controlSource(target, detail)!;
  const at = new Date().toISOString();
  const report: AutomaticControl = { targetId: target.id, identity: source.identity, attemptedAt: at, checkedAt: at, checks: [healthCheck({ phase: "before", checkedAt: at })], updates: ["library 1.0.0 → 2.0.0"], warnings: [] };
  return { detail, target, source, report };
}

test("Contrôle autonome : cadence horaire, nouveau déploiement et reprise des erreurs", () => {
  const { report } = fixture(), now = Date.parse(report.checkedAt!);
  assert.equal(automaticControlDue(null, report.identity, now), true);
  assert.equal(automaticControlDue(report, report.identity, now + controlInterval - 1), false);
  assert.equal(automaticControlDue(report, report.identity, now + controlInterval), true);
  assert.equal(automaticControlDue(report, "new-deployment", now), true);
  assert.equal(automaticControlDue(report, report.identity, now, true), true);
  const failed = { ...report, error: "offline" };
  assert.equal(automaticControlFresh(failed, now), false);
  assert.equal(automaticControlDue(failed, report.identity, now + 299_999), false);
  assert.equal(automaticControlDue(failed, report.identity, now + 300_000), true);
  assert.equal(automaticControlDue({ ...report, checkedAt: "invalid" }, report.identity, now), true);
  assert.equal(automaticControlFresh(report, now - 1), false);
});

test("Contrôle autonome : verrou durable, récupération après arrêt et protection du nouveau propriétaire", async () => {
  const now = Date.now(), id = "lease-fixture";
  const expired = await claimAutomaticControl(id, now - 11 * 60_000);
  assert.ok(expired);
  const current = await claimAutomaticControl(id, now);
  assert.ok(current);
  await expired();
  assert.equal(await claimAutomaticControl(id, now), null, "l’ancien propriétaire ne supprime pas le verrou courant");
  await current();
  const next = await claimAutomaticControl(id, now);
  assert.ok(next); await next();
});

test("Contrôle autonome : exécution sans interface, conservation des résultats et isolation des pannes", async () => {
  const { detail, target, report } = fixture();
  const targets = [target, { ...target, id: "healthy" }];
  await writeAutomaticControl({ ...report, checkedAt: new Date(Date.now() - 2 * controlInterval).toISOString(), attemptedAt: new Date(Date.now() - 2 * controlInterval).toISOString() });
  const scanned: string[] = [];
  const dependencies = {
    projects: async () => [detail.project, { ...detail.project, id: "archived", lifecycle: "archived" as const }],
    detail: async () => detail,
    targets: async () => targets,
    scan: async (item: UpdateTarget) => { scanned.push(item.id); if (item.id === target.id) throw Error("private credential must not appear"); return { checks: [], updates: [], warnings: [] }; },
    read: readAutomaticControl, write: writeAutomaticControl, claim: claimAutomaticControl,
    log: async () => {},
  };
  assert.deepEqual(await reconcileAutomaticControls({}, dependencies), { checked: 1, failed: 1, deferred: 0 });
  assert.deepEqual(scanned, [target.id, "healthy"]);
  const failed = (await readAutomaticControl(target.id))!;
  assert.deepEqual(failed.checks, report.checks, "la dernière preuve reste conservée avec son ancienne date");
  assert.ok(failed.error);
  assert.ok(!JSON.stringify(failed).includes("private credential"));
  assert.equal(automaticControlFresh(failed), false);
  scanned.length = 0;
  assert.deepEqual(await reconcileAutomaticControls({}, dependencies), { checked: 0, failed: 0, deferred: 0 });
  assert.deepEqual(scanned, [], "aucun nouveau scan avant son échéance");
  const release = await claimAutomaticControl("healthy"); assert.ok(release);
  assert.deepEqual(await reconcileAutomaticControls({ force: true }, dependencies), { checked: 0, failed: 1, deferred: 1 });
  await release();
});

test("Contrôle autonome : un déploiement qui change pendant le scan ne reçoit pas le rapport précédent", async () => {
  const { detail, target } = fixture(); target.id = "changed-during-scan";
  let written: AutomaticControl | undefined;
  const result = await reconcileAutomaticControls({ projectId: detail.project.id }, {
    projects: async () => [detail.project, { ...detail.project, id: "another-project" }], detail: async () => detail, targets: async () => [target],
    scan: async () => { detail.railway![0].services[0].activeDeployments[0].id = "new"; return { checks: [], updates: [], warnings: [] }; },
    read: async () => null, write: async control => { written = control; }, claim: claimAutomaticControl, log: async () => {},
  });
  assert.equal(result.failed, 1); assert.ok(written?.error); assert.equal(written?.checkedAt, undefined);
});

test("Santé : alertes et versions automatiques liées au déploiement actuel, expiration et pannes visibles", () => {
  const { detail, target, report } = fixture();
  const state = { enabled: false, targets: [target], runs: [], automaticControls: [report] };
  const health = projectHealth(detail, state);
  assert.equal(health.security.length, 1);
  assert.equal(health.securityFromScan, true);
  assert.ok(health.updates.includes("library 1.0.0 → 2.0.0"));
  report.error = "offline";
  assert.equal(projectHealth(detail, state).securityFromScan, true, "les alertes déjà connues restent visibles pendant la panne");
  assert.equal(projectHealth(detail, state).incomplete, true);
  delete report.error;
  report.checkedAt = new Date(Date.now() - controlInterval).toISOString();
  assert.equal(projectHealth(detail, state).securityFromScan, true, "l’expiration ne fait pas disparaître les alertes connues");
  report.checks = [];
  assert.equal(projectHealth(detail, state).securityFromScan, false);
  report.checkedAt = new Date().toISOString();
  detail.railway![0].services[0].activeDeployments[0].id = "redeployed-same-commit";
  assert.equal(projectHealth(detail, state).security.length, 0);
  assert.equal(projectHealth(detail, state).incomplete, true);
});

test("Source du contrôle : refuser des instances avec des commits différents ou une racine différente", () => {
  const { detail, target } = fixture(), service = detail.railway![0].services[0];
  service.activeDeployments.push(structuredClone(service.activeDeployments[0]));
  service.activeDeployments[1].evidence!.commit = "a".repeat(40);
  assert.equal(controlSource(target, detail), null);
  service.activeDeployments.pop();
  service.activeDeployments[0].evidence!.rootDirectory = "/other";
  assert.equal(controlSource(target, detail), null);
  service.activeDeployments[0].evidence!.rootDirectory = "/backend";
  detail.railway![0].observedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  assert.equal(controlSource(target, detail), null, "un relevé hébergeur périmé ne confirme pas le commit courant");
});

test("Contrôle réel depuis la base : les observations hébergeur sont chargées sans assemblage fictif", async () => {
  process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const project = await createProject("live", createProjectSchema.parse({ name: "Observed fixture", url: "https://observed.example.test" }));
  const connection = await saveVercelConnection({ name: "Observed fixture", teamId: `team_${randomUUID().replaceAll("-", "")}`, secret: "unit-test-only" });
  const at = new Date().toISOString(), commit = "c".repeat(40);
  const remote: VercelProject = { id: `prj_${randomUUID().replaceAll("-", "")}`, name: project.name, teamId: connection.teamId, teamSlug: "qa", teamName: "QA", framework: "nextjs", nodeBranch: "24.x", rootDirectory: null, repository: "qa/observed", productionBranch: "main", domains: [], excluded: false, clientSuggestion: null, latest: null, production: { id: "deployed", state: "READY", target: "production", createdAt: at, url: project.url, framework: "nextjs", nodeBranch: "24.x", repository: "qa/observed", branch: "main", commit, regions: [] } };
  await applyVercelSnapshot(connection.id, [remote]);
  await linkVercelProject(connection.id, remote.id, project.id);
  const detail = await observedProjectDetail(project.id, "live");
  const target = (await updateTargets(project.id))[0];
  assert.equal(detail.vercel?.[0].production?.commit, commit);
  assert.equal(controlSource(target, detail)?.commit, commit);
  let scanned = false;
  const result = await reconcileAutomaticControls({ provider: "vercel" }, {
    projects: async () => [project], detail: observedProjectDetail, targets: updateTargets,
    scan: async (_target, source) => { assert.equal(source.commit, commit); scanned = true; return { checks: [], updates: [], warnings: [] }; },
    read: readAutomaticControl, write: writeAutomaticControl, claim: claimAutomaticControl, log: async () => {},
  });
  assert.equal(scanned, true);
  assert.equal(result.checked, 1);
  assert.equal(result.failed, 0);
  assert.equal((await readAutomaticControl(target.id))?.error, undefined);
});

test("Parc : limiter à trois projets simultanés pour ne pas retarder tout le parc derrière un scan lent", async () => {
  const { detail, target } = fixture();
  const projects = Array.from({length: 7}, (_, index) => ({...detail.project, id: `parallel-${index}`}));
  let active = 0, maximum = 0;
  const result = await reconcileAutomaticControls({}, {
    projects: async () => projects,
    detail: async id => ({...detail, project: {...detail.project, id}}),
    targets: async id => [{...target, id: `target-${id}`, projectId: id}],
    scan: async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return {checks: [], updates: [], warnings: []};
    },
    read: async () => null, write: async () => {}, claim: async () => async () => {}, log: async () => {},
  });
  assert.equal(result.checked, 7);
  assert.equal(maximum, 3);
});
