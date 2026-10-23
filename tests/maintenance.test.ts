import { authFixture } from "./auth-fixture";
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GET, POST } from "../src/app/api/[...path]/route";
import { createProject, database, list, save } from "../src/lib/db";
import { createProjectSchema } from "../src/lib/validation";
import {
  applyVercelSnapshot,
  linkVercelProject,
  saveVercelConnection,
} from "../src/lib/vercel";
import type { VercelProject } from "../src/lib/vercel-types";
import { GitHubMaintenanceClient } from "../src/lib/connectors/github-maintenance";
import {
  approveMaintenance,
  closeMaintenance,
  createMaintenancePlan,
  inspectMaintenance,
  updateLatestMaintenance,
  maintenanceState,
  mergeMaintenance,
  refreshMaintenance,
} from "../src/lib/maintenance";
import {
  dependencyBlocker,
  nodeFileChanges,
  parseWorkspace,
  readMaintenanceFiles,
  updateManifest,
} from "../src/lib/maintenance-files";
import {
  maintenanceBranch,
  operationSchema,
  safeBranch,
  safeDirectory,
  workerPayloadSchema,
  type MaintenancePayload,
} from "../src/lib/maintenance-contract";
import { maintenanceToken } from "../src/lib/maintenance-credentials";
import {
  assertPublicDependencies,
  assertPublicLock,
  regenerateDependencies,
  rollbackTree,
  runMaintenanceWorker,
} from "../scripts/maintenance-worker";

process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.VIGIE_MAINTENANCE_GITHUB_TOKEN = "private-github-unit-test";
process.env.VIGIE_MAINTENANCE_REPOSITORIES = "team/app";
process.env.VIGIE_MAINTENANCE_RUNNER_REPOSITORY = "team/runner";
process.env.VIGIE_MAINTENANCE_ALLOW_MERGE = "true";
process.env.VIGIE_MAINTENANCE_REQUIRED_CHECKS = '{"team/app":["CI-0"]}';
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const manifest = {
  name: "fixture",
  engines: { node: "20.x" },
  dependencies: { react: "^19.0.0" },
  scripts: { postinstall: "must-never-run" },
};
function payload(): MaintenancePayload {
  return {
    format: "vigie.maintenance.v1",
    id: randomUUID(),
    repository: "team/app",
    baseBranch: "main",
    baseSha,
    directory: "",
    nodeMode: "major",
    operation: { kind: "node", version: "24.2.0" },
  };
}
function fakeGitHub(
  options: {
    stale?: boolean;
    checks?: string[];
    modified?: boolean;
    failDispatch?: boolean;
    rejectDispatch?: boolean;
    extraFile?: boolean;
    run?: string;
    mergePending?: boolean;
    manager?: "npm" | "pnpm";
    manifest?: Record<string, any>;
  } = {},
) {
  const calls: {
    path: string;
    method: string;
    body: any;
    authorization: string | null;
  }[] = [];
  const packageManifest =
    options.manager === "pnpm"
      ? { ...manifest, packageManager: "pnpm@10.10.0" }
      : options.manifest || manifest;
  const lockfile =
    options.manager === "pnpm"
      ? "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^19.0.0\n        version: 19.0.0\n"
      : JSON.stringify({
          name: "fixture",
          lockfileVersion: 3,
          packages: {
            "": {
              engines: packageManifest.engines,
              dependencies: packageManifest.dependencies,
            },
            "node_modules/react": {
              version: "19.0.0",
              resolved: "https://registry.npmjs.org/react/-/react-19.0.0.tgz",
            },
          },
        });
  const fileNames = [
    "package.json",
    options.manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json",
  ];
  const contents = [JSON.stringify(packageManifest, null, 2) + "\n", lockfile];
  const blobHashes = ["d".repeat(40), "e".repeat(40)];
  let jobId = "";
  let pull: any = null;
  let merged = false;
  const transport = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path,
      method,
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.hostname === "nodejs.org")
      return Response.json([
        {
          version: "v24.2.0",
          date: "2025-11-01",
          lts: "Krypton",
          security: false,
        },
        { version: "v22.2.0", date: "2025-11-01", lts: "Jod", security: false },
      ]);
    if (url.hostname === "raw.githubusercontent.com")
      return Response.json({
        v24: { start: "2025-01-01", lts: "2025-10-01", end: "2028-04-30" },
        v22: { start: "2024-01-01", lts: "2024-10-01", end: "2027-04-30" },
      });
    if (url.hostname === "registry.npmjs.org")
      return Response.json({
        name: "react",
        version: "19.1.0",
        engines: { node: ">=18" },
      });
    assert.equal(url.hostname, "api.github.com");
    if (path === `/repos/team/app/git/commits/${baseSha}`)
      return Response.json({
        sha: baseSha,
        tree: { sha: "f".repeat(40) },
        parents: [],
      });
    if (path === "/repos/team/app/commits/main")
      return Response.json({ sha: options.stale ? headSha : baseSha });
    if (path.includes("/git/trees/") && method === "GET")
      return Response.json({
        tree: fileNames.map((path, index) => ({
          path,
          sha: blobHashes[index],
          type: "blob",
          mode: "100644",
          size: contents[index].length,
        })),
        truncated: false,
      });
    const blobIndex = blobHashes.findIndex(
      (hash) => path === `/repos/team/app/git/blobs/${hash}`,
    );
    if (blobIndex !== -1)
      return Response.json({
        encoding: "base64",
        content: Buffer.from(contents[blobIndex]).toString("base64"),
      });
    if (path === "/repos/team/runner/actions/workflows/vigie-maintenance.yml")
      return Response.json({
        state: "active",
        path: ".github/workflows/vigie-maintenance.yml",
      });
    if (path.endsWith("/dispatches")) {
      if (options.rejectDispatch)
        return Response.json(
          { message: "private refusal details" },
          { status: 403 },
        );
      jobId = JSON.parse(body.inputs.job).id;
      if (options.failDispatch)
        throw new Error("private-token-must-not-appear");
      return new Response(null, { status: 204 });
    }
    if (path.includes("/actions/workflows/vigie-maintenance.yml/runs?"))
      return Response.json({
        workflow_runs: jobId
          ? [
              {
                id: 123,
                display_title: `vigie-maintenance-${jobId}`,
                status: options.run || "completed",
                conclusion: "success",
              },
            ]
          : [],
      });
    if (path === "/repos/team/runner/actions/runs/123")
      return Response.json({
        id: 123,
        display_title: `vigie-maintenance-${jobId}`,
        status: options.run || "completed",
        conclusion: "success",
      });
    if (path.includes("/pulls?")) return Response.json(pull ? [pull] : []);
    if (path === "/repos/team/app/git/trees" && method === "POST")
      return Response.json({ sha: "f".repeat(40) });
    if (path === "/repos/team/app/git/commits" && method === "POST")
      return Response.json({ sha: headSha });
    if (path.includes("/git/ref/heads/"))
      return new Response(null, { status: 404 });
    if (path === "/repos/team/app/git/refs")
      return Response.json({ ref: body.ref });
    if (path === "/repos/team/app/git/refs/heads/main" && method === "PATCH")
      return Response.json({ object: { sha: body.sha } });
    if (path === "/repos/team/app/pulls" && method === "POST") {
      jobId = body.head.split("/").at(-1);
      pull = {
        number: 7,
        body: body.body,
        state: "open",
        merged: false,
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
        changed_files: 2,
        base: { ref: body.base },
        head: { ref: body.head, sha: headSha, repo: { full_name: "team/app" } },
      };
      return Response.json(pull);
    }
    if (path === "/repos/team/app/pulls/7" && method === "GET")
      return Response.json({
        ...pull,
        merged,
        merge_commit_sha: mergeSha,
        head: { ...pull.head, sha: options.modified ? mergeSha : headSha },
      });
    if (path === "/repos/team/app/pulls/7/files?per_page=100")
      return Response.json([
        ...fileNames.map((filename) => ({ filename, status: "modified" })),
        ...(options.extraFile
          ? [{ filename: ".github/workflows/pwn.yml", status: "modified" }]
          : []),
      ]);
    if (path === `/repos/team/app/git/commits/${headSha}`)
      return Response.json({
        parents: [{ sha: baseSha }],
        message: `Vigie maintenance job ${jobId}`,
      });
    if (path.includes("/check-runs?"))
      return Response.json({
        total_count: (options.checks || ["success"]).length,
        check_runs: (options.checks || ["success"]).map(
          (conclusion, index) => ({
            name: `CI-${index}`,
            status: "completed",
            conclusion,
          }),
        ),
      });
    if (path.endsWith("/status?per_page=100"))
      return Response.json({ total_count: 0, statuses: [] });
    if (path === "/repos/team/app/pulls/7/merge-async") {
      if (options.mergePending)
        return Response.json(
          {
            status: "pending",
            details: { uuid: "79faccc2-7a7e-4cb5-b462-9600048e3651" },
          },
          { status: 202 },
        );
      merged = true;
      return Response.json({ status: "merged", details: { sha: mergeSha } });
    }
    if (path.includes("/merge-async/"))
      return Response.json({ status: "pending" });
    if (path === "/repos/team/app/pulls/7" && method === "PATCH") {
      pull.state = "closed";
      return Response.json(pull);
    }
    throw new Error(`Appel non prévu : ${method} ${path}`);
  }) as typeof fetch;
  return {
    transport,
    calls,
    completeMerge: () => {
      merged = true;
    },
  };
}
async function fixtureTarget() {
  const project = await createProject(
    "live",
    createProjectSchema.parse({ name: `Maintenance ${randomUUID()}` }),
  );
  const connection = await saveVercelConnection({
    name: "Test maintenance",
    teamId: `team_${randomUUID().replaceAll("-", "")}`,
    secret: "test-vercel-no-network",
  });
  const remote: VercelProject = {
    id: `prj_${randomUUID().replaceAll("-", "")}`,
    name: project.name,
    teamId: connection.teamId,
    teamSlug: "team",
    teamName: "Team",
    framework: "nextjs",
    nodeBranch: "20.x",
    rootDirectory: null,
    repository: "team/app",
    productionBranch: "main",
    domains: [],
    production: {
      id: "dpl_fixture",
      url: null,
      state: "READY",
      target: "production",
      createdAt: new Date().toISOString(),
      framework: "nextjs",
      nodeBranch: "20.x",
      repository: "team/app",
      branch: "main",
      commit: baseSha,
      regions: [],
    },
    latest: null,
    excluded: false,
    clientSuggestion: null,
  };
  await applyVercelSnapshot(connection.id, [remote]);
  await linkVercelProject(connection.id, remote.id, project.id);
  return `vercel:${connection.id}:${remote.id}`;
}
async function planned(targetId: string, fake: ReturnType<typeof fakeGitHub>) {
  return createMaintenancePlan(
    { targetId, operation: { kind: "node", version: "24.2.0" } },
    fake.transport,
  );
}

test("Contrat de maintenance : dépôts, chemins, branches et opérations fermées", () => {
  assert.equal(safeDirectory("/apps/web/"), "apps/web");
  for (const path of [
    "../web",
    "apps/../../secret",
    "C:\\temp",
    "apps/.git",
    ".github",
  ])
    assert.throws(() => safeDirectory(path));
  for (const branch of ["../main", "main..next", "main.lock", "main;pwd"])
    assert.throws(() => safeBranch(branch));
  assert.equal(workerPayloadSchema.parse(payload()).repository, "team/app");
  assert.throws(() =>
    workerPayloadSchema.parse({ ...payload(), command: "arbitrary shell" }),
  );
  assert.throws(() =>
    operationSchema.parse({
      kind: "dependencies",
      updates: [{ name: "react", version: "latest" }],
    }),
  );
  assert.throws(() =>
    operationSchema.parse({ kind: "node", version: "24.2.0", shell: "echo" }),
  );
});
test("Manifestes : champs conservés, composants existants, doublons et liens internes", () => {
  const updated = updateManifest(manifest, { kind: "node", version: "24.2.0" });
  assert.equal(updated.engines.node, "24.x");
  assert.deepEqual(updated.dependencies, manifest.dependencies);
  assert.deepEqual(updated.scripts, manifest.scripts);
  assert.throws(
    () =>
      updateManifest(manifest, {
        kind: "dependencies",
        updates: [{ name: "absent", version: "1.0.0" }],
      }),
    /absent/,
  );
  assert.throws(
    () =>
      updateManifest(manifest, {
        kind: "dependencies",
        updates: [
          { name: "react", version: "19.1.0" },
          { name: "react", version: "19.1.0" },
        ],
      }),
    /plusieurs/,
  );
  assert.throws(
    () =>
      updateManifest(
        { dependencies: { internal: "workspace:*" } },
        {
          kind: "dependencies",
          updates: [{ name: "internal", version: "1.0.0" }],
        },
      ),
    /workspace/,
  );
});

test("Plan groupé : Node et dépendances appliqués ensemble sans toucher aux scripts", () => {
  const updated = updateManifest(manifest, {
    kind: "all", version: "24.2.0", updates: [{ name: "react", version: "19.1.0" }],
  }, "exact");
  assert.equal(updated.engines.node, "24.2.0");
  assert.equal(updated.dependencies.react, "19.1.0");
  assert.deepEqual(updated.scripts, manifest.scripts);
  assert.equal(manifest.engines.node, "20.x");
  assert.throws(() => operationSchema.parse({
    kind: "all", version: "24.2.0", updates: [{ name: "react", version: "latest" }],
  }));
});
test("Node : modifications cohérentes package.json/lockfile et aucun script applicatif", async () => {
  const fake = fakeGitHub();
  const client = new GitHubMaintenanceClient("test", fake.transport);
  const snapshot = await readMaintenanceFiles(client, "team/app", baseSha, "");
  const changed = nodeFileChanges(snapshot, "24.2.0");
  assert.deepEqual([...changed.keys()].sort(), [
    "package-lock.json",
    "package.json",
  ]);
  assert.equal(
    JSON.parse(changed.get("package-lock.json")!).packages[""].engines.node,
    "24.x",
  );
  assert.equal(
    JSON.parse(changed.get("package.json")!).scripts.postinstall,
    "must-never-run",
  );
  assert.equal(dependencyBlocker(snapshot), null);
});
test("Sources de résolution : registres et protocoles externes refusés, workspace borné", () => {
  assertPublicDependencies({
    dependencies: {
      public: "^1.0.0",
      internal: "workspace:*",
      shared: "catalog:",
    },
  });
  for (const version of [
    "https://evil.test/a.tgz",
    "file:../../secret",
    "git+ssh://host/repo",
    "npm:another@1.0.0",
  ])
    assert.throws(() =>
      assertPublicDependencies({ dependencies: { pkg: version } }),
    );
  assertPublicLock(JSON.stringify({ lockfileVersion: 3, packages: {} }), "npm");
  assertPublicLock(
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/pkg": {
          version: "1.0.0",
          funding: { url: "https://github.com/sponsors/example" },
        },
      },
    }),
    "npm",
  );
  assertPublicLock(
    "lockfileVersion: '9.0'\nimporters:\n  apps/web:\n    dependencies:\n      core:\n        version: link:../../packages/core\n",
    "pnpm",
    new Set(["packages/core/package.json"]),
  );
  assert.throws(
    () =>
      assertPublicLock(
        "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      core:\n        version: link:../../outside\n",
        "pnpm",
      ),
    /hors/,
  );
  assert.throws(
    () =>
      assertPublicLock(
        JSON.stringify({
          lockfileVersion: 3,
          resolved: "https://registry.npmjs.org.evil.test/a",
        }),
        "npm",
      ),
    /registre/,
  );
  assert.throws(
    () => parseWorkspace("packages:\n  - ../../outside\n"),
    /périmètre/,
  );
  assert.throws(
    () => parseWorkspace("packages: ['apps/*']\npnpmfile: ../../hook.js\n"),
    /spécifique/,
  );
});
test("Client GitHub : pas de redirection ni de fuite du message brut ou du secret", async () => {
  const client = new GitHubMaintenanceClient("secret", (async (
    _url,
    options,
  ) => {
    assert.equal(options?.redirect, "error");
    return Response.json({ message: "raw-secret" }, { status: 403 });
  }) as typeof fetch);
  await assert.rejects(
    client.request("/repos/team/app"),
    (error) =>
      error instanceof Error &&
      !error.message.includes("raw-secret") &&
      !error.message.includes("secret"),
  );
  await assert.rejects(client.request("https://evil.test"), /autorisé/);
});
test("Exécuteur Node : branche dédiée et PR, aucun push main, répétition idempotente", async () => {
  const fake = fakeGitHub();
  const request = payload();
  const client = new GitHubMaintenanceClient("secret", fake.transport);
  assert.deepEqual(await runMaintenanceWorker(request, client, ["team/app"]), {
    pullNumber: 7,
  });
  const writes = fake.calls.filter((call) => call.method !== "GET");
  assert.equal(writes.filter((call) => call.path.endsWith("/pulls")).length, 1);
  assert.equal(
    writes.find((call) => call.path.endsWith("/git/refs"))?.body.ref,
    `refs/heads/${maintenanceBranch(request.id)}`,
  );
  assert.ok(
    !writes.some(
      (call) => call.method === "PATCH" || call.path.includes("/merge"),
    ),
  );
  await runMaintenanceWorker(request, client, ["team/app"]);
  assert.equal(
    fake.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/pulls"),
    ).length,
    1,
  );
});
test("Exécuteur : liste autorisée et branche devenue obsolète bloquent les écritures", async () => {
  const request = payload();
  const fake = fakeGitHub({ stale: true });
  const client = new GitHubMaintenanceClient("secret", fake.transport);
  await assert.rejects(runMaintenanceWorker(request, client, []), /autorisé/);
  await assert.rejects(
    runMaintenanceWorker(request, client, ["team/app"]),
    /changé/,
  );
  assert.ok(fake.calls.every((call) => call.method === "GET"));
});

test("Exécution : publier après build, sans PR ni contournement des protections", async () => {
  for (const fails of [false, true]) {
    const fake = fakeGitHub();
    const input: MaintenancePayload = { ...payload(), execute: true, operation: {
      kind: "all", version: "24.2.0", updates: [{ name: "react", version: "19.1.0" }],
    } };
    let validated = false;
    const run = () => runMaintenanceWorker(input, new GitHubMaintenanceClient("secret", fake.transport), ["team/app"], async () => {
      assert.ok(!fake.calls.some((call) => call.method === "PATCH"));
      if (fails) throw new Error("Build échoué");
      validated = true;
    }, async () => new Map([["package.json", JSON.stringify(updateManifest(manifest, input.operation))]]));
    if (fails) await assert.rejects(run(), /Build échoué/);
    else assert.deepEqual(await run(), { commitSha: headSha });
    const publications = fake.calls.filter((call) => call.method === "PATCH");
    assert.equal(publications.length, validated ? 1 : 0);
    if (validated) assert.deepEqual(publications[0].body, { sha: headSha, force: false });
    assert.ok(!fake.calls.some((call) => call.method === "POST" && call.path.endsWith("/pulls")));
  }
});

test("Exécution : remplacer l’ancienne PR et libérer son verrou sans fusion", async () => {
  const targetId = await fixtureTarget();
  const fake = fakeGitHub();
  const old = await planned(targetId, fake);
  await approveMaintenance(old.id, { approved: true }, fake.transport);
  await runMaintenanceWorker(old.payload, new GitHubMaintenanceClient("secret", fake.transport), ["team/app"]);
  await refreshMaintenance(old.id, fake.transport);
  const execution = await updateLatestMaintenance({ targetId, approved: true, execute: true }, fake.transport);
  assert.equal(execution.job?.payload.execute, true);
  assert.equal(execution.job?.status, "queued");
  assert.ok(fake.calls.some((call) => call.path.endsWith("/pulls/7") && call.method === "PATCH" && call.body.state === "closed"));
  assert.ok(!fake.calls.some((call) => call.path.includes("/merge")));
  await database().prepare("DELETE FROM maintenance_locks WHERE job_id=?").run(execution.job!.id);
});
test("Résolution npm/pnpm : mises à jour individuelles et groupées, sans scripts ni secrets", async () => {
  for (const { manager, kind } of (["npm", "pnpm"] as const).flatMap((manager) =>
    (["dependencies", "all"] as const).map((kind) => ({ manager, kind })),
  )) {
    const fake = fakeGitHub({ manager });
    const client = new GitHubMaintenanceClient("secret", fake.transport);
    const snapshot = await readMaintenanceFiles(
      client,
      "team/app",
      baseSha,
      "",
    );
    const commands: any[] = [];
    if (kind === "all") {
      snapshot.files.set(".nvmrc", "20.0.0\n");
      snapshot.files.set(".node-version", "20.0.0\n");
    }
    const command = (async (file: string, args: string[], options: any) => {
      commands.push({ file, args, options });
      assert.equal(options.env.npm_config_ignore_scripts, "true");
      assert.ok(
        !JSON.stringify(options.env).includes("private-github-unit-test"),
      );
      assert.ok(args.includes("--ignore-scripts"));
      if (options.cwd) {
        const manifest = JSON.parse(
          await readFile(join(options.cwd, "package.json"), "utf8"),
        );
        assert.equal(manifest.dependencies.react, "19.1.0");
        assert.equal(manifest.engines.node, kind === "all" ? "24.2.0" : "20.x");
        await writeFile(
          join(
            options.cwd,
            manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
          ),
          manager === "npm"
            ? JSON.stringify({
                lockfileVersion: 3,
                packages: { "": { dependencies: manifest.dependencies, engines: manifest.engines } },
              })
            : "lockfileVersion: '9.0'\nimporters: {}\n",
        );
      }
      return { stdout: "", stderr: "" };
    }) as unknown as Parameters<typeof regenerateDependencies>[3];
    const changed = await regenerateDependencies(
      client,
      {
        ...payload(),
        nodeMode: "exact",
        operation: kind === "all" ? {
          kind, version: "24.2.0",
          updates: [{ name: "react", version: "19.1.0" }],
        } : {
          kind,
          updates: [{ name: "react", version: "19.1.0" }],
        },
      },
      snapshot,
      command,
    );
    assert.equal(changed.size, kind === "all" ? 4 : 2);
    if (kind === "all") {
      assert.equal(changed.get(".nvmrc"), "24.2.0\n");
      assert.equal(changed.get(".node-version"), "24.2.0\n");
      assert.equal(JSON.parse(changed.get("package.json")!).engines.node, "24.2.0");
    }
    assert.ok(commands.length >= 1);
    if (manager === "pnpm")
      assert.ok(commands.at(-1).args.includes("--ignore-pnpmfile"));
  }
});
test("API maintenance : authentification, démo et CSRF restent obligatoires", async () => {
  const path = ["maintenance"];
  const anonymous = await GET(
    new Request("http://127.0.0.1:3001/api/maintenance"),
    { params: Promise.resolve({ path }) },
  );
  assert.equal(anonymous.status, 401);
  const { cookie } = await authFixture();
  const demo = await GET(
    new Request("http://127.0.0.1:3001/api/maintenance?workspace=demo", {
      headers: { cookie },
    }),
    { params: Promise.resolve({ path }) },
  );
  assert.equal(demo.status, 400);
  const csrf = await POST(
    new Request("http://127.0.0.1:3001/api/maintenance/plans", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.test",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { params: Promise.resolve({ path: ["maintenance", "plans"] }) },
  );
  assert.equal(csrf.status, 403);
  const latestPath = { params: Promise.resolve({ path: ["maintenance", "latest"] }) };
  const latestBody = JSON.stringify({ targetId: "untrusted", approved: true });
  const unauthenticatedLatest = await POST(new Request("http://127.0.0.1:3001/api/maintenance/latest", {
    method: "POST", headers: { "content-type": "application/json" }, body: latestBody,
  }), latestPath);
  assert.equal(unauthenticatedLatest.status, 401);
  const crossSiteLatest = await POST(new Request("http://127.0.0.1:3001/api/maintenance/latest", {
    method: "POST", headers: { cookie, origin: "https://evil.test", "content-type": "application/json" }, body: latestBody,
  }), latestPath);
  assert.equal(crossSiteLatest.status, 403);
});
test("Un clic : une préparation Node et dépendances, sans fusion ni double dispatch", async () => {
  const fake = fakeGitHub();
  const targetId = await fixtureTarget();
  await assert.rejects(updateLatestMaintenance({ targetId }, fake.transport));
  const result = await updateLatestMaintenance({ targetId, approved: true }, fake.transport);
  assert.equal(result.current, false);
  assert.equal(result.job?.status, "queued");
  assert.deepEqual(result.job?.payload.operation, {
    kind: "all", version: "24.2.0", updates: [{ name: "react", version: "19.1.0" }],
  });
  assert.deepEqual(result.job?.files.sort(), ["package-lock.json", "package.json"]);
  const repeated = await updateLatestMaintenance({ targetId, approved: true }, fake.transport);
  assert.equal(repeated.job?.id, result.job?.id);
  assert.equal(repeated.existing, true);
  const otherTarget = await fixtureTarget();
  await assert.rejects(updateLatestMaintenance({ targetId: otherTarget, approved: true }, fake.transport), /autre service/);
  assert.equal(fake.calls.filter((call) => call.path.endsWith("/dispatches")).length, 1);
  assert.ok(!fake.calls.some((call) => call.path.includes("/merge")));
  assert.ok(fake.calls.filter((call) => call.path.includes("/react/")).every((call) => !call.authorization));
  await database().prepare("DELETE FROM maintenance_locks WHERE job_id=?").run(result.job!.id);
});

test("Un clic : déjà à jour ou registre invalide, aucun dispatch", async () => {
  const targetId = await fixtureTarget();
  const current = fakeGitHub({ manifest: {
    ...manifest, engines: { node: "24.x" }, dependencies: { react: "19.1.0" },
  } });
  const result = await updateLatestMaintenance({ targetId, approved: true }, current.transport);
  assert.equal(result.current, true);
  assert.equal(result.job, null);
  assert.ok(!current.calls.some((call) => call.method !== "GET"));
  for (const invalid of ["20.0.0-beta.1", "19.1.0"]) {
    const fake = fakeGitHub();
    const invalidRegistry = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).hostname === "registry.npmjs.org")
        return Response.json({ name: "react", version: invalid, deprecated: invalid === "19.1.0" });
      return fake.transport(input, init);
    }) as typeof fetch;
    await assert.rejects(updateLatestMaintenance({ targetId, approved: true }, invalidRegistry), /stable, dépréciée/);
    assert.ok(!fake.calls.some((call) => call.method !== "GET"));
  }
});

test("Un clic : aucune rétrogradation des déclarations Node exactes", async () => {
  const targetId = await fixtureTarget();
  for (const fields of [
    { engines: { node: "24.99.0" } },
    { volta: { node: "24.99.0" } },
    { devEngines: { runtime: { name: "node", version: "24.99.0" } } },
    { devEngines: { runtime: [{ name: "node", version: "24.99.0" }] } },
  ]) {
    const fake = fakeGitHub({ manifest: { ...manifest, ...fields } });
    await assert.rejects(updateLatestMaintenance({ targetId, approved: true }, fake.transport), /antérieure/);
    assert.ok(!fake.calls.some((call) => call.method !== "GET"));
  }
});

test("Plans : source attestée, cible supportée, approbation explicite et verrou par dépôt", async () => {
  const fake = fakeGitHub();
  const targetId = await fixtureTarget();
  const inspection = await inspectMaintenance(targetId, fake.transport);
  assert.ok(inspection.nodeVersions.includes("24.2.0"));
  const first = await planned(targetId, fake);
  const second = await planned(targetId, fake);
  await assert.rejects(
    approveMaintenance(first.id, { approved: false }, fake.transport),
  );
  await approveMaintenance(first.id, { approved: true }, fake.transport);
  await approveMaintenance(first.id, { approved: true }, fake.transport);
  assert.equal(
    fake.calls.filter((call) => call.path.endsWith("/dispatches")).length,
    1,
  );
  await assert.rejects(
    approveMaintenance(second.id, { approved: true }, fake.transport),
    /déjà en cours/,
  );
  await database()
    .prepare("DELETE FROM maintenance_locks WHERE job_id=?")
    .run(first.id);
});
test("Plan obsolète ou expiré : aucun dispatch", async () => {
  const fake = fakeGitHub();
  const targetId = await fixtureTarget();
  const job = await planned(targetId, fake);
  await assert.rejects(
    approveMaintenance(
      job.id,
      { approved: true },
      fakeGitHub({ stale: true }).transport,
    ),
    /changé/,
  );
  await database()
    .prepare("UPDATE maintenance_jobs SET data=? WHERE id=?")
    .run(JSON.stringify({ ...job, expiresAt: "2020-01-01T00:00:00Z" }), job.id);
  await assert.rejects(
    approveMaintenance(job.id, { approved: true }, fake.transport),
    /expiré/,
  );
  assert.ok(!fake.calls.some((call) => call.path.endsWith("/dispatches")));
});
test("Envoi incertain : verrou conservé et message sans secret", async () => {
  const fake = fakeGitHub({ failDispatch: true });
  const job = await planned(await fixtureTarget(), fake);
  const result = await approveMaintenance(
    job.id,
    { approved: true },
    fake.transport,
  );
  assert.equal(result.status, "dispatching");
  assert.ok(!JSON.stringify(result).includes("private-token"));
  assert.ok(
    await database()
      .prepare("SELECT job_id FROM maintenance_locks WHERE job_id=?")
      .get(job.id),
  );
  await database()
    .prepare("DELETE FROM maintenance_locks WHERE job_id=?")
    .run(job.id);
});
test("Publication : CI réussie, confirmation, SHA figé ; fusion distincte du déploiement", async () => {
  const fake = fakeGitHub();
  const job = await planned(await fixtureTarget(), fake);
  await approveMaintenance(job.id, { approved: true }, fake.transport);
  await runMaintenanceWorker(
    job.payload,
    new GitHubMaintenanceClient("worker-secret", fake.transport),
    ["team/app"],
  );
  const tracked = await refreshMaintenance(job.id, fake.transport);
  assert.equal(tracked.canMerge, true);
  await assert.rejects(
    mergeMaintenance(
      job.id,
      {
        confirmed: true,
        previewReviewed: false,
        returnReviewed: true,
        expectedHead: headSha,
      },
      fake.transport,
    ),
  );
  const merged = await mergeMaintenance(
    job.id,
    {
      confirmed: true,
      previewReviewed: true,
      returnReviewed: true,
      expectedHead: headSha,
    },
    fake.transport,
  );
  assert.equal(merged.status, "merged");
  assert.equal(merged.deployment, "not-verified");
  assert.equal(
    fake.calls.find((call) => call.path.endsWith("/merge-async"))?.body.sha,
    headSha,
  );
  assert.equal(
    fake.calls.find((call) => call.path.endsWith("/merge-async"))?.body
      .bypass_rules,
    false,
  );
  assert.ok(
    !(await database()
      .prepare("SELECT job_id FROM maintenance_locks WHERE job_id=?")
      .get(job.id)),
  );
});
test("CI absente, échouée ou ignorée : fusion bloquée", async () => {
  for (const checks of [[], ["failure"], ["skipped"]]) {
    const fake = fakeGitHub({ checks });
    const job = await planned(await fixtureTarget(), fake);
    await approveMaintenance(job.id, { approved: true }, fake.transport);
    await runMaintenanceWorker(
      job.payload,
      new GitHubMaintenanceClient("secret", fake.transport),
      ["team/app"],
    );
    assert.equal(
      (await refreshMaintenance(job.id, fake.transport)).canMerge,
      false,
    );
    await assert.rejects(
      mergeMaintenance(
        job.id,
        {
          confirmed: true,
          previewReviewed: true,
          returnReviewed: true,
          expectedHead: headSha,
        },
        fake.transport,
      ),
    );
    await closeMaintenance(job.id, fake.transport);
  }
});

test("Lecture CI refusée : PR suivie, anciens succès effacés et fusion bloquée", async () => {
  for (const endpoint of ["/check-runs?", "/status?"]) {
    const fake = fakeGitHub();
    const job = await planned(await fixtureTarget(), fake);
    await approveMaintenance(job.id, { approved: true }, fake.transport);
    await runMaintenanceWorker(
      job.payload,
      new GitHubMaintenanceClient("secret", fake.transport),
      ["team/app"],
    );
    assert.equal(
      (await refreshMaintenance(job.id, fake.transport)).canMerge,
      true,
    );
    const denied = (async (input, init) =>
      String(input).includes(endpoint)
        ? Response.json({ message: "private-token-must-not-leak" }, { status: 403 })
        : fake.transport(input, init)) as typeof fetch;
    const tracked = await refreshMaintenance(job.id, denied);
    assert.equal(tracked.status, "pull_request");
    assert.equal(tracked.pullNumber, 7);
    assert.equal(tracked.headSha, headSha);
    assert.equal(tracked.canMerge, false);
    assert.deepEqual(tracked.checks, []);
    assert.match(tracked.mergeBlocker || "", /non vérifiables/);
    assert.ok(!JSON.stringify(tracked).includes("private-token-must-not-leak"));
    assert.equal(
      (await maintenanceState()).jobs.find((stored) => stored.id === job.id)
        ?.pullNumber,
      7,
    );
    assert.ok(
      await database()
        .prepare("SELECT job_id FROM maintenance_locks WHERE job_id=?")
        .get(job.id),
    );
    await assert.rejects(
      mergeMaintenance(job.id, {
        confirmed: true,
        previewReviewed: true,
        returnReviewed: true,
        expectedHead: headSha,
      }, denied),
      /non vérifiables/,
    );
    assert.ok(!fake.calls.some((call) => call.path.endsWith("/merge-async")));
    const recovered = await refreshMaintenance(job.id, fake.transport);
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.canMerge, true);
    await closeMaintenance(job.id, fake.transport);
  }
});
test("Modification externe d’une PR : arrêt de la fusion depuis Vigie", async () => {
  const fake = fakeGitHub({ extraFile: true });
  const job = await planned(await fixtureTarget(), fake);
  await approveMaintenance(job.id, { approved: true }, fake.transport);
  await runMaintenanceWorker(
    job.payload,
    new GitHubMaintenanceClient("secret", fake.transport),
    ["team/app"],
  );
  await assert.rejects(refreshMaintenance(job.id, fake.transport), /portée/);
  await database()
    .prepare("DELETE FROM maintenance_locks WHERE job_id=?")
    .run(job.id);
});
test("État exposé : jamais le jeton serveur ; archivage retire la cible", async () => {
  const state = await maintenanceState();
  assert.ok(!JSON.stringify(state).includes("private-github-unit-test"));
  const target = state.targets.at(-1)!;
  const project = (await list<any>("projects", "live")).find(
    (project) => project.id === target.projectId,
  );
  await save("projects", "live", { ...project, lifecycle: "archived" });
  assert.ok(
    !(await maintenanceState()).targets.some(
      (item) => item.projectId === project.id,
    ),
  );
});
test("Retour code : les fichiers modifiés après fusion ne sont jamais écrasés", async () => {
  const request = {
    ...payload(),
    operation: { kind: "rollback", pullNumber: 7 },
  } as MaintenancePayload;
  const client = new GitHubMaintenanceClient("secret", (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7"))
      return Response.json({
        merged: true,
        body: "Vigie maintenance job previous",
        base: { ref: "main" },
        head: { repo: { full_name: "team/app" } },
        merge_commit_sha: mergeSha,
        changed_files: 1,
      });
    if (path.endsWith(`/git/commits/${mergeSha}`))
      return Response.json({
        parents: [{ sha: "f".repeat(40) }],
        tree: { sha: mergeSha },
      });
    if (path.includes("/git/commits/"))
      return Response.json({ tree: { sha: path.split("/").at(-1) } });
    if (path.endsWith("/files"))
      return Response.json([{ filename: "package.json", status: "modified" }]);
    if (path.includes("/git/trees/"))
      return Response.json({
        tree: [
          {
            path: "package.json",
            type: "blob",
            mode: "100644",
            sha: path.endsWith(baseSha) ? headSha : mergeSha,
          },
        ],
      });
    throw new Error("Unexpected read");
  }) as typeof fetch);
  await assert.rejects(rollbackTree(client, request), /changé/);
});
test("Railway : la cible Node exacte permet les correctifs sans changer de majeure", () => {
  const updated = updateManifest(
    {
      engines: { node: "24.x" },
      devEngines: { runtime: { name: "node", version: "24.x" } },
      volta: { node: "24.1.0" },
    },
    { kind: "node", version: "24.2.0" },
    "exact",
  );
  assert.equal(updated.engines.node, "24.2.0");
  assert.equal(updated.devEngines.runtime.version, "24.2.0");
  assert.equal(updated.volta.node, "24.2.0");
});
test("Propriétaires GitHub : identifiants distincts sans transmission au registre public", () => {
  process.env.VIGIE_MAINTENANCE_GITHUB_TOKENS = JSON.stringify({
    team: "owner-private-token",
    "team/app": "repository-private-token",
    other: "other-private-token",
  });
  try {
    assert.equal(maintenanceToken("team/app"), "repository-private-token");
    assert.equal(maintenanceToken("team/runner"), "owner-private-token");
    assert.equal(maintenanceToken("other/app"), "other-private-token");
  } finally {
    delete process.env.VIGIE_MAINTENANCE_GITHUB_TOKENS;
  }
});
test("Jeton propriétaire séparé : ajout Janssen sans remplacer Theoo ni une entrée de dépôt", () => {
  const previousMap = process.env.VIGIE_MAINTENANCE_GITHUB_TOKENS;
  const previousOwner = process.env.VIGIE_MAINTENANCE_GITHUB_TOKEN_JANSSEN76140;
  try {
    process.env.VIGIE_MAINTENANCE_GITHUB_TOKENS = JSON.stringify({
      TheooLeroux: "original-theoo-test-token",
      Janssen76140: "old-janssen-test-token",
      "Janssen76140/specific": "specific-repository-test-token",
    });
    process.env.VIGIE_MAINTENANCE_GITHUB_TOKEN_JANSSEN76140 = "separate-janssen-test-token";
    assert.equal(maintenanceToken("TheooLeroux/Vigie"), "original-theoo-test-token");
    assert.equal(maintenanceToken("janssen76140/project"), "separate-janssen-test-token");
    assert.equal(maintenanceToken("Janssen76140/specific"), "specific-repository-test-token");
    process.env.VIGIE_MAINTENANCE_GITHUB_TOKEN_JANSSEN76140 = "invalid token";
    assert.equal(maintenanceToken("Janssen76140/project"), null);
  } finally {
    if (previousMap === undefined) delete process.env.VIGIE_MAINTENANCE_GITHUB_TOKENS;
    else process.env.VIGIE_MAINTENANCE_GITHUB_TOKENS = previousMap;
    if (previousOwner === undefined) delete process.env.VIGIE_MAINTENANCE_GITHUB_TOKEN_JANSSEN76140;
    else process.env.VIGIE_MAINTENANCE_GITHUB_TOKEN_JANSSEN76140 = previousOwner;
  }
});

test("Fusion asynchrone : attente et verrou conservés, sans double demande ni faux succès", async () => {
  const fake = fakeGitHub({ mergePending: true });
  const job = await planned(await fixtureTarget(), fake);
  await approveMaintenance(job.id, { approved: true }, fake.transport);
  await runMaintenanceWorker(
    job.payload,
    new GitHubMaintenanceClient("secret", fake.transport),
    ["team/app"],
  );
  const pending = await mergeMaintenance(
    job.id,
    {
      confirmed: true,
      previewReviewed: true,
      returnReviewed: true,
      expectedHead: headSha,
    },
    fake.transport,
  );
  assert.equal(pending.status, "merging");
  assert.equal(
    (await refreshMaintenance(job.id, fake.transport)).status,
    "merging",
  );
  await assert.rejects(closeMaintenance(job.id, fake.transport), /engagée/);
  await assert.rejects(
    mergeMaintenance(
      job.id,
      {
        confirmed: true,
        previewReviewed: true,
        returnReviewed: true,
        expectedHead: headSha,
      },
      fake.transport,
    ),
  );
  assert.equal(
    fake.calls.filter(
      (call) => call.method === "PUT" && call.path.endsWith("/merge-async"),
    ).length,
    1,
  );
  assert.ok(
    await database()
      .prepare("SELECT job_id FROM maintenance_locks WHERE job_id=?")
      .get(job.id),
  );
  fake.completeMerge();
  assert.equal(
    (await refreshMaintenance(job.id, fake.transport)).status,
    "merged",
  );
});
test("Envoi refusé explicitement : fermeture possible sans inventer de run", async () => {
  const fake = fakeGitHub({ rejectDispatch: true });
  const job = await planned(await fixtureTarget(), fake);
  const rejected = await approveMaintenance(
    job.id,
    { approved: true },
    fake.transport,
  );
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.dispatchRejected, true);
  assert.equal(
    (await closeMaintenance(job.id, fake.transport)).status,
    "closed",
  );
  assert.ok(
    !(await database()
      .prepare("SELECT job_id FROM maintenance_locks WHERE job_id=?")
      .get(job.id)),
  );
});
test("Plan dépendances : versions exactes et prérequis Node visibles, aucun secret au registre", async () => {
  const fake = fakeGitHub();
  const targetId = await fixtureTarget();
  const job = await createMaintenancePlan(
    {
      targetId,
      operation: {
        kind: "dependencies",
        updates: [{ name: "react", version: "19.1.0" }],
      },
    },
    fake.transport,
  );
  assert.ok(
    job.warnings.some((warning) => warning.includes("requiert Node >=18")),
  );
  assert.ok(
    fake.calls
      .filter((call) => !call.path.startsWith("/repos/"))
      .every((call) => !call.authorization),
  );
});
