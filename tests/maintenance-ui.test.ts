import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectMaintenance } from "../src/components/project-maintenance";
import { MaintenanceQuickUpdate } from "../src/components/maintenance-quick-update";
import { maintenanceScope } from "../src/lib/maintenance-scope";
import type { MaintenanceState } from "../src/lib/maintenance-contract";

test("Fiche projet : parcours rapide visible, sans écriture au rendu", () => {
  let requests = 0;
  const html = renderToStaticMarkup(
    createElement(ProjectMaintenance, {
      projectId: "project-alpha",
      projectName: "Alpha & Beta",
      request: async () => { requests++; },
    }),
  );
  assert.match(html, /Mises à jour de Alpha &amp; Beta/);
  assert.match(html, /Node et dépendances/);
  assert.doesNotMatch(html, /\bPR\b|Options avancées|Plan et portée|fusion/i);
  assert.equal(requests, 0);
});

test("Parcours rapide : un bouton par service, blocages et verrou partagé visibles", () => {
  const targets = [
    { id: "web", name: "Frontend", provider: "Vercel", repository: "team/app", directory: "", blocked: null },
    { id: "docs", name: "Documentation", provider: "Railway", repository: "team/docs", directory: "docs", blocked: "Image externe" },
  ] as MaintenanceState["targets"];
  let writes = 0;
  const render = (state: MaintenanceState, busy = false) => renderToStaticMarkup(createElement(MaintenanceQuickUpdate, {
    state, targets, busy, onUpdate: () => { writes++; },
  }));
  const state = { configured: true, targets, jobs: [] } as unknown as MaintenanceState;
  const html = render(state);
  assert.match(html, /aria-label="Mettre à jour — Frontend"/);
  assert.match(html, /aria-label="Mettre à jour — Documentation" disabled/);
  assert.match(html, /publie et déclenche son déploiement/);
  assert.doesNotMatch(html, /<select/);
  assert.equal(writes, 0);
  state.jobs = [{ status: "pull_request", payload: { repository: "TEAM/APP" } }] as MaintenanceState["jobs"];
  assert.doesNotMatch(render(state), /aria-label="Mettre à jour — Frontend" disabled/);
  state.jobs = [{ status: "queued", payload: { repository: "TEAM/APP", execute: true } }] as MaintenanceState["jobs"];
  assert.match(render(state), /aria-label="Mettre à jour — Frontend" disabled/);
  assert.match(render(state), /Mise à jour en cours/);
  state.jobs = [];
  assert.match(render(state, true), /aria-label="Mettre à jour — Frontend" disabled/);
});

test("Fiche projet : services et suivi strictement limités au projet choisi", () => {
  const state = {
    targets: [
      { id: "alpha-web", projectId: "alpha" },
      { id: "beta-api", projectId: "beta" },
      { id: "alpha-docs", projectId: "alpha" },
    ],
    jobs: [
      { id: "beta-update", projectId: "beta" },
      { id: "alpha-update", projectId: "alpha" },
    ],
  } as MaintenanceState;
  const alpha = maintenanceScope(state, "alpha");
  assert.deepEqual(alpha.targets.map((target) => target.id), [
    "alpha-web", "alpha-docs",
  ]);
  assert.deepEqual(alpha.jobs.map((job) => job.id), ["alpha-update"]);
  assert.deepEqual(maintenanceScope(state, "unlinked"), { targets: [], jobs: [] });
  assert.equal(maintenanceScope(state).targets.length, 3);
  assert.equal(maintenanceScope(state).jobs.length, 2);
  assert.deepEqual(maintenanceScope(null, "alpha"), { targets: [], jobs: [] });
  assert.equal(state.targets.length, 3);
  assert.equal(state.jobs.length, 2);
});
