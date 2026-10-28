import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { compareAdvisoryVersions, freeWordPressFindings, freeWordPressScanner, selectCompatibleWordPressUpdates } from "../src/lib/updates/wordpress-free-security";
import { wordpressPlanSchema } from "../src/lib/updates/wordpress-security";
import { securityCheck, requireSecurityPass, requireZeroFinalFindings } from "../src/lib/updates/security";
import type { UpdateResult } from "../src/lib/updates/types";
import { assertManagedAgentFile, agentFileHash } from "../src/lib/updates/wordpress-agent-package";

const plan = () => wordpressPlanSchema.parse({ wordpress: { current: "6.8.3", target: "7.1.3", requiresPhp: "8.1" }, php: "8.2.35", plugins: [{ slug: "example", current: "1", target: "2", requiresPhp: "8.1", requiresWordPress: "6.8" }], themes: [{ slug: "custom-child", current: "", target: "", requiresPhp: "", requiresWordPress: "" }, { slug: "integer-theme", current: "27", target: "27", requiresPhp: "", requiresWordPress: "" }] });
const report = (plugin = "example", vulnerabilities: unknown[] | null = []) => ({ error: 0, updated: "1792736835", data: { plugin, name: "Example", link: `https://wordpress.org/plugins/${plugin}/`, closed: 0, vulnerability: vulnerabilities } });
const issue = (min: string | null, minOp: string | null, max: string | null, maxOp: string | null) => ({ uuid: "fixture-123", operator: { min_version: min, min_operator: minOp, max_version: max, max_operator: maxOp }, impact: { cvss3: { score: "9.8" } }, source: [{ id: "CVE-2026-12345" }] });

test("Bornes PHP : Elementor récent n’est pas affecté par une ancienne borne beta ; versions à quatre segments", () => {
  const data = report("elementor", [issue(null, null, "3.22.0-beta2", "lt")]);
  assert.equal(freeWordPressFindings(data, "plugin", "elementor", "4.3.5").length, 0);
  assert.equal(freeWordPressFindings(data, "plugin", "elementor", "3.21.4").length, 1);
  for (const [a, b] of [["3.22.0-alpha1", "3.22.0-beta1"], ["3.22.0-beta1", "3.22.0-beta2"], ["3.22.0-beta2", "3.22.0-RC1"], ["3.22.0-RC1", "3.22.0"], ["3.22.0", "3.22.0-pl1"], ["1.8.8.3", "2.0.0.3"]]) assert.ok(compareAdvisoryVersions(a, b) < 0);
  assert.throws(() => compareAdvisoryVersions("1.2.3", "unknown"));
});

test("Rapport gratuit : correctif et source conservés ; signal suspect distinct d’une infection confirmée", () => {
  const data = report("wpforms", [{ ...issue(null, null, "2.0.0.3", "lt"), source: [{ id: "CVE-2026-18409", name: "WPForms Pro — Stored XSS", link: "https://www.wordfence.com/threat-intel/vulnerabilities/example" }] }]);
  const finding = freeWordPressFindings(data, "plugin", "wpforms", "1.8.8.3")[0];
  assert.deepEqual(finding.fixedVersions, ["2.0.0.3"]);
  assert.match(finding.url!, /wordfence/);
  const supply = { ...report(), data: { ...report().data, supplychain: [{ verdict: "suspicious", audit_id: 40 }] } };
  const suspicious = freeWordPressFindings(supply, "plugin", "example", "6.4.0")[0];
  assert.equal(suspicious.kind, "supply-chain");
  assert.match(suspicious.explanation!, /aucune compromission du site n’est confirmée/);
});

test("Barrière finale : WPVulnerability ne peut pas être ignoré dans un succès de maintenance", () => {
  const findings = freeWordPressFindings(report("example", [issue(null, null, "2", "lt")]), "plugin", "example", "1");
  const result: UpdateResult = { targetId: "wordpress:fixture", name: "Fixture", stage: "completed", message: "Terminé", warnings: [], checks: [securityCheck("WPVulnerability", "before", "Fixture", findings)] };
  assert.throws(() => requireZeroFinalFindings([result]), /WPVulnerability/);
  assert.equal(result.stage, "failed");
});

test("Contrôle gratuit : bornes réelles, correctifs, CVSS, alias et risques de chaîne de distribution", () => {
  const data = report("example", [issue("1", "ge", "2", "lt")]);
  assert.equal(freeWordPressFindings(data, "plugin", "example", "1.9")[0].severity, "critical");
  assert.deepEqual(freeWordPressFindings(data, "plugin", "example", "2"), []);
  assert.deepEqual(freeWordPressFindings(data, "plugin", "example", "0.9"), []);
  assert.equal(freeWordPressFindings(data, "plugin", "example", "1")[0].aliases[0], "CVE-2026-12345");
  const malformedRange = report("example", [issue(null, null, "not-a-version", "lt")]);
  assert.equal(freeWordPressFindings(malformedRange, "plugin", "example", "2").length, 1);
  const supply = { ...report(), data: { ...report().data, supplychain: [{ verdict: "cleaned", audit_id: 7, affected_versions: { min_version: "1", min_operator: "ge", max_version: "2", max_operator: "lt" } }] } };
  const malicious = freeWordPressFindings(supply, "plugin", "example", "1.5");
  assert.match(malicious[0].id, /^MAL-/);
  assert.throws(() => requireSecurityPass(securityCheck("WPVulnerability", "candidate", "fixture", malicious)), /Mise à jour WordPress bloquée/);
  assert.deepEqual(freeWordPressFindings(supply, "plugin", "example", "2"), []);
  assert.throws(() => freeWordPressFindings(data, "plugin", "another", "1"), /correspond pas/);
});

test("Contrôle gratuit : cœur, extensions et thèmes publics sans jeton ; versions personnalisées conservées", async () => {
  const calls: string[] = [];
  const scan = freeWordPressScanner((async (input, options) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "www.wpvulnerability.net");
    assert.equal(new Headers(options?.headers).has("Authorization"), false); calls.push(url.pathname);
    return Response.json(url.pathname.startsWith("/core/") ? { error: 0, updated: 1792736835, data: { core: url.pathname.split("/")[2], vulnerability: null } } : url.pathname.startsWith("/theme/") ? { error: 0, updated: 1792736835, data: { theme: "integer-theme", name: null, vulnerability: [] } } : report());
  }) as typeof fetch);
  const candidate = await scan.prepare(plan());
  await scan(candidate, false); await scan(candidate, true); await scan(candidate, false);
  assert.deepEqual(calls, ["/plugin/example/", "/core/6.8.3/", "/theme/integer-theme/", "/core/7.1.3/"]);
  assert.ok(scan.warnings.some(warning => warning.includes("custom-child")));
});

test("Catalogue inconnu : extension conservée avec réserve explicite ; erreur fournisseur bloquante", async () => {
  const scan = freeWordPressScanner((async () => Response.json({ ...report(), data: { ...report().data, name: null } })) as typeof fetch);
  const prepared = await scan.prepare(plan());
  assert.equal(prepared.plugins[0].target, "1");
  assert.ok(scan.warnings.some(warning => warning.includes("conservée")));
  const privateCatalog = freeWordPressScanner((async () => Response.json({ ...report(), data: { ...report().data, link: null } })) as typeof fetch);
  assert.equal((await privateCatalog.prepare(plan())).plugins[0].target, "1");
  for (const response of [new Response("", { status: 503 }), Response.json({ error: 1, data: null }), Response.json({ error: 0, updated: 1, data: { plugin: "example", name: "Example" } })]) {
    await assert.rejects(freeWordPressScanner((async () => response) as typeof fetch).prepare(plan()), /indisponible|incomplet/);
  }
});

test("PHP en lecture seule : seules les propositions compatibles sont conservées, thèmes personnalisés acceptés", () => {
  const input = plan(); input.wordpress.requiresPhp = "8.3";
  input.plugins.push({ slug: "needs-new-core", current: "1", target: "2", requiresPhp: "", requiresWordPress: "7.1", requiresPlugins: [] });
  const selected = selectCompatibleWordPressUpdates(input);
  assert.equal(selected.php, input.php);
  assert.equal(selected.wordpress.target, input.wordpress.current);
  assert.equal(selected.plugins[0].target, "2");
  assert.equal(selected.plugins[1].target, "1");
  assert.deepEqual(selected.themes, input.themes);
  assert.ok(selected.warnings.some(warning => warning.includes("fourni par l’hébergement")));
  assert.throws(() => wordpressPlanSchema.parse({ ...input, themes: [{ ...input.themes[0], target: "1.0" }] }));
});

test("Agent géré : migration de fichiers connus, refus d’un autre propriétaire et des fichiers altérés", () => {
  const oldWorker = "known old worker", oldPlan = "known old plan", base = { protocol: "vigie-local-v1", root: "/home/fixture/site", secret: "a".repeat(64), phpBinary: "/opt/alt/php82/usr/bin/php", wpBinary: "/usr/local/bin/wp", environment: "production" };
  const old = JSON.stringify({ ...base, workerSha256: agentFileHash(oldWorker), planSha256: agentFileHash(oldPlan) });
  const next = JSON.stringify({ ...base, workerSha256: agentFileHash("new worker"), planSha256: agentFileHash("new plan") });
  const hashes = { "agent.php": agentFileHash(oldWorker), "plan.php": agentFileHash(oldPlan) };
  assert.doesNotThrow(() => assertManagedAgentFile("agent.php", oldWorker, "new worker", next, hashes));
  assert.doesNotThrow(() => assertManagedAgentFile("config.json", old, next, next, hashes));
  assert.throws(() => assertManagedAgentFile("agent.php", oldWorker + " altered", "new worker", next, hashes), /aucun écrasement/);
  assert.throws(() => assertManagedAgentFile("config.json", JSON.stringify({ ...JSON.parse(old), secret: "b".repeat(64) }), next, next, hashes), /aucun écrasement/);
});
