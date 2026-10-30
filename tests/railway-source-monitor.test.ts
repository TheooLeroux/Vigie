import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { parseRailwaySources, railwaySourcesCommand, readRailwaySources, scanRailwaySources } from "../src/lib/updates/railway-source-monitor";
import { readRailwayProbe } from "../src/lib/updates/docker-node";
import { scanAutomaticTarget } from "../src/lib/automatic-controls";
import { GitHubAccessError } from "../src/lib/updates/github";
import { healthUpdates, healthFixture } from "./project-health-fixture";
import { controlSource } from "../src/lib/automatic-control-state";
import { projectSecurity } from "../src/lib/project-security";
const target = healthUpdates().runs[0].targets[0], deploymentId = "c98eca95-6176-4d4c-9add-f44184dd0be8", commit = "a".repeat(40), nonce = "fixture-nonce";
const manifest = { dependencies: { example: "1.0.0" } };
const lock = { lockfileVersion: 3, packages: { "": manifest, "node_modules/example": { version: "1.0.0" } } };
const files = () => [{ path: "package.json", content: JSON.stringify(manifest) }, { path: "package-lock.json", content: JSON.stringify(lock) }];
const envelope = () => ({ nonce, deployment: deploymentId, service: target.remoteId, environment: target.environmentId, files: files() });
const instance = () => ({ serviceInstance: { source: { repo: target.repository }, rootDirectory: target.root, activeDeployments: [{ id: deploymentId, status: "SUCCESS", meta: { repo: target.repository, commitHash: commit, rootDirectory: target.root, imageDigest: "sha256:" + "b".repeat(64) } }] } });
const probe: typeof readRailwayProbe = async (_target, _id, options) => [{ id: "replica", ...options.parse(JSON.stringify(envelope()), nonce) }];

test("Sources Railway : identité, verrou correspondant et limites de lecture strictes", () => {
  const parsed = parseRailwaySources(JSON.stringify(envelope()), nonce, target, deploymentId);
  assert.equal(parsed.files.length, 2);
  assert.match(parsed.hash, /^[a-f0-9]{64}$/);
  for (const changes of [{ nonce: "wrong" }, { deployment: "wrong" }, { service: "other" }, { environment: "other" }, { files: [{ path: ".env", content: "secret" }, files()[1]] }, { files: [files()[0], files()[0]] }, { files: [files()[0], { path: "package-lock.json", content: JSON.stringify({ ...lock, packages: { "": { dependencies: { other: "1.0" } } } }) }] }]) assert.throws(() => parseRailwaySources(JSON.stringify({ ...envelope(), ...changes }), nonce, target, deploymentId));
  assert.throws(() => parseRailwaySources("x".repeat(6_000_001), nonce, target, deploymentId), /volumineuse/);
  const command = railwaySourcesCommand(nonce, target.root);
  assert.match(command, /-u NODE_OPTIONS -u NODE_PATH/);
  assert.match(command, /O_NOFOLLOW/);
  assert.doesNotMatch(command, /npm install|package\.scripts|process\.env\)|\.env['"]/);
});

test("Sources Railway : refus avant SSH si la source a changé, refus si réplicas divergents", async () => {
  let probed = false;
  const changed = instance(); changed.serviceInstance.activeDeployments[0].meta.commitHash = "c".repeat(40);
  await assert.rejects(readRailwaySources(target, deploymentId, commit, { instance: async () => changed, probe: async (...args) => { probed = true; return probe(...args); } }), /ne correspondent/);
  assert.equal(probed, false);
  const divergent: typeof readRailwayProbe = async (_target, _id, options) => [{ id: "one", ...options.parse(JSON.stringify(envelope()), nonce) }, { id: "two", ...options.parse(JSON.stringify({ ...envelope(), files: [{ ...files()[0], content: JSON.stringify({ ...manifest, name: "different" }) }, files()[1]] }), nonce) }];
  await assert.rejects(readRailwaySources(target, deploymentId, commit, { instance: async () => instance(), probe: divergent }), /réplicas/);
});

test("Sources Railway : dérive pendant l’analyse refusée et périmètre partiel explicite", async () => {
  let current = instance();
  const readers = { instance: async () => current, probe };
  const result = { checks: [{ tool: "OSV" as const, phase: "before" as const, checkedAt: new Date().toISOString(), scope: deploymentId, status: "passed" as const, findings: [], message: "OK" }], updates: [], warnings: [], securityCoverage: { scope: "sources" as const, source: "railway" as const, packages: 2, limitations: ["GitHub inaccessible"] } };
  const read = (t: typeof target, d: string, c: string) => readRailwaySources(t, d, c, readers);
  const observation = await scanRailwaySources(target, deploymentId, commit, { read, scan: async (_files, options) => { assert.equal(options.source, "railway"); assert.match(options.limitations![0], /GitHub inaccessible/); return result; } });
  assert.equal(observation.coverage, "partial");
  assert.equal(observation.securityCoverage.scope, "dependencies");
  await assert.rejects(scanRailwaySources(target, deploymentId, commit, { read, scan: async () => { current = instance(); current.serviceInstance.activeDeployments[0].id = "another"; return result; } }), /ne correspondent/);
});

test("Surveillance : repli réservé aux refus d’accès GitHub, sans masquer une panne OSV", async () => {
  let fallback = 0;
  const source = { commit, deploymentId, identity: "fixture", image: undefined, hosting: undefined };
  const railway: typeof scanRailwaySources = async () => { fallback++; return { checks: [], updates: [], warnings: [], coverage: "partial", securityCoverage: { scope: "dependencies", limitations: ["GitHub inaccessible"], packages: 1 } }; };
  await scanAutomaticTarget(target, source, { dependencies: async () => { throw new GitHubAccessError(404); }, railway });
  assert.equal(fallback, 1);
  await assert.rejects(scanAutomaticTarget(target, source, { dependencies: async () => { throw new Error("OSV failed"); }, railway }), /OSV failed/);
  await assert.rejects(scanAutomaticTarget(target, { ...source, deploymentId: undefined }, { dependencies: async () => { throw new GitHubAccessError(403); }, railway }), /403/);
  assert.equal(fallback, 1);
});

test("Compteur : les vulnérabilités du conteneur restent comptées pour une racine de monorepo", async () => {
  const observation = await scanRailwaySources(target, deploymentId, commit, {
    read: async () => ({ files: files(), assertCurrent: async () => {} }),
    scan: async () => ({ checks: [{ tool: "OSV", phase: "before", checkedAt: new Date().toISOString(), scope: deploymentId, status: "warning", message: "Alerte", findings: [{ id: "GHSA-example", aliases: ["CVE-2026-12345"], package: "example", version: "1.0.0", severity: "high", scope: "" }] }], updates: [], warnings: [], securityCoverage: { scope: "sources", source: "railway", packages: 1, limitations: ["GitHub inaccessible"] } }),
  });
  assert.equal(observation.checks[0].findings[0].scope, target.root);
  assert.equal(observation.checks[0].findings[0].usage, "runtime");
  const detail = healthFixture(); detail.railway![0].observedAt = new Date().toISOString();
  const security = projectSecurity(detail, { enabled: true, targets: [target], runs: [], automaticControls: [{ ...observation, targetId: target.id, identity: controlSource(target, detail)!.identity, checkedAt: new Date().toISOString(), attemptedAt: new Date().toISOString() }] });
  assert.equal(security.count, 1);
  assert.equal(security.known, false);
  assert.equal(security.partial, true);
});
