import test from "node:test";
import assert from "node:assert/strict";
import { searchIndirectCompatibility } from "../src/lib/updates/indirect-compatibility";
import { npmGraph, seedNpmCatalogVersion, seedNpmCoordinatedVersion, validateNpmProposal } from "../src/lib/updates/remediation";

const artifact = (name: string, version: string) => ({ resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: "sha512-Zml4dHVyZQ==" });
function lock(version: string) {
  return JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { parent: "1.0.0" } }, "node_modules/parent": { version: "1.0.0", dependencies: { indirect: "^1", untouched: "^2" }, ...artifact("parent", "1.0.0") }, "node_modules/indirect": { version, ...artifact("indirect", version) }, "node_modules/untouched": { version: "2.7.0", ...artifact("untouched", "2.7.0") } } });
}
function transport(unsafe: string[] = [], incomplete = false): typeof fetch {
  const versions = Array.from({ length: 13 }, (_, index) => {
    const version = `1.${index}.0`, dist = artifact("indirect", version);
    return { version, dist: { tarball: dist.resolved, integrity: dist.integrity }, engines: { node: ">=20" } };
  });
  return async (input, options) => {
    if (String(input).startsWith("https://api.osv.dev/")) {
      const queries = JSON.parse(String(options?.body)).queries;
      return Response.json({ results: queries.map((query: { version: string }) => incomplete ? { next_page_token: "more" } : unsafe.includes(query.version) ? { vulns: [{ id: "MAL-fixture-security" }] } : {}) });
    }
    assert.equal(String(input), "https://registry.npmjs.org/indirect");
    return Response.json({ "dist-tags": { latest: "1.12.0" }, versions: Object.fromEntries(versions.map(item => [item.version, item])) });
  };
}

test("Recherche indirecte : explore le catalogue au-delà du verrou initial puis retient la plus récente des versions validées", async () => {
  const evaluated: string[] = [];
  const failed = lock("1.12.0");
  const result = await searchIndirectCompatibility(lock("1.10.0"), failed, ["indirect"], "24.14.0", async candidate => {
    evaluated.push(candidate.version);
    validateNpmProposal(failed, candidate.lock);
    assert.equal(npmGraph(candidate.lock).nodes.get("node_modules/untouched")?.version, "2.7.0");
    return Number(candidate.version.split(".")[1]) <= 7 ? { kind: "valid", lock: candidate.lock } : { kind: "incompatible" };
  }, transport());
  assert.equal(result?.version, "1.7.0");
  assert.ok(result!.attempts <= 6);
  assert.equal(evaluated.at(-1), "1.7.0");
  assert.ok(evaluated.includes("1.9.0"));
});

test("Recherche indirecte : une version malveillante ou une vérification OSV incomplète n’est jamais testée comme sûre", async () => {
  const evaluated: string[] = [];
  const result = await searchIndirectCompatibility(lock("1.10.0"), lock("1.12.0"), ["indirect"], "24.14.0", async candidate => {
    evaluated.push(candidate.version);
    return Number(candidate.version.split(".")[1]) <= 7 ? { kind: "valid", lock: candidate.lock } : { kind: "incompatible" };
  }, transport(["1.7.0"]));
  assert.equal(result?.version, "1.6.0");
  assert.ok(!evaluated.includes("1.7.0"));
  await assert.rejects(searchIndirectCompatibility(lock("1.10.0"), lock("1.12.0"), ["indirect"], "24.14.0", async () => { throw Error("Must not execute an incompletely checked version"); }, transport([], true)), /incomplète/);
});

test("Recherche indirecte : budget borné, aucune réussite inventée et validation finale obligatoire", async () => {
  let attempts = 0;
  const bounded = await searchIndirectCompatibility(lock("1.10.0"), lock("1.12.0"), ["indirect"], "24.14.0", async () => { attempts++; return { kind: "incompatible" }; }, transport(), undefined, 2);
  assert.equal(bounded, null);
  assert.equal(attempts, 2);
  let calls = 0;
  await assert.rejects(searchIndirectCompatibility(lock("1.10.0"), lock("1.12.0"), ["indirect"], "24.14.0", async candidate => ++calls === 1 ? { kind: "valid", lock: candidate.lock } : { kind: "incompatible" }, transport(), undefined, 1), /n’a pas reproduit/);
});

test("Recherche indirecte : plusieurs branches installées ne font pas modifier une copie étrangère à la pile d’erreur", async () => {
  const raw = JSON.parse(lock("1.12.0"));
  raw.packages["node_modules/parent"].dependencies.validator = "^3";
  raw.packages["node_modules/parent"].dependencies.other = "1.0.0";
  raw.packages["node_modules/validator"] = { version: "3.1.0", ...artifact("validator", "3.1.0") };
  raw.packages["node_modules/other"] = { version: "1.0.0", dependencies: { validator: "^1" }, ...artifact("other", "1.0.0") };
  raw.packages["node_modules/other/node_modules/validator"] = { version: "1.9.0", ...artifact("validator", "1.9.0") };
  const failed = JSON.stringify(raw), seen: string[] = [];
  const registry: typeof fetch = async (input, options) => {
    if (String(input).includes("/validator")) {
      const versions = ["3.1.0", "3.0.0", ...Array.from({ length: 20 }, (_, i) => `1.${i}.0`)].map(version => ({ version, dist: { tarball: artifact("validator", version).resolved, integrity: artifact("validator", version).integrity } }));
      return Response.json({ "dist-tags": { latest: "3.1.0" }, versions: Object.fromEntries(versions.map(item => [item.version, item])) });
    }
    return transport()(input, options);
  };
  const result = await searchIndirectCompatibility(lock("1.10.0"), failed, ["validator", "indirect"], "24.14.0", async candidate => {
    seen.push(candidate.name);
    assert.equal(npmGraph(candidate.lock).nodes.get("node_modules/validator")?.version, "3.1.0");
    assert.equal(npmGraph(candidate.lock).nodes.get("node_modules/other/node_modules/validator")?.version, "1.9.0");
    return Number(candidate.version.split(".")[1]) <= 7 ? { kind: "valid", lock: candidate.lock } : { kind: "incompatible" };
  }, registry, undefined, 6, undefined, ["node_modules/validator", "node_modules/indirect"]);
  assert.equal(result?.name, "indirect");
  assert.equal(result?.version, "1.7.0");
  assert.ok(seen.every(name => name === "indirect"));
});

test("Recherche indirecte : deux versions liées par des pairs changent ensemble, sans réécrire leurs plages", () => {
  const original = JSON.parse(lock("1.10.0")), failed = JSON.parse(lock("1.12.0"));
  for (const data of [original, failed]) data.packages["node_modules/parent"].dependencies.adapter = "^1 || ^2";
  original.packages["node_modules/adapter"] = { version: "1.5.0", peerDependencies: { indirect: "^1" }, ...artifact("adapter", "1.5.0") };
  failed.packages["node_modules/adapter"] = { version: "2.0.0", peerDependencies: { indirect: "^1.12" }, ...artifact("adapter", "2.0.0") };
  failed.packages["node_modules/indirect"].dependencies = { adapter: "^2" };
  const value = artifact("indirect", "1.7.0"), candidate = { version: "1.7.0", dependencies: { adapter: "^1" }, dist: { tarball: value.resolved, integrity: value.integrity } };
  const before = JSON.stringify(original), current = JSON.stringify(failed);
  assert.equal(seedNpmCatalogVersion(current, "indirect", candidate), null);
  const proposal = seedNpmCoordinatedVersion(before, current, "indirect", candidate, ["node_modules/indirect"]);
  assert.ok(proposal);
  validateNpmProposal(current, proposal.lock);
  assert.equal(npmGraph(proposal.lock).nodes.get("node_modules/adapter")?.version, "1.5.0");
  assert.deepEqual(npmGraph(proposal.lock).nodes.get("node_modules/adapter")?.peerDependencies, { indirect: "^1" });
  failed.packages[""].dependencies.adapter = "2.0.0";
  assert.equal(seedNpmCoordinatedVersion(before, JSON.stringify(failed), "indirect", candidate), null);
});

test("Recherche indirecte : un échec réseau OSV est retenté une fois, puis reste bloquant", async () => {
  let queries = 0;
  const registry = transport();
  const transient: typeof fetch = async (input, options) => {
    if (String(input).includes("api.osv.dev") && ++queries === 1) throw Error("temporary network failure");
    return registry(input, options);
  };
  const result = await searchIndirectCompatibility(lock("1.10.0"), lock("1.12.0"), ["indirect"], "24.14.0", async candidate => ({ kind: "valid", lock: candidate.lock }), transient, undefined, 1);
  assert.ok(result);
  assert.equal(queries, 2);
  queries = 0;
  const unavailable: typeof fetch = async (input, options) => { if (String(input).includes("api.osv.dev")) { queries++; throw Error("network unavailable"); } return registry(input, options); };
  await assert.rejects(searchIndirectCompatibility(lock("1.10.0"), lock("1.12.0"), ["indirect"], "24.14.0", async () => { throw Error("Must not run unchecked packages"); }, unavailable), /deux tentatives/);
  assert.equal(queries, 2);
});
