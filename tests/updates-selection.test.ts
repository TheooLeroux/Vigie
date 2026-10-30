import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { satisfies } from "semver";
import { compatibleVersions, CompatibilitySelectionError, type PackageVersion } from "../src/lib/updates/versions";
import { checkPackageVersions, packageIdentity } from "../src/lib/updates/advisories";
import { withPlanningSession } from "../src/lib/updates/planning";
import { runCommand, DependencyValidationError, yarnPeerWarning } from "../src/lib/updates/process";
import { prepareNodeSources, type NodeValidationRuntime } from "../src/lib/updates/node";
import { requireStrictYarnConfiguration } from "../src/lib/updates/manager-policy";

function registry(packages: Record<string, PackageVersion[]>, unsafe: string[] = [], requests: string[] = []): typeof fetch {
  return async (input, options) => {
    const url = new URL(String(input));
    requests.push(url.hostname + url.pathname);
    if (url.hostname === "api.osv.dev") {
      const queries = JSON.parse(String(options?.body)).queries as { package: { name: string }; version: string }[];
      return Response.json({ results: queries.map(item => unsafe.includes(`${item.package.name}@${item.version}`) ? { vulns: [{ id: "GHSA-fixture-low" }] } : {}) });
    }
    const name = decodeURIComponent(url.pathname.slice(1).replace(/\/latest$/, "")), items = packages[name];
    assert.ok(items, name);
    return Response.json(url.pathname.endsWith("/latest") ? items[0] : { "dist-tags": { latest: items[0].version }, versions: Object.fromEntries(items.map(item => [item.version, item])) });
  };
}

test("Sélection : préfère une seule dépendance antérieure à deux, même si le premier choix admissible était différent", async () => {
  const transport = registry({
    a: [{ version: "3.0.0", peerDependencies: { b: "^1", c: "^1" } }, { version: "2.0.0", peerDependencies: { b: "^3", c: "^3" } }],
    b: [{ version: "3.0.0" }, { version: "2.0.0" }, { version: "1.0.0" }],
    c: [{ version: "3.0.0" }, { version: "2.0.0" }, { version: "1.0.0" }],
  });
  const result = await compatibleVersions({ dependencies: { a: "1.0.0", b: "1.0.0", c: "1.0.0" } }, "24.14.0", transport);
  assert.deepEqual(result.versions, { a: "2.0.0", b: "3.0.0", c: "3.0.0" });
});

test("Sélection : à fraîcheur égale, minimise le recul dans les catalogues", async () => {
  const transport = registry({
    a: [{ version: "4.0.0", peerDependencies: { b: "^1" } }, { version: "3.0.0", peerDependencies: { b: "^4" } }],
    b: [4, 3, 2, 1].map(n => ({ version: `${n}.0.0` })),
  });
  const result = await compatibleVersions({ dependencies: { a: "1.0.0", b: "1.0.0" } }, "24.14.0", transport);
  assert.deepEqual(result.versions, { a: "3.0.0", b: "4.0.0" });
});

test("Sélection : découvre les liens de pairs des anciennes versions avant de conclure à l’optimum", async () => {
  const transport = registry({
    a: [{ version: "3.0.0", peerDependencies: { b: "^1" } }, { version: "2.0.0", peerDependencies: { b: "^3", c: "^2" } }],
    b: [{ version: "3.0.0" }, { version: "1.0.0" }],
    c: [{ version: "3.0.0", peerDependencies: { d: "^1" } }, { version: "2.0.0", peerDependencies: { d: "^3" } }],
    d: [{ version: "3.0.0" }, { version: "1.0.0" }],
  });
  const result = await compatibleVersions({ dependencies: { a: "1.0.0", b: "1.0.0", c: "1.0.0", d: "1.0.0" } }, "24.14.0", transport);
  const versions = result.versions;
  assert.equal(Object.values(versions).filter(version => version === "3.0.0").length, 2);
  assert.equal(result.selection.expandedCatalogs, 4);
});

test("Sélection : OSV prime sur la récence, y compris après exclusion d’une combinaison refusée", async () => {
  const requests: string[] = [];
  const transport = registry({ lib: [{ version: "3.0.0" }, { version: "2.0.0" }, { version: "1.0.0" }] }, ["lib@3.0.0"], requests);
  const result = await compatibleVersions({ dependencies: { lib: "^1" } }, "24.14.0", transport, {}, {}, { screen: items => checkPackageVersions(items, transport), rejectedCombinations: [{ lib: "2.0.0" }] });
  assert.equal(result.versions.lib, "1.0.0");
  assert.ok(result.selection.screenedVersions >= 3);
  assert.ok(requests.some(url => url.includes("api.osv.dev")));
});

test("Sélection : une combinaison refusée n’interdit pas ses versions dans un autre ensemble", async () => {
  const transport = registry({ a: [{ version: "2.0.0" }, { version: "1.0.0" }], b: [{ version: "2.0.0" }, { version: "1.0.0" }] });
  const result = await compatibleVersions({ dependencies: { a: "^1", b: "^1" } }, "24.14.0", transport, {}, {}, { rejectedCombinations: [{ a: "2.0.0", b: "2.0.0" }, { a: "2.0.0", b: "1.0.0" }] });
  assert.deepEqual(result.versions, { a: "1.0.0", b: "2.0.0" });
});

test("Sélection : la récupération cible l’API défaillante sans reculer les paquets indépendants", async () => {
  const transport = registry({ grid: [{ version: "2.2.0" }, { version: "2.1.0" }, { version: "1.6.0" }, { version: "1.5.0" }], unrelated: [{ version: "9.0.0" }, { version: "8.0.0" }, { version: "7.0.0" }] });
  const result = await compatibleVersions({ dependencies: { grid: "1.5.0", unrelated: "7.0.0" } }, "24.14.0", transport, {}, {}, {
    rejectedCombinations: [{ grid: "2.2.0", unrelated: "9.0.0" }], preferredRanges: { grid: "^1.5.0" },
  });
  assert.deepEqual(result.versions, { grid: "1.6.0", unrelated: "9.0.0" });
});

test("Sélection : une préférence de récupération n’exclut pas les autres branches sûres", async () => {
  const transport = registry({ grid: [{ version: "2.2.0" }, { version: "2.1.0" }, { version: "1.5.0" }], unrelated: [{ version: "9.0.0" }] }, ["grid@1.5.0"]);
  const result = await compatibleVersions({ dependencies: { grid: "1.5.0", unrelated: "9.0.0" } }, "24.14.0", transport, {}, {}, {
    screen: items => checkPackageVersions(items, transport),
    rejectedCombinations: [{ grid: "2.2.0", unrelated: "9.0.0" }], preferredRanges: { grid: "^1.5.0" },
  });
  assert.deepEqual(result.versions, { grid: "2.1.0", unrelated: "9.0.0" });
});

test("Sélection : épuise son budget explicitement et conserve les contraintes de plateforme", async () => {
  const transport = registry({ lib: [{ version: "3.0.0", os: ["darwin"] }, { version: "2.0.0", cpu: ["!x64"] }, { version: "1.0.0", os: ["linux"], cpu: ["x64"], libc: ["glibc"] }] });
  assert.equal((await compatibleVersions({ dependencies: { lib: "^1" } }, "24.14.0", transport, {}, {}, { platform: { os: "linux", cpu: "x64", libc: "glibc" } })).versions.lib, "1.0.0");
  await assert.rejects(compatibleVersions({ dependencies: { lib: "^1" } }, "24.14.0", transport, {}, {}, { searchBudget: 1 }), /Budget.*épuisé.*aucun optimum/);
});

test("Sélection : ne conserve pas silencieusement une dépendance quand toutes ses versions sont dépréciées", async () => {
  await assert.rejects(compatibleVersions({ dependencies: { lib: "1.0.0" } }, "24.14.0", registry({ lib: [{ version: "2.0.0", deprecated: "unsafe" }, { version: "1.0.0", deprecated: "unsafe" }] })), CompatibilitySelectionError);
});

test("Sélection : compare ses résultats à une énumération exhaustive de petits graphes", async () => {
  let seed = 7201;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const names = ["a", "b", "c", "d"];
  for (let example = 0; example < 40; example++) {
    const packages = Object.fromEntries(names.map(name => [name, [3, 2, 1].map(n => {
      const peerDependencies: Record<string, string> = {};
      for (const peer of names) if (peer !== name && random() % 3 === 0) peerDependencies[peer] = `^${1 + random() % 3}`;
      return { version: `${n}.0.0`, peerDependencies };
    })]));
    let expected = [Infinity, Infinity];
    for (const a of packages.a) for (const b of packages.b) for (const c of packages.c) for (const d of packages.d) {
      const selected = { a, b, c, d };
      if (!Object.values(selected).every(item => Object.entries(item.peerDependencies).every(([peer, range]) => satisfies(selected[peer as keyof typeof selected].version, range)))) continue;
      const score = [Object.values(selected).filter(item => item.version !== "3.0.0").length, Object.values(selected).reduce((sum, item) => sum + 3 - Number(item.version[0]), 0)];
      if (score[0] < expected[0] || score[0] === expected[0] && score[1] < expected[1]) expected = score;
    }
    const result = compatibleVersions({ dependencies: Object.fromEntries(names.map(name => [name, "^1"])) }, "24.14.0", registry(packages));
    if (!Number.isFinite(expected[0])) { await assert.rejects(result, CompatibilitySelectionError); continue; }
    const actual = Object.values((await result).versions);
    assert.deepEqual([actual.filter(version => version !== "3.0.0").length, actual.reduce((sum, version) => sum + 3 - Number(version[0]), 0)], expected, `graphe ${example}`);
  }
});

test("OSV : lots bornés, déduplication et partage seulement dans la même exécution", async t => {
  const items = Array.from({ length: 300 }, (_, n) => ({ name: `lib-${n}`, version: "1.0.0" }));
  let requests = 0;
  const transport: typeof fetch = async (_input, options) => {
    requests++;
    const queries = JSON.parse(String(options?.body)).queries;
    assert.ok(queries.length <= 128);
    return Response.json({ results: queries.map(() => ({})) });
  };
  await withPlanningSession(async () => {
    const results = await Promise.all([checkPackageVersions([...items, items[0]], transport), checkPackageVersions([...items].reverse(), transport)]);
    assert.equal(results[0].size, 300);
    assert.equal(results[1].size, 300);
    assert.equal(requests, 3);
  });
  await withPlanningSession(() => checkPackageVersions(items, transport));
  assert.equal(requests, 6);
  t.diagnostic("300 versions, deux services : 3 requêtes OSV au lieu de 6, lots de 128 maximum ; aucun cache entre exécutions.");
});

test("OSV : erreurs, pagination, identifiants manquants et panne ne sont jamais des preuves de sécurité", async () => {
  const items = [{ name: "lib", version: "1.0.0" }];
  for (const response of [{ results: [] }, { results: [{ next_page_token: "more" }] }, { results: [{ error: "unavailable" }] }, { results: [{ vulns: [{}] }] }]) {
    await assert.rejects(checkPackageVersions(items, async () => Response.json(response)), /incomplète/);
  }
  await assert.rejects(checkPackageVersions(items, async () => new Response("offline", { status: 403 })), /OSV ne permet pas/);
  assert.equal((await checkPackageVersions(items, async () => Response.json({ results: [{ vulns: [{ id: "LOW-OR-UNKNOWN" }] }] })) ).size, 0);
  assert.equal((await checkPackageVersions(items, async () => Response.json({ results: [{}] }))).has(packageIdentity(items[0])), true);
});

test("Yarn : même un processus réussi est refusé s’il signale un conflit de pairs", async () => {
  for (const warning of ['warning "pkg" has unmet peer dependency "react@^18".', 'warning "pkg" has incorrect peer dependency "react@^18".', "➤ YN0002: missing peer", "➤ YN0060: incompatible peer", "➤ YN0059: invalid range"]) {
    assert.equal(yarnPeerWarning(warning), true);
    await assert.rejects(runCommand(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(warning)})`], { strictYarnPeers: true }), /Installation Yarn refusée/);
  }
  assert.equal(yarnPeerWarning("YN0000: Done"), false);
  assert.equal(await runCommand(process.execPath, ["-e", 'process.stdout.write("YN0000: Done")'], { strictYarnPeers: true }), "YN0000: Done");
});

test("Yarn : un fichier de configuration ne peut pas masquer les conflits ou remplacer l’exécutable vérifié", () => {
  for (const config of ["logFilters:\n  - code: YN0060\n    level: discard", "yarnPath: .yarn/custom.cjs", 'yarn-path "./custom.js"', "plugins:\n  - path: custom.js", "--install.silent true", "--silent true", "enableMessageNames: false", '{"logFilters": []}', '"\\u006cogFilters": []']) {
    assert.throws(() => requireStrictYarnConfiguration(config), /Validation dédiée/);
  }
  requireStrictYarnConfiguration("nodeLinker: node-modules\nenableGlobalCache: false\n");
});

test("Moteur : préfiltre avant installation, ne reteste pas une combinaison refusée et conserve scans et tests", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-selection-"));
  const installed: string[] = [], validated: string[] = [], scanned: string[] = [];
  const transport = registry({ lib: ["3.0.0", "2.2.0", "2.1.0", "1.0.0"].map(version => ({ version })) }, ["lib@3.0.0"]);
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: "fixture", dependencies: { lib: "^2" }, scripts: { test: "node test.js" } }));
  await writeFile(join(folder, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { lib: "^1" } }, "node_modules/lib": { version: "1.0.0" } } }));
  const currentVersion = async () => JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies.lib as string;
  const runtime: NodeValidationRuntime = {
    image: async () => "sha256:" + "a".repeat(64),
    execute: async (_command, args) => {
      if (args[0] === "rm") return "";
      assert.ok(args.includes("--read-only") && args.includes("--cap-drop=ALL"));
      const version = await currentVersion(), command = args.at(-1)!;
      if (command.includes("--package-lock-only")) {
        installed.push(version);
        await writeFile(join(folder, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { lib: version } }, "node_modules/lib": { version } } }));
      } else {
        validated.push(version);
        if (version === "2.2.0") throw new DependencyValidationError("API incompatible", ["lib"]);
      }
      return "";
    },
  };
  try {
    await prepareNodeSources(folder, [""], ["package.json", "package-lock.json"], "24.14.0", transport, [], { limits: new Map(), attempt: 0, runtime }, {
      resolved: async () => { scanned.push(await currentVersion()); }, image: async () => {}, validated: async () => {},
    });
    assert.equal(await currentVersion(), "2.1.0");
    assert.deepEqual(installed, ["2.2.0", "2.1.0"]);
    assert.deepEqual(validated, ["2.2.0", "2.1.0"]);
    assert.deepEqual(scanned, ["2.2.0", "2.1.0"]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Moteur : une rupture majeure identifiée revient en deux essais à une API compatible et rescannée", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-api-recovery-"));
  const attempts: Record<string, string>[] = [], scans: Record<string, string>[] = [];
  const current = async () => JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies as Record<string, string>;
  const transport = registry({ grid: [{ version: "2.2.0" }, { version: "2.1.0" }, { version: "1.6.0" }, { version: "1.5.0" }], unrelated: Array.from({ length: 20 }, (_, n) => ({ version: `9.0.${19 - n}` })) });
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: "fixture", dependencies: { grid: "1.5.0", unrelated: "9.0.0" }, scripts: { test: "node test.js" } }));
  await writeFile(join(folder, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  const runtime: NodeValidationRuntime = { image: async () => "sha256:" + "a".repeat(64), execute: async (_command, args) => {
    if (args[0] === "rm") return "";
    if (args.at(-1)!.includes("--package-lock-only")) {
      const versions = await current();
      await writeFile(join(folder, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: versions }, ...Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])) } }));
    } else {
      const versions = await current(); attempts.push(versions);
      if (versions.grid.startsWith("2.")) throw new DependencyValidationError("Missing export", ["grid"]);
    }
    return "";
  } };
  try {
    await prepareNodeSources(folder, [""], ["package.json", "package-lock.json"], "24.14.0", transport, [], { limits: new Map(), attempt: 0, runtime }, {
      resolved: async () => { scans.push(await current()); }, image: async () => {}, validated: async () => {},
    });
    assert.deepEqual(attempts, [{ grid: "2.2.0", unrelated: "9.0.19" }, { grid: "1.6.0", unrelated: "9.0.19" }]);
    assert.deepEqual(scans, attempts);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
