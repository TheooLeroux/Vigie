import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOsv, parseTrivy, requireSecurityPass, scanDockerImage, scanNodeSources, securityCheck, severity } from "../src/lib/updates/security";
import { checkWordPressRequirements, compareWordPressVersions, parseWordPressPlan, wordPressScanner, wordpressPlanSchema, wordpressPlanScript, wordpressVulnerabilities } from "../src/lib/updates/wordpress-security";
import { wordpressUpdateScript } from "../src/lib/updates/wordpress";
import { runCommand } from "../src/lib/updates/process";
import { managerCommands } from "../src/lib/updates/node";
import { dockerRuntimeBase } from "../src/lib/updates/dockerfile";
import type { SecurityFinding } from "../src/lib/updates/types";

const finding = (severity: SecurityFinding["severity"] = "high", id = "GHSA-aaaa-bbbb-cccc"): SecurityFinding => ({ id, aliases: ["CVE-2026-12345"], package: "library", version: "1.0.0", severity });
test("Sécurité : distinction des alertes préexistantes, nouvelles, aggravées, inconnues et malveillantes", () => {
  const old = finding();
  assert.equal(securityCheck("OSV", "before", "lock", [old]).status, "warning");
  assert.equal(securityCheck("OSV", "candidate", "lock", [old], [old]).status, "warning");
  assert.equal(securityCheck("OSV", "candidate", "lock", [old]).status, "blocked");
  assert.equal(securityCheck("OSV", "candidate", "lock", [{ ...old, scope: "frontend" }], [{ ...old, scope: "backend" }]).status, "blocked");
  assert.equal(securityCheck("OSV", "candidate", "lock", [old], [finding("low")]).status, "blocked");
  assert.equal(securityCheck("OSV", "candidate", "lock", [finding("critical")], [finding("critical")]).status, "blocked");
  assert.equal(securityCheck("OSV", "candidate", "lock", [finding("unknown")]).status, "blocked");
  assert.equal(securityCheck("OSV", "candidate", "lock", [finding("unknown")], [finding("unknown")]).status, "warning");
  assert.equal(securityCheck("OSV", "candidate", "lock", [finding("low", "MAL-2026-123")], [finding("low", "MAL-2026-123")]).status, "blocked");
  assert.equal(securityCheck("OSV", "candidate", "lock", []).status, "passed");
  const alias = { ...old, id: "CVE-2026-12345", aliases: [] };
  assert.equal(securityCheck("Trivy", "candidate", "image", [alias], [old]).status, "warning");
  assert.throws(() => requireSecurityPass(securityCheck("OSV", "candidate", "lock", [old])), /Publication arrêtée/);
});
test("OSV : sévérité des groupes et conservation des alertes sans score", () => {
  const report = parseOsv(JSON.stringify({ results: [{ source: { path: "/tmp/package-lock.json" }, packages: [{ package: { name: "library", version: "1.0.0" }, groups: [{ ids: ["GHSA-aaaa-bbbb-cccc"], max_severity: "9.8" }], vulnerabilities: [{ id: "GHSA-aaaa-bbbb-cccc", aliases: ["CVE-2026-12345"] }, { id: "GHSA-eeee-ffff-gggg" }] }] }] }));
  assert.deepEqual(report.findings.map(entry => entry.severity), ["critical", "unknown"]);
  assert.deepEqual(report.sources, ["/tmp/package-lock.json"]);
  assert.throws(() => parseOsv('{"error":"not a report"}'));
  assert.equal(severity("MEDIUM"), "moderate");
  assert.equal(severity("not-a-score"), "unknown");
  assert.equal(severity("7.5"), "high");
});
test("Trivy : paquets système et arrêt sur rapport incomplet ou système hors support", () => {
  const report = { SchemaVersion: 2, Metadata: { OS: { Family: "debian", Eosl: false } }, Results: [{ Target: "debian", Vulnerabilities: [{ VulnerabilityID: "CVE-2026-12345", PkgName: "openssl", InstalledVersion: "3.0.0-1", Severity: "HIGH" }] }] };
  assert.equal(parseTrivy(JSON.stringify(report))[0].severity, "high");
  assert.throws(() => parseTrivy(JSON.stringify({ ...report, Metadata: {} })), /n’a pas identifié/);
  assert.throws(() => parseTrivy(JSON.stringify({ ...report, Metadata: { OS: { Family: "debian", Eosl: true } } })), /fin de support/);
  assert.ok(parseTrivy(JSON.stringify({ ...report, Metadata: { OS: { Family: "debian", Eosl: true } } }), true).some(item => item.id === "EOL-OS"));
  assert.equal(dockerRuntimeBase("FROM node:20-bookworm AS build\nFROM node:22-slim\n"), "node:22-slim");
});
test("OSV : seuls les manifestes et verrous sont fournis, jamais les sources ou secrets du worker", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-security-test-"));
  const previous = process.env.VIGIE_UPDATES_WPSCAN_TOKEN;
  process.env.VIGIE_UPDATES_WPSCAN_TOKEN = "private-fixture-never-forwarded";
  try {
    await writeFile(join(folder, "package.json"), "{}");
    await writeFile(join(folder, "package-lock.json"), "{}");
    await writeFile(join(folder, "private.txt"), "must-not-be-copied");
    const execute: typeof runCommand = async (command, args, options) => {
      assert.equal(command, "osv-scanner");
      assert.ok(args.includes("--all-packages"));
      assert.deepEqual(options?.acceptedExitCodes, [1]);
      assert.ok(!JSON.stringify(options).includes("private-fixture"));
      assert.ok(!options?.env?.DATABASE_URL && !options?.env?.VIGIE_CONNECTOR_ENCRYPTION_KEY);
      assert.equal(options?.env?.HOME, options?.cwd);
      assert.equal(options?.env?.TMPDIR, options?.cwd);
      await assert.rejects(readFile(join(options!.cwd!, "private.txt")));
      const path = args.find(arg => arg.startsWith("--lockfile="))!.slice(11);
      return JSON.stringify({ results: [{ source: { path }, packages: [] }] });
    };
    assert.deepEqual(await scanNodeSources(folder, [""], ["package.json", "package-lock.json", "private.txt"], execute), []);
    let inventory: string[] = [];
    await scanNodeSources(folder, [""], ["package.json", "package-lock.json"], async (_command, args) => JSON.stringify({ results: [{ source: { path: args.find(arg => arg.startsWith("--lockfile="))!.slice(11) }, packages: ["direct", "indirect"].map(name => ({ package: { name, version: "1.0.0", ecosystem: "npm" } })) }] }), async names => { inventory = names; });
    assert.deepEqual(inventory, ["direct", "indirect"], "le catalogue doit couvrir aussi les paquets sans alerte, pas seulement les vulnérabilités");
    await assert.rejects(scanNodeSources(folder, [""], ["package.json", "package-lock.json"], async () => '{"results":[]}'), /tous les fichiers/);
    await assert.rejects(scanNodeSources(folder, [""], ["package.json", "package-lock.json"], async () => '{}'), /rapport de sécurité/);
    await assert.rejects(scanNodeSources(folder, [""], ["package.json", "package-lock.json"], async (_command, args) => JSON.stringify({ results: [{ source: { path: args.find(arg => arg.startsWith("--lockfile="))!.slice(11) }, packages: [{ package: { name: "unknown", version: "git-commit", ecosystem: "Git" } }] }] })), /identifier précisément/);
    await assert.rejects(scanNodeSources(folder, [""], ["package.json"], execute), /verrouillage/);
    await writeFile(join(folder, "package.json"), JSON.stringify({ dependencies: { library: "1.0.0" } }));
    await assert.rejects(scanNodeSources(folder, [""], ["package.json", "package-lock.json"], execute), /aucune dépendance/);
  } finally {
    if (previous === undefined) delete process.env.VIGIE_UPDATES_WPSCAN_TOKEN; else process.env.VIGIE_UPDATES_WPSCAN_TOKEN = previous;
    await rm(folder, { recursive: true, force: true });
  }
});
test("Trivy : commande bornée, pas de secrets, cible autorisée et erreurs non assimilées à un scan réussi", async () => {
  await assert.rejects(scanDockerImage("attacker/private:latest"), /non autorisée/);
  let inspected = false;
  const report = await scanDockerImage("node:24.14.0-slim", async (command, args, options) => {
    inspected = true;
    assert.equal(command, "trivy");
    assert.ok(args.includes("--scanners=vuln"));
    assert.ok(!options?.env?.DATABASE_URL);
    return JSON.stringify({ SchemaVersion: 2, Metadata: { OS: { Family: "debian" } }, Results: [{ Target: "debian" }] });
  });
  assert.ok(inspected);
  assert.deepEqual(report, []);
  await assert.rejects(scanDockerImage("node:24-slim", async () => '{}'), /rapport d’image/);
});
test("Exécuteur : seul le code vulnérabilités explicitement accepté autorise la lecture d’un rapport", async () => {
  assert.equal(await runCommand(process.execPath, ["-e", "process.stdout.write('report');process.exit(1)"], { acceptedExitCodes: [1] }), "report");
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(2)"], { acceptedExitCodes: [1] }), /a échoué/);
});
const plan = () => wordpressPlanSchema.parse({ wordpress: { current: "6.8", target: "6.8.3" }, php: "8.3.1", plugins: [{ slug: "example", current: "1.0", target: "1.2", requiresPhp: "8.0", requiresWordPress: "6.8" }], themes: [] });
test("WordPress : prérequis PHP/WordPress/extensions et bornes de versions avec plusieurs branches corrigées", () => {
  checkWordPressRequirements(plan());
  const incompatible = plan(); incompatible.plugins[0].requiresPhp = "8.4";
  assert.throws(() => checkWordPressRequirements(incompatible), /PHP plus récent/);
  incompatible.plugins[0].requiresPhp = "8.0"; incompatible.plugins[0].requiresWordPress = "6.9";
  assert.throws(() => checkWordPressRequirements(incompatible), /WordPress plus récent/);
  incompatible.plugins[0].requiresWordPress = "6.8"; incompatible.plugins[0].requiresPlugins = ["missing"];
  assert.throws(() => checkWordPressRequirements(incompatible), /extension absente/);
  assert.equal(compareWordPressVersions("1.2.3.4", "1.2.3"), 4);
  const advisory = { vulnerabilities: [{ id: "abcd", cvss: { score: "8.5" }, affected_versions: [{ introduced_in: "1.0", fixed_in: "1.5" }, { introduced_in: "2.0", fixed_in: "2.2" }] }] };
  assert.equal(wordpressVulnerabilities(advisory, "plugins/example", "1.4").length, 1);
  assert.equal(wordpressVulnerabilities(advisory, "plugins/example", "1.5").length, 0);
  assert.equal(wordpressVulnerabilities(advisory, "plugins/example", "2.1")[0].severity, "high");
  assert.equal(wordpressVulnerabilities({ vulnerabilities: [{ id: "abcd", fixed_in: "invalid" }] }, "plugins/example", "1.5").length, 1);
});
test("WPScan : jeton obligatoire, origine fixe, réponses incomplètes et quotas bloquants", async () => {
  await assert.rejects(wordPressScanner(undefined, "")(plan(), false), /jeton WPScan/);
  const requests: string[] = [];
  const scan = wordPressScanner(async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://wpscan.com");
    assert.equal((options!.headers as Record<string, string>).Authorization, "Token token=fixture-only");
    requests.push(url.pathname);
    return Response.json({ [url.pathname.includes("wordpresses") ? "6.8" : "example"]: { vulnerabilities: [] } });
  }, "fixture-only");
  assert.deepEqual(await scan(plan(), false), []);
  await scan(plan(), false);
  assert.equal(requests.length, 2);
  assert.ok(requests.includes("/api/v3/wordpresses/68"));
  await assert.rejects(wordPressScanner(async () => new Response("", { status: 429 }), "fixture-only")(plan(), true), /quota/);
  await assert.rejects(wordPressScanner(async () => new Response("", { status: 404 }), "fixture-only")(plan(), true), /ne couvre pas/);
  await assert.rejects(wordPressScanner(async () => Response.json({}), "fixture-only")(plan(), true), /incomplet/);
});
test("WordPress : plan figé, sauvegarde avant mutation et vérification des versions installées", () => {
  const current = plan();
  const encoded = Buffer.from(JSON.stringify(current)).toString("base64");
  assert.deepEqual(parseWordPressPlan(`VIGIE_PLAN=${encoded}\n`), current);
  assert.throws(() => parseWordPressPlan("unexpected"), /plan WordPress/);
  const script = wordpressUpdateScript("/home/test/site", "/home/test/.vigie-backups/id/site", current);
  assert.ok(script.indexOf("sha256sum -c") < script.indexOf("core update --version"));
  assert.ok(script.includes("core update --version='6.8.3'"));
  assert.ok(script.includes("plugin update 'example' --version='1.2'"));
  assert.ok(!script.includes("update --all"));
  assert.ok(wordpressPlanScript("/home/test/site").includes("wp_update_plugins()"));
});
test("Validation : les tests d’intégration et navigateur déclarés restent automatiques pour chaque gestionnaire", () => {
  for (const packageManager of ["npm@11.9.0", "pnpm@10.11.0", "yarn@4.9.2"]) {
    const commands = managerCommands({ packageManager, scripts: { "test:integration": "node integration.js", "test:e2e": "playwright test" } }, ["package-lock.json"]);
    assert.match(commands.validate, /run test:integration/);
    assert.match(commands.validate, /run test:e2e/);
  }
});
