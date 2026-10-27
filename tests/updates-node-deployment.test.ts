import test from "node:test";
import assert from "node:assert/strict";
import { confirmDeployedNode, deployedNodeCheck, verifyDeployedNode } from "../src/lib/updates/node-deployment";
import { compatibleVersions } from "../src/lib/updates/versions";
import { providerPreflight } from "../src/lib/updates/providers";
import type { UpdateResult, UpdateTarget } from "../src/lib/updates/types";

const sha = "a".repeat(40), id = "deployment-new", expected = "24.22.1";
const target: UpdateTarget = { id: "fixture", projectId: "project", name: "Application standard", provider: "railway", connectionId: "connection", remoteId: "service", environmentId: "environment", repository: "owner/app", branch: "main", root: "server", url: "https://example.test/health", mode: "git", configured: true, unavailable: null, builder: "RAILPACK" };
function active(version = expected, staticSite = false) {
  return { id, status: "SUCCESS", meta: { repo: "owner/app", branch: "main", commitHash: sha, rootDirectory: "/server", imageDigest: "sha256:" + "b".repeat(64), railpackInfo: { railpackVersion: "0.43.0", metadata: { nodeIsSPA: staticSite }, resolvedPackages: { node: { resolvedVersion: version } } } } };
}
const reference = { deploymentId: id, commit: sha };

test("Node : le correctif testé est imposé exactement, y compris dans devEngines, sans modifier les scripts", async () => {
  const original = { name: "app", engines: { node: "24.x", npm: ">=10" }, devEngines: { runtime: { name: "node", version: "24.x", onFail: "error" } }, scripts: { start: "node server.js", test: "node --test" } };
  const { manifest } = await compatibleVersions(original, expected);
  assert.equal(manifest.engines.node, expected);
  assert.equal(manifest.devEngines.runtime.version, expected);
  assert.equal(manifest.engines.npm, ">=10");
  assert.deepEqual(manifest.scripts, original.scripts);
  assert.equal(original.engines.node, "24.x");
});

test("Node déployé : une image active exacte et liée au commit testé passe, avec une preuve qualifiée", () => {
  const check = deployedNodeCheck(target, reference, expected, [active()]);
  assert.equal(check.status, "passed");
  assert.equal(check.phase, "after");
  assert.match(check.message, /24.22.1.*image active/);
  assert.match(check.message, /n’est pas une commande/);
  const build = deployedNodeCheck(target, reference, expected, [active(expected, true)]);
  assert.equal(build.status, "passed");
  assert.match(build.message, /site statique/);
});

test("Node déployé : un service READY et HTTP valide ne suffisent pas avec un ancien correctif", () => {
  const check = deployedNodeCheck(target, reference, expected, [active("24.21.0")]);
  assert.equal(check.status, "blocked");
  assert.match(check.message, /24.22.1 attendu, Node 24.21.0/);
  assert.equal(deployedNodeCheck(target, reference, expected, [active("24.22.2")]).status, "blocked", "une version différente n’a pas été testée");
});

test("Node déployé : absence, ancien commit, répertoire différent et déploiements mélangés ne produisent aucun succès", () => {
  const missingNode = active();
  missingNode.meta.railpackInfo.resolvedPackages = {} as typeof missingNode.meta.railpackInfo.resolvedPackages;
  const missingDigest = active(); missingDigest.meta.imageDigest = "";
  const missingProducer = active(); missingProducer.meta.railpackInfo.railpackVersion = "";
  const oldCommit = active(); oldCommit.meta.commitHash = "c".repeat(40);
  const wrongRoot = active(); wrongRoot.meta.rootDirectory = "/other";
  const wrongRepo = active(); wrongRepo.meta.repo = "other/app";
  const wrongBranch = active(); wrongBranch.meta.branch = "preview";
  const other = active(); other.id = "old-deployment";
  const notReady = active(); notReady.status = "BUILDING";
  for (const deployments of [[], [missingNode], [missingDigest], [missingProducer], [oldCommit], [wrongRoot], [wrongRepo], [wrongBranch], [other], [notReady], [active(), other]]) {
    assert.equal(deployedNodeCheck(target, reference, expected, deployments).status, "blocked");
  }
  assert.equal(deployedNodeCheck(target, reference, expected, [active("24.x")]).status, "blocked");
  assert.equal(deployedNodeCheck(target, reference, "24.x", [active()]).status, "blocked");
});

test("Node déployé : le résultat conserve le contrôle bloquant ; une preuve correcte ne saute pas le contrôle HTTP", async () => {
  const result: UpdateResult = { targetId: target.id, name: target.name, stage: "publishing", message: "", warnings: [] };
  const events: string[] = [];
  await assert.rejects(confirmDeployedNode(target, result, reference, expected, async (stage, message) => { events.push(stage + message); }, async () => deployedNodeCheck(target, reference, expected, [active("24.21.0")])), /24.22.1 attendu, Node 24.21.0/);
  assert.equal(result.stage, "verifying");
  assert.equal(result.checks?.[0].status, "blocked");
  assert.equal(events.length, 1);
  await confirmDeployedNode(target, result, reference, expected, async () => {}, async () => deployedNodeCheck(target, reference, expected, [active()]));
  assert.equal(result.stage, "verifying", "le contrôle HTTPS doit encore être exécuté par l’exécuteur");
});

test("Node déployé : Docker sans attestation et Vercel limité à une majeure restent à vérifier", async () => {
  const docker = active();
  delete (docker.meta as { railpackInfo?: unknown }).railpackInfo;
  assert.equal(deployedNodeCheck({ ...target, builder: "DOCKERFILE" }, reference, expected, [docker]).status, "blocked");
  const check = await verifyDeployedNode({ ...target, provider: "vercel" }, reference, expected, { railway: async () => { throw Error("wrong provider"); }, vercel: async () => ({ nodeVersion: "24.x", targets: { production: { id } } }) });
  assert.equal(check.status, "blocked");
  assert.match(check.message, /Vercel.*attestation/);
});

test("Node déployé : le lecteur vérifie l’instance active, pas simplement le dernier build", async () => {
  const check = await verifyDeployedNode(target, reference, expected, { railway: async () => ({ serviceInstance: { rootDirectory: "/server", latestDeployment: active(), activeDeployments: [active("24.21.0")] } }), vercel: async () => { throw Error("wrong provider"); } });
  assert.equal(check.status, "blocked");
  const root = { ...target, root: "" }, deployment = active();
  deployment.meta.rootDirectory = "";
  const verified = await verifyDeployedNode(root, reference, expected, { railway: async () => ({ serviceInstance: { rootDirectory: null, activeDeployments: [deployment] } }), vercel: async () => { throw Error("wrong provider"); } });
  assert.equal(verified.status, "passed");
});

test("Node : un forçage hébergeur imprécis ou ancien est refusé avant toute publication", async () => {
  const readers = (variables: Record<string, string>) => ({
    instance: async () => ({ service: { projectId: "remote-project" }, serviceInstance: { rootDirectory: "/server", builder: "RAILPACK", source: { repo: "owner/app" }, latestDeployment: active(), activeDeployments: [active()] } }),
    railway: async () => ({ variables }), vercel: async () => { throw Error("wrong provider"); },
  });
  assert.equal(await providerPreflight(target, expected, readers({})), id);
  assert.equal(await providerPreflight(target, expected, readers({ RAILPACK_NODE_VERSION: expected })), id);
  for (const version of ["24", "24.x", "24.21.0", "24.22.2"]) await assert.rejects(providerPreflight(target, expected, readers({ RAILPACK_NODE_VERSION: version })), /exactement 24.22.1/);
});
