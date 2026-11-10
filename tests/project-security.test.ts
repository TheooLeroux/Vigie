import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectSecurity, normalizedVulnerabilities } from "../src/lib/project-security";
import { summarizeProject } from "../src/lib/project-summary";
import { compareProjectSeverity } from "../src/lib/project-severity";
import { controlSource, controlInterval } from "../src/lib/automatic-control-state";
import type { AutomaticControl } from "../src/lib/automatic-control-state";
import { healthCheck, healthFixture, healthUpdates, healthRelease } from "./project-health-fixture";
import type { SecurityFinding, UpdateState } from "../src/lib/updates/types";
import { ProjectSecurityBadge } from "../src/components/project-security-badge";
import { ProjectHealthSummary } from "../src/components/project-health-summary";
import { npmDependencyUsage } from "../src/lib/updates/dependency-usage";
import { railpackImageIdentity, railpackImageReport } from "../src/lib/updates/railpack-image-report";

function fixture(findings = healthCheck().findings) {
  const detail = healthFixture(), target = healthUpdates().runs[0].targets[0], now = new Date().toISOString();
  detail.railway![0].observedAt = now;
  const report: AutomaticControl = { targetId: target.id, identity: controlSource(target, detail)!.identity, attemptedAt: now, checkedAt: now, checks: [healthCheck({ phase: "before", checkedAt: now, findings })], updates: [], warnings: [], securityCoverage: { scope: "dependencies", packages: 30, limitations: [] } };
  const state: UpdateState = { enabled: false, targets: [target], runs: [], automaticControls: [report] };
  return { detail, target, report, state };
}

test("Railpack : OSV et Trivy coexistent avec leurs dates pour le déploiement et l’image attestés", () => {
  const { detail, target, report, state } = fixture();
  const service = detail.railway![0].services[0];
  service.builder = "RAILPACK";
  const deployment = service.activeDeployments[0], evidence = deployment.evidence!;
  evidence.staticSite = true;
  evidence.packages.push({ name: "caddy", version: "2.11.9", usage: "runtime" });
  const imageFinding: SecurityFinding = { id: "CVE-2026-4321", aliases: [], package: "apt", version: "3.0.3", severity: "high", fixedVersions: ["3.0.4"], scope: target.root };
  const check = healthCheck({ tool: "Trivy", scope: "Image Railpack Caddy 2.11.9", checkedAt: report.checkedAt, findings: [imageFinding] });
  const proof = healthCheck({ tool: "Caddy", phase: "after", status: "passed", checkedAt: report.checkedAt, findings: [],
    caddyEvidence: { version: "2.11.9", deploymentId: deployment.id, imageDigest: evidence.imageDigest!, instances: ["instance"],
      packagesHash: "c".repeat(64), binaryHash: "d".repeat(64) } });
  const run = healthUpdates([check, proof]).runs[0];
  Object.assign(run.results[0], { commit: evidence.commit, deploymentId: deployment.id });
  const noop = healthUpdates().runs[0];
  noop.id = "noop";
  state.runs = [noop, run];
  const read = () => projectSecurity(detail, state);
  const current = read();
  assert.equal(current.count, 2);
  assert.deepEqual(current.vulnerabilities.find(item => item.package === "apt")?.scanners, [{ tool: "Trivy", checkedAt: report.checkedAt }]);
  assert.equal(current.services[0].railpackImageCheckedAt, report.checkedAt);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /Version corrigée référencée, image à valider/);
  assert.match(html, /Trivy · image Railpack/);
  check.findings = [{ ...imageFinding, fixedVersions: undefined }];
  const withoutFix = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(withoutFix, /Aucune installation proposée pour ce signalement/);
  assert.match(withoutFix, /aucune version correctrice indiquée dans ce rapport/);
  assert.doesNotMatch(withoutFix, /Version corrigée référencée, image à valider/);
  check.findings = [imageFinding];

  // Evidence must survive the normal five-run history window.
  const identity = railpackImageIdentity(target, detail.railway)!;
  assert.equal(railpackImageReport({ ...run, results: [{ ...run.results[0], stage: "attention" }] }, identity), null);
  assert.equal(railpackImageReport({ ...run, purpose: "assessment" }, identity), null);
  assert.equal(railpackImageReport({ ...run, projectId: "another-project" }, identity), null);
  assert.equal(railpackImageReport({ ...run, results: [{ ...run.results[0], checks: [check] }] }, identity), null);
  const old = railpackImageReport(run, identity)!;
  state.runs = [noop];
  state.railpackImageReports = [old];
  assert.equal(read().count, 2);
  old.check.checkedAt = new Date(Date.now() - controlInterval - 1).toISOString();
  assert.equal(read().count, 2, "les alertes du même digest restent visibles et datées");
  assert.equal(read().services[0].status, "partial");
  assert.match(read().services[0].limitations.join(" "), /nouveau scan/);

  deployment.id = "redeployed";
  report.identity = controlSource(target, detail)!.identity;
  assert.equal(read().count, 1);
  deployment.id = identity.deploymentId;
  // Same commit and same Caddy version are insufficient for a new image.
  evidence.imageDigest = "sha256:" + "e".repeat(64);
  report.identity = controlSource(target, detail)!.identity;
  assert.equal(read().count, 1);
  assert.equal(read().services[0].status, "partial");
  assert.match(read().services[0].limitations.join(" "), /attendent un scan/);
});

test("Compteur : vulnérabilités, soupçons et fins de support sont distincts", () => {
  const finding = healthCheck().findings[0];
  const { detail, state } = fixture([finding, { ...finding, id: "WPV-SUPPLY-test", aliases: [], kind: "supply-chain" }, { ...finding, id: "uncertain", aliases: [], kind: "unconfirmed" }, { ...finding, id: "EOL-OS", aliases: [], package: "base-image" }]);
  detail.railway![0].services[0].activeDeployments[0].evidence!.packages[0].release = { ...healthRelease, supported: false, securityUpdate: true };
  const security = projectSecurity(detail, state), summary = summarizeProject(detail.project, detail, state);
  assert.equal(security.count, 1);
  assert.equal(security.signals.length, 2);
  assert.equal(security.alerts.length, 3);
  assert.equal(summary.count, 1);
  assert.equal(summary.known, false, "l’applicabilité non confirmée limite la couverture");
  assert.equal(summary.severityCounts?.high, 1);
});

test("Signalements : fusion transitive des alias par composant, version et service", () => {
  const finding = healthCheck().findings[0];
  const items: SecurityFinding[] = [
    { ...finding, id: "GHSA-one", aliases: ["CVE-2026-0001"], severity: "low" },
    { ...finding, id: "GHSA-two", aliases: ["CVE-2026-0002"] },
    { ...finding, id: "CVE-2026-0001", aliases: ["GHSA-two"], severity: "critical" },
    { ...finding, id: "GHSA-one", aliases: [], package: "different" },
    { ...finding, id: "GHSA-one", aliases: [], version: "2.0.0" },
  ];
  const evidence = items.map(finding => ({ targetId: "a", name: "A", tool: "OSV" as const, checkedAt: new Date().toISOString(), finding }));
  evidence.push({ ...evidence[0], targetId: "b", name: "B" });
  const entries = normalizedVulnerabilities(evidence);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].severity, "critical");
  assert.deepEqual(entries[0].aliases, ["CVE-2026-0001", "CVE-2026-0002", "GHSA-ONE", "GHSA-TWO"]);
});

test("Fiche : toutes les failles sont visibles, les plus graves en premier", () => {
  const base = healthCheck().findings[0];
  const { detail, state } = fixture([
    ...Array.from({ length: 6 }, (_, index) => ({ ...base, id: `GHSA-low-${index}`, aliases: [], severity: "low" as const, package: `library-${index}` })),
    { ...base, id: "GHSA-critical", aliases: [], severity: "critical", title: "Exécution de code à distance", fixedVersions: ["1.2.3"], url: "https://example.test/advisory" },
  ]);
  const security = projectSecurity(detail, state);
  assert.equal(security.vulnerabilities[0].title, "Exécution de code à distance");
  assert.deepEqual(security.vulnerabilities[0].fixedVersions, ["1.2.3"]);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /7 failles connues/);
  assert.match(html, /Correction :/);
  assert.match(html, /1\.2\.3/);
  assert.match(html, /href="https:\/\/example.test\/advisory"/);
  assert.ok(html.indexOf("Exécution de code à distance") < html.indexOf("library-0"));
  assert.equal(html.match(/<details class="security-finding">/g)?.length, 7);
  assert.doesNotMatch(html, /autres signalements/);
  assert.match(html, /<details class="security-findings-block" open="">/);
  assert.doesNotMatch(html, /<details class="security-finding"[^>]*open/);
});

test("Fiche : le pictogramme annonce un motif lié au déploiement analysé, visible dans le détail", () => {
  const base = healthCheck().findings[0];
  const { detail, state, target, report } = fixture([
    { ...base, fixedVersions: ["1.2.3"] },
    { ...base, package: "other-library" },
  ]);
  state.enabled = true;
  const blocked = healthCheck({ checkedAt: report.checkedAt, status: "blocked", findings: [{ ...base, id: "CVE-2026-12345", aliases: [], explanation: "La dépendance parente impose encore cette version." }] });
  const assessment = healthUpdates([blocked]).runs[0];
  state.assessment = { ...assessment, createdAt: report.attemptedAt, updatedAt: report.attemptedAt, purpose: "assessment", stage: "failed", assessmentSources: { [target.id]: report.identity } };
  assessment.results[0].stage = "failed";
  const markup = () => renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  const html = markup();
  assert.equal(html.match(/<article\b/g)?.length, 1);
  assert.match(html, /aria-label="Failles du projet"/);
  const summaries = [...html.matchAll(/<details class="security-finding"><summary>(.*?)<\/summary>/g)].map(match => match[1]);
  const blockedSummary = summaries.find(summary => summary.includes("security-finding-reason"));
  assert.match(blockedSummary || "", /Motif disponible/);
  assert.doesNotMatch(blockedSummary || "", /La dépendance parente impose encore cette version/);
  assert.match(html, /<div class="security-finding-body">.*La faille bloque la proposition de mise à jour.*La dépendance parente impose encore cette version/);
  assert.equal(summaries.filter(summary => summary.includes("security-finding-reason")).length, 1);

  assessment.results[0] = { ...assessment.results[0], stage: "completed", assessment: { changes: ["Autres dépendances mises à jour"] }, checks: [healthCheck({ npmRetained: blocked.findings })] };
  state.assessment.stage = "completed";
  assert.match(markup(), /Toujours présente dans la proposition/);

  state.assessment.assessmentSources![target.id] = "ancien-déploiement";
  const stale = markup();
  assert.doesNotMatch(stale, /security-finding-reason|Compatibilité du correctif à confirmer/);

  const actualRun = healthUpdates([healthCheck({ npmRetained: blocked.findings })]).runs[0];
  state.runs = [actualRun];
  assert.match(markup(), /security-finding-reason.*Toujours présente après la mise à jour.*La dépendance parente impose encore cette version/);
  actualRun.results[0].checks = [blocked];
  actualRun.stage = actualRun.results[0].stage = "failed";
  actualRun.results[0].previousDeploymentId = "deployed";
  assert.match(markup(), /security-finding-reason.*La version proposée contient encore cette faille/);
  actualRun.results[0].previousDeploymentId = "ancien-déploiement";
  assert.doesNotMatch(markup(), /security-finding-reason/);
});

test("Couverture : un scan complet sans alerte donne un zéro borné à son périmètre", () => {
  const { detail, state, report } = fixture([]);
  report.warnings.push("Le code métier n’est pas analysé.", "Catalogue de mises à jour indisponible.");
  const sourceOnly = projectSecurity(detail, state);
  assert.equal(sourceOnly.count, 0);
  assert.equal(sourceOnly.partial, true);
  assert.match(sourceOnly.services[0].limitations.join(" "), /paquets de l’image déployée restent à analyser/);
  report.securityCoverage!.scope = "image";
  report.checks.push(healthCheck({ tool: "Trivy", phase: "before", checkedAt: report.checkedAt, status: "passed", findings: [] }));
  const summary = summarizeProject(detail.project, detail, state);
  assert.equal(summary.known, true);
  assert.equal(summary.count, 0);
  assert.equal(summary.coveredServices, 1);
  const html = renderToStaticMarkup(createElement(ProjectSecurityBadge, { summary, onOpen() {} }));
  assert.match(html, /0 faille/);
  assert.match(html, /Périmètre couvert/);
  assert.doesNotMatch(html, /Contrôles incomplets|Non vérifiable/);
});

test("Compteur projet : une seule faille, de gravité maximale, même dans plusieurs blocs", () => {
  const { detail, target, report, state } = fixture();
  const service = structuredClone(detail.railway![0].services[0]);
  service.id = "tailscale";
  service.name = "tailscale";
  detail.railway![0].services.push(service);
  const secondTarget = { ...target, id: "tailscale-target", remoteId: service.id, name: service.name };
  state.targets.push(secondTarget);
  const finding = report.checks[0].findings[0];
  const secondCheck = { ...report.checks[0], findings: [{ ...finding, id: finding.aliases[0], aliases: [finding.id], severity: "critical" as const }] };
  state.automaticControls!.push({ ...report, targetId: secondTarget.id, identity: controlSource(secondTarget, detail)!.identity, checks: [secondCheck] });
  const summary = summarizeProject(detail.project, detail, state);
  assert.equal(summary.count, 1);
  assert.equal(summary.severityCounts?.critical, 1);
  assert.equal(summary.severityCounts?.high, 0);
  const moderate = { ...summary, count: 150, severityCounts: { critical: 0, high: 0, moderate: 150, low: 0, unknown: 0 } };
  assert.ok(compareProjectSeverity(summary, moderate) < 0);
  assert.ok(compareProjectSeverity(moderate, undefined) < 0);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /1 faille connue/);
  const blocks = html.split('<details class="security-findings-block"').slice(1).map(section => section.split("</details>")[0]);
  assert.equal(blocks.length, 2);
  const backend = blocks.find(block => block.includes('Bloc : <strong>Backend</strong>'));
  const tailscale = blocks.find(block => block.includes('Bloc : <strong>tailscale</strong>'));
  assert.ok(backend);
  assert.ok(tailscale);
  for (const block of [backend, tailscale]) {
    assert.match(block, /CVE-2026-12345/);
    assert.match(block, /1 signalement/);
  }
  detail.railway![0].observedAt = new Date(0).toISOString();
  const historical = summarizeProject(detail.project, detail, state);
  assert.equal(historical.lastKnown?.count, 1);
  assert.equal(historical.lastKnown?.severityCounts.critical, 1);
  assert.ok(compareProjectSeverity(historical, moderate) < 0);
});

test("Couverture : aucun zéro depuis un runtime seul, un service absent ou un rapport vide", () => {
  const { detail, state, report } = fixture([]);
  report.checks = [];
  assert.equal(summarizeProject(detail.project, detail, state).known, false);
  state.automaticControls = [];
  assert.equal(projectSecurity(detail, state).status, "pending");
  const html = renderToStaticMarkup(createElement(ProjectSecurityBadge, { summary: summarizeProject(detail.project, detail, state), onOpen() {} }));
  assert.doesNotMatch(html, /0 faille/);
  assert.equal(summarizeProject(detail.project, detail, null).known, false);
  detail.railway = [];
  state.targets = [];
  assert.equal(projectSecurity(detail, state).known, false);
});

test("Couverture : une ressource observée sans cible de maintenance reste dans le dénominateur", () => {
  const { detail, state } = fixture([]);
  const database = structuredClone(detail.railway![0].services[0]);
  Object.assign(database, { id: "database", name: "PostgreSQL", repository: null, image: "postgres:17" });
  detail.railway![0].services.push(database);
  const security = projectSecurity(detail, state);
  assert.equal(security.totalServices, 2);
  assert.equal(security.coveredServices, 0);
  assert.equal(security.analyzedServices, 1);
  assert.equal(security.partial, true);
  const html = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(html, /PostgreSQL/);
  assert.match(html, /0\/2 service/);
  assert.match(html, /Aucun rapport automatique/);
});

test("Couverture : un verrou partagé conserve les signalements sans les compter comme applicables", () => {
  const { detail, state, report } = fixture([{ ...healthCheck().findings[0], kind: "unconfirmed", explanation: "Verrou partagé" }]);
  report.securityCoverage!.limitations = ["Autres applications présentes dans le verrou."];
  const result = projectSecurity(detail, state);
  assert.equal(result.count, 0);
  assert.equal(result.signals.length, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.known, false);
});

test("Fraîcheur : une panne conserve les alertes du même déploiement, un nouveau déploiement les invalide", () => {
  const { detail, state, report } = fixture();
  report.error = "GitHub refuse l’accès au dépôt";
  assert.equal(projectSecurity(detail, state).count, 1);
  assert.equal(projectSecurity(detail, state).status, "error");
  delete report.error;
  report.checkedAt = new Date(Date.now() - controlInterval - 1000).toISOString();
  assert.equal(projectSecurity(detail, state).count, 1);
  assert.equal(projectSecurity(detail, state).status, "stale");
  detail.railway![0].services[0].activeDeployments[0].id = "new-deployment";
  assert.equal(projectSecurity(detail, state).count, 0);
  assert.equal(projectSecurity(detail, state).known, false);
});

test("Usage : seules les dépendances npm prouvées exclusivement dev sont classées construction", () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/lib": { version: "1.0.0", dev: true }, "node_modules/other/node_modules/lib": { version: "1.0.0" }, "node_modules/tool": { version: "2.0.0", dev: true } } });
  assert.equal(npmDependencyUsage(lock, "lib", "1.0.0"), "runtime");
  assert.equal(npmDependencyUsage(lock, "tool", "2.0.0"), "build");
  assert.equal(npmDependencyUsage(lock, "absent", "1.0.0"), "unknown");
  assert.equal(npmDependencyUsage("lockfileVersion: 9", "lib", "1.0.0"), "unknown");
});

test("Historique : l’expiration du relevé hébergeur conserve le nombre et la date sans valider le présent", () => {
  const { detail, state, report } = fixture();
  detail.railway![0].observedAt = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
  const security = projectSecurity(detail, state), summary = summarizeProject(detail.project, detail, state);
  assert.equal(security.status, "stale");
  assert.equal(security.count, 0, "le rapport ne prouve pas l’état actuel");
  assert.equal(security.known, false);
  assert.equal(summary.lastKnown?.count, 1);
  assert.equal(summary.lastKnown?.checkedAt, report.checks[0].checkedAt);
  const html = renderToStaticMarkup(createElement(ProjectSecurityBadge, { summary, onOpen() {} }));
  assert.match(html, /project-severity high" title="Élevée">1</);
  assert.match(html, /Ancien relevé/);
  assert.match(html, /dateTime=/);
  const panel = renderToStaticMarkup(createElement(ProjectHealthSummary, { detail, updates: state }));
  assert.match(panel, /derniers contrôles enregistrés/);
  assert.match(panel, /ne confirment pas l’état actuel/);
});

test("Historique : ancien zéro clairement daté, aucun zéro inventé depuis un scan bloqué ou absent", () => {
  const { detail, state, report } = fixture([]);
  report.checks[0].status = "passed";
  report.checkedAt = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
  report.checks[0].checkedAt = report.checkedAt;
  let summary = summarizeProject(detail.project, detail, state);
  assert.equal(summary.lastKnown?.count, 0);
  let html = renderToStaticMarkup(createElement(ProjectSecurityBadge, { summary, onOpen() {} }));
  assert.match(html, /project-severity">0</);
  assert.match(html, /Ancien relevé/);
  assert.doesNotMatch(html, /Périmètre couvert/);
  report.checks[0].status = "blocked";
  summary = summarizeProject(detail.project, detail, state);
  assert.equal(summary.lastKnown, undefined);
  report.checks = [];
  assert.equal(summarizeProject(detail.project, detail, state).lastKnown, undefined);
});

test("Historique : un changement de déploiement distingue ancien rapport et périmètre actuel", () => {
  const { detail, state } = fixture();
  detail.railway![0].services[0].activeDeployments[0].id = "new-deployment";
  const security = projectSecurity(detail, state);
  assert.equal(security.count, 0);
  assert.equal(security.known, false);
  assert.equal(security.lastKnown?.count, 1);
  state.automaticControls![0].identity = JSON.stringify([state.targets[0].id, "another-project"]);
  assert.equal(projectSecurity(detail, state).lastKnown, undefined);
  state.targets = []; detail.railway = [];
  assert.equal(projectSecurity(detail, state).lastKnown, undefined);
});

test("Historique : dédoublonnage des CVE, séparation des soupçons et périmètre incomplet", () => {
  const finding = healthCheck().findings[0];
  const { detail, state, report } = fixture([finding, { ...finding, id: finding.aliases[0], aliases: [finding.id] }, { ...finding, id: "uncertain", aliases: [], kind: "unconfirmed" }]);
  report.coverage = "partial";
  detail.railway![0].observedAt = new Date(0).toISOString();
  const old = projectSecurity(detail, state).lastKnown!;
  assert.equal(old.count, 1);
  assert.equal(old.signalCount, 1);
  assert.equal(old.partial, true);
});
