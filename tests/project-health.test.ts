import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectHealth } from "../src/lib/project-health";
import { ProjectHealthSummary } from "../src/components/project-health-summary";
import { healthCheck, healthFixture, healthRelease, healthUpdates, healthAt } from "./project-health-fixture";

test("Résumé projet : correctif de sécurité et mise à jour du déploiement actif visibles ensemble", () => {
  const detail = healthFixture(), pkg = detail.railway![0].services[0].activeDeployments[0].evidence!.packages[0];
  pkg.version = "24.21.0";
  pkg.release = { ...healthRelease, state: "available", securityUpdate: true };
  const state = projectHealth(detail);
  assert.equal(state.security.length, 1);
  assert.equal(state.updates.length, 1);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail }));
  assert.match(html, /Alertes de sécurité/);
  assert.match(html, /Mises à jour disponibles/);
  assert.match(html, /correctif de sécurité manquant/);
  assert.match(html, /24.21.0 → 24.22.1/);
  assert.match(html, /<summary>Voir les composants concernés<\/summary>/);
});

test("Résumé projet : une dernière tentative échouée ne remplace pas les versions actives", () => {
  const detail = healthFixture(), service = detail.railway![0].services[0];
  service.latestDeployment = structuredClone(service.activeDeployments[0]);
  service.latestDeployment.id = "rejected";
  service.latestDeployment.status = "FAILED";
  service.latestDeployment.evidence!.packages[0].release = { ...healthRelease, state: "available", securityUpdate: true };
  assert.equal(projectHealth(detail).security.length, 0);
  assert.equal(projectHealth(detail).updates.length, 0);
});

test("Résumé projet : candidats rejetés exclus, réserves acceptées conservées et liées à l’image active", () => {
  const detail = healthFixture();
  const cleared = healthUpdates([healthCheck({ status: "blocked" }), healthCheck({ status: "passed", findings: [] })]);
  assert.equal(projectHealth(detail, cleared).security.length, 0);
  const current = healthUpdates([healthCheck()]);
  assert.equal(projectHealth(detail, current).security.length, 1);
  assert.match(projectHealth(detail, current).security[0], /CVE-2026-12345/);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: current }));
  assert.match(html, /<summary>Voir les alertes<\/summary>/);
  assert.match(html, /CVE-2026-12345/);
  assert.equal(projectHealth(detail, healthUpdates([healthCheck({ findings: [{ ...healthCheck().findings[0], scope: "another-service" }] })])).security.length, 0);
  detail.railway![0].services[0].activeDeployments[0].evidence!.imageDigest = "sha256:" + "c".repeat(64);
  assert.equal(projectHealth(detail, current).security.length, 0, "un rapport d’une autre image n’est pas applicable");
});
test("Objectif sécurité : des correctifs restants ne donnent jamais aucune mise à jour signalée", () => {
  const detail = healthFixture();
  const accepted = healthUpdates([healthCheck({ findings: [{ ...healthCheck().findings[0], fixedVersions: ["2.0.3"] }] })]);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: accepted }));
  assert.match(html, /Correctifs de sécurité à valider/);
  assert.match(html, /2.0.3/);
  assert.doesNotMatch(html, /Aucune mise à jour signalée/);
  const unresolved = healthUpdates([healthCheck()]);
  assert.match(renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: unresolved })), /Sécurité non résolue/);
  const failed = healthUpdates([healthCheck({ status: "blocked" })]);
  failed.runs[0].id = "new-search";
  failed.runs[0].stage = "failed";
  failed.runs[0].results[0].stage = "failed";
  failed.runs.push(...accepted.runs);
  assert.equal(projectHealth(detail, failed).security.length, 1, "un essai récent rejeté ne doit pas effacer les alertes du déploiement encore actif");
  assert.match(renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: failed })), /Combinaison sûre non validée/);
});

test("Résumé projet : inventaire en retard après publication ne réannonce pas l’ancien Node vulnérable", () => {
  const detail = healthFixture(), deployment = detail.railway![0].services[0].activeDeployments[0];
  deployment.id = "old-deployment";
  deployment.evidence!.packages[0].release = { ...healthRelease, state: "available", securityUpdate: true };
  detail.railway![0].observedAt = "2026-10-27T14:59:00.000Z";
  const state = projectHealth(detail, healthUpdates());
  assert.equal(state.incomplete, true);
  assert.equal(state.updates.length, 0);
  assert.equal(state.security.length, 0);
});

test("Résumé projet : absence de catalogue ne devient pas un état sécurisé ou à jour", () => {
  const detail = healthFixture();
  detail.railway = [];
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: null }));
  assert.match(html, /Sécurité à vérifier/);
  assert.match(html, /Versions à vérifier/);
  assert.doesNotMatch(html, /Aucune alerte connue|Aucune mise à jour signalée/);
  detail.railway = healthFixture().railway;
  detail.railway![0].connectionError = "Relevé indisponible";
  assert.match(renderToStaticMarkup(createElement(ProjectHealthSummary, { detail })), /Couverture partielle|Contrôle à actualiser/);
});

test("Résumé projet : WordPress, extensions, thèmes et PHP ; une mise à jour ordinaire ne devient pas une faille", () => {
  const detail = healthFixture();
  detail.railway = [];
  detail.hosting = [{ id: "wordpress", connectionId: "hosting", connectionName: "Hébergement", documentRoot: "/home/site/public_html", domains: [], aliases: [], kind: "wordpress", version: "6.9.0", observedAt: healthAt, firstSeenAt: healthAt, lastSeenAt: healthAt, missingSince: null, inspectionError: null, ignored: false, suggestedEnvironment: "production", observerConfigured: true, project: null, linkMethod: "manual", candidates: [], inventory: { source: "wordpress-observer", observedAt: healthAt, lastAttemptAt: healthAt, error: null, wordpress: { version: "6.9.0", latestVersion: "6.9.1", updateState: "available", updateCheckedAt: healthAt, updateSource: "wordpress" }, php: null, site: null, configuration: null, database: null, plugins: [], themes: [], warnings: [] } }];
  assert.equal(projectHealth(detail).updates.length, 1);
  assert.equal(projectHealth(detail).security.length, 0);
  detail.hosting[0].inventory!.php = { version: "8.1.0", scope: "web", sapi: "fpm", extensions: [], limits: {}, release: { latestVersion: "8.1.30", updateAvailable: true, securityRelease: true, upstreamSupported: false, supportEndsAt: "2025-12-31", checkedAt: healthAt } };
  assert.equal(projectHealth(detail).updates.length, 2);
  assert.equal(projectHealth(detail).security.length, 2);
  const updates = healthUpdates([healthCheck({ tool: "WPScan", phase: "after", findings: [{ ...healthCheck().findings[0], package: "wordpresses/wordpress", version: "6.9.0", scope: undefined }] })]);
  Object.assign(updates.runs[0].targets[0], { mode: "wordpress", remoteId: "wordpress", connectionId: "hosting" });
  assert.equal(projectHealth(detail, updates).security.length, 3);
  detail.hosting[0].inventory!.wordpress!.version = "6.9.1";
  assert.equal(projectHealth(detail, updates).security.length, 2, "une ancienne alerte portant sur une version remplacée est écartée");
});

test("Résumé projet : nouvelle LTS et contrôles non terminés restent explicites", () => {
  const detail = healthFixture(), release = detail.railway![0].services[0].activeDeployments[0].evidence!.packages[0].release!;
  release.latestLts = "26.1.0";
  assert.equal(projectHealth(detail).updates.length, 1);
  const updates = healthUpdates();
  updates.runs[0].stage = "verifying";
  assert.match(renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates })), /Mise à jour en cours/);
  updates.runs[0].stage = "attention";
  release.latestLts = "24.22.1";
  assert.match(renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates })), /Vérification requise/);
});
test("Résumé projet : Vercel distingue la branche Node du correctif exact et les mises à jour de framework", () => {
  const detail = healthFixture();
  detail.railway = [];
  detail.vercel = [{ id: "vercel", name: "Frontend", teamId: "team", teamSlug: "team", teamName: "Team", framework: "nextjs", nodeBranch: "24.x", rootDirectory: null, repository: "example/app", productionBranch: "main", domains: [], latest: null, excluded: false, clientSuggestion: null, connectionId: "connection", connectionName: "Vercel", configured: true, connectionError: null, observedAt: healthAt, missingSince: null, projectId: "project", projectName: "App", clientName: null, linkMethod: "manual", production: { id: "deployment", url: "example.test", state: "READY", target: "production", createdAt: healthAt, framework: "nextjs", nodeBranch: "24.x", repository: "example/app", branch: "main", commit: null, regions: [], nodeRelease: { ...healthRelease, state: "unknown", securityUpdate: null }, analysis: { status: "observed", checkedAt: healthAt, truncated: false, languages: [], runtimes: [], technologies: [{ name: "next", version: "16.0.0", usage: "framework", source: "build-log", update: "available", latestVersion: "16.1.0" }] } } }];
  const health = projectHealth(detail);
  assert.equal(health.securityKnown, false);
  assert.equal(health.security.length, 0);
  assert.equal(health.updates.length, 1);
  assert.match(renderToStaticMarkup(createElement(ProjectHealthSummary, { detail })), /Sécurité à vérifier/);
  const state=healthUpdates([]), sha="a".repeat(40);
  Object.assign(state.runs[0].targets[0],{provider:"vercel",remoteId:"vercel",environmentId:null,root:""});
  detail.vercel![0].production!.commit=sha;
  state.runs[0].results[0].checks=[healthCheck({status:"passed",findings:[],scope:""}),healthCheck({tool:"Node",phase:"after",status:"passed",findings:[],nodeEvidence:{version:"24.22.1",deploymentId:"deployment",source:"vercel-function",usage:"runtime",projectId:"vercel",commit:sha,region:"fra1"}})];
  assert.equal(projectHealth(detail,state).securityKnown,true,"le scan accepté reste lié au déploiement Vercel attesté");
  state.runs[0].results[0].managedNode={provider:"vercel",version:"24.22.1",latestLts:"24.22.2",updatePending:true,securityUpdate:true,checkedAt:healthAt};
  const managedHealth=projectHealth(detail,state);
  assert.equal(managedHealth.security.length,1,"le correctif de sécurité Node reste signalé");
  assert.ok(managedHealth.manualUpdates.some(item=>item.reason.includes("Runtime géré par Vercel")));
  assert.ok(managedHealth.updates.some(item=>item.includes("24.22.1 → 24.22.2")));
  detail.vercel![0].production!.commit="b".repeat(40);
  assert.equal(projectHealth(detail,state).securityKnown,false,"un nouveau commit ne réutilise pas la preuve précédente");
});
