import { authFixture } from "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createProject, database, projectDetail, save, workspaceData } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import { activityPage } from "../src/lib/activity";
import { activityEntries, activityOutcome } from "../src/lib/activity-model";
import { listBackups } from "../src/lib/backups";
import { updateStorage } from "../src/lib/updates/storage";
import { projectSummaries } from "../src/lib/project-summaries";
import { observedInventory } from "../src/lib/project-summary";
import { refreshProjectHosting } from "../src/lib/updates/refresh-hosting";
import { reconcileAutomaticControls } from "../src/lib/automatic-controls";
import { automaticControlDue, controlMatches, controlSource, hasVerifiedSecurityControl, type AutomaticControl } from "../src/lib/automatic-control-state";
import { writeAutomaticControl } from "../src/lib/automatic-control-storage";
import { observedProjectDetail } from "../src/lib/project-observations";
import { railwayState } from "../src/lib/railway";
import { updateTargets } from "../src/lib/updates/targets";
import { ApiError } from "../src/lib/http";
import { GET, POST } from "../src/app/api/[...path]/route";
import { healthCheck, healthFixture, healthUpdates } from "./project-health-fixture";

async function project(name: string) { return createProject("live", createProjectSchema.parse({ name, url: "https://example.test", technology: "Node.js", provider: "Vercel", runtime: "Node", version: "24" })); }

test("Historique serveur : recherche et pagination retrouvent les actions au-delà de la centième", async () => {
  const p = await project("Historical audit fixture");
  for (let index = 0; index < 125; index++) await save("activity", "live", { id: randomUUID(), projectId: p.id, projectName: p.name, action: "project.created", detail: `audit-archive-${index}`, createdAt: new Date(Date.UTC(2025, 0, 1) + index * 1000).toISOString() }, p.id);
  const result = await activityPage({ projectId: p.id, query: "AUDIT-ARCHIVE", page: 4 }, "live");
  assert.equal(result.total, 125); assert.equal(result.items.length, 25);
  assert.equal(result.items.at(-1)?.detail, "audit-archive-0");
  assert.equal((await activityPage({ projectId: p.id, query: "audit-archive-0" }, "live")).total, 1);
  assert.equal((await activityPage({ projectId: p.id, query: "%' OR 1=1 --" }, "live")).total, 0);
  assert.equal((await activityPage({ projectId: p.id, kind: "Revues", query: "audit-archive" }, "live")).total, 0);
});

test("Historique serveur : caractères LIKE littéraux et date civile de Paris sont respectés", async () => {
  const p = await project("Date audit fixture");
  for (const [detail, createdAt] of [["ParisBoundary 100%_done", "2024-01-01T23:30:00.000Z"], ["ParisBoundary 100X_done", "2024-01-01T22:59:00.000Z"]]) await save("activity", "live", { id: randomUUID(), projectId: p.id, projectName: p.name, action: "project.reviewed", detail, createdAt }, p.id);
  assert.equal((await activityPage({ projectId: p.id, query: "100%_done" }, "live")).total, 1);
  const result = await activityPage({ projectId: p.id, query: "ParisBoundary", since: "2024-01-02", kind: "Revues" }, "live");
  assert.equal(result.total, 1); assert.equal(result.items[0].detail, "ParisBoundary 100%_done");
  await assert.rejects(activityPage({ since: "2026-02-30" }, "live"), /invalide/);
});

test("Activité et historique : seuls les bilans en échec et les nouvelles propositions sont affichés", async () => {
  const p = await project("Maintenance history fixture");
  const actions = ["updates.assessment_started", "updates.assessed", "updates.assessment_failed", "updates.assessment_changed", "updates.completed", "updates.failed", "project.updated"];
  for (const [index, action] of actions.entries()) {
    await save("activity", "live", {
      id: randomUUID(), projectId: p.id, projectName: p.name, action,
      detail: "Maintenance history marker", createdAt: new Date(Date.UTC(2025, 0, 2) + index * 1000).toISOString(),
    }, p.id);
  }
  for (const projectId of [undefined, p.id]) {
    const filters = { projectId, query: p.name };
    const assessments = await activityPage({ ...filters, kind: "Bilans automatiques" }, "live");
    assert.equal(assessments.total, 2);
    assert.deepEqual(assessments.items.map(item => item.action), ["updates.assessment_changed", "updates.assessment_failed"]);
    assert.equal(assessments.items[1].detail, "Consultez le bilan dans la fiche du projet.");
    assert.equal((await activityPage({ projectId, kind: "Bilans automatiques", query: "assessment_started" }, "live")).total, 0);
    const updates = await activityPage({ ...filters, kind: "Mises à jour" }, "live");
    assert.deepEqual(updates.items.map(item => item.action), ["updates.failed", "updates.completed"]);
  }
  for (const data of [await workspaceData("live"), await projectDetail(p.id, "live")]) {
    assert.deepEqual(data.activity.filter(item => item.projectId === p.id && item.action.startsWith("updates.assess")).map(item => item.action), ["updates.assessment_changed", "updates.assessment_failed"]);
  }
});

test("À suivre : les échecs et propositions sont recherchés dans tout le journal", async () => {
  const p = await project("Focus activity fixture");
  const samples = [
    ["hosting.inventory", "Relevé ordinaire"],
    ["hosting.inventory_failed", "Relevé en échec"],
    ["Échec historique", "Ancien format"],
    ["updates.assessment_changed", "Nouvelle proposition"],
    ["updates.completed", "Installation terminée"],
    ["hosting.automatic_control", "Contrôle automatique : 2 service(s) vérifié(s), 0 couverture(s) limitée(s), 0 échec(s), 0 différé(s)."],
    ["hosting.automatic_control", "Contrôle automatique : 2 service(s) vérifié(s), 0 couverture(s) limitée(s), 12 échec(s), 0 différé(s)."],
  ];
  for (const [index, [action, detail]] of samples.entries()) {
    await save("activity", "live", {
      id: randomUUID(), projectId: p.id, projectName: p.name, action, detail,
      createdAt: new Date(Date.UTC(2025, 0, 3, 0, index)).toISOString(),
    }, p.id);
  }
  for (const projectId of [undefined, p.id]) {
    const page = await activityPage({ projectId, query: p.name, view: "focus" }, "live");
    assert.equal(page.total, 4);
    assert.deepEqual(page.items.map(item => item.action), [
      "hosting.automatic_control", "updates.assessment_changed", "Échec historique", "hosting.inventory_failed",
    ]);
    assert.deepEqual(page.items.map(activityOutcome), ["failure", "change", "failure", "failure"]);
  }
});

test("Journal complet : une collecte ne se coupe pas à la pagination et respecte les filtres", async () => {
  const first = await project("Collection premier projet");
  const second = await project("Collection second projet");
  const collectionId = randomUUID();
  const otherCollection = randomUUID();
  for (let index = 0; index < 56; index++) {
    const p = index === 55 ? second : first;
    await save("activity", "live", {
      id: randomUUID(), projectId: p.id, projectName: p.name,
      action: "hosting.inventory", detail: `pagination-inventaire ${index}`,
      createdAt: new Date(Date.UTC(2025, 0, 3, 0, index)).toISOString(),
      collectionId: index >= 26 ? collectionId : index >= 24 ? otherCollection : undefined,
    }, p.id);
  }
  const filters = { view: "complete", query: "pagination-inventaire" };
  const firstPage = await activityPage(filters, "live");
  assert.equal(firstPage.total, 26);
  const entries = activityEntries(firstPage.items, true);
  assert.equal(entries.length, 25);
  assert.equal(entries[0].events.length, 30);
  assert.equal(entries[0].latest.projectId, second.id);
  assert.equal(entries[1].events.length, 2);
  const lastPage = await activityPage({ ...filters, page: 1 }, "live");
  assert.deepEqual(lastPage.items.map(item => item.detail), ["pagination-inventaire 0"]);
  const scoped = await activityPage({ ...filters, projectId: first.id }, "live");
  assert.equal(activityEntries(scoped.items, true)[0].events.length, 29);
  const search = await activityPage({ ...filters, query: "pagination-inventaire 55" }, "live");
  assert.deepEqual(search.items.map(item => item.projectId), [second.id]);
});

test("Actualisation : seules les connexions liées et périmées sont relues, avec déduplication des appels concurrents", async () => {
  const p = healthFixture().project; let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const item = { projectId: p.id, connectionId: "connected", observedAt: new Date(Date.now() - 16 * 60_000).toISOString(), connectionError: null };
  const deps = { project: async () => p, vercel: async () => ({ projects: [item, { ...item }, { ...item, projectId: "other", connectionId: "unrelated" }] }) as any, railway: async () => ({ projects: [] }) as any, syncVercel: async () => { calls++; await gate; return {} as any; }, syncRailway: async () => { throw Error("must not run"); } };
  const first = refreshProjectHosting(p.id, deps), second = refreshProjectHosting(p.id, deps);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); release();
  assert.equal((await first).errors.length, 0); await second;
  item.observedAt = new Date().toISOString(); await refreshProjectHosting(p.id, deps); assert.equal(calls, 1);
  item.observedAt = "invalid"; deps.syncVercel = async () => { throw Error("private provider response"); };
  const failed = await refreshProjectHosting(p.id, deps); assert.equal(failed.errors.length, 1); assert.doesNotMatch(failed.errors[0], /private provider/);
});

test("Couverture limitée : pas de faux succès de sécurité, pas de retry toutes les cinq minutes, une vraie erreur reste isolée", async () => {
  const detail = healthFixture(), target = healthUpdates().runs[0].targets[0];
  detail.railway![0].observedAt = new Date().toISOString();
  const writes: AutomaticControl[] = [];
  const limited = { ...target, id: "external-image", repository: null };
  const result = await reconcileAutomaticControls({}, { projects: async () => [detail.project], detail: async () => detail, targets: async () => [limited, target], read: async () => null, write: async report => { writes.push(report); }, claim: async () => async () => {}, log: async () => {}, scan: async () => { throw new ApiError("GitHub refuse l’opération (404)"); } });
  assert.equal(result.limited, 1); assert.equal(result.failed, 1);
  const report = writes.find(report => report.targetId === limited.id)!;
  assert.equal(report.coverage, "partial"); assert.equal(report.error, undefined); assert.deepEqual(report.checks, []);
  assert.equal(automaticControlDue(report, report.identity, Date.parse(report.attemptedAt) + 5 * 60_000), false);
  assert.equal(controlMatches(report, limited, detail), true);
  assert.equal(hasVerifiedSecurityControl(detail, { enabled: true, targets: [limited], runs: [], automaticControls: [report] }), false);
  assert.match(writes.find(report => report.targetId === target.id)!.error!, /404/);
});

test("Sauvegardes : les traces de mise à jour ne sont pas des ZIP téléchargeables", async () => {
  const p = await project("Recovery fixture"), run = healthUpdates().runs[0];
  run.id = randomUUID(); run.projectId = p.id; run.targets[0].projectId = p.id;
  run.targets[0].mode = "wordpress"; run.targets[0].provider = "o2switch";
  run.results[0].backup = `/home/test/.vigie-backups/${run.id}/abc123`;
  run.results[0].warnings = ["private-content-not-for-catalog"];
  await (await updateStorage()).prepare("INSERT INTO update_runs(id,project_id,stage,data) VALUES(?,?,?,?)").run(run.id, p.id, run.stage, JSON.stringify(run));
  assert.equal((await listBackups()).some(group => group.projectId === p.id), false);
});

test("Résumés groupés : un identifiant disparu ne supprime pas les autres projets, pas de faux état sûr", async () => {
  const p = await project("Summary fixture");
  const data = await projectSummaries([p.id, randomUUID()]);
  assert.ok(data[p.id]); assert.equal(Object.keys(data).length, 1);
  assert.equal(data[p.id].known, false); assert.equal(data[p.id].count, 0);
  const detail = healthFixture(); assert.equal(observedInventory(detail), true, "les paquets de l’image observée constituent un relevé technique");
});

test("Résumés groupés : le rapport et le dernier traitement restent associés à leur projet", async () => {
  const [first, second] = await Promise.all([project("Railway avec rapport"), project("Projet sans rapport")]);
  const remote = healthFixture().railway![0];
  const now = new Date().toISOString();
  await railwayState();
  await database().prepare("INSERT INTO railway_connections(id,workspace_id,data,secret_cipher) VALUES(?,?,?,?)")
    .run(remote.connectionId, remote.workspaceId, JSON.stringify({ id: remote.connectionId, name: "Railway", workspaceId: remote.workspaceId }), "unused");
  await database().prepare("INSERT INTO railway_projects(connection_id,remote_id,project_id,observed_at,data) VALUES(?,?,?,?,?)")
    .run(remote.connectionId, remote.id, first.id, now, JSON.stringify(remote));
  const [target] = await updateTargets(first.id);
  const source = controlSource(target, await observedProjectDetail(first.id, "live"))!;
  await writeAutomaticControl({ targetId: target.id, identity: source.identity, attemptedAt: now, checkedAt: now,
    checks: [healthCheck({ phase: "before", checkedAt: now })], updates: [], warnings: [] });

  const run = { ...healthUpdates().runs[0], id: randomUUID(), projectId: second.id, createdAt: now, stage: "attention" as const };
  await (await updateStorage()).prepare("INSERT INTO update_runs(id,project_id,stage,data) VALUES(?,?,?,?)")
    .run(run.id, run.projectId, run.stage, JSON.stringify(run));

  const summaries = await projectSummaries([first.id, second.id, first.id]);
  assert.equal(Object.keys(summaries).length, 2);
  assert.equal(summaries[first.id].severityCounts?.high, 1);
  assert.equal(summaries[first.id].attention, false);
  assert.equal(summaries[second.id].count, 0);
  assert.equal(summaries[second.id].known, false);
  assert.equal(summaries[second.id].attention, true);
});

test("Routes audit : authentification conservée et requête de résumé bornée", async () => {
  for (const path of ["activity", "backups"]) assert.equal((await GET(new Request(`http://127.0.0.1:3001/api/${path}`), { params: Promise.resolve({ path: [path] }) })).status, 401);
  const fixture = await authFixture();
  const response = await POST(new Request("http://127.0.0.1:3001/api/project-summaries", { method: "POST", headers: { cookie: fixture.cookie, "Content-Type": "application/json", origin: "http://127.0.0.1:3001" }, body: JSON.stringify({ ids: Array.from({ length: 201 }, () => randomUUID()) }) }), { params: Promise.resolve({ path: ["project-summaries"] }) });
  assert.equal(response.status, 400);
});
