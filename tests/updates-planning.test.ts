import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { compatibleVersions, packageCatalog, CompatibilitySelectionError, type PackageVersion } from "../src/lib/updates/versions";
import { withPlanningSession, planningCatalog, mapConcurrent } from "../src/lib/updates/planning";

test("Planification : lectures parallèles bornées, communes aux services et reprises, privées à l’exécution", async t => {
  const manifest = { dependencies: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`package-${i}`, "1.0.0"])) };
  let requests = 0, active = 0, peak = 0;
  const transport: typeof fetch = async () => {
    requests++; peak = Math.max(peak, ++active);
    await delay(15);
    active--;
    return Response.json({ version: "2.0.0" });
  };
  const started = performance.now();
  await withPlanningSession(async () => {
    const [first, second] = await Promise.all([compatibleVersions(manifest, "24.14.0", transport), compatibleVersions(manifest, "24.14.0", transport)]);
    assert.deepEqual(first.versions, second.versions);
    assert.equal(requests, 24);
    await compatibleVersions(manifest, "24.14.0", transport);
    assert.equal(requests, 24, "une reprise ne relit pas les mêmes catalogues");
  });
  const elapsed = Math.round(performance.now() - started);
  assert.equal(peak, 8);
  await withPlanningSession(() => compatibleVersions(manifest, "24.14.0", transport));
  assert.equal(requests, 48, "une autre exécution doit relire le registre");
  t.diagnostic(`24 catalogues, deux services et une reprise : ${elapsed} ms, 24 lectures au lieu de 72 ; latence simulée de 15 ms par lecture.`);
});

test("Planification : échec, péremption et budget mémoire ne créent pas de résultats permanents", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let reads = 0;
  const transport: typeof fetch = async () => Response.json({});
  const read = async () => ({ value: ++reads, bytes: 20 * 1024 * 1024 });
  await withPlanningSession(async () => {
    assert.equal(await planningCatalog("a", transport, read), 1);
    assert.equal(await planningCatalog("a", transport, read), 1);
    assert.equal(await planningCatalog("b", transport, read), 2);
    assert.equal(await planningCatalog("a", transport, read), 3, "le budget de 32 Mio évince l’ancien catalogue");
    t.mock.timers.tick(300_001);
    assert.equal(await planningCatalog("a", transport, read), 4);
    await assert.rejects(planningCatalog("failed", transport, async () => { throw Error("unavailable"); }), /unavailable/);
    assert.equal(await planningCatalog("failed", transport, read), 5);
    const other: typeof fetch = async () => Response.json({});
    assert.equal(await planningCatalog("failed", other, read), 6, "les fournisseurs restent distincts");
  });
});

test("Planification : le registre complet est dédupliqué sans cacher une panne", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    if (++calls === 1) return new Response("unavailable", { status: 503 });
    return Response.json({ "dist-tags": { latest: "2.0.0" }, versions: { "2.0.0": { version: "2.0.0" } } });
  };
  await withPlanningSession(async () => {
    await assert.rejects(packageCatalog("library", transport), /indisponible/);
    const versions = await Promise.all([packageCatalog("library", transport), packageCatalog("library", transport)]);
    assert.deepEqual(versions[0], versions[1]);
    assert.equal(calls, 2);
  });
});

test("Planification : un conflit cyclique ne multiplie pas les choix de 18 paquets indépendants", async () => {
  const packages: Record<string, PackageVersion[]> = {};
  for (let i = 0; i < 18; i++) packages[`a${i}`] = [3, 2, 1].map(n => ({ version: `${n}.0.0` }));
  for (const [name, peer, opposite] of [["z1", "z2", false], ["z2", "z3", false], ["z3", "z1", true]] as const) {
    packages[name] = [3, 2, 1].map(n => ({ version: `${n}.0.0`, peerDependencies: { [peer]: `${opposite && n < 3 ? 3 - n : n}.0.0` } }));
  }
  const transport: typeof fetch = async input => {
    const url = String(input), name = decodeURIComponent(new URL(url).pathname.slice(1).replace(/\/latest$/, ""));
    return Response.json(url.endsWith("/latest") ? packages[name][0] : { versions: Object.fromEntries(packages[name].map(p => [p.version, p])) });
  };
  const manifest = { dependencies: Object.fromEntries(Object.keys(packages).map(name => [name, "1.0.0"])) };
  const limits = Object.fromEntries(Object.keys(packages).map(name => [name, "<3"]));
  await assert.rejects(withPlanningSession(() => compatibleVersions(manifest, "24.14.0", transport, {}, limits)), error => error instanceof CompatibilitySelectionError);
});

test("Planification : un échec attend la fin des lectures déjà lancées", async () => {
  let settled = false;
  await assert.rejects(mapConcurrent([0, 1, 2], 2, async n => {
    if (n === 0) throw Error("failed");
    await delay(10); settled = true;
    assert.equal(n, 1);
  }), /failed/);
  assert.equal(settled, true);
});
