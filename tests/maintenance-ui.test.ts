import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectMaintenance } from "../src/components/project-maintenance";
import { maintenanceScope } from "../src/lib/maintenance-scope";
import type { MaintenanceState } from "../src/lib/maintenance-contract";

test("Fiche projet : entrée Mises à jour explicite, sans requête avant ouverture", () => {
  let requests = 0;
  const html = renderToStaticMarkup(
    createElement(ProjectMaintenance, {
      projectId: "project-alpha",
      projectName: "Alpha & Beta",
      request: async () => { requests++; },
    }),
  );
  assert.match(html, /Mises à jour de Alpha &amp; Beta/);
  assert.match(html, /Mettre à jour/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="project-maintenance-project-alpha"/);
  assert.match(html, /id="project-maintenance-project-alpha" hidden/);
  assert.match(html, /Aucun déploiement direct en production/);
  assert.equal(requests, 0);
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
