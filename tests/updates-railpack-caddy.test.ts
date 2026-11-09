import assert from "node:assert/strict";
import test from "node:test";
import { caddyConfig, caddyVersionChange, parseCaddyProbe, verifyRailwayCaddy } from "../src/lib/updates/railpack-caddy";
import { publishGitVersions } from "../src/lib/updates/executor";
import { caddyImageSecurity, requireZeroFinalFindings, securityCheck } from "../src/lib/updates/security";
import type { SecurityFinding, UpdateCheck, UpdateTarget } from "../src/lib/updates/types";

const target: UpdateTarget = { id: "frontend", name: "Frontend", provider: "railway", mode: "git", builder: "RAILPACK",
  repository: "example/app", branch: "main", root: "frontend", connectionId: "connection", remoteId: "service", environmentId: "environment",
  projectId: "project", url: "https://example.test", configured: true, unavailable: null };
const nonce = "00000000-0000-4000-8000-000000000000";
const commit = "a".repeat(40);
const reference = { deploymentId: "deployment", commit };
const image = (digest = "b") => ({ serviceInstance: { rootDirectory: "/frontend", activeDeployments: [{
  id: reference.deploymentId, status: "SUCCESS", meta: { repo: target.repository, branch: target.branch, commitHash: commit, imageDigest: "sha256:" + digest.repeat(64),
    railpackInfo: { railpackVersion: "0.43.0", metadata: { nodeIsSPA: "true" }, resolvedPackages: { caddy: { resolvedVersion: "2.11.9" } } } },
}] } });

test("Caddy : seule une version stable supérieure est planifiée et les configurations personnalisées sont préservées", async () => {
  const change = caddyVersionChange("2.11.7", "2.11.9")!;
  assert.deepEqual(JSON.parse(caddyConfig(change)), { packages: { caddy: "2.11.9" } });
  assert.equal(caddyVersionChange("2.11.9", "2.11.9"), null);
  assert.equal(caddyVersionChange("2.11.10", "2.11.9"), null);
  assert.equal(caddyVersionChange("2.11.9", "2.12.0-rc.1"), null);
  assert.throws(() => caddyVersionChange("2.11.7", "2.11.9", '{"packages":{"caddy":"2.11.7","node":"26.13.0"}}'), /personnalisée/);
  assert.throws(() => caddyVersionChange("2.11.7", "2.11.9", '{"packages":{"caddy":"2.11.10"}}'), /supérieure/);
  assert.ok(caddyVersionChange("2.11.7", "2.11.9", caddyConfig({ version: "2.11.7" })));
  const path = "frontend/railpack.json";
  const rejectRemote = async () => { throw new Error("Un appel distant ne devait pas partir"); };
  await assert.rejects(() => publishGitVersions("example/app", "main", commit, [{ path, content: caddyConfig(change) }], rejectRemote), /version Caddy validée/);
  await assert.rejects(() => publishGitVersions("example/app", "main", commit, [{ path, content: '{"deploy":{"startCommand":"wrong"}}' }], rejectRemote, undefined, new Map([[path, change]])), /version Caddy validée/);
});

test("Caddy : le processus actif doit correspondre au manifeste, à l’image et à l’identité du déploiement", async () => {
  const packagesHash = "c".repeat(64), binaryHash = "d".repeat(64);
  const output = [nonce, reference.deploymentId, target.remoteId, target.environmentId, packagesHash, binaryHash + " v2.11.9 h1:hash"].join("\n");
  assert.deepEqual(parseCaddyProbe(output, nonce, target, reference.deploymentId), { version: "2.11.9", packagesHash, binaryHash });
  assert.throws(() => parseCaddyProbe(output + "\nv2.11.7", nonce, target, reference.deploymentId), /non confirmée/);
  assert.throws(() => parseCaddyProbe(output, nonce, target, "older"), /non confirmée/);
  const probe: typeof import("../src/lib/updates/docker-node").readRailwayProbe = async (_target, _id, protocol) => [
    { id: "instance", ...protocol.parse(output, nonce) },
  ];
  const verified = await verifyRailwayCaddy(target, reference, "26.13.0", "2.11.9", { instance: async () => image(), probe });
  assert.equal(verified.status, "passed");
  assert.equal(verified.caddyEvidence?.version, "2.11.9");
  assert.match(verified.message, /2\.11\.9 lu sur les processus actifs/);
  let reads = 0;
  await assert.rejects(() => verifyRailwayCaddy(target, reference, "26.13.0", "2.11.9", { instance: async () => image(reads++ ? "c" : "b"), probe }), /ne correspondent pas/);
  await assert.rejects(() => verifyRailwayCaddy(target, reference, "26.13.0", "2.11.7", { instance: async () => image(), probe }), /manifeste actif/);
});

test("Caddy : une réserve existante reste visible et une alerte nouvelle, aggravée ou issue d’un recul bloque", () => {
  const old: SecurityFinding = { id: "CVE-2026-1", package: "golang.org/x/net", version: "v0.59.0", severity: "high", aliases: [], scope: "frontend" };
  const newer = { ...old, version: "v0.60.0" };
  const before = securityCheck("Trivy", "before", "Image active attestée", [old]);
  const accepted = caddyImageSecurity("Image candidate", [old], [newer]);
  assert.equal(accepted.status, "warning");
  assert.equal(accepted.caddyRetained?.[0].version, newer.version);
  assert.ok(accepted.findings[0].explanation?.includes(old.version));
  const proof: UpdateCheck = { ...before, tool: "Caddy", status: "passed", findings: [],
    caddyEvidence: { version: "2.11.7", deploymentId: "previous", imageDigest: "sha256:" + "a".repeat(64), packagesHash: "b".repeat(64), binaryHash: "c".repeat(64), instances: ["instance"] } };
  const result = { targetId: target.id, name: target.name, previousDeploymentId: "previous", stage: "completed" as const, warnings: [], message: "" };
  assert.doesNotThrow(() => requireZeroFinalFindings([{ ...result, checks: [proof, before, accepted] }]));
  assert.throws(() => requireZeroFinalFindings([{ ...result, checks: [before, accepted] }]));
  assert.throws(() => requireZeroFinalFindings([{ ...result, checks: [accepted] }]));
  for (const finding of [{ ...newer, severity: "critical" as const }, { ...newer, id: "CVE-2026-2" }, { ...newer, version: "v0.58.0" }, { ...newer, scope: "backend" }]) {
    assert.equal(caddyImageSecurity("Image candidate", [old], [finding]).status, "blocked");
  }
});
