import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { workspaceLockCovers } from "../src/lib/updates/workspace-monitor";
import { scanCurrentNode } from "../src/lib/updates/node-monitor";
import { healthUpdates } from "./project-health-fixture";

const manifest = { dependencies: { fastify: "^5.0.0" } };
const pnpm = "lockfileVersion: '9.0'\nimporters:\n  apps/api:\n    dependencies:\n      fastify:\n        specifier: ^5.0.0\n        version: 5.0.0\n";
test("Workspace : le verrou doit couvrir le bon service et ses contraintes exactes", () => {
  assert.equal(workspaceLockCovers("pnpm-lock.yaml", pnpm, "apps/api", manifest), true);
  assert.equal(workspaceLockCovers("pnpm-lock.yaml", pnpm, "apps/other", manifest), false);
  assert.equal(workspaceLockCovers("pnpm-lock.yaml", pnpm, "apps/api", {dependencies:{fastify:"^6.0.0"}}), false);
  const npm = JSON.stringify({packages:{"apps/api":manifest}});
  assert.equal(workspaceLockCovers("package-lock.json", npm, "apps/api", manifest), true);
  assert.equal(workspaceLockCovers("package-lock.json", npm, "apps/other", manifest), false);
  assert.equal(workspaceLockCovers("yarn.lock", "", "apps/api", manifest, {workspaces:["apps/*"]}), true);
  assert.equal(workspaceLockCovers("yarn.lock", "", "apps/api", manifest, {workspaces:["unrelated/*"]}), false);
  assert.equal(workspaceLockCovers("pnpm-lock.yaml", "invalid: [", "apps/api", manifest), false);
});

test("Sonde : remonter au verrou parent vérifié du même commit sans attribuer toutes les alertes au seul service", async () => {
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = '{"example":"test-only"}';
  const target = {...healthUpdates().runs[0].targets[0], root:"apps/api"}, commit = "b".repeat(40);
  const calls: string[] = [];
  const rawManifest = JSON.stringify(manifest);
  const result = await scanCurrentNode(target, commit, {
    github: async path => {
      calls.push(path); assert.ok(path.endsWith(`?ref=${commit}`));
      const name = new URL("https://api.github.com"+path).pathname;
      if (name.endsWith("/contents/apps/api")) return [{name:"package.json",type:"file"}];
      if (name.endsWith("/contents/apps")) return [];
      if (name.endsWith("/contents/")) return [{name:"package.json",type:"file"},{name:"pnpm-lock.yaml",type:"file"}];
      const content = name.endsWith("package.json") ? rawManifest : pnpm;
      return {type:"file",encoding:"base64",size:Buffer.byteLength(content),content:Buffer.from(content).toString("base64")};
    },
    scan: async (folder, _roots, names) => {
      assert.deepEqual(names,["package.json","pnpm-lock.yaml"]);
      assert.equal(await readFile(folder+"/pnpm-lock.yaml","utf8"),pnpm);
      return [{id:"CVE-fixture",aliases:[],package:"fastify",version:"5.0.0",severity:"high",scope:""}];
    },
    latest: async () => {throw Error("Le contrôle du verrou partagé ne doit pas inventer les versions du service.");},
  });
  assert.equal(result.checks[0].findings[0].kind,"unconfirmed");
  assert.match(result.checks[0].scope,/Verrou partagé/);
  assert.ok(result.warnings.some(warning=>warning.includes("d’autres services")));
  assert.deepEqual(result.updates,[]);
  assert.ok(calls.some(path=>path.includes("/contents/?ref=")));
});
