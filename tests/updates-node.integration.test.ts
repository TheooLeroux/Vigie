import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prepareNodeSources, snapshotSources, changedSources } from "../src/lib/updates/node";
import { createNodeRemediator } from "../src/lib/updates/remediation";
import { requireSecurityPass, securityCheck } from "../src/lib/updates/security";
import { runCommand } from "../src/lib/updates/process";
import { validateDockerfile, versionOnlyDockerfile } from "../src/lib/updates/dockerfile";

const docker = { skip: process.env.VIGIE_TEST_DOCKER !== "1" };
const nodeVersion = "24.14.0";
async function fixture(packageManager?: string, script = "node -e \"if (!require('is-number')(42)) process.exit(1)\"") {
  const folder = await mkdtemp(join(tmpdir(), "vigie-node-integration-"));
  const manifest = { name: "vigie-isolated-fixture", version: "1.0.0", private: true, ...(packageManager ? { packageManager } : {}), engines: { node: "22.x" }, dependencies: { "is-number": "6.0.0" }, scripts: { test: script } };
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  const names = ["package.json"];
  if (!packageManager || packageManager.startsWith("npm@")) {
    names.push("package-lock.json");
    await writeFile(join(folder, "package-lock.json"), JSON.stringify({ name: manifest.name, version: "1.0.0", lockfileVersion: 3, packages: {} }));
  }
  return { folder, names };
}

for (const manager of ["npm@11.9.0", "pnpm@10.11.0", "yarn@1.22.22", "yarn@4.9.2"]) {
  test(`Docker réel : dépendances, verrouillage et tests avec ${manager}`, docker, async () => {
    const { folder, names } = await fixture(manager);
    try {
      const before = await snapshotSources(folder, names);
      const prepared = await prepareNodeSources(folder, [""], names, nodeVersion);
      const manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
      assert.equal(manifest.engines.node, nodeVersion);
      assert.notEqual(manifest.dependencies["is-number"], "6.0.0");
      assert.match(manifest.dependencies["is-number"], /^\d+\.\d+\.\d+$/);
      const changes = await changedSources(folder, before, prepared.allowed);
      assert.ok(changes.some(file => file.path === "package.json"));
      assert.ok(changes.some(file => /lock|shrinkwrap/.test(file.path)));
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}

test("Docker réel : un test en échec arrête la mise à jour avant publication", docker, async () => {
  const { folder, names } = await fixture(undefined, "node -e \"process.exit(1)\"");
  try { await assert.rejects(prepareNodeSources(folder, [""], names, nodeVersion), /a échoué/); }
  finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : une validation exacte est réutilisée, toute autre source du dépôt l’invalide", docker, async t => {
  const { folder, names } = await fixture(undefined, "node -e \"if (!require('is-number')(42)) process.exit(1); require('node:fs').appendFileSync('executions.log','run\\n')\"");
  names.push("shared-source.js");
  await writeFile(join(folder, "shared-source.js"), "export const value = 1;\n");
  const retry = { limits: new Map<string, Record<string, string>>(), attempt: 0, validations: new Set<string>() };
  let reused = 0;
  const checks = { resolved: async () => {}, image: async () => {}, validated: async () => {}, reused: async () => { reused++; } };
  try {
    const firstStart = performance.now();
    await prepareNodeSources(folder, [""], names, nodeVersion, fetch, [], retry, checks);
    const firstMs = performance.now() - firstStart;
    assert.equal(await readFile(join(folder, "executions.log"), "utf8"), "run\n");
    const cachedStart = performance.now();
    await prepareNodeSources(folder, [""], names, nodeVersion, fetch, [], retry, checks);
    const cachedMs = performance.now() - cachedStart;
    t.diagnostic(`Même proposition : première préparation ${Math.round(firstMs)} ms ; réutilisation ${Math.round(cachedMs)} ms. Mesure isolée, hors scans et déploiement.`);
    assert.equal(reused, 1);
    assert.equal(await readFile(join(folder, "executions.log"), "utf8"), "run\n");
    await writeFile(join(folder, "shared-source.js"), "export const value = 2;\n");
    await prepareNodeSources(folder, [""], names, nodeVersion, fetch, [], retry, checks);
    assert.equal(reused, 1);
    assert.equal(await readFile(join(folder, "executions.log"), "utf8"), "run\nrun\n");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test("Docker réel : une alerte de sécurité arrête le parcours avant les scripts du projet", docker, async () => {
  const { folder, names } = await fixture(undefined, "node -e \"require('node:fs').writeFileSync('executed.txt','unexpected')\"");
  let validated = false;
  try {
    await assert.rejects(prepareNodeSources(folder, [""], names, nodeVersion, fetch, [], undefined, {
      resolved: async () => { throw new Error("security-policy-blocked"); },
      image: async () => { throw new Error("image must not run"); },
      validated: async () => { validated = true; },
    }), /security-policy-blocked/);
    await assert.rejects(readFile(join(folder, "executed.txt")));
    assert.equal(validated, false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test("Docker réel : la boucle sécurité recherche une autre proposition si les tests refusent la première", docker, async () => {
  const program = "if(require('is-number/package.json').version.startsWith('6.')){console.error('error TS2614: Module \"is-number\" has no exported member fixture');process.exit(1)}";
  const { folder, names } = await fixture(undefined, `node -e ${JSON.stringify(program)}`);
  const manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
  manifest.dependencies["is-number"] = "5.0.0";
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  await writeFile(join(folder, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: manifest.name, version: "1.0.0", dependencies: manifest.dependencies }, "node_modules/is-number": { version: "5.0.0" } } }));
  const transport: typeof fetch = async (input, options) => {
    if (String(input).startsWith("https://api.osv.dev/")) {
      const queries = JSON.parse(String(options?.body)).queries as { version: string }[];
      return Response.json({ results: queries.map(item => item.version === "7.0.0" ? { vulns: [{ id: "GHSA-fixture-security" }] } : {}) });
    }
    const versions = ["7.0.0", "6.0.0", "5.0.0"].map(version => ({ version }));
    return Response.json(String(input).endsWith("/latest") ? versions[0] : { "dist-tags": { latest: "7.0.0" }, versions: Object.fromEntries(versions.map(item => [item.version, item])) });
  };
  const scanned: string[] = [], messages: string[] = [];
  try {
    const retry = { limits: new Map<string, Record<string, string>>(), attempt: 0, remediation: { iterations: 0, constraints: new Map<string, Record<string, string>>(), tried: new Set<string>(), seen: new Set<string>(), repair: createNodeRemediator(transport, async () => JSON.stringify({ patches: [] })) } };
    const prepared = await prepareNodeSources(folder, [""], names, nodeVersion, transport, [], retry, {
      resolved: async () => {
        const next = JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies["is-number"];
        scanned.push(next);
        const existing = { id: "GHSA-fixture-security", aliases: [], package: "is-number", version: next, severity: "low" as const, scope: "" };
        requireSecurityPass(securityCheck("OSV", "candidate", "fixture", next === "7.0.0" ? [existing] : [], [existing]));
      },
      image: async () => {}, validated: async () => {}, remediating: async message => { messages.push(message); },
    });
    assert.deepEqual(scanned, ["7.0.0", "6.0.0", "7.0.0", "5.0.0"]);
    assert.equal(JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies["is-number"], "5.0.0");
    assert.ok(messages.some(message => message.includes("écartée après échec des tests")));
    assert.ok(prepared.warnings.some(message => message.includes("sans ignorer les assertions")));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : un conflit de dépendances est résolu sans forcer l’installation", docker, async () => {
  const { folder, names } = await fixture();
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: "vigie-peer-conflict-fixture", private: true, dependencies: { react: "18.3.1", "react-dom": "18.3.1" }, scripts: { test: "node --version" } }));
  const transport: typeof fetch = async input => {
    const url = String(input);
    if (url.includes("react-dom")) {
      const item = { version: "18.3.1", peerDependencies: { react: "^18.3.1" } };
      return Response.json(url.endsWith("/latest") ? item : { versions: { "18.3.1": item } });
    }
    return Response.json(url.endsWith("/latest") ? { version: "19.0.0" } : { versions: { "19.0.0": { version: "19.0.0" }, "18.3.1": { version: "18.3.1" } } });
  };
  try {
    const result = await prepareNodeSources(folder, [""], names, nodeVersion, transport);
    assert.equal(JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies.react, "18.3.1");
    assert.ok(result.warnings.some(warning => warning.includes("react")));
  }
  finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : une proposition sans intersection de pairs est écartée sans contraindre les parents suivants", docker, async () => {
  const { folder, names } = await fixture();
  const manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
  manifest.dependencies["is-number"] = "5.0.0";
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  await writeFile(join(folder, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: manifest.name, version: "1.0.0", dependencies: manifest.dependencies }, "node_modules/is-number": { version: "5.0.0" } } }));
  const transport: typeof fetch = async (input, options) => {
    if (String(input).startsWith("https://api.osv.dev/")) {
      const queries = JSON.parse(String(options?.body)).queries as { version: string }[];
      return Response.json({ results: queries.map(item => item.version === "7.0.0" ? { vulns: [{ id: "GHSA-fixture-security" }] } : {}) });
    }
    const versions = ["7.0.0", "6.0.0", "5.0.0"].map(version => ({ version }));
    return Response.json(String(input).endsWith("/latest") ? versions[0] : { "dist-tags": { latest: "7.0.0" }, versions: Object.fromEntries(versions.map(item => [item.version, item])) });
  };
  const scanned: string[] = [], messages: string[] = [];
  const key = JSON.stringify(["", [["is-number", "6.0.0"]], []]);
  const retry = { limits: new Map<string, Record<string, string>>(), attempt: 0, resolution: { attempts: 1, learned: new Map([[key, { "is-number": ["<6.0.0"] }]]) }, remediation: { iterations: 1, constraints: new Map([["", { "is-number": "6.0.0" }]]), tried: new Set([":is-number@6.0.0"]), seen: new Set<string>(), repair: createNodeRemediator(transport, async () => JSON.stringify({ patches: [] })) } };
  try {
    await prepareNodeSources(folder, [""], names, nodeVersion, transport, [], retry, {
      resolved: async () => {
        const version = JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies["is-number"];
        scanned.push(version);
        requireSecurityPass(securityCheck("OSV", "candidate", "fixture", version === "7.0.0" ? [{ id: "GHSA-fixture-security", aliases: [], package: "is-number", version, severity: "critical", scope: "" }] : []));
      },
      image: async () => {}, validated: async () => {}, remediating: async message => { messages.push(message); },
    });
    assert.deepEqual(scanned, ["7.0.0", "5.0.0"]);
    assert.ok(messages.some(message => message.includes("pairs indirects ne permettent aucun ensemble admissible")));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : un pair indirect refusé par npm fait recalculer les versions directes", docker, async () => {
  const { folder, names } = await fixture();
  await mkdir(join(folder, "package"));
  await writeFile(join(folder, "package/package.json"), JSON.stringify({ name: "vigie-indirect-parent", version: "1.0.0", peerDependencies: { react: "^18 || ^19", "react-dom": "^18 || ^19" }, dependencies: { "react-json-view-lite": "1.5.0" } }));
  await runCommand("tar", ["-czf", join(folder, "parent.tgz"), "-C", folder, "package"]);
  names.push("parent.tgz", "package/package.json");
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: "vigie-transitive-peer-fixture", private: true, dependencies: { "vigie-indirect-parent": "file:parent.tgz", react: "^18.0.0", "react-dom": "^18.0.0" }, scripts: { test: "node -e \"if(!require('react/package.json').version.startsWith('18.'))process.exit(1)\"" } }));
  const versions: Record<string, any[]> = { react: [{ version: "19.0.0" }, { version: "18.3.1" }], "react-dom": [{ version: "19.0.0", peerDependencies: { react: "^19" } }, { version: "18.3.1", peerDependencies: { react: "^18" } }], "react-json-view-lite": [{ version: "1.5.0", peerDependencies: { react: "^16.13.1 || ^17.0.0 || ^18.0.0", "react-dom": "^16.13.1 || ^17.0.0 || ^18.0.0" } }] };
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname.slice(1), all = !path.endsWith("/latest"), name = decodeURIComponent(all ? path : path.slice(0, -7));
    assert.ok(versions[name], name);
    const items = versions[name];
    return Response.json(all ? { "dist-tags": { latest: items[0].version }, versions: Object.fromEntries(items.map(item => [item.version, item])) } : items[0]);
  };
  const messages: string[] = [], scanned: string[] = [];
  try {
    await prepareNodeSources(folder, [""], names, nodeVersion, transport, [], undefined, {
      resolved: async () => { scanned.push(JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies.react); },
      image: async () => {}, validated: async () => {}, remediating: async message => { messages.push(message); },
    });
    const dependencies = JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies;
    assert.equal(dependencies.react, "18.3.1");
    assert.equal(dependencies["react-dom"], "18.3.1");
    assert.deepEqual(scanned, ["18.3.1"]);
    assert.ok(messages.some(message => message.includes("react-json-view-lite@1.5.0 exige")));
  } catch (error) {
    const selected = JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies;
    throw new Error(`Pair indirect : ${JSON.stringify({ selected, messages, scanned })}`, { cause: error });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

for (const crossRootRetry of [false, true]) test(`Docker réel : coordination transitive sans changer le manifeste, puis nouveau scan et tests${crossRootRetry ? " après le repli d’un autre service" : ""}`, docker, async () => {
  const { folder, names } = await fixture();
  for (const [name, range] of [["consumer", "^2 || ^3"], ["fixed", "2.0.0"]]) {
    const directory = join(folder, name);
    await mkdir(directory);
    await mkdir(join(directory, "package"));
    await writeFile(join(directory, "package/package.json"), JSON.stringify({ name: `vigie-${name}`, version: "1.0.0", dependencies: { "is-odd": range } }));
    await runCommand("tar", ["-czf", join(folder, `${name}.tgz`), "-C", directory, "package"]);
    names.push(`${name}.tgz`, `${name}/package/package.json`);
  }
  const manifest = { name: "vigie-balanced-indirect-fixture", version: "1.0.0", private: true, dependencies: { "vigie-consumer": "file:consumer.tgz", "vigie-fixed": "file:fixed.tgz" }, scripts: { test: "node -e \"if(require('is-odd/package.json').version!=='2.0.0')process.exit(1)\"" } };
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  await writeFile(join(folder, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies }, "node_modules/vigie-consumer": { version: "1.0.0" }, "node_modules/vigie-fixed": { version: "1.0.0" } } }));
  const transport: typeof fetch = async () => { throw Error("No parent catalogue should be needed for compatible installed versions"); };
  if (crossRootRetry) {
    await mkdir(join(folder, "ui"));
    const program = "if(require('is-number/package.json').version.startsWith('7.')){console.error('error TS2614: Module \"is-number\" has no exported member legacy');process.exit(1)}";
    await writeFile(join(folder, "ui/package.json"), JSON.stringify({ name: "vigie-other-service", private: true, dependencies: { "is-number": "^6.0.0" }, scripts: { test: `node -e ${JSON.stringify(program)}` } }));
    await writeFile(join(folder, "ui/package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { "is-number": "^6.0.0" } }, "node_modules/is-number": { version: "6.0.0" } } }));
    names.push("ui/package.json", "ui/package-lock.json");
  }
  const registry: typeof fetch = async input => {
    assert.ok(String(input).includes("/is-number"));
    return Response.json(String(input).endsWith("/latest") ? { version: "7.0.0" } : { versions: { "7.0.0": { version: "7.0.0" }, "6.0.0": { version: "6.0.0" } } });
  };
  const retry = { limits: new Map<string, Record<string, string>>(), attempt: 0, remediation: { iterations: 0, constraints: new Map<string, Record<string, string>>(), tried: new Set<string>(), seen: new Set<string>(), repair: createNodeRemediator(transport, async () => JSON.stringify({ patches: [] })) } };
  const scanned: boolean[] = [], messages: string[] = [];
  try {
    await prepareNodeSources(folder, crossRootRetry ? ["", "ui"] : [""], names, nodeVersion, crossRootRetry ? registry : transport, [], retry, {
      resolved: async () => {
        const lock = JSON.parse(await readFile(join(folder, "package-lock.json"), "utf8"));
        const blocked = Object.entries(lock.packages).some(([path, node]: [string, any]) => path.endsWith("node_modules/is-number") && node.version === "6.0.0");
        scanned.push(blocked);
        requireSecurityPass(securityCheck("OSV", "candidate", "fixture", blocked ? [{ id: "GHSA-fixture-security", aliases: [], package: "is-number", version: "6.0.0", severity: "critical", scope: "" }] : []));
      },
      image: async () => {}, validated: async () => {}, remediating: async message => { messages.push(message); },
    });
    assert.deepEqual(scanned, crossRootRetry ? [true, false, true, false] : [true, false]);
    const final = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
    assert.deepEqual(final.dependencies, manifest.dependencies);
    assert.deepEqual(final.scripts, manifest.scripts);
    assert.ok(!final.overrides);
    assert.ok(messages.some(message => message.includes("coordination des versions indirectes")));
    if (crossRootRetry) {
      assert.equal(JSON.parse(await readFile(join(folder, "ui/package.json"), "utf8")).dependencies["is-number"], "6.0.0");
      assert.equal(messages.filter(message => message.includes("coordination des versions indirectes")).length, 2);
      assert.ok(messages.some(message => message.includes("reprise de compatibilité")));
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

for (const scenario of ["baseline", "unsafe", "targeted", "catalog", "catalog-mutates", "catalog-unsafe"]) test(`Docker réel : repli du verrou initial après rupture indirecte ${scenario}`, docker, async () => {
  const unsafe = scenario === "unsafe", catalog = scenario.startsWith("catalog"), targeted = scenario === "targeted" || catalog, mutates = scenario === "catalog-mutates", catalogUnsafe = scenario === "catalog-unsafe";
  const { folder, names } = await fixture();
  await mkdir(join(folder, "provider"));
  await mkdir(join(folder, "provider/package"));
  const dependencies: Record<string, string> = { "is-number": catalog ? "^5 || ^6 || ^7" : "^6 || ^7", ...(targeted ? { "kind-of": "^5 || ^6" } : {}) };
  await writeFile(join(folder, "provider/package/package.json"), JSON.stringify({ name: "vigie-history-provider", version: "1.0.0", dependencies }));
  await runCommand("tar", ["-czf", join(folder, "provider.tgz"), "-C", join(folder, "provider"), "package"]);
  names.push("provider.tgz", "provider/package/package.json");
  const diagnostic = targeted ? "warning ".repeat(5000) + "\n    at compiler (/app/node_modules/is-number/index.js:1:1)\n" + "schema ".repeat(5000) : "Invalid plugin options";
  const program = `${catalogUnsafe ? "if(require('is-number/package.json').version.startsWith('6.'))require('fs').writeFileSync('unsafe-executed','bad');" : ""}if(Number(require('is-number/package.json').version.split('.')[0])>${catalog ? 5 : 6}){console.error(${JSON.stringify(diagnostic)});process.exit(1)}${mutates ? "require('fs').writeFileSync('source.js','changed');" : ""}require('fs').writeFileSync('validated-six','ok')`;
  const manifest = { name: "vigie-transitive-api-fixture", version: "1.0.0", private: true, dependencies: { "vigie-history-provider": "file:provider.tgz" }, scripts: { test: `node -e ${JSON.stringify(program)}` } };
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  const response = await fetch("https://registry.npmjs.org/is-number/6.0.0");
  assert.ok(response.ok);
  const previous = await response.json();
  const catalogVersions: Record<string, any> = { "6.0.0": previous };
  if (catalog) {
    for (const version of ["5.0.0", "7.0.0"]) {
      const metadata = await fetch(`https://registry.npmjs.org/is-number/${version}`);
      assert.ok(metadata.ok);
      catalogVersions[version] = await metadata.json();
    }
  }
  if (mutates) { names.push("source.js"); await writeFile(join(folder, "source.js"), "original"); }
  const integrity = "sha512-" + createHash("sha512").update(await readFile(join(folder, "provider.tgz"))).digest("base64");
  const packages: Record<string, any> = { "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies }, "node_modules/vigie-history-provider": { version: "1.0.0", resolved: "file:provider.tgz", integrity, dependencies }, "node_modules/is-number": { version: "6.0.0", resolved: previous.dist.tarball, integrity: previous.dist.integrity } };
  if (targeted) {
    const unrelated = await fetch("https://registry.npmjs.org/kind-of/5.1.0");
    assert.ok(unrelated.ok);
    const metadata = await unrelated.json();
    packages["node_modules/kind-of"] = { version: "5.1.0", resolved: metadata.dist.tarball, integrity: metadata.dist.integrity };
  }
  await writeFile(join(folder, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, requires: true, packages }));
  const transport: typeof fetch = async (input, options) => {
    if (String(input).includes("api.osv.dev")) return Response.json({ results: JSON.parse(String(options?.body)).queries.map(() => ({})) });
    assert.ok(String(input).includes("/is-number"));
    return Response.json({ "dist-tags": { latest: "7.0.0" }, versions: catalog ? catalogVersions : { "7.0.0": { version: "7.0.0" }, "6.0.0": { version: "6.0.0" } } });
  };
  const retry = { limits: new Map<string, Record<string, string>>(), attempt: 0, remediation: { iterations: 0, constraints: new Map<string, Record<string, string>>(), tried: new Set<string>(), seen: new Set<string>(), repair: createNodeRemediator(transport, async () => JSON.stringify({ patches: [] })) } };
  const scanned: string[] = [], messages: string[] = [], validated: string[] = [];
  try {
    const preparation = prepareNodeSources(folder, [""], names, nodeVersion, transport, [], retry, {
      resolved: async () => {
        const version = JSON.parse(await readFile(join(folder, "package-lock.json"), "utf8")).packages["node_modules/is-number"].version;
        scanned.push(version);
        requireSecurityPass(securityCheck("OSV", "candidate", "fixture", (unsafe || catalogUnsafe) && version === "6.0.0" ? [{ id: "GHSA-fixture-security", aliases: [], package: "is-number", version, severity: "critical", scope: "" }] : []));
      },
      image: async () => {}, validated: async root => { validated.push(root); }, remediating: async message => { messages.push(message); },
    });
    if (mutates) {
      await assert.rejects(preparation, /hors du périmètre/);
      assert.deepEqual(validated, []);
      return;
    } else if (unsafe) {
      await assert.rejects(preparation, /source particulière/);
      assert.deepEqual(validated, []);
      await assert.rejects(readFile(join(folder, "validated-six")), { code: "ENOENT" });
    } else {
      await preparation;
      assert.deepEqual(validated, [""]);
      assert.equal(await readFile(join(folder, "validated-six"), "utf8"), "ok");
    }
    assert.deepEqual(scanned, catalog ? ["7.0.0", "6.0.0", "5.0.0", "5.0.0"] : ["7.0.0", "6.0.0"]);
    assert.deepEqual(JSON.parse(await readFile(join(folder, "package.json"), "utf8")).dependencies, manifest.dependencies);
    assert.ok(messages.some(message => message.includes(catalog ? "meilleure version validée" : targeted ? "repli ciblé de is-number" : "à partir du verrou initial")));
    if (targeted) assert.equal(JSON.parse(await readFile(join(folder, "package-lock.json"), "utf8")).packages["node_modules/kind-of"].version, "6.0.3");
    if (catalogUnsafe) await assert.rejects(readFile(join(folder, "unsafe-executed")), { code: "ENOENT" });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : le verrou npm est reconstruit sans conserver un ancien arbre contradictoire", docker, async () => {
  const { folder, names } = await fixture();
  await writeFile(join(folder, "package-lock.json"), JSON.stringify({ name: "vigie-isolated-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { dependencies: { "is-number": "6.0.0" } }, "node_modules/is-number": { version: "6.0.0" }, "node_modules/old-unused-peer": { version: "1.0.0" } } }));
  try {
    await prepareNodeSources(folder, [""], names, nodeVersion);
    const lock = JSON.parse(await readFile(join(folder, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["node_modules/is-number"].version, "7.0.0");
    assert.ok(!lock.packages["node_modules/old-unused-peer"]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : une rupture d’API identifiée conserve la branche compatible sans bloquer les autres mises à jour", docker, async () => {
  const program = "if(require('is-number/package.json').version.startsWith('7.')){console.error('error TS2614: Module \"is-number\" has no exported member legacy');process.exit(1)}";
  const { folder, names } = await fixture(undefined, `node -e ${JSON.stringify(program)}`);
  const manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
  manifest.dependencies["is-odd"] = "2.0.0";
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  const transport: typeof fetch = async input => {
    if (String(input).includes("is-odd")) return Response.json({ version: "3.0.1" });
    return Response.json(String(input).endsWith("/latest") ? { version: "7.0.0" } : { versions: { "7.0.0": { version: "7.0.0" }, "6.0.0": { version: "6.0.0" } } });
  };
  try {
    const result = await prepareNodeSources(folder, [""], names, nodeVersion, transport);
    const updated = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
    assert.deepEqual(updated.dependencies, { "is-number": "6.0.0", "is-odd": "3.0.1" });
    assert.ok(result.warnings.some(warning => warning.includes("montée majeure écartée")));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : le repli de compatibilité ne peut pas masquer une altération du code", docker, async () => {
  const program = "require('fs').writeFileSync('source.js','changed');console.error('error TS2614: Module \"is-number\" has no exported member legacy');process.exit(1)";
  const { folder, names } = await fixture(undefined, `node -e ${JSON.stringify(program)}`);
  names.push("source.js");
  await writeFile(join(folder, "source.js"), "original");
  try { await assert.rejects(prepareNodeSources(folder, [""], names, nodeVersion), /hors du périmètre/); }
  finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : le Dockerfile d’un service indépendant ne bloque pas la racine Node", docker, async () => {
  const { folder, names } = await fixture();
  await mkdir(join(folder, "unrelated"));
  await writeFile(join(folder, "unrelated", "Dockerfile"), "FROM node:20");
  names.push("unrelated/Dockerfile");
  try {
    const before = await snapshotSources(folder, names);
    const prepared = await prepareNodeSources(folder, [""], names, nodeVersion);
    await changedSources(folder, before, prepared.allowed);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : image multi-étapes, Node, paquet runtime et serveur HTTP validés", docker, async () => {
  const { folder, names } = await fixture();
  names.push("Dockerfile", "server.js");
  await writeFile(join(folder, "Dockerfile"), 'FROM node:22-slim AS builder\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install --ignore-scripts --no-audit --no-fund\nCOPY server.js ./server.js\nFROM node:22-slim AS runner\nWORKDIR /app\nRUN npm install --no-audit --no-fund --no-save express@4.21.2\nCOPY --from=builder /app/server.js ./server.js\nEXPOSE 8080\nCMD ["node","server.js"]\n');
  await writeFile(join(folder, "server.js"), "if(process.env.DATABASE_URL||process.env.GITHUB_TOKEN||process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY)process.exit(1);const express=require('express');const app=express();app.get('/',(req,res)=>res.send('ok'));app.listen(process.env.PORT||8080);");
  try {
    const before = await snapshotSources(folder, names);
    const prepared = await prepareNodeSources(folder, [""], names, nodeVersion);
    const changes = await changedSources(folder, before, prepared.allowed);
    const dockerfile = changes.find(file => file.path === "Dockerfile")!.content;
    assert.equal(dockerfile.match(/node:24\.14\.0-slim/g)?.length, 2);
    assert.ok(!dockerfile.includes("express@4.21.2"));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : refus Trivy, autre base officielle validée ou refus final sans contournement", docker, async () => {
  for (const acceptedAttempt of [2, 4, 0]) {
    const folder = await mkdtemp(join(tmpdir(), "vigie-base-integration-"));
    const initial = 'FROM node:24.22.1-slim AS builder\nWORKDIR /app\nCOPY server.js ./server.js\nFROM node:24.22.1-slim AS runner\nWORKDIR /app\nCOPY --from=builder /app/server.js ./server.js\nEXPOSE 8080\nCMD ["node","server.js"]\n';
    const server = "require('node:http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT||8080)";
    await writeFile(join(folder, "Dockerfile"), initial);
    await writeFile(join(folder, "server.js"), server);
    let inspected = 0;
    const messages: string[] = [];
    try {
      const validate = () => validateDockerfile(folder, "", ["Dockerfile", "server.js"], "24.22.1", async () => {
        inspected++;
        requireSecurityPass(securityCheck("Trivy", "candidate", "fixture", inspected === acceptedAttempt ? [] : [{ id: "CVE-fixture", aliases: [], package: "fixture", version: "1.0.0", severity: "critical", scope: "fixture" }]));
      }, async message => { messages.push(message); });
      if (acceptedAttempt) {
        await validate();
        const selected = await readFile(join(folder, "Dockerfile"), "utf8");
        assert.equal(selected.match(acceptedAttempt === 2 ? /node:24\.22\.1-trixie-slim/g : /node:24\.22\.1-alpine/g)?.length, 2);
        assert.ok(versionOnlyDockerfile(initial, selected));
        assert.equal(inspected, acceptedAttempt);
      } else {
        await assert.rejects(validate(), /Trivy/);
        assert.equal(await readFile(join(folder, "Dockerfile"), "utf8"), initial);
        assert.equal(inspected, 4);
      }
      assert.equal(await readFile(join(folder, "server.js"), "utf8"), server);
      assert.ok(messages.length > 0);
    } finally { await rm(folder, { recursive: true, force: true }); }
  }
});

test("Docker réel : les scripts ne peuvent pas modifier le manifeste validé", docker, async () => {
  const { folder, names } = await fixture(undefined, "node -e \"require('fs').writeFileSync('package.json', '{}')\"");
  try { await assert.rejects(prepareNodeSources(folder, [""], names, nodeVersion), /hors du périmètre/); }
  finally { await rm(folder, { recursive: true, force: true }); }
});

test("Docker réel : un script qui altère du code ne peut pas le publier", docker, async () => {
  const { folder, names } = await fixture(undefined, "node -e \"require('fs').writeFileSync('source.js', 'changed')\"");
  names.push("source.js");
  await writeFile(join(folder, "source.js"), "original");
  try {
    const validations = new Set<string>();
    await assert.rejects(prepareNodeSources(folder, [""], names, nodeVersion, fetch, [], { limits: new Map(), attempt: 0, validations }), /hors du périmètre/);
    assert.equal(validations.size, 0, "une altération détectée ne doit jamais remplir le cache de validation");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
