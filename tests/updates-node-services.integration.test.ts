import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNodeServices } from "../src/lib/updates/node-services";
import { requireSecurityPass, securityCheck } from "../src/lib/updates/security";
import { nodeValidationRuntime, prepareNodeSources } from "../src/lib/updates/node";
import { runCommand } from "../src/lib/updates/process";

const docker = { skip: process.env.VIGIE_TEST_DOCKER !== "1" }, nodeVersion = "24.14.0";
const transport: typeof fetch = async input => Response.json(String(input).endsWith("/latest") ? { version: "7.0.0" } : { versions: { "7.0.0": { version: "7.0.0" }, "6.0.0": { version: "6.0.0" } } });
async function fixture(programs: Record<string, string>) {
  const folder = await mkdtemp(join(tmpdir(), "vigie-services-native-")), names: string[] = [];
  for (const [root, program] of Object.entries(programs)) {
    await mkdir(join(folder, root));
    const manifest = { name: root, version: "1.0.0", private: true, engines: { node: "22.x" }, dependencies: { "is-number": "6.0.0" }, scripts: { test: `node -e ${JSON.stringify(program)}` } };
    for (const [name, content] of Object.entries({ "package.json": JSON.stringify(manifest), "package-lock.json": JSON.stringify({ name: root, version: "1.0.0", lockfileVersion: 3, packages: {} }), "source.js": "original" })) {
      await writeFile(join(folder, root, name), content);
      names.push(`${root}/${name}`);
    }
  }
  return { folder, names };
}
const compatible = "if(!require('is-number')(42))process.exit(1)";

test("Docker cache : réinstallation hors réseau depuis les contenus, corruption refusée", docker, async () => {
  const { folder, names } = await fixture({ first: compatible });
  const runtime = nodeValidationRuntime(nodeVersion);
  try {
    await prepareNodeSources(folder, ["first"], names, nodeVersion, transport, [], { limits: new Map(), attempt: 0, runtime }, {
      resolved: async () => {}, image: async () => {}, validated: async () => {},
    });
    const content = await runtime.downloads!("first");
    const cacheOnlyInstall = () => runCommand("docker", ["run", "--rm", "--network=none", "--read-only", "--tmpfs=/tmp:rw,exec,nosuid,size=1g", "--cap-drop=ALL", "--security-opt=no-new-privileges", `--user=${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, "--env=HOME=/tmp", "--env=npm_config_cache=/tmp/npm", "--mount", `type=bind,source=${content},target=/vigie-npm-content`, "--mount", `type=bind,source=${folder},target=/app`, "--workdir=/app/first", `node:${nodeVersion}-bookworm`, "sh", "-c", "set -eu; mkdir -p /tmp/npm/_cacache; ln -s /vigie-npm-content /tmp/npm/_cacache/content-v2; npm ci --offline --strict-peer-deps --ignore-scripts --no-audit --no-fund; npm ls --all --json"], { timeout: 30_000 });
    assert.match(await cacheOnlyInstall(), /is-number/);
    const lock = JSON.parse(await readFile(join(folder, "first/package-lock.json"), "utf8"));
    const integrity: string = lock.packages["node_modules/is-number"].integrity;
    const [algorithm, digest] = integrity.split("-");
    const hex = Buffer.from(digest, "base64").toString("hex");
    await writeFile(join(content, algorithm, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), "corrupted cached tarball");
    await assert.rejects(cacheOnlyInstall(), /échoué|commande|Command/i);
  } finally { await runtime.dispose!(); await rm(folder, { recursive: true, force: true }); }
});

test("Docker parallèle : le repli d’un service ne relance pas la préparation de son voisin", docker, async t => {
  const rejectMajor = "if(require('is-number/package.json').version.startsWith('7.')){console.error('error TS2614: Module \"is-number\" has no exported member legacy');process.exit(1)}";
  const { folder, names } = await fixture({ first: compatible, second: rejectMajor });
  const scans = new Map<string, number>(), validated: string[] = [], remediations: string[] = [];
  const firstScans = new Set<string>();
  let release!: () => void;
  const bothResolved = new Promise<void>(done => { release = done; });
  const deadline = setTimeout(() => release(), 30_000);
  deadline.unref();
  try {
    const start = performance.now();
    const result = await prepareNodeServices(folder, ["first", "second"], names, nodeVersion, (_working, roots, phase) => ({
      resolved: async () => {
        if (phase !== "prepare") return;
        scans.set(roots[0], (scans.get(roots[0]) || 0) + 1);
        firstScans.add(roots[0]);
        if (firstScans.size === 2) release();
        await bothResolved;
      },
      validated: async root => { validated.push(`${phase}:${root}`); },
      image: async () => {},
      remediating: async message => { remediations.push(message); },
    }), { concurrency: 2, transport });
    assert.equal(scans.get("first"), 1, "le service déjà accepté ne doit pas être repréparé");
    assert.equal(scans.get("second"), 2, "la reprise reste limitée au service incompatible");
    assert.deepEqual(validated.sort(), ["final:first", "final:second", "prepare:first", "prepare:second"]);
    assert.ok(remediations.some(message => message.includes("montée majeure") || message.includes("reprise de compatibilité")));
    assert.equal(JSON.parse(await readFile(join(folder, "first/package.json"), "utf8")).dependencies["is-number"], "7.0.0");
    assert.equal(JSON.parse(await readFile(join(folder, "second/package.json"), "utf8")).dependencies["is-number"], "6.0.0");
    assert.equal(result.allowed.size, 4);
    assert.ok("services" in result && result.services.length === 2);
    t.diagnostic(`Deux services préparés et validés ensemble en ${Math.round(performance.now() - start)} ms ; une seule reprise locale, sans répéter le voisin.`);
  } finally { clearTimeout(deadline); release(); await rm(folder, { recursive: true, force: true }); }
});

for (const scenario of ["combined-inputs", "final-source", "final-security"]) {
  test(`Docker parallèle : ${scenario} bloque la proposition assemblée sans modifier l’original`, docker, async () => {
    const program = scenario === "combined-inputs"
      ? "if(require('../second/package.json').dependencies['is-number']==='7.0.0')process.exit(1)"
      : scenario === "final-source"
        ? `if(require('../second/package.json').engines.node==='${nodeVersion}')require('node:fs').writeFileSync('source.js','changed')`
        : compatible;
    const { folder, names } = await fixture({ first: program, second: compatible });
    const originals = await Promise.all(names.map(name => readFile(join(folder, name), "utf8")));
    try {
      await assert.rejects(prepareNodeServices(folder, ["first", "second"], names, nodeVersion, (_working, roots, phase) => ({
        resolved: async () => {
          if (scenario === "final-security" && phase === "final" && roots[0] === "first") requireSecurityPass(securityCheck("OSV", "candidate", "first", [{ id: "MAL-2026-fixture", aliases: [], package: "is-number", version: "7.0.0", severity: "critical", scope: "first" }]));
        },
        image: async () => {}, validated: async () => {},
      }), { concurrency: 2, transport }));
      for (const [index, name] of names.entries()) assert.equal(await readFile(join(folder, name), "utf8"), originals[index]);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}

test("Docker parallèle : l’image d’un service reste construite, inspectée et démarrée avant assemblage", docker, async () => {
  const { folder, names } = await fixture({ first: compatible, second: compatible });
  const inspected: string[] = [];
  try {
    const imageSource = 'FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev --strict-peer-deps\nCOPY server.js ./\nEXPOSE 3000\nCMD ["node","server.js"]\n';
    await writeFile(join(folder, "first/Dockerfile"), imageSource);
    await writeFile(join(folder, "first/server.js"), "require('node:http').createServer((_,res)=>res.end('ok')).listen(3000,'0.0.0.0');\n");
    names.push("first/Dockerfile", "first/server.js");
    await prepareNodeServices(folder, ["first", "second"], names, nodeVersion, () => ({
      resolved: async () => {}, validated: async () => {}, image: async (root, image) => { inspected.push(root + ":" + image); },
    }), { concurrency: 2, transport, dockerRoots: ["first"] });
    assert.equal(inspected.length, 1);
    assert.match(inspected[0], /^first:vigie-validation:/);
    assert.match(await readFile(join(folder, "first/Dockerfile"), "utf8"), /FROM node:24\.14\.0-bookworm-slim/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
