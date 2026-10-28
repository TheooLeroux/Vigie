import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeRemediator, dependencyRange, npmCoordinationCandidates, npmGraph, npmIndirectVersionsChanged, seedNpmIndirectVersions, validateNpmProposal } from "../src/lib/updates/remediation";
import { requireSecurityPass, securityCheck, SecurityPolicyError, parseOsv } from "../src/lib/updates/security";
import type { SecurityFinding } from "../src/lib/updates/types";
import { compatibleVersions, type PackageVersion } from "../src/lib/updates/versions";
import { runCommand, IndirectValidationError } from "../src/lib/updates/process";

const alert: SecurityFinding = { id: "GHSA-test-test-test", aliases: [], package: "indirect", version: "1.1.0", severity: "critical", scope: "", fixedVersions: ["2.1.2"] };
test("Le repli du verrou distingue un changement indirect d’un changement direct et refuse une référence inexploitable", () => {
  assert.equal(npmIndirectVersionsChanged(lock(), lock("3.0.0")), false);
  assert.equal(npmIndirectVersionsChanged(lock(), lock("2.0.0", "^2", "2.1.2")), true);
  assert.equal(npmIndirectVersionsChanged('{"lockfileVersion":3,"packages":{}}', lock()), false);
});
test("Le repli ciblé reste dans les plages actuelles, avec des artefacts publics, sans changer les paquets directs", () => {
  const original = lock("1.0.0", "^1 || ^2", "1.1.0"), current = lock("2.0.0", "^1 || ^2", "2.2.0");
  const seeded = seedNpmIndirectVersions(original, current, ["parent", "indirect"]);
  assert.ok(seeded);
  validateNpmProposal(current, seeded);
  assert.equal(npmGraph(seeded).nodes.get("node_modules/parent")?.version, "2.0.0");
  assert.equal(npmGraph(seeded).nodes.get("node_modules/indirect")?.version, "1.1.0");
  assert.equal(seedNpmIndirectVersions(original, lock("2.0.0", "^2", "2.2.0"), ["indirect"]), null);
  const peers = JSON.parse(current);
  peers.packages[""].dependencies.consumer = "1.0.0";
  peers.packages["node_modules/consumer"] = { version: "1.0.0", peerDependencies: { indirect: "^2" } };
  assert.equal(seedNpmIndirectVersions(original, JSON.stringify(peers), ["indirect"]), null);
  assert.equal(seedNpmIndirectVersions(original.replace("https://registry.npmjs.org/indirect", "https://private.invalid/indirect"), current, ["indirect"]), null);
});
test("Le diagnostic indirect ne conserve que les paquets autorisés, sans exposer les chemins ou journaux", async () => {
  const diagnostic = "\n    at compiler (/tmp/secret/node_modules/@vendor/compiler/lib.js:1:1) private-marker /tmp/node_modules/unknown/index.js";
  const program = `process.stderr.write('warning '.repeat(5000));console.error(${JSON.stringify(diagnostic)});process.stderr.write('schema '.repeat(5000));process.exit(1)`;
  await assert.rejects(runCommand(process.execPath, ["-e", program], { diagnosticIndirectPackages: ["@vendor/compiler", "absent"], diagnosticIndirectLocations: { "node_modules/@vendor/compiler": "@vendor/compiler" } }), error => {
    assert.ok(error instanceof IndirectValidationError);
    assert.deepEqual(error.packages, ["@vendor/compiler"]);
    assert.deepEqual(error.locations, ["node_modules/@vendor/compiler"]);
    assert.ok(!JSON.stringify(error).includes("private-marker"));
    assert.ok(!error.message.includes("/tmp/secret"));
    return true;
  });
});
function lock(parent = "2.0.0", range = "^1.0.0", child = "1.1.0") {
  return JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: { parent } }, "node_modules/parent": { version: parent, dependencies: { indirect: range }, resolved: `https://registry.npmjs.org/parent/-/parent-${parent}.tgz`, integrity: "sha512-Zml4dHVyZQ==" }, "node_modules/indirect": { version: child, resolved: `https://registry.npmjs.org/indirect/-/indirect-${child}.tgz`, integrity: "sha512-Zml4dHVyZQ==" } } });
}
const registry = (parents: PackageVersion[], safe = ["2.2.0"], additional: Record<string, PackageVersion[]> = {}) => {
  const packages: Record<string, PackageVersion[]> = { parent: parents, indirect: [{ version: "2.2.0" }, { version: "2.1.2" }, { version: "1.1.0" }], ...additional };
  const transport: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.osv.dev") {
      assert.equal(url.pathname, "/v1/querybatch");
      const queries = JSON.parse(String(options?.body)).queries as { version: string }[];
      return Response.json({ results: queries.map(item => safe.includes(item.version) ? {} : { vulns: [{ id: alert.id }] }) });
    }
    assert.equal(url.origin, "https://registry.npmjs.org");
    const latest = url.pathname.endsWith("/latest"), name = decodeURIComponent(url.pathname.slice(1).replace(/\/latest$/, ""));
    const versions = packages[name];
    assert.ok(versions, `unexpected package ${name}`);
    return Response.json(latest ? versions[0] : { "dist-tags": { latest: versions[0].version }, versions: Object.fromEntries(versions.map(item => [item.version, item])) });
  };
  return transport;
};
async function fixture(parent = "2.0.0", range = "^1.0.0") {
  const folder = await mkdtemp(join(tmpdir(), "vigie-remediation-test-"));
  const manifest = JSON.stringify({ name: "fixture", dependencies: { parent } });
  const content = lock(parent, range);
  await writeFile(join(folder, "package.json"), manifest);
  await writeFile(join(folder, "package-lock.json"), content);
  const originals = new Map<string, string | null>([["package.json", JSON.stringify({ name: "fixture", dependencies: { parent: "^1.0.0" } })], ["package-lock.json", lock("1.0.0", "^1.0.0")]]);
  return { folder, manifest, content, originals };
}
const noPatch: typeof runCommand = async () => JSON.stringify({ patches: [] });
test("Remédiation : les suffixes incompatibles communs sont prouvés une seule fois dans le budget", async () => {
  const current = await fixture();
  try {
    const data = JSON.parse(current.content);
    data.packages["node_modules/parent"].dependencies = { middle: "^1" };
    data.packages["node_modules/middle"] = { version: "1.0.0", dependencies: { bridge: "^1" } };
    data.packages["node_modules/bridge"] = { version: "1.0.0", dependencies: { indirect: "^1" } };
    const raw = JSON.stringify(data);
    await writeFile(join(current.folder, "package-lock.json"), raw);
    const versions = (dependency: string, range: string) => Array.from({ length: 40 }, (_, i) => ({ version: `1.0.${39 - i}`, dependencies: { [dependency]: range } }));
    const transport = registry(versions("middle", "^1"), ["2.2.0"], { middle: versions("bridge", "^1"), bridge: versions("indirect", "^1") });
    const originals = new Map(current.originals).set("package-lock.json", raw);
    await assert.rejects(createNodeRemediator(transport, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", originals, new Set()), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Aucun parent stable compatible/);
      assert.doesNotMatch(error.message, /atteint sa limite/);
      return true;
    });
    assert.equal(await readFile(join(current.folder, "package-lock.json"), "utf8"), raw);
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});
test("Graphe npm : dépendances de développement, portées imbriquées, alias et cycles", () => {
  const data = JSON.parse(lock());
  data.packages[""].devDependencies = { devtool: "1.0.0" };
  data.packages["node_modules/devtool"] = { version: "1.0.0", dependencies: { indirect: "^1" } };
  data.packages["node_modules/parent/node_modules/indirect"] = { version: "1.2.0", dependencies: { parent: "^2" } };
  const graph = npmGraph(JSON.stringify(data));
  assert.equal(graph.resolve("node_modules/parent", "indirect"), "node_modules/parent/node_modules/indirect");
  assert.deepEqual(graph.paths("indirect", "1.1.0"), [["node_modules/devtool", "node_modules/indirect"]]);
  assert.equal(dependencyRange("npm:@scope/pkg@^2.1.2"), "^2.1.2");
  assert.equal(dependencyRange("git+https://example.test/repo"), null);
});
test("Correctifs npm : pas de dépassement des contraintes, de préversion, de changement direct ou de registre arbitraire", () => {
  validateNpmProposal(lock("2.0.0", "^1"), lock("2.0.0", "^1", "1.2.0"));
  assert.throws(() => validateNpmProposal(lock(), lock("2.0.0", "^1", "2.2.0")), /sort des contraintes/);
  assert.throws(() => validateNpmProposal(lock(), lock("3.0.0", "^2", "2.2.0")), /dépendances directes/);
  const arbitrary = JSON.parse(lock("2.0.0", "^1", "1.2.0")); arbitrary.packages["node_modules/indirect"].resolved = "https://untrusted.test/file.tgz";
  assert.throws(() => validateNpmProposal(lock(), JSON.stringify(arbitrary)), /origine npm/);
  const unchangedVersion = JSON.parse(lock());
  unchangedVersion.packages["node_modules/indirect"].resolved = "https://untrusted.test/file.tgz";
  assert.throws(() => validateNpmProposal(lock(), JSON.stringify(unchangedVersion)), /origine npm/);
  unchangedVersion.packages["node_modules/indirect"].resolved = "https://user:password@registry.npmjs.org/indirect/-/indirect-1.1.0.tgz";
  assert.throws(() => validateNpmProposal(lock(), JSON.stringify(unchangedVersion)), /origine npm/);
  unchangedVersion.packages["node_modules/indirect"].resolved = JSON.parse(lock()).packages["node_modules/indirect"].resolved;
  delete unchangedVersion.packages["node_modules/indirect"].integrity;
  assert.throws(() => validateNpmProposal(lock(), JSON.stringify(unchangedVersion)), /intégrité/);
  const prerelease = JSON.parse(lock("2.0.0", "^1", "1.2.0")); prerelease.packages["node_modules/indirect"].version = "1.2.0-beta.1";
  assert.throws(() => validateNpmProposal(lock(), JSON.stringify(prerelease)), /non stable|sort des contraintes/);
});
test("Remédiation : correctif indirect conservant le manifeste et tous les contrôles stricts", async () => {
  const current = await fixture("2.0.0", "^2");
  await writeFile(join(current.folder, "package-lock.json"), lock("2.0.0", "^2", "2.1.0"));
  const execute: typeof runCommand = async (command, args, options) => {
    assert.equal(command, "osv-scanner");
    assert.ok(args.includes("--strategy=in-place") && args.includes("--no-introduce"));
    assert.ok(!args.some(arg => arg.startsWith("--ignore-")));
    assert.equal(options?.env?.npm_config_ignore_scripts, "true");
    assert.equal(options?.env?.npm_config_strict_peer_deps, "true");
    assert.ok(!options?.env?.DATABASE_URL && !options?.env?.VIGIE_CONNECTOR_ENCRYPTION_KEY);
    await writeFile(join(options!.cwd!, "package-lock.json"), lock("2.0.0", "^2", "2.2.0"));
    return JSON.stringify({ patches: ["indirect"] });
  };
  try {
    const decision = await createNodeRemediator(registry([]), execute)(current.folder, [""], ["package.json", "package-lock.json"], [{ ...alert, version: "2.1.0" }], "24.14.0", current.originals, new Set());
    assert.equal(decision.kind, "lock");
    assert.equal(JSON.parse(await readFile(join(current.folder, "package-lock.json"), "utf8")).packages["node_modules/indirect"].version, "2.2.0");
    assert.equal(await readFile(join(current.folder, "package.json"), "utf8"), current.manifest);
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});
test("Remédiation : un parent stable antérieur à la candidate peut résoudre la faille dans la plage initiale", async () => {
  const current = await fixture("3.0.0");
  try {
    const transport = registry([{ version: "3.0.0", dependencies: { indirect: "^1" } }, { version: "2.0.0", dependencies: { indirect: "^2.1.2" }, engines: { node: ">=22" } }, { version: "1.0.0", dependencies: { indirect: "^1" } }]);
    const decision = await createNodeRemediator(transport, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set());
    assert.equal(decision.kind, "parents");
    if (decision.kind === "parents") assert.deepEqual(decision.constraints.get(""), { parent: "2.0.0" });
    assert.equal(await readFile(join(current.folder, "package.json"), "utf8"), current.manifest);
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});

test("Remédiation : un correctif hors contraintes est rejeté puis les parents sont recherchés", async () => {
  const current = await fixture();
  const execute: typeof runCommand = async (_command, _args, options) => {
    await writeFile(join(options!.cwd!, "package-lock.json"), lock("2.0.0", "^1", "2.2.0"));
    return JSON.stringify({ patches: ["incompatible"] });
  };
  try {
    const transport = registry([{ version: "3.0.0", dependencies: { indirect: "^2" } }, { version: "2.0.0", dependencies: { indirect: "^1" } }]);
    const decision = await createNodeRemediator(transport, execute)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set());
    assert.equal(decision.kind, "parents");
    if (decision.kind === "parents") assert.deepEqual(decision.constraints.get(""), { parent: "3.0.0" });
    assert.ok(decision.messages.some(message => message.includes("proposition OSV rejetée")));
    assert.equal(await readFile(join(current.folder, "package-lock.json"), "utf8"), current.content);
    assert.equal(await readFile(join(current.folder, "package.json"), "utf8"), current.manifest);
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});
test("Remédiation : un verrou rejeté n’est pas reproposé ; la recherche passe aux parents", async () => {
  const current = await fixture();
  let calls = 0;
  const execute: typeof runCommand = async (_command, _args, options) => {
    calls++;
    await writeFile(join(options!.cwd!, "package-lock.json"), lock("2.0.0", "^1", "1.2.0"));
    return JSON.stringify({ patches: ["fixture"] });
  };
  const transport = registry([{ version: "3.0.0", dependencies: { indirect: "^2" } }, { version: "2.0.0", dependencies: { indirect: "^1" } }]);
  const repair = createNodeRemediator(transport, execute), tried = new Set<string>();
  try {
    assert.equal((await repair(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, tried)).kind, "lock");
    await writeFile(join(current.folder, "package-lock.json"), current.content);
    const next = await repair(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, tried);
    assert.equal(next.kind, "parents");
    assert.equal(calls, 1);
    if (next.kind === "parents") assert.deepEqual(next.constraints.get(""), { parent: "3.0.0" });
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});
test("Remédiation : retour sécurisé dans la plage déclarée, jamais sous sa borne ou hors de cette plage", async () => {
  const current = await fixture("3.0.0");
  current.originals.set("package-lock.json", lock("2.5.0", "^1"));
  current.originals.set("package.json", JSON.stringify({ dependencies: { parent: "^2.0.0" } }));
  const transport = registry([{ version: "3.0.0", dependencies: { indirect: "^1" } }, { version: "2.5.0", dependencies: { indirect: "^1" } }, { version: "2.2.0", dependencies: { indirect: "^2" } }]);
  try {
    const decision = await createNodeRemediator(transport, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set());
    assert.equal(decision.kind, "parents");
    if (decision.kind === "parents") assert.equal(decision.constraints.get("")?.parent, "2.2.0");
    assert.ok(decision.messages.some(message => message.includes("Version antérieure")));
    current.originals.set("package.json", JSON.stringify({ dependencies: { parent: "2.5.0" } }));
    await assert.rejects(createNodeRemediator(transport, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set()), /Aucun parent stable/);
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});
test("Remédiation : parents coordonnés à travers les pairs, sans imposer un changement inutile", async () => {
  const current = await fixture();
  const data = JSON.parse(current.content);
  data.packages[""].dependencies.consumer = "1.0.0";
  data.packages["node_modules/consumer"] = { version: "1.0.0", peerDependencies: { indirect: "^1 || ^2" } };
  await writeFile(join(current.folder, "package-lock.json"), JSON.stringify(data));
  await writeFile(join(current.folder, "package.json"), JSON.stringify({ dependencies: { parent: "2.0.0", consumer: "1.0.0" } }));
  current.originals.set("package.json", JSON.stringify({ dependencies: { parent: "^1.0.0", consumer: "^1.0.0" } }));
  const transport = registry([{ version: "3.0.0", dependencies: { indirect: "^2" } }, { version: "2.0.0", dependencies: { indirect: "^1" } }], ["2.2.0"], { consumer: [{ version: "1.0.0", peerDependencies: { indirect: "^1 || ^2" } }] });
  try {
    const decision = await createNodeRemediator(transport, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set());
    assert.equal(decision.kind, "parents");
    if (decision.kind === "parents") assert.deepEqual(decision.constraints.get(""), { parent: "3.0.0", consumer: "1.0.0" });
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});

test("Remédiation : un même parent doit corriger toutes les alertes ensemble, sans choix contradictoires", async () => {
  const current = await fixture();
  const data = JSON.parse(current.content);
  data.packages["node_modules/parent"].dependencies.other = "^1";
  data.packages["node_modules/other"] = { version: "1.1.0" };
  await writeFile(join(current.folder, "package-lock.json"), JSON.stringify(data));
  const alerts = [alert, { ...alert, id: "GHSA-other-other-other", package: "other" }];
  const parents = [
    { version: "4.0.0", dependencies: { indirect: "^2", other: "^1" } },
    { version: "3.0.0", dependencies: { indirect: "^1", other: "^2" } },
    { version: "2.5.0", dependencies: { indirect: "^2", other: "^2" } },
    { version: "2.0.0", dependencies: { indirect: "^1", other: "^1" } },
  ];
  const other = [{ version: "2.2.0" }, { version: "1.1.0" }];
  try {
    const tried = new Set<string>();
    const decision = await createNodeRemediator(registry(parents, ["2.2.0"], { other }), noPatch)(current.folder, [""], ["package.json", "package-lock.json"], alerts, "24.14.0", current.originals, tried);
    assert.equal(decision.kind, "parents");
    if (decision.kind === "parents") assert.deepEqual(decision.constraints.get(""), { parent: "2.5.0" });
    assert.ok(!tried.has(":parent@2.5.0") && !tried.has(":parent@4.0.0") && !tried.has(":parent@3.0.0"), "une version seulement proposée ne doit pas être marquée comme déjà testée");
    const incompatible = parents.filter(item => item.version !== "2.5.0"), rejected = new Set<string>();
    await assert.rejects(createNodeRemediator(registry(incompatible, ["2.2.0"], { other }), noPatch)(current.folder, [""], ["package.json", "package-lock.json"], alerts, "24.14.0", current.originals, rejected), /indirect.*other.*compatible avec toutes ces alertes/);
    assert.ok(![...rejected].some(item => item.startsWith(":parent@")));
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});
test("Objectif sécurité puis récence : les parents sûrs se coordonnent par leurs pairs au lieu de figer le premier", async () => {
  const current = await fixture();
  const data = JSON.parse(current.content);
  data.packages[""].dependencies.consumer = "1.0.0";
  data.packages["node_modules/consumer"] = { version: "1.0.0", peerDependencies: { parent: "^2" } };
  await writeFile(join(current.folder, "package-lock.json"), JSON.stringify(data));
  const manifest = { dependencies: { parent: "2.0.0", consumer: "1.0.0" } };
  await writeFile(join(current.folder, "package.json"), JSON.stringify(manifest));
  current.originals.set("package.json", JSON.stringify({ dependencies: { parent: "^1.0.0", consumer: "^1.0.0" } }));
  const transport = registry([{ version: "4.0.0", dependencies: { indirect: "^1" } }, { version: "3.0.0", dependencies: { indirect: "^2" } }, { version: "2.0.0", dependencies: { indirect: "^2" } }], ["2.2.0"], { consumer: [{ version: "1.0.0", peerDependencies: { parent: "^2" } }] });
  try {
    const decision = await createNodeRemediator(transport, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set());
    assert.equal(decision.kind, "parents");
    if (decision.kind !== "parents") return;
    assert.equal(decision.constraints.get("")?.parent, "3.0.0 || 2.0.0");
    const selected = await compatibleVersions(manifest, "24.14.0", transport, {}, decision.constraints.get(""));
    assert.equal(selected.versions.parent, "2.0.0", "la version 3 sûre individuellement n’est pas compatible avec le pair ; la version 4 récente est vulnérable");
    assert.equal(selected.versions.consumer, "1.0.0");
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});
test("Remédiation : absence de parent compatible expliquée, aucun override ou suppression d’alerte", async () => {
  const current = await fixture();
  try {
    const transport = registry([{ version: "2.0.0", dependencies: { indirect: "^1" } }, { version: "1.0.0", dependencies: { indirect: "^1" } }]);
    await assert.rejects(createNodeRemediator(transport, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set()), /parent@2\.0\.0 → indirect@1\.1\.0.*2\.2\.0.*Aucun override/);
    assert.equal(await readFile(join(current.folder, "package-lock.json"), "utf8"), current.content);
    assert.equal(await readFile(join(current.folder, "package.json"), "utf8"), current.manifest);
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});

test("Remédiation : coordonner les versions indirectes avant de changer de nouveau les parents directs", async () => {
  const current = await fixture();
  const data = JSON.parse(current.content);
  data.packages[""].dependencies.anchor = "1.0.0";
  data.packages["node_modules/parent"].dependencies = { provider: "^1 || ^2" };
  data.packages["node_modules/provider"] = { version: "2.0.0", dependencies: { indirect: "^1" } };
  data.packages["node_modules/anchor"] = { version: "1.0.0", dependencies: { provider: "1.0.0" } };
  data.packages["node_modules/anchor/node_modules/provider"] = { version: "1.0.0" };
  const raw = JSON.stringify(data);
  await writeFile(join(current.folder, "package-lock.json"), raw);
  const manifest = JSON.stringify({ dependencies: { parent: "2.0.0", anchor: "1.0.0" } });
  await writeFile(join(current.folder, "package.json"), manifest);
  assert.deepEqual(npmCoordinationCandidates(raw, [alert]), ["provider"]);
  try {
    const tried = new Set<string>(), repair = createNodeRemediator(registry([{ version: "3.0.0", dependencies: { indirect: "^2" } }]), noPatch);
    const decision = await repair(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, tried);
    assert.equal(decision.kind, "balance");
    assert.ok(decision.messages.some(message => message.includes("versions indirectes de provider")));
    assert.equal(await readFile(join(current.folder, "package-lock.json"), "utf8"), raw);
    assert.equal(await readFile(join(current.folder, "package.json"), "utf8"), manifest);
    assert.ok([...tried].some(key => key.startsWith("balance:")));
    const next = await repair(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, tried);
    assert.equal(next.kind, "parents");
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});

test("Remédiation : une nouvelle chaîne ne fait pas oublier le parent qui réintroduisait déjà la faille", async () => {
  const current = await fixture("4.0.0");
  const parents: PackageVersion[] = [{ version: "4.0.0", dependencies: { indirect: "^1" } }, { version: "3.0.0", dependencies: { bridge: "^1" } }, { version: "2.0.0" }];
  const repair = createNodeRemediator(registry(parents, ["2.2.0"], { bridge: [{ version: "1.0.0", dependencies: { indirect: "^1" } }] }), noPatch), tried = new Set<string>();
  try {
    const first = await repair(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, tried);
    assert.equal(first.kind, "parents");
    if (first.kind === "parents") assert.equal(first.constraints.get("")?.parent, "3.0.0 || 2.0.0");
    const nextLock = JSON.parse(lock("3.0.0"));
    nextLock.packages["node_modules/parent"].dependencies = { bridge: "^1" };
    nextLock.packages["node_modules/bridge"] = { version: "1.0.0", dependencies: { indirect: "^1" } };
    await writeFile(join(current.folder, "package-lock.json"), JSON.stringify(nextLock));
    await writeFile(join(current.folder, "package.json"), JSON.stringify({ dependencies: { parent: "3.0.0" } }));
    const second = await repair(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, tried);
    assert.equal(second.kind, "parents");
    if (second.kind === "parents") assert.equal(second.constraints.get("")?.parent, "2.0.0");
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});
test("Remédiation : registre ou service OSV indisponible ne deviennent pas une version sûre", async () => {
  const current = await fixture();
  const transport = registry([{ version: "3.0.0", dependencies: { indirect: "^2" } }, { version: "2.0.0", dependencies: { indirect: "^1" } }]);
  try {
    const unavailable: typeof fetch = (input, options) => String(input).startsWith("https://api.osv.dev/") ? Promise.resolve(new Response("", { status: 503 })) : transport(input, options);
    await assert.rejects(createNodeRemediator(unavailable, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set()), /OSV ne permet pas/);
    let attempts = 0;
    const transient: typeof fetch = (input, options) => {
      if (String(input).startsWith("https://api.osv.dev/") && ++attempts === 1) return Promise.reject(new TypeError("fetch failed"));
      return transport(input, options);
    };
    assert.equal((await createNodeRemediator(transient, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set())).kind, "parents");
    assert.equal(attempts, 2);
    const offline: typeof fetch = (input, options) => String(input).startsWith("https://api.osv.dev/") ? Promise.reject(new TypeError("fetch failed")) : transport(input, options);
    await assert.rejects(createNodeRemediator(offline, noPatch)(current.folder, [""], ["package.json", "package-lock.json"], [alert], "24.14.0", current.originals, new Set()), /OSV est injoignable.*indirect.*deux tentatives/);
  } finally { await rm(current.folder, { recursive: true, force: true }); }
});
test("Sécurité : toutes les alertes et leurs versions corrigées alimentent la boucle", () => {
  const low = { ...alert, id: "GHSA-low-low-low", severity: "low" as const };
  const check = securityCheck("OSV", "candidate", "lock", [alert, low]);
  assert.throws(() => requireSecurityPass(check), error => error instanceof SecurityPolicyError && error.check.blockers?.length === 2);
  const report = parseOsv(JSON.stringify({ results: [{ source: { path: "/tmp/package-lock.json" }, packages: [{ package: { name: "indirect", version: "1.1.0", ecosystem: "npm" }, vulnerabilities: [{ id: alert.id, affected: [{ package: { name: "indirect", ecosystem: "npm" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "2.1.2" }] }] }] }] }] }] }));
  assert.deepEqual(report.findings[0].fixedVersions, ["2.1.2"]);
});
