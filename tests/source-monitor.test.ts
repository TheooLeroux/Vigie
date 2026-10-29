import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { scanCurrentDependencies, scanDependencyFiles } from "../src/lib/updates/source-monitor";
import { scanCurrentNode } from "../src/lib/updates/node-monitor";
import { healthUpdates } from "./project-health-fixture";
import { SourceQualificationError } from "../src/lib/updates/capabilities";
import type { runCommand } from "../src/lib/updates/process";

test("Surveillance PHP : lire le verrou du commit actif sans exécuter de script ni autoriser la maintenance", async () => {
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = '{"example":"test-only"}';
  const target = healthUpdates().runs[0].targets[0], commit = "b".repeat(40), paths: string[] = [];
  const lock = JSON.stringify({ packages: [{ name: "vendor/library", version: "1.0.0" }] });
  const github = async (path: string, _token: string, method = "GET") => {
    paths.push(path); assert.equal(method, "GET"); assert.ok(path.endsWith(`?ref=${commit}`));
    if (path.includes("/backend?")) return [{ name: "composer.json", type: "file" }, { name: "composer.lock", type: "file" }, { name: ".env", type: "file" }, { name: "main.php", type: "file" }];
    assert.ok(path.includes("/composer.lock?"));
    return { type: "file", encoding: "base64", content: Buffer.from(lock).toString("base64"), size: Buffer.byteLength(lock) };
  };
  const result = await scanCurrentDependencies(target, commit, {
    node: (target, commit) => scanCurrentNode(target, commit, { github, scan: async () => { throw Error("Scanner Node interdit pour PHP"); }, latest: async () => "1.0.0" }),
    github,
    scan: async (files, ecosystem) => {
      assert.equal(ecosystem, "Packagist"); assert.deepEqual(files.map(file => file.name), ["composer.lock"]);
      assert.equal(Buffer.from(files[0].content).toString("utf8"), lock);
      return { packages: 1, findings: [{ id: "CVE-2026-1111", aliases: [], package: "vendor/library", version: "1.0.0", severity: "high", scope: "temporary" }] };
    },
  });
  assert.equal(result.sourceQualification?.family, "php");
  assert.equal(result.securityCoverage?.packages, 1);
  assert.deepEqual(result.securityCoverage?.limitations, []);
  assert.equal(result.checks[0].findings[0].scope, "backend");
  assert.deepEqual(result.updates, []);
  assert.ok(paths.every(path => !path.includes(".env") && !path.includes("main.php")));
});

test("Surveillance Python : plusieurs verrous conservent une applicabilité à confirmer", async () => {
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = '{"example":"test-only"}';
  const target = healthUpdates().runs[0].targets[0], commit = "b".repeat(40);
  const github = async (path: string) => path.includes("/backend?") ? [{ name: "pyproject.toml", type: "file" }, { name: "uv.lock", type: "file" }, { name: "poetry.lock", type: "file" }] : { type: "file", encoding: "base64", content: Buffer.from("version = 1").toString("base64"), size: 11 };
  const result = await scanCurrentDependencies(target, commit, {
    node: (target, commit) => scanCurrentNode(target, commit, { github, scan: async () => [], latest: async () => "1.0.0" }), github,
    scan: async (_files, ecosystem) => { assert.equal(ecosystem, "PyPI"); return { packages: 1, findings: [{ id: "CVE-2026-1111", aliases: [], package: "library", version: "1.0.0", severity: "high" }] }; },
  });
  assert.equal(result.checks[0].findings[0].kind, "unconfirmed");
  assert.equal(result.securityCoverage?.limitations.length, 1);
});

test("Surveillance : absence de verrou ne devient pas une preuve de zéro faille", async () => {
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = '{"example":"test-only"}';
  const target = healthUpdates().runs[0].targets[0], commit = "b".repeat(40);
  const github = async () => [{ name: "composer.json", type: "file" }, { name: "composer.lock", type: "symlink" }];
  await assert.rejects(scanCurrentDependencies(target, commit, {
    node: (target, commit) => scanCurrentNode(target, commit, { github, scan: async () => [], latest: async () => "1.0.0" }), github,
    scan: async () => { throw Error("Ne doit pas analyser un lien"); },
  }), error => error instanceof SourceQualificationError && /verrou résolu/.test(error.message));
});

test("OSV multilangage : isolation, rapport complet et nettoyage même après un échec", async () => {
  let directory = "";
  const files = [{ name: "composer.lock", content: Buffer.from('{"packages":[]}') }];
  const execute: typeof runCommand = async (command, args, options) => {
    assert.equal(command, "osv-scanner"); assert.ok(args.includes("--all-packages"));
    directory = options!.cwd!;
    assert.deepEqual(Object.keys(options!.env!).sort(), ["HOME", "NODE_ENV", "PATH", "TMPDIR"]);
    assert.equal(await readFile(directory + "/composer.lock", "utf8"), '{"packages":[]}');
    return JSON.stringify({ results: [{ source: { path: args.find(arg => arg.startsWith("--lockfile="))!.slice(11) }, packages: [{ package: { name: "vendor/library", version: "1.0.0", ecosystem: "Packagist" }, vulnerabilities: [] }] }] });
  };
  assert.deepEqual(await scanDependencyFiles(files, "Packagist", execute), { findings: [], packages: 1 });
  await assert.rejects(access(directory));
  await assert.rejects(scanDependencyFiles(files, "PyPI", execute), /version résolue/);
  await assert.rejects(access(directory));
  await assert.rejects(scanDependencyFiles(files, "Packagist", async () => '{"results":[]}'), /chaque verrou/);
  await assert.rejects(scanDependencyFiles([{ name: "../composer.lock", content: files[0].content }], "Packagist", execute), /non autorisés/);
});
