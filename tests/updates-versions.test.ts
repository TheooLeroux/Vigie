import test from "node:test";
import assert from "node:assert/strict";
import { compatibleVersions, verifiedPeerConflicts, type PackageVersion } from "../src/lib/updates/versions";
import { npmPeerConflicts, PeerResolutionError, runCommand } from "../src/lib/updates/process";
import { dockerPackages, rewriteDockerfile, versionOnlyDockerfile } from "../src/lib/updates/dockerfile";
import { prepareNodeSources } from "../src/lib/updates/node";
import { nodeTestProfile } from "../src/lib/updates/node-test-profile";

function registry(packages: Record<string, PackageVersion[]>) {
  const requests: string[] = [];
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname.slice(1), all = !path.endsWith("/latest"), name = decodeURIComponent(all ? path : path.slice(0, -7));
    requests.push(name + (all ? "/all" : "/latest"));
    const versions = packages[name];
    assert.ok(versions, `Catalogue de test absent : ${name}`);
    return Response.json(all ? { versions: Object.fromEntries(versions.map(item => [item.version, item])) } : versions[0]);
  };
  return { transport, requests };
}

test("Versions compatibles : un délai réseau est retenté sans accepter un catalogue absent", async () => {
  let requests = 0;
  const transport: typeof fetch = async () => {
    if (++requests === 1) throw new DOMException("timeout", "TimeoutError");
    return Response.json({ version: "2.0.0" });
  };
  assert.equal((await compatibleVersions({ dependencies: { library: "1.0.0" } }, "24.14.0", transport)).versions.library, "2.0.0");
  assert.equal(requests, 2);
  requests = 0;
  const unavailable: typeof fetch = async () => { requests++; throw new DOMException("timeout", "TimeoutError"); };
  await assert.rejects(compatibleVersions({ dependencies: { library: "1.0.0" } }, "24.14.0", unavailable), /library.*deux tentatives/);
  assert.equal(requests, 2);
});

test("Versions compatibles : TypeScript respecte le parseur récent sans bloquer les autres paquets", async () => {
  const { transport, requests } = registry({ typescript: [{ version: "7.0.2" }, { version: "6.0.4" }, { version: "5.9.3" }], parser: [{ version: "8.72.0", peerDependencies: { typescript: ">=4.8.4 <6.1.0" } }, { version: "8.45.0", peerDependencies: { typescript: "<6" } }], unrelated: [{ version: "3.0.0" }] });
  const source = { devDependencies: { typescript: "~5.9.3", parser: "^8.45.0", unrelated: "1.0.0" } };
  const result = await compatibleVersions(source, "24.14.0", transport);
  assert.deepEqual(result.manifest.devDependencies, { typescript: "6.0.4", parser: "8.72.0", unrelated: "3.0.0" });
  assert.ok(result.warnings.some(warning => warning.includes("typescript") && warning.includes("6.0.4")));
  assert.ok(!requests.includes("unrelated/all"));
  assert.equal(source.devDependencies.typescript, "~5.9.3");
});

test("Versions compatibles : React et son renderer sont choisis ensemble selon le framework", async () => {
  const { transport } = registry({ framework: [{ version: "3.0.0", peerDependencies: { react: "^18" } }], react: [{ version: "19.3.0" }, { version: "18.3.1" }], "react-dom": [{ version: "19.3.0", peerDependencies: { react: "^19.3.0" } }, { version: "18.3.1", peerDependencies: { react: "^18.3.1" } }] });
  const result = await compatibleVersions({ dependencies: { framework: "2.0.0", react: "^18.0.0", "react-dom": "^18.0.0" } }, "24.14.0", transport);
  assert.deepEqual(result.manifest.dependencies, { framework: "3.0.0", react: "18.3.1", "react-dom": "18.3.1" });
});

test("Résolution npm : pairs indirects structurés, confirmés au registre et recalcul coordonné", async () => {
  const diagnostic = 'npm error code ERESOLVE\nnpm error   peer react@"^16.13.1 || ^17.0.0 || ^18.0.0" from nested-view@1.5.0\nnpm error secret-fixture';
  const conflicts = npmPeerConflicts(diagnostic);
  assert.deepEqual(conflicts, [{ peer: "react", range: "^16.13.1 || ^17.0.0 || ^18.0.0", consumer: "nested-view", version: "1.5.0" }]);
  const { transport } = registry({ "nested-view": [{ version: "1.5.0", peerDependencies: { react: conflicts[0].range } }], react: [{ version: "19.0.0" }, { version: "18.3.1" }], "react-dom": [{ version: "19.0.0", peerDependencies: { react: "^19" } }, { version: "18.3.1", peerDependencies: { react: "^18" } }] });
  const verified = await verifiedPeerConflicts(conflicts, { react: "19.0.0" }, transport);
  assert.deepEqual(verified, conflicts);
  const result = await compatibleVersions({ dependencies: { react: "^18", "react-dom": "^18" } }, "24.14.0", transport, {}, { react: [verified[0].range, ">=18.3.1 <19"] });
  assert.deepEqual(result.versions, { react: "18.3.1", "react-dom": "18.3.1" });
  await assert.rejects(verifiedPeerConflicts([{ ...conflicts[0], range: "^17" }], { react: "19.0.0" }, transport), /ne confirme pas/);
  await assert.rejects(compatibleVersions({ dependencies: { react: "^19", "react-dom": "^19" } }, "24.14.0", transport, {}, { react: [verified[0].range] }), /Aucun ensemble/);
  assert.deepEqual(npmPeerConflicts(diagnostic.replace("ERESOLVE", "NETWORK")), []);
  assert.deepEqual(npmPeerConflicts('ERESOLVE\nnpm error peer react@"https://secret.invalid/token" from nested-view@1.5.0'), []);
  const args = ["-e", `process.stderr.write(${JSON.stringify(diagnostic)});process.exit(1)`];
  await assert.rejects(runCommand(process.execPath, args, { peerResolution: true }), error => error instanceof PeerResolutionError && error.conflicts.length === 1 && !error.message.includes("secret-fixture"));
  await assert.rejects(runCommand(process.execPath, args), error => !(error instanceof PeerResolutionError) && error instanceof Error && !error.message.includes("secret-fixture"));
});

test("Versions compatibles : les pairs peuvent monter ensemble et les versions ne sont pas rétrogradées", async () => {
  const { transport } = registry({ first: [{ version: "2.0.0", peerDependencies: { second: "^2" } }], second: [{ version: "2.0.0", peerDependencies: { first: "^2" } }] });
  assert.deepEqual((await compatibleVersions({ dependencies: { first: "1.0.0", second: "1.0.0" } }, "24.14.0", transport)).versions, { first: "2.0.0", second: "2.0.0" });
  const impossible = registry({ first: [{ version: "2.0.0", peerDependencies: { second: "^1" } }], second: [{ version: "2.0.0" }, { version: "1.0.0" }] });
  await assert.rejects(compatibleVersions({ dependencies: { first: "1.0.0", second: "2.0.0" } }, "24.14.0", impossible.transport), /Aucun ensemble/);
});

test("Versions compatibles : moteur Node, préversions, dépréciations et dist-tag respectés", async () => {
  const { transport } = registry({ tool: [{ version: "3.0.0", engines: { node: ">=26" } }, { version: "4.0.0" }, { version: "3.1.0-beta.1" }, { version: "2.9.0", deprecated: "unsafe" }, { version: "2.8.0", engines: { node: ">=22" } }, { version: "2.0.0" }] });
  assert.equal((await compatibleVersions({ dependencies: { tool: "2.0.0" } }, "24.14.0", transport)).versions.tool, "2.8.0");
});

test("Versions compatibles : un repli après tests sélectionne le dernier correctif sans bloquer les autres paquets", async () => {
  const { transport } = registry({ library: [{ version: "2.0.0" }, { version: "1.9.3" }, { version: "1.5.0" }], other: [{ version: "3.0.0" }] });
  const result = await compatibleVersions({ dependencies: { library: "^1.5.0", other: "1.0.0" } }, "24.14.0", transport, {}, { library: "^1.5.0" });
  assert.deepEqual(result.versions, { library: "1.9.3", other: "3.0.0" });
  await assert.rejects(prepareNodeSources("unused", ["docs"], [], "24.14.0", transport, ["docs"]), /Dockerfile est absent/);
});

test("Versions compatibles : les types Node restent alignés sur le runtime LTS retenu", async () => {
  const { transport } = registry({ "@types/node": [{ version: "26.0.0" }, { version: "24.19.2" }, { version: "22.0.0" }] });
  const result = await compatibleVersions({ devDependencies: { "@types/node": "^22.0.0" } }, "24.14.0", transport);
  assert.equal(result.manifest.devDependencies["@types/node"], "24.19.2");
});

test("Versions compatibles : les noms ne peuvent pas devenir des contraintes héritées du prototype", async () => {
  const { transport } = registry({ constructor: [{ version: "2.0.0" }] });
  const result = await compatibleVersions({ dependencies: { constructor: "1.0.0" } }, "24.14.0", transport);
  assert.equal(result.versions.constructor, "2.0.0");
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "version"), false);
});

test("Dockerfile : toutes les étapes Node et la dépendance runtime sont actualisées sans modifier les instructions", () => {
  const original = "FROM node:20-slim AS builder\nRUN npm install --no-audit --no-fund\nFROM node:20-slim AS runner\nRUN npm install --no-save express@4.21.2\nCOPY --from=builder /app/build ./build\nEXPOSE 8080\nCMD [\"node\",\"server.js\"]\n";
  assert.deepEqual(dockerPackages(original), { express: "4.21.2" });
  assert.deepEqual(dockerPackages(original + "RUN npm install --no-save express@5.0.0\nRUN npm install --no-save express@4.21.2\n"), { express: "5.0.0" });
  const candidate = rewriteDockerfile(original, "24.14.0", { express: "5.2.0" });
  assert.equal(candidate.match(/node:24\.14\.0-slim/g)?.length, 2);
  assert.ok(candidate.includes("express@5.2.0"));
  assert.ok(versionOnlyDockerfile(original, candidate));
  assert.ok(!versionOnlyDockerfile(original, candidate + "RUN echo unexpected\n"));
  assert.ok(!versionOnlyDockerfile(original, candidate.replace("-slim", "-alpine")));
  assert.throws(() => rewriteDockerfile("FROM attacker/node:20\n", "24.14.0", {}), /officielles/);
  assert.throws(() => rewriteDockerfile("# syntax=attacker/frontend\nFROM node:20\n", "24.14.0", {}), /validation dédiée/);
  assert.throws(() => rewriteDockerfile("FROM node:20\nRUN npm install express@latest\n", "24.14.0", {}), /version explicite/);
  assert.throws(() => rewriteDockerfile("FROM node:20\nRUN --mount=type=ssh npm ci\n", "24.14.0", {}), /validation dédiée/);
  assert.equal(rewriteDockerfile("FROM node:20\nRUN npm install\n", "24.14.0", {}), "FROM node:24.14.0\nRUN npm install\n");
});

test("Profil de test NesAppli : valeurs factices locales uniquement, aucune récupération des secrets du worker", () => {
  const manifest = { name: "backend", dependencies: { "@supabase/supabase-js": "2.0.0" } };
  const schema = "JWT_REFRESH_SECRET SUPABASE_JWT_SECRET ADMIN_BOOTSTRAP_SECRET PI_API_SECRET";
  const profile = nodeTestProfile(manifest, schema)!;
  assert.equal(profile.environment.SUPABASE_URL, "http://127.0.0.1:9");
  assert.equal(profile.environment.SMTP_HOST, "127.0.0.1");
  assert.equal(profile.environment.SMTP_PORT, "9");
  assert.match(profile.environment.SUPABASE_SERVICE_ROLE_KEY, /^vigie-test-only/);
  assert.ok(profile.environment.JWT_SECRET.length >= 32);
  assert.ok(!("DATABASE_URL" in profile.environment) && !("GITHUB_TOKEN" in profile.environment) && !("VIGIE_CONNECTOR_ENCRYPTION_KEY" in profile.environment));
  assert.equal(nodeTestProfile(manifest, "unrelated schema"), null);
  assert.equal(nodeTestProfile({ name: "other" }, schema), null);
});
