import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { securityCheck, requireSecurityPass } from "../src/lib/updates/security";
import { wordpressBlockingMessage } from "../src/lib/updates/wordpress-blocking";
import { UpdateProgress } from "../src/components/project-updates";
import { ProjectHealthSummary } from "../src/components/project-health-summary";
import { healthCheck, healthFixture, healthUpdates } from "./project-health-fixture";

test("WordPress bloqué : deux failles et un signal distincts, barrière intacte, absence de recherche fictive", () => {
  const issue = { ...healthCheck().findings[0], package: "plugins/wpforms", scope: undefined };
  const findings = [issue, { ...issue, id: "other" }, { ...issue, id: "WPV-SUPPLY-40", package: "plugins/kirki" }];
  const candidate = securityCheck("WPVulnerability", "candidate", "fixture", findings);
  assert.equal(candidate.status, "blocked");
  assert.equal(candidate.blockers?.length, 3);
  assert.match(candidate.message, /2 failles connues et 1 signalement à vérifier/);
  assert.match(candidate.message, /avant toute modification/);
  assert.doesNotMatch(candidate.message, /Recherche|3 vulnérabilité/);
  assert.throws(() => requireSecurityPass(candidate), /Mise à jour WordPress bloquée/);
  const final = securityCheck("WPVulnerability", "after", "fixture", findings);
  assert.doesNotMatch(final.message, /avant toute modification/);
  assert.equal(wordpressBlockingMessage(securityCheck("WPVulnerability", "before", "fixture", findings)), null);
});

test("WordPress : ancien échec reste historique mais sa présentation explique le blocage", () => {
  const state = healthUpdates();
  const run = state.runs[0]; run.stage = "failed"; run.message = "Publication arrêtée : 3 vulnérabilité(s). Recherche d’une autre combinaison.";
  run.results[0].stage = "failed";
  run.targets[0].mode = "wordpress";
  run.results[0].checks = [healthCheck({ tool: "WPVulnerability", phase: "candidate", status: "blocked" })];
  const html = renderToStaticMarkup(createElement(UpdateProgress, { run }));
  assert.match(html, /Mise à jour bloquée/);
  assert.doesNotMatch(html, /Non publiée|Recherche d’une autre combinaison/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ProjectHealthSummary, { detail: healthFixture(), updates: state })), /Dernière tentative WordPress bloquée/);
  assert.match(run.message, /Recherche/, "la présentation ne réécrit pas le rapport historique");
});
