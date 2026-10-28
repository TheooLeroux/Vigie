import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { scanCurrentNode } from "../src/lib/updates/node-monitor";
import { healthUpdates } from "./project-health-fixture";
import { repositoryAllowed } from "../src/lib/updates/github";

test("Sonde Node : analyse en lecture seule du commit déployé, sans exécuter ses scripts", async () => {
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = '{"example":"unit-test-token"}';
  process.env.VIGIE_UPDATES_REPOSITORIES = "example/app";
  const target = healthUpdates().runs[0].targets[0], commit = "b".repeat(40);
  const calls: string[] = [], scanned: string[] = [];
  const manifest = JSON.stringify({ dependencies: { library: "^1.0.0" }, scripts: { postinstall: "must never run" } });
  const lock = JSON.stringify({ lockfileVersion: 3 });
  let folder = "";
  const dependencies = {
    github: async (path: string, _token: string, method = "GET") => {
      assert.equal(method, "GET"); assert.ok(path.endsWith(`?ref=${commit}`)); calls.push(path);
      if (path.includes(`/backend/?ref=`)) return [{ name: "package.json", type: "file" }, { name: "package-lock.json", type: "file" }];
      const content = path.includes("/package.json?") ? manifest : lock;
      return { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) };
    },
    scan: (async (directory, roots, names, _execute, inventory) => {
      folder = directory; scanned.push(directory);
      assert.deepEqual(roots, [""]); assert.deepEqual(names, ["package.json", "package-lock.json"]);
      assert.equal(await readFile(directory + "/package.json", "utf8"), manifest);
      await inventory?.(["library"], [{ name: "library", version: "1.0.0" }]);
      return [{ id: "CVE-fixture", aliases: [], package: "library", version: "1.0.0", severity: "high" as const, scope: "" }];
    }) as NonNullable<Parameters<typeof scanCurrentNode>[2]>["scan"],
    latest: async () => "2.0.0",
  };
  const result = await scanCurrentNode(target, commit, dependencies);
  assert.equal(calls.length, 3); assert.equal(scanned.length, 1);
  assert.equal(result.checks[0].findings[0].scope, "backend");
  assert.match(result.updates[0], /1.0.0 → 2.0.0/);
  await assert.rejects(access(folder), "les sources temporaires sont supprimées");
  process.env.VIGIE_UPDATES_REPOSITORIES = "";
  await scanCurrentNode(target, commit, dependencies);
  assert.equal(repositoryAllowed(target.repository!), false, "la surveillance en lecture n’accorde aucun droit de publication au dépôt");
  calls.length = 0;
  await assert.rejects(scanCurrentNode(target, null, dependencies), /commit réellement déployé/);
  assert.deepEqual(calls, [], "aucun recours à la tête de branche");
  await assert.rejects(scanCurrentNode({ ...target, root: "../escape" }, commit, dependencies), /Répertoire source invalide/);
  await assert.rejects(scanCurrentNode({ ...target, repository: "example/../escape" }, commit, dependencies), /accès GitHub en lecture/);
  await assert.rejects(scanCurrentNode({ ...target, mode: "archive", repository: null }, commit, dependencies), /ne sont pas reliées/);
  await assert.rejects(scanCurrentNode(target, commit, { ...dependencies, github: async () => [{ name: "package.json", type: "file" }, { name: "package-lock.json", type: "symlink" }] }), /verrou absent/);
});
