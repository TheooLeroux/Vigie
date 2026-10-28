import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectHealth } from "../src/lib/project-health";
import { ProjectHealthSummary } from "../src/components/project-health-summary";
import { healthFixture, healthUpdates, healthCheck, healthAt } from "./project-health-fixture";
import type { SiteInventory, WordPressComponent } from "../src/lib/types";
import { wordpressSecurityVersions } from "../src/lib/updates/wordpress-security-key";
import { UpdateReadiness } from "../src/components/project-updates";

function component(slug: string, version: string, latestVersion = version): WordPressComponent {
  return { file: slug + "/main.php", slug, name: slug, version, latestVersion, updateState: version === latestVersion ? "current" : "available", updateCheckedAt: healthAt, updateSource: "wordpress", active: true, mustUse: false, autoUpdate: false, requiresPhp: null, requiresWordPress: null, template: null };
}
function wordpressFixture() {
  const detail = healthFixture(); detail.railway = [];
  const inventory: SiteInventory = { source: "wordpress-observer", observedAt: healthAt, lastAttemptAt: healthAt, error: null, wordpress: { version: "7.1.3", latestVersion: "7.1.3", updateState: "current", updateCheckedAt: healthAt, updateSource: "wordpress" }, php: null, site: null, configuration: null, database: null, plugins: [component("private-pro", "3.0.103", "3.0.124"), component("webtoffee", "5.0.4")], themes: [component("hello-elementor", "3.4.4", "3.5.1"), component("twentytwentyfive", "1.2", "1.5")], warnings: [] };
  detail.hosting = [{ id: "wordpress", connectionId: "hosting", connectionName: "o2switch", documentRoot: "/home/site/public_html", domains: [], aliases: [], kind: "wordpress", version: "7.1.3", observedAt: healthAt, firstSeenAt: healthAt, lastSeenAt: healthAt, missingSince: null, inspectionError: null, ignored: false, suggestedEnvironment: "production", observerConfigured: true, project: null, linkMethod: "manual", candidates: [], inventory }];
  const state = healthUpdates([]);
  Object.assign(state.runs[0].targets[0], { mode: "wordpress", remoteId: "wordpress", connectionId: "hosting" });
  state.runs[0].results[0].checks = [];
  state.runs[0].results[0].warnings = ["private-pro : catalogue privé, non identifié ou fermé ; extension conservée, couverture de sécurité limitée."];
  return { detail, inventory, state };
}

test("WordPress : succès avec extension privée et deux thèmes restants explique les trois interventions", () => {
  const { detail, state } = wordpressFixture(), health = projectHealth(detail, state);
  assert.equal(health.updates.length, 3);
  assert.equal(health.manualUpdates.length, 3);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /Interventions manuelles requises/);
  assert.match(html, /Vigie ne peut pas télécharger cette extension/);
  assert.match(html, /Vigie ne met pas les thèmes à jour actuellement/);
  assert.match(html, /Apparence → Thèmes/);
  assert.match(html, /hello-elementor/);
  assert.match(html, /twentytwentyfive/);
  assert.doesNotMatch(html, /Mises à jour disponibles|webtoffee/);
  detail.hosting![0].inventory!.plugins[0].version = "3.0.124";
  detail.hosting![0].inventory!.plugins[0].updateState = "current";
  assert.equal(projectHealth(detail, state).manualUpdates.length, 2, "une mise à jour extérieure effectivement observée disparaît du suivi");
});

test("WordPress : les mises à jour publiques restent disponibles et PHP est géré par l’hébergeur", () => {
  const { detail, inventory, state } = wordpressFixture();
  inventory.plugins.push(component("public-plugin", "1.0", "2.0"));
  inventory.php = { version: "8.2.0", scope: "web", sapi: "litespeed", extensions: [], limits: {}, release: { latestVersion: "8.2.35", updateAvailable: true, securityRelease: false, upstreamSupported: true, supportEndsAt: null, checkedAt: healthAt } };
  const health = projectHealth(detail, state);
  assert.equal(health.manualUpdates.length, 4);
  assert.equal(health.updates.length, 5);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /Mises à jour disponibles/);
  assert.match(html, /public-plugin : 1.0 → 2.0/);
  assert.match(html, /PHP est affiché uniquement/);
});

test("WordPress : WPVulnerability après installation montre les alertes applicables sans reprendre le candidat", () => {
  const { detail, inventory, state } = wordpressFixture();
  state.runs[0].results[0].checks = [
    healthCheck({ tool: "WPVulnerability", phase: "candidate", findings: [{ ...healthCheck().findings[0], package: "plugins/rejected", scope: undefined }] }),
    healthCheck({ tool: "WPVulnerability", phase: "after", findings: [
      { ...healthCheck().findings[0], package: "plugins/private-pro", version: "3.0.103", scope: undefined },
      { ...healthCheck().findings[0], id: "WPV-core", package: "wordpress/wordpress", version: "7.1.3", scope: undefined },
      { ...healthCheck().findings[0], id: "WPV-fixed", package: "plugins/webtoffee", version: "4.9.0", scope: undefined },
    ] }),
  ];
  assert.equal(projectHealth(detail, state).security.length, 2);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /Alertes de sécurité/);
  assert.doesNotMatch(html, /Aucune alerte connue|plugins\/rejected|plugins\/webtoffee/);
  inventory.wordpress!.version = "7.1.4";
  assert.equal(projectHealth(detail, state).security.length, 1);
});

test("WordPress : un ancien inventaire ne réannonce pas une extension déjà corrigée par le rapport gratuit", () => {
  const { detail, inventory, state } = wordpressFixture();
  inventory.plugins[1] = component("webtoffee", "4.9.0", "5.0.4");
  state.runs[0].results[0].checks = [healthCheck({ tool: "WPVulnerability", phase: "after", checkedAt: "2026-10-27T15:01:00.000Z", findings: [] })];
  assert.equal(projectHealth(detail, state).updates.length, 0);
  assert.equal(projectHealth(detail, state).incomplete, true);
});

test("WordPress : contrôle actuel remplace le faux positif historique, y compris sans exécution préalable", () => {
  const { detail, inventory, state } = wordpressFixture();
  state.targets = state.runs[0].targets;
  state.runs[0].results[0].checks = [healthCheck({ tool: "WPVulnerability", phase: "after", findings: [{ ...healthCheck().findings[0], package: "plugins/private-pro", version: "3.0.103", scope: undefined }] })];
  state.currentSecurity = [{ targetId: "target", versions: wordpressSecurityVersions(inventory), warnings: [], check: healthCheck({ tool: "WPVulnerability", phase: "before", findings: [] }) }];
  assert.equal(projectHealth(detail, state).security.length, 0);
  state.runs = [];
  state.currentSecurity[0].check!.findings = [{ ...healthCheck().findings[0], package: "plugins/private-pro", version: "3.0.103", scope: undefined }];
  assert.equal(projectHealth(detail, state).security.length, 1, "la détection ne nécessite aucune mise à jour");
  inventory.plugins[0].version = "3.0.124";
  assert.equal(projectHealth(detail, state).security.length, 0, "un contrôle portant sur d’autres versions n’est pas réutilisé");
  assert.doesNotMatch(renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state })), /Aucune alerte connue/);
});

test("WordPress : contrôle indisponible ne présente pas de confirmation de sécurité", () => {
  const { detail, inventory, state } = wordpressFixture();
  state.targets = state.runs[0].targets;
  state.currentSecurity = [{ targetId: "target", versions: wordpressSecurityVersions(inventory), warnings: [], error: "Fournisseur indisponible" }];
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /Contrôle de sécurité indisponible/);
  assert.doesNotMatch(html, /Aucune alerte connue/);
});

test("WordPress : le résumé distingue la configuration actuelle de l’ancien échec", () => {
  const { detail, state } = wordpressFixture();
  state.runs[0].stage = "failed";
  state.runs[0].results[0].checks = [healthCheck({tool:"WPVulnerability",status:"blocked"})];
  state.targets = state.runs[0].targets;
  state.enabled = false;
  state.disabledReason = "L’exécuteur de maintenance n’est pas connecté à cette instance de Vigie.";
  let html = renderToStaticMarkup(createElement(ProjectHealthSummary,{detail,updates:state}));
  assert.match(html, /Maintenance non activée/);
  assert.match(html, /exécuteur de maintenance n’est pas connecté/);
  assert.doesNotMatch(html, /Dernière tentative WordPress bloquée|Combinaison sûre non validée/);
  state.enabled = true;
  state.targets[0].unavailable = "Le contrôle de l’agent a expiré.";
  html = renderToStaticMarkup(createElement(ProjectHealthSummary,{detail,updates:state}));
  assert.match(html, /Vérification technique requise/);
  state.targets[0].unavailable = null;
  html = renderToStaticMarkup(createElement(ProjectHealthSummary,{detail,updates:state}));
  assert.match(html, /Interventions manuelles requises/);
});

test("WordPress : les correctifs manuels ne gonflent pas le compteur automatique", () => {
  const {detail,inventory,state} = wordpressFixture();
  state.targets = state.runs[0].targets;
  state.currentSecurity = [{targetId:"target",versions:wordpressSecurityVersions(inventory),warnings:state.runs[0].results[0].warnings,check:healthCheck({tool:"WPVulnerability",phase:"before",findings:[{...healthCheck().findings[0],package:"plugins/private-pro",version:"3.0.103",scope:undefined,fixedVersions:["3.0.124"]}]})}];
  const health = projectHealth(detail,state);
  assert.equal(health.manualSecurityFixes.length,1);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary,{detail,updates:state}));
  assert.match(html,/Interventions manuelles requises/);
  assert.match(html,/Correctifs de sécurité à traiter manuellement/);
  assert.doesNotMatch(html,/1 correctif\(s\) ou mise\(s\) à jour à examiner/);
  state.currentSecurity[0].warnings=[];
  state.runs[0].results[0].warnings=[];
  state.currentSecurity[0].manualUpdates=[{package:"plugins/private-pro",version:"3.0.103",reason:"Fichiers personnalisés",action:"Reporter les modifications avec le développeur"}];
  assert.equal(projectHealth(detail,state).manualSecurityFixes.length,1,"une extension personnalisée est conservée même sans avertissement de catalogue privé");
});

test("Disponibilité : les composants manuels n’empêchent pas un WordPress techniquement prêt", () => {
  const {state} = wordpressFixture();
  state.targets = state.runs[0].targets;
  state.runs[0].results[0].manualUpdates = [{package:"plugins/private-pro",version:"3",reason:"Privé",action:"Intervention manuelle"}];
  let html = renderToStaticMarkup(createElement(UpdateReadiness,{state}));
  assert.match(html,/WordPress est prêt pour une maintenance/);
  assert.match(html,/Ils ne bloquent pas/);
  state.enabled = false;
  state.disabledReason = "Exécuteur déconnecté.";
  state.targets[0].unavailable = "Le contrôle de l’agent a expiré.";
  html = renderToStaticMarkup(createElement(UpdateReadiness,{state}));
  assert.match(html,/Maintenance non activée/);
  assert.match(html,/Exécuteur déconnecté/);
  assert.match(html,/Vérification technique/);
  assert.doesNotMatch(html,/0 service|WordPress est prêt/);
});
