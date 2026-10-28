import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { wordpressPlanSchema } from "../src/lib/updates/wordpress-security";
import { freeWordPressScanner, freeWordPressFindings } from "../src/lib/updates/wordpress-free-security";
import { wordpressMaintenanceCheck, recordWordPressManualUpdates, wordpressCompletionMessage } from "../src/lib/updates/wordpress-maintenance";
import { requireSecurityPass, requireZeroFinalFindings, securityCheck } from "../src/lib/updates/security";
import { wordPressUpdateOrigin } from "../src/lib/wordpress-component-policy";
import { wordpressSecurityVersions } from "../src/lib/updates/wordpress-security-key";
import type { SiteInventory } from "../src/lib/types";
import type { SecurityFinding, UpdateResult } from "../src/lib/updates/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WordPressManualUpdates } from "../src/components/project-updates";
import { healthUpdates } from "./project-health-fixture";

const component = (slug: string, current = "1", target = "2") => ({ slug, current, target, requiresPhp: "", requiresWordPress: "", requiresPlugins: [] });
const plan = () => wordpressPlanSchema.parse({ wordpress: { current: "6.8.3", target: "6.8.4" }, php: "8.3.30", plugins: [{ ...component("private"), target: "1", manualReason: "Personnalisation protégée." }, component("public")], themes: [{ ...component("parent"), target: "1" }] });
const finding = (name: string, version = "1"): SecurityFinding => ({ id: "WPV-" + name, package: name, version, aliases: [], severity: "critical" });
const result = (): UpdateResult => ({ targetId: "wordpress:fixture", name: "Fixture", stage: "completed", message: "", warnings: [] });

test("WordPress : une faille sur un composant conservé reste visible sans bloquer les autres mises à jour", () => {
  for (const phase of ["candidate", "after"] as const) {
    const findings = [finding("plugins/private"), finding("themes/parent")];
    const check = wordpressMaintenanceCheck(plan(), phase, "Fixture", findings);
    assert.equal(check.status, "warning");
    assert.deepEqual(check.findings, findings);
    assert.doesNotThrow(() => requireSecurityPass(check));
    assert.doesNotThrow(() => requireZeroFinalFindings([{ ...result(), checks: [securityCheck("WPVulnerability", "before", "Fixture", findings), check] }]));
    assert.match(check.message, /intervention manuelle requise/);
  }
});

test("WordPress : aucune dispense pour une version modifiée, une autre version conservée ou un autre scanner", () => {
  for (const findingValue of [finding("plugins/public", "2"), finding("plugins/private", "2"), finding("wordpress/wordpress", "6.8.4")]) {
    const check = wordpressMaintenanceCheck(plan(), "candidate", "Fixture", [findingValue]);
    assert.throws(() => requireSecurityPass(check));
    assert.throws(() => requireZeroFinalFindings([{ ...result(), checks: [check] }]));
  }
  const check = wordpressMaintenanceCheck(plan(), "after", "Fixture", [finding("plugins/private")]);
  assert.throws(() => requireZeroFinalFindings([{ ...result(), checks: [{ ...check, tool: "OSV" }] }]));
  assert.throws(() => requireZeroFinalFindings([{ ...result(), checks: [securityCheck("WPVulnerability", "before", "Fixture", check.findings)] }]));
});

test("WordPress : une extension privée homonyme du catalogue public n’est ni remplacée ni certifiée par ce catalogue", async () => {
  const input = plan(); input.plugins = [{ ...component("public"), updateOrigin: "external" }]; input.themes = [];
  const calls: string[] = [];
  const scan = freeWordPressScanner((async input => { const url = new URL(String(input)); calls.push(url.pathname); return Response.json({ error: 0, updated: 1, data: { core: url.pathname.split("/")[2], vulnerability: [] } }); }) as typeof fetch);
  const selected = await scan.prepare(input);
  assert.equal(selected.plugins[0].target, "1");
  assert.ok(selected.plugins[0].manualReason);
  await scan(selected, true);
  assert.deepEqual(calls, ["/core/6.8.4/"]);
});

test("WordPress : un catalogue indisponible sur les composants manuels n’empêche pas le cœur et une autre extension de passer", async () => {
  const calls: string[] = [];
  const scan = freeWordPressScanner((async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    const identity = url.pathname.split("/")[2];
    if (identity === "private" || url.pathname.startsWith("/theme/")) return new Response("Unavailable", { status: 503 });
    return Response.json({ error: 0, updated: 1, data: url.pathname.startsWith("/core/") ? { core: identity, vulnerability: [] } : { plugin: identity, name: identity, link: `https://wordpress.org/plugins/${identity}/`, vulnerability: [] } });
  }) as typeof fetch);
  const selected = await scan.prepare(plan());
  assert.equal(selected.wordpress.target, "6.8.4");
  assert.equal(selected.plugins.find(item => item.slug === "public")?.target, "2");
  assert.equal(selected.plugins.find(item => item.slug === "private")?.target, "1");
  assert.equal(calls.includes("/plugin/private/"), false, "le catalogue du composant manuel ne participe pas à la sélection des mises à jour");
  await scan(selected, false);
  const candidate = wordpressMaintenanceCheck(selected, "candidate", "Fixture", await scan(selected, true));
  assert.doesNotThrow(() => requireSecurityPass(candidate));
  assert.doesNotThrow(() => requireZeroFinalFindings([{ ...result(), warnings: scan.warnings, checks: [candidate] }]));
  assert.ok(scan.warnings.some(warning => warning.startsWith("private : contrôle de sécurité indisponible")));
  assert.ok(scan.warnings.some(warning => warning.startsWith("parent : contrôle de sécurité indisponible")));
  assert.equal(calls.filter(path => path === "/plugin/private/").length, 1, "une panne sur un composant conservé n’est pas répétée à chaque phase");
  assert.equal(calls.filter(path => path === "/theme/parent/").length, 1);
});

test("WordPress : une panne de contrôle sur une extension à installer reste bloquante", async () => {
  const scan = freeWordPressScanner((async () => new Response("Unavailable", { status: 503 })) as typeof fetch);
  await assert.rejects(scan.prepare(plan()), /indisponible/);
});

test("WordPress : interventions structurées avec action et version cible ; aucune fausse réussite intégrale", () => {
  const inventory = { plugins: [{ slug: "private", version: "1", latestVersion: "3" }, { slug: "custom-mu", version: "1", mustUse: true }], themes: [{ slug: "parent", version: "1", updateState: "available" }] } as unknown as SiteInventory;
  const report = result();
  recordWordPressManualUpdates(report, plan(), inventory, [finding("plugins/private")]);
  assert.equal(report.manualUpdates?.length, 3);
  assert.equal(report.manualUpdates?.[0].target, "3");
  assert.ok(report.manualUpdates?.every(item => item.reason && item.action));
  assert.match(wordpressCompletionMessage(report, true), /3 composant/);
  assert.match(wordpressCompletionMessage(report, false), /Aucune mise à jour automatique applicable/);
});

test("WordPress : origine exacte et invalidation de sécurité sur changement de thème ou d’origine", () => {
  assert.equal(wordPressUpdateOrigin(null, "sample", "plugin"), "unknown");
  for (const uri of ["false", "https://wordpress.org/plugins/other/", "https://wordpress.org.evil.test/plugins/sample/", "https://private.test/update?token=secret"]) assert.equal(wordPressUpdateOrigin(uri, "sample", "plugin"), "external");
  assert.equal(wordPressUpdateOrigin("https://wordpress.org/plugins/sample/", "sample", "plugin"), "wordpress.org");
  assert.equal(wordPressUpdateOrigin("w.org/plugin/sample", "sample", "plugin"), "wordpress.org");
  const inventory = { wordpress: { version: "6.8.3" }, plugins: [], themes: [{ slug: "parent", version: "1" }] } as unknown as SiteInventory;
  const first = wordpressSecurityVersions(inventory);
  inventory.themes[0].version = "2";
  assert.notEqual(wordpressSecurityVersions(inventory), first);
  const second = wordpressSecurityVersions(inventory);
  inventory.themes[0].updateOrigin = "external";
  assert.notEqual(wordpressSecurityVersions(inventory), second);
  const third = wordpressSecurityVersions(inventory);
  inventory.plugins.push({ slug: "custom-mu", version: "1", mustUse: true } as any);
  assert.notEqual(wordpressSecurityVersions(inventory), third, "la liste manuelle doit être invalidée à l’ajout d’un MU");
});

test("WordPress : vulnérabilité d’un thème inactif conservée avec son identité et ses bornes", async () => {
  const input = plan(); input.plugins = [];
  const scan = freeWordPressScanner((async input => {
    const url = new URL(String(input));
    return Response.json({ error: 0, updated: 1, data: url.pathname.startsWith("/core/") ? { core: url.pathname.split("/")[2], vulnerability: [] } : { theme: "parent", name: "Parent", vulnerability: [{ uuid: "theme-issue", operator: { max_version: "2", max_operator: "lt" } }] } });
  }) as typeof fetch);
  const findings = await scan(input, false);
  assert.equal(findings[0].package, "themes/parent");
  assert.deepEqual(findings[0].fixedVersions, ["2"]);
  assert.throws(() => freeWordPressFindings({ error: 0, updated: 1, data: { theme: "other", vulnerability: [] } }, "theme", "parent", "1"));
});

test("WordPress : la liste visible explique le composant, les versions, le motif et l’action sans annoncer une sécurité complète", () => {
  const run = healthUpdates([]).runs[0];
  run.results[0].manualUpdates = [{ package: "plugins/private", version: "1", target: "3", reason: "Personnalisation protégée.", action: "Contacter le développeur." }, { package: "themes/custom", version: "", reason: "Version inconnue.", action: "Vérifier auprès de l’éditeur." }];
  const html = renderToStaticMarkup(createElement(WordPressManualUpdates, { run }));
  for (const text of ["Interventions manuelles restantes", "plugins/private", "1 → 3", "Personnalisation protégée", "Contacter le développeur", "mise à jour à vérifier", "leurs alertes de sécurité restent à traiter"]) assert.ok(html.includes(text), text);
  assert.equal(html.includes("<details"), false, "les interventions restent visibles sans déplier le compte rendu");
  run.results[0].manualUpdates = [];
  assert.equal(renderToStaticMarkup(createElement(WordPressManualUpdates, { run })), "");
});

test("WordPress : les interventions du contrôle actuel s’affichent sans historique d’exécution", () => {
  const html = renderToStaticMarkup(createElement(WordPressManualUpdates, { observations: [{ targetId: "wp", versions: "fixture", warnings: [], check: securityCheck("WPVulnerability", "before", "Fixture", []), manualUpdates: [{ package: "plugins/private", version: "1", reason: "Distribution privée.", action: "Vérifier la licence." }] }] }));
  assert.match(html, /Composants à traiter manuellement/);
  assert.match(html, /contrôle en lecture seule/);
  assert.match(html, /Vérifier la licence/);
  assert.doesNotMatch(html, /Mises à jour automatiques terminées/);
  const selected = plan();
  const report = result();
  selected.plugins[0].manualReason = "";
  recordWordPressManualUpdates(report, selected, { plugins: [], themes: [] } as unknown as SiteInventory, [{ ...finding("plugins/private"), kind: "supply-chain" }]);
  assert.match(report.manualUpdates![0].reason, /Signal de sécurité à vérifier/);
  assert.doesNotMatch(report.manualUpdates![0].reason, /version vulnérable/);
});
