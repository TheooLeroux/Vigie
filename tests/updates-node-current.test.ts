import test from "node:test";
import assert from "node:assert/strict";
import { checkCurrentNodeConfiguration, nodeImageReceipt, nodeReceiptDraft, nodeSecurityHash, nodeSourceHash, nodeTargetsHash, reusableNodeReceipt, sameNodeReceiptProof, unchangedNodeInputs, type NodeValidationReceipt } from "../src/lib/updates/node-current";
import { nodeCatalogState, officialNodeImageDigest, unchangedNodeCatalogs } from "../src/lib/updates/node-catalog-state";
import { dockerNodeBases } from "../src/lib/updates/dockerfile";
import type { SecurityFinding, UpdateTarget } from "../src/lib/updates/types";

const sha = "a".repeat(64), imageDigest = "sha256:" + "b".repeat(64), startedAt = Date.parse("2026-10-27T15:00:00Z");
const modified = "Mon, 26 Oct 2026 12:00:00 GMT";
const target: UpdateTarget = { id: "app", projectId: "project", name: "Generic fixture", provider: "railway", connectionId: "connection", remoteId: "remote", environmentId: "env", repository: "example/app", branch: "main", root: "backend", url: "https://example.test/health", mode: "git", configured: true, unavailable: null };
const key = { sourceHash: sha, targetsHash: nodeTargetsHash([target]), policyHash: sha, nodeVersion: "24.22.1" };
const entry = { url: "https://registry.npmjs.org/is-number", accept: "application/vnd.npm.install-v1+json", etag: 'W/"catalog-a"', modified };
function receipt(): NodeValidationReceipt {
  return nodeReceiptDraft(key, [entry], {
    validatedAt: new Date(startedAt).toISOString(), validationImage: imageDigest, images: [{ image: "node:24.22.1-bookworm", digest: imageDigest }],
    deployments: [{ targetId: target.id, deploymentId: "deployment", imageDigest, source: "container", usage: "runtime" }],
    securityHash: nodeSecurityHash([]), imageSecurity: [],
    validations: [{ targetId: target.id, checkedAt: new Date(startedAt).toISOString(), scope: "backend", status: "warning", message: "Tests réussis ; aucun parcours navigateur déclaré." }],
    warnings: [{ targetId: target.id, messages: ["Réserve conservée"] }],
  })!;
}
const catalog = (etag = entry.etag, date = modified) => new Response(null, { status: 200, headers: { etag, "last-modified": date } });
const changed: SecurityFinding = { id: "NEW-ADVISORY", aliases: [], package: "is-number", version: "7.0.0", severity: "high", scope: "backend" };

test("Configuration actuelle : preuve récente exacte, source entière, cible et politique ; expiration non prolongée", () => {
  const saved = receipt();
  assert.deepEqual(reusableNodeReceipt(saved, key, startedAt + 60_000), saved);
  for (const field of ["sourceHash", "targetsHash", "policyHash", "nodeVersion"] as const) assert.equal(reusableNodeReceipt(saved, { ...key, [field]: field === "nodeVersion" ? "24.22.2" : "c".repeat(64) }, startedAt + 60_000), null);
  assert.equal(reusableNodeReceipt(saved, key, startedAt + 24 * 60 * 60_000 + 1), null);
  assert.equal(reusableNodeReceipt(saved, key, startedAt - 1), null);
  assert.equal(reusableNodeReceipt({}, key, startedAt), null);
  assert.equal(reusableNodeReceipt({ ...saved, validations: [] }, key, startedAt), null);
  assert.equal(reusableNodeReceipt({ ...saved, deployments: [...saved.deployments, ...saved.deployments] }, key, startedAt), null);
  const files = [{ path: "backend/package-lock.json", hash: sha }, { path: "shared/code.js", hash: sha }];
  assert.equal(nodeSourceHash(files), nodeSourceHash([...files].reverse()));
  assert.notEqual(nodeSourceHash(files), nodeSourceHash([files[0], { ...files[1], hash: "changed" }]));
  assert.notEqual(nodeTargetsHash([target]), nodeTargetsHash([{ ...target, root: "other" }]));
  assert.equal(reusableNodeReceipt(saved, key, startedAt + 1000)!.validatedAt, saved.validatedAt);
});

test("Catalogues : tous les paquets verrouillés, y compris les indirects, sont observés une seule fois", async () => {
  const calls: { url: string; method?: string }[] = [];
  const transport: typeof fetch = async (url, options) => { calls.push({ url: String(url), method: options?.method }); return String(url).endsWith("/latest") ? Response.json({ version: "1.0.0" }) : catalog(); };
  const state = nodeCatalogState(transport, startedAt);
  await state.transport("https://registry.npmjs.org/direct/latest", { headers: { Accept: "application/json" } });
  await Promise.all([state.packages(["direct", "@scope/indirect"]), state.packages(["@scope/indirect"])]);
  const entries = await state.snapshot();
  assert.equal(entries?.length, 3);
  assert.equal(calls.filter(call => call.url.endsWith("%40scope%2Findirect")).length, 2, "observation initiale + confirmation finale, sans doublon entre services");
  assert.ok(entries?.some(entry => entry.url.endsWith("direct") && !entry.url.endsWith("latest")), "une nouvelle branche de maintenance doit aussi invalider");
});

test("Catalogues : une publication indirecte, une absence d’attestation ou une publication en cours de job interdit la reprise", async () => {
  assert.equal(await unchangedNodeCatalogs([entry], async () => catalog('"new-release"')), false);
  assert.equal(await unchangedNodeCatalogs([entry], async () => new Response(null, { status: 304 })), true);
  assert.equal(await unchangedNodeCatalogs([entry], async () => catalog('"catalog-a"')), true, "comparaison HTTP faible et forte du même ETag");
  assert.equal(await unchangedNodeCatalogs([entry], async () => { throw new Error("offline"); }), false);
  assert.equal(await unchangedNodeCatalogs([entry], async () => new Response(null, { status: 200 })), false);
  for (const response of [catalog(entry.etag, new Date(startedAt + 1000).toUTCString()), new Response(null, { status: 200, headers: { etag: entry.etag } })]) {
    const state = nodeCatalogState(async () => response, startedAt);
    await state.packages(["indirect"]);
    assert.equal(await state.snapshot(), null);
  }
  let etag = entry.etag;
  const state = nodeCatalogState(async () => catalog(etag), startedAt);
  await state.packages(["indirect"]);
  etag = '"changed-during-validation"';
  assert.equal(await state.snapshot(), null);
});

test("Catalogues : requêtes bornées, pas de requête vers un hôte ou chemin persisté non autorisé", async () => {
  let requests = 0, active = 0, peak = 0;
  const transport: typeof fetch = async () => { requests++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return catalog(); };
  const state = nodeCatalogState(transport, startedAt);
  await Promise.all([state.packages(Array.from({ length: 16 }, (_, i) => `package-${i}`)), state.packages(Array.from({ length: 16 }, (_, i) => `other-${i}`))]);
  assert.ok(peak <= 8);
  requests = 0;
  for (const url of ["http://registry.npmjs.org/a", "https://evil.test/a", "https://registry.npmjs.org/a?token=secret", "https://registry.npmjs.org/a/-/file.tgz", "https://user:secret@registry.npmjs.org/a"]) assert.equal(await unchangedNodeCatalogs([{ ...entry, url }], transport), false);
  assert.equal(requests, 0);
  let attempts = 0;
  const offline = nodeCatalogState(async () => { attempts++; throw new Error("metadata unavailable"); }, startedAt);
  await offline.packages(Array.from({ length: 500 }, (_, i) => `package-${i}`));
  assert.ok(attempts <= 8, "une panne de l’optimisation ne doit pas ajouter des centaines de délais réseau au parcours complet");
  assert.equal(await offline.snapshot(), null);
});

test("Reprise : scans finaux, intégrité et catalogues obligatoires ; chaque dérive retourne au moteur complet", async () => {
  const saved = receipt(), calls: string[] = [];
  const actions = () => ({ baseline: [] as SecurityFinding[], images: async () => { calls.push("images"); return true; }, finalScan: async () => { calls.push("final-scan"); return [] as SecurityFinding[]; }, sources: async () => { calls.push("sources"); }, catalogs: async () => { calls.push("catalogs"); return true; } });
  assert.equal(await checkCurrentNodeConfiguration(saved, actions()), true);
  assert.deepEqual(calls, ["images", "final-scan", "sources", "catalogs"]);
  assert.equal(await checkCurrentNodeConfiguration(saved, { ...actions(), baseline: [changed] }), false);
  assert.equal(await checkCurrentNodeConfiguration(saved, { ...actions(), images: async () => false }), false);
  assert.equal(await checkCurrentNodeConfiguration(saved, { ...actions(), finalScan: async () => [changed] }), false);
  assert.equal(await checkCurrentNodeConfiguration(saved, { ...actions(), sources: async () => { throw new Error("source modified"); } }), false);
  assert.equal(await checkCurrentNodeConfiguration(saved, { ...actions(), catalogs: async () => false }), false);
  assert.equal(await checkCurrentNodeConfiguration(saved, { ...actions(), finalScan: async () => { throw new Error("scanner unavailable"); } }), false);
});

test("Production : une preuve fraîche doit conserver la version, le déploiement, l’image ET le type runtime/construction", () => {
  const saved = receipt(), proof = { version: saved.nodeVersion, ...saved.deployments[0] };
  assert.equal(sameNodeReceiptProof(saved, target.id, proof), true);
  assert.equal(sameNodeReceiptProof(saved, target.id, undefined), false);
  for (const change of [{ version: "24.21.0" }, { deploymentId: "another" }, { imageDigest: "sha256:" + sha }, { source: "railpack" as const, usage: "build" as const }]) assert.equal(sameNodeReceiptProof(saved, target.id, { ...proof, ...change }), false);
  assert.equal(sameNodeReceiptProof(saved, "different-service", proof), false);
});

test("Images : toutes les bases multi-stage, une empreinte officielle liée à l’image locale, aucun jeton persisté", async () => {
  assert.deepEqual(dockerNodeBases("FROM node:24.22.1-bookworm AS build\nFROM build AS assets\nFROM node:24.22.1-alpine\n"), ["node:24.22.1-bookworm", "node:24.22.1-alpine"]);
  const requests: { url: string; auth: string | null }[] = [];
  const transport: typeof fetch = async (url, options) => {
    requests.push({ url: String(url), auth: new Headers(options?.headers).get("authorization") });
    return String(url).startsWith("https://auth.docker.io/") ? Response.json({ token: "ephemeral-test-token" }) : new Response(null, { headers: { "docker-content-digest": imageDigest } });
  };
  const image = await nodeImageReceipt("node:24.22.1-bookworm", imageDigest, async () => JSON.stringify([`node@${imageDigest}`]), transport);
  assert.deepEqual(image, { image: "node:24.22.1-bookworm", digest: imageDigest });
  assert.ok(!JSON.stringify(image).includes("ephemeral"));
  assert.equal(requests[0].auth, null);
  assert.equal(requests[1].auth, "Bearer ephemeral-test-token");
  assert.equal(await nodeImageReceipt("node:24.22.1-bookworm", imageDigest, async () => JSON.stringify([`node@sha256:${sha}`]), transport), null);
  assert.equal(await unchangedNodeInputs(receipt(), async () => catalog(), async () => "sha256:" + sha), false);
  assert.equal(await unchangedNodeInputs(receipt(), async () => catalog(), async () => { throw new Error("unknown image"); }), false);
  assert.equal(await unchangedNodeInputs(receipt(), async () => catalog(), async () => imageDigest), true);
  const before = requests.length;
  await assert.rejects(() => officialNodeImageDigest("private.example/node:24", transport));
  assert.equal(requests.length, before);
});

test("Catalogues publics réels : observation et attestation conditionnelle, sans lecture d’application", { skip: process.env.VIGIE_TEST_REGISTRY !== "1" }, async () => {
  const state = nodeCatalogState();
  const response = await state.transport("https://registry.npmjs.org/is-number/latest", { headers: { Accept: "application/json" } });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await state.packages(["is-number"]);
  const entries = await state.snapshot();
  assert.equal(entries?.length, 2);
  assert.equal(await unchangedNodeCatalogs(entries!), true);
  assert.match(await officialNodeImageDigest("node:24.14.0-bookworm"), /^sha256:[a-f0-9]{64}$/);
});
