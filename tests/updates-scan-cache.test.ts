import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeScanCache, scanDockerImage } from "../src/lib/updates/security";
import type { SecurityFinding } from "../src/lib/updates/types";

test("OSV : seuls les verrous inchangés de ce job sont réutilisés, avec alertes et date d’origine", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-scan-cache-test-"));
  let now = Date.parse("2026-10-27T12:00:00Z");
  const calls: string[][] = [], names = ["one/package.json", "one/package-lock.json", "two/package.json", "two/package-lock.json"];
  const findings: (SecurityFinding & { scope: string })[] = ["one", "two"].map(scope => ({ id: "GHSA-fixture", aliases: [], package: "fixture", version: "1.0.0", severity: "high", scope }));
  try {
    for (const root of ["one", "two"]) { await mkdir(join(folder, root)); await writeFile(join(folder, root, "package.json"), '{"name":"fixture"}'); await writeFile(join(folder, root, "package-lock.json"), "{}"); }
    const scan = createNodeScanCache(folder, ["one", "two"], async (_folder, roots) => { calls.push([...roots]); return findings.filter(finding => roots.includes(finding.scope!)); }, () => now);
    const original = await scan(names);
    now += 1000;
    const reused = await scan(names);
    assert.deepEqual(calls, [["one", "two"]]);
    assert.equal(reused.checkedAt, original.checkedAt);
    assert.equal(reused.findings.length, 2, "les failles élevées restent visibles");
    reused.findings[0].package = "changed-by-caller";
    assert.equal((await scan(names)).findings[0].package, "fixture");
    await writeFile(join(folder, "one/package-lock.json"), '{"changed":true}');
    await scan(names);
    assert.deepEqual(calls.at(-1), ["one"]);
    await writeFile(join(folder, "two/package.json"), '{"name":"fixture","scripts":{"test":"changed"}}');
    await scan(names);
    assert.deepEqual(calls.at(-1), ["two"]);
    now += 300_000;
    await scan(names);
    assert.deepEqual(calls.at(-1), ["one", "two"], "le cache expire après cinq minutes");
    const before = calls.length;
    await scan(names, true);
    assert.equal(calls.length, before + 1, "la dernière analyse ne réutilise jamais le cache");
    assert.deepEqual(calls.at(-1), ["one", "two"]);
    const anotherJob = createNodeScanCache(folder, ["one"], async (_folder, roots) => { calls.push(roots); return []; });
    await anotherJob(names);
    assert.deepEqual(calls.at(-1), ["one"], "aucun résultat transmis à un autre job");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Trivy : base partagée dans le job, rapports distincts et mise à jour de la base maintenue", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vigie-trivy-cache-test-")), working: string[] = [];
  try {
    for (const image of ["node:24.14.0-slim", "node:24.22.1-alpine"]) {
      await scanDockerImage(image, async (_command, args, options) => {
        assert.equal(args[args.indexOf("--cache-dir") + 1], folder);
        assert.ok(!args.some(arg => /skip.*update|ignore.*unfixed/.test(arg)));
        working.push(options!.cwd!);
        assert.equal(options!.env!.DATABASE_URL, undefined);
        return JSON.stringify({ SchemaVersion: 2, Metadata: { OS: { Family: "alpine" } }, Results: [{ Target: image }] });
      }, false, folder);
    }
    assert.notEqual(working[0], working[1]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
