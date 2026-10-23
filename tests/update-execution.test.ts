import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { validateUpdate } from "../scripts/validate-update";
import type { MaintenancePayload } from "../src/lib/maintenance-contract";
import { updateStatus } from "../src/components/maintenance-panel";

process.env.VIGIE_MAINTENANCE_GITHUB_TOKEN = "isolated-unit-test-credential";
test("Validation : code isolé, aucun secret transmis au build, refus du build échoué", async () => {
  for (const pnpm of [false, true]) {
    for (const fails of [false, true]) {
      const payload: MaintenancePayload = {
        format: "vigie.maintenance.v1", id: randomUUID(), repository: "team/app", baseBranch: "main",
        baseSha: "a".repeat(40), directory: "", nodeMode: "exact", execute: true,
        operation: { kind: "all", version: "24.2.0", updates: [] },
      };
      const calls: { file: string; args: string[]; env: any }[] = [];
      let source = "";
      const execute = (async (file: string, args: string[], options: any) => {
        calls.push({ file, args, env: options.env });
        if (file === "git" && args.includes("checkout")) {
          source = args[1];
          await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { build: "untrusted-project-code" }, ...(pnpm ? { packageManager: "pnpm@10.10.0" } : {}) }));
        }
        if (file === "docker" && args[0] === "run") {
          assert.ok(!JSON.stringify(options.env).includes("isolated-unit-test-credential"));
          assert.ok(!JSON.stringify(args).includes("isolated-unit-test-credential"));
          assert.ok(args.includes("--cap-drop=ALL"));
          assert.ok(!args.some((argument) => argument.includes("docker.sock")));
          if (args.at(-1) === "build") {
            assert.ok(args.includes("--network=none"));
            assert.ok(args.includes("--read-only"));
            if (fails) throw new Error("private diagnostic must not leak");
          }
        }
        return { stdout: "", stderr: "" };
      }) as unknown as NonNullable<Parameters<typeof validateUpdate>[2]>;
      if (fails) await assert.rejects(validateUpdate(payload, "b".repeat(40), execute), /build isolé échoué/);
      else await validateUpdate(payload, "b".repeat(40), execute);
      assert.ok(calls.some((call) => call.args.includes("--ignore-scripts")));
      assert.ok(calls.some((call) => call.args.at(-1) === "build"));
      await assert.rejects(access(source));
    }
  }
});

test("Docker Linux : installation et build réels du candidat sans publication", { skip: process.env.GITHUB_ACTIONS !== "true", timeout: 300_000 }, async () => {
  const realCommand = promisify(execFile);
  const payload: MaintenancePayload = {
    format: "vigie.maintenance.v1", id: randomUUID(), repository: "team/app", baseBranch: "main",
    baseSha: "a".repeat(40), directory: "", nodeMode: "exact", execute: true,
    operation: { kind: "all", version: "24.14.0", updates: [] },
  };
  let built = false;
  const execute = (async (file: string, args: string[], options: any) => {
    if (file === "git") {
      if (args.includes("checkout")) {
        const source = args[1];
        await writeFile(join(source, "package.json"), JSON.stringify({ name: "vigie-build-fixture", version: "1.0.0", scripts: { build: 'node -e "if(process.version!==\'v24.14.0\')process.exit(1)"' } }));
        await writeFile(join(source, "package-lock.json"), JSON.stringify({ name: "vigie-build-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "vigie-build-fixture", version: "1.0.0" } } }));
      }
      return { stdout: "", stderr: "" };
    }
    const result = await realCommand(file, args, options);
    if (args.at(-1) === "build") built = true;
    return result;
  }) as unknown as NonNullable<Parameters<typeof validateUpdate>[2]>;
  await validateUpdate(payload, "b".repeat(40), execute);
  assert.equal(built, true);
});

test("Statut : publication et déploiement observé ne sont pas confondus", () => {
  assert.equal(updateStatus({ status: "queued" } as any), "Mise à jour en cours");
  assert.equal(updateStatus({ status: "merged", deployment: "not-verified" } as any), "Déploiement en cours");
  assert.equal(updateStatus({ status: "merged", deployment: "observed" } as any), "Mise à jour déployée");
});
