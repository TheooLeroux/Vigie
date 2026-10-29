import { authFixture } from "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createProject, save } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import { activityPage } from "../src/lib/activity";
import { recordedBackups } from "../src/lib/backups";
import { updateStorage } from "../src/lib/updates/storage";
import { projectSummaries } from "../src/lib/project-summaries";
import { observedInventory } from "../src/lib/project-summary";
import { refreshProjectHosting } from "../src/lib/updates/refresh-hosting";
import { reconcileAutomaticControls } from "../src/lib/automatic-controls";
import { automaticControlDue, controlMatches, hasVerifiedSecurityControl, type AutomaticControl } from "../src/lib/automatic-control-state";
import { ApiError } from "../src/lib/http";
import { GET, POST } from "../src/app/api/[...path]/route";
import { healthFixture, healthUpdates } from "./project-health-fixture";

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

test("Sauvegardes : catalogue de reprise sans export du rapport complet ni des paramètres privés", async () => {
  const p = await project("Recovery fixture"), run = healthUpdates().runs[0];
  run.id = randomUUID(); run.projectId = p.id; run.targets[0].projectId = p.id;
  run.targets[0].mode = "wordpress"; run.targets[0].provider = "o2switch";
  run.results[0].backup = `/home/test/.vigie-backups/${run.id}/abc123`;
  run.results[0].warnings = ["private-content-not-for-catalog"];
  await (await updateStorage()).prepare("INSERT INTO update_runs(id,project_id,stage,data) VALUES(?,?,?,?)").run(run.id, p.id, run.stage, JSON.stringify(run));
  const data = await recordedBackups();
  const saved = data.items.find(item => item.runId === run.id)!;
  assert.equal(saved.kind, "wordpress"); assert.equal(saved.path, run.results[0].backup);
  assert.doesNotMatch(JSON.stringify(data), /private-content-not-for-catalog|nodeEvidence|checks/);
});

test("Résumés groupés : un identifiant disparu ne supprime pas les autres projets, pas de faux état sûr", async () => {
  const p = await project("Summary fixture");
  const data = await projectSummaries([p.id, randomUUID()]);
  assert.ok(data[p.id]); assert.equal(Object.keys(data).length, 1);
  assert.equal(data[p.id].known, false); assert.equal(data[p.id].count, 0);
  const detail = healthFixture(); assert.equal(observedInventory(detail), true, "les paquets de l’image observée constituent un relevé technique");
});

test("Routes audit : authentification conservée et requête de résumé bornée", async () => {
  for (const path of ["activity", "backups"]) assert.equal((await GET(new Request(`http://127.0.0.1:3001/api/${path}`), { params: Promise.resolve({ path: [path] }) })).status, 401);
  const fixture = await authFixture();
  const response = await POST(new Request("http://127.0.0.1:3001/api/project-summaries", { method: "POST", headers: { cookie: fixture.cookie, "Content-Type": "application/json", origin: "http://127.0.0.1:3001" }, body: JSON.stringify({ ids: Array.from({ length: 201 }, () => randomUUID()) }) }), { params: Promise.resolve({ path: ["project-summaries"] }) });
  assert.equal(response.status, 400);
});
