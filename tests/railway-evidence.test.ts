import "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deploymentEvidence } from "../src/lib/connectors/railway-evidence";
import {
  enrichRailwayReleases,
  nodeRelease,
} from "../src/lib/connectors/software-releases";
import {
  railwayVersionAttention,
  railwayRuntimeDeployments,
} from "../src/lib/railway-status";
import { database } from "../src/lib/db";
import type {
  RailwayProject,
  RailwayDeployment,
} from "../src/lib/railway-types";
const at = "2026-10-22T10:00:00.000Z";
const meta = {
  repo: "https://github.com/team/app.git",
  branch: "main",
  commitHash: "f".repeat(40),
  rootDirectory: "/frontend",
  imageDigest: "sha256:" + "a".repeat(64),
  variables: { API_KEY: "sensitive-fixture-value" },
  commitMessage: "sensitive-fixture-value",
  serviceManifest: { deploy: { startCommand: "echo sensitive-fixture-value" } },
  railpackInfo: {
    railpackVersion: "0.15.0",
    metadata: {
      nodeIsSPA: "true",
      nodeRuntime: "vite",
      secret: "sensitive-fixture-value",
    },
    resolvedPackages: {
      node: {
        resolvedVersion: "22.8.0",
        requestedVersion: "sensitive-fixture-value",
      },
      caddy: { resolvedVersion: "2.11.1" },
      pnpm: { resolvedVersion: "10.1.0" },
      unknown: { resolvedVersion: "1.0.0" },
    },
  },
};
const catalog = {
  checkedAt: at,
  releases: [
    {
      version: "26.1.0",
      date: "2026-10-01",
      lts: false as const,
      security: false,
    },
    { version: "24.5.0", date: "2026-10-01", lts: "Krypton", security: false },
    { version: "22.8.2", date: "2026-10-01", lts: "Jod", security: false },
    { version: "22.8.1", date: "2026-09-01", lts: "Jod", security: true },
    { version: "20.20.2", date: "2026-01-01", lts: "Iron", security: true },
  ],
  schedule: {
    v20: { start: "2023-01-01", end: "2000-04-30" },
    v22: { start: "2024-01-01", end: "2999-04-30" },
    v24: { start: "2025-01-01", end: "2999-04-30" },
    v26: { start: "2026-01-01", end: "2999-04-30" },
  },
};
function project(): RailwayProject {
  const env = randomUUID();
  return {
    id: randomUUID(),
    name: "Versions test",
    workspaceId: randomUUID(),
    workspaceName: "Test",
    environments: [{ id: env, name: "production", ephemeral: false }],
    services: [
      {
        id: randomUUID(),
        name: "web",
        environmentId: env,
        environmentName: "production",
        domains: [],
        repository: "team/app",
        image: null,
        builder: "RAILPACK",
        region: null,
        replicas: 1,
        rootDirectory: "/frontend",
        healthcheckPath: null,
        cronSchedule: null,
        latestDeployment: null,
        activeDeployments: [
          {
            id: randomUUID(),
            status: "SUCCESS",
            createdAt: at,
            updatedAt: at,
            evidence: deploymentEvidence(meta),
          },
        ],
      },
    ],
  };
}
async function clearCache() {
  (await database().exec(
    "CREATE TABLE IF NOT EXISTS software_release_catalog(cache_key TEXT PRIMARY KEY,data TEXT NOT NULL,expires_at TEXT NOT NULL); DELETE FROM software_release_catalog;",
  ));
}
test("Preuves Railway : uniquement les champs autorisés, jamais les commandes, messages ou secrets", () => {
  const evidence = deploymentEvidence(meta)!;
  assert.equal(evidence.repository, "team/app");
  assert.equal(evidence.commit, "f".repeat(40));
  assert.equal(evidence.rootDirectory, "/frontend");
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /sensitive-fixture-value|serviceManifest|variables|requestedVersion|unknown/,
  );
  assert.deepEqual(
    evidence.packages.map((p) => [p.name, p.usage]),
    [
      ["node", "build"],
      ["caddy", "runtime"],
      ["pnpm", "tool"],
    ],
  );
  const server = deploymentEvidence({
    ...meta,
    railpackInfo: { ...meta.railpackInfo, metadata: { nodeRuntime: "node" } },
  })!;
  assert.equal(server.packages[0].usage, "runtime");
  assert.equal(
    deploymentEvidence({
      repo: "https://secret:password@github.com/team/app",
      commitHash: "not-a-commit",
    }),
    null,
  );
  assert.equal(
    deploymentEvidence({
      railpackInfo: {
        resolvedPackages: {
          node: { requestedVersion: "22.x" },
          php: { resolvedVersion: "^8.3.0" },
        },
      },
    }),
    null,
  );
});
test("Node : correctifs de la même branche, sécurité, dernière LTS et fin de support indépendants", () => {
  const old = nodeRelease("22.8.0", catalog);
  assert.equal(old.latestVersion, "22.8.2");
  assert.equal(old.latestLts, "24.5.0");
  assert.equal(old.latestStable, "26.1.0");
  assert.equal(old.securityUpdate, true);
  assert.equal(old.state, "available");
  assert.equal(old.supported, true);
  assert.equal(nodeRelease("22.8.2", catalog).state, "current");
  assert.equal(nodeRelease("22.8.2", catalog).securityUpdate, false);
  assert.equal(nodeRelease("22.99.0", catalog).state, "ahead");
  assert.equal(nodeRelease("20.20.2", catalog).state, "current");
  assert.equal(nodeRelease("20.20.2", catalog).supported, false);
  assert.equal(nodeRelease("22.8.0", null).state, "unknown");
});
test("Catalogues officiels : cache, sources fixes sans jeton Railway et publications futures exclues", async () => {
  (await clearCache());
  const p = project(),
    calls: string[] = [];
  const fake = (async (url, options) => {
    calls.push(String(url));
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("authorization"), null);
    if (String(url).includes("nodejs.org/dist"))
      return Response.json([
        ...catalog.releases.map((r) => ({ ...r, version: "v" + r.version })),
        { version: "v99.0.0", date: "2999-01-01", security: false, lts: false },
      ]);
    if (String(url).includes("/schedule.json"))
      return Response.json(catalog.schedule);
    if (
      String(url) ===
      "https://api.github.com/repos/caddyserver/caddy/releases/latest"
    )
      return Response.json({
        tag_name: "v2.11.7",
        prerelease: false,
        draft: false,
        published_at: "2026-01-01T00:00:00Z",
      });
    throw new Error("Source inattendue");
  }) as typeof fetch;
  const first = await enrichRailwayReleases([p], fake),
    packages = first[0].services[0].activeDeployments[0].evidence!.packages;
  assert.equal(packages[0].release?.latestVersion, "22.8.2");
  assert.equal(packages[0].release?.latestStable, "26.1.0");
  assert.equal(packages[1].release?.latestVersion, "2.11.7");
  assert.equal(packages[2].release?.state, "unknown");
  assert.equal(calls.length, 3);
  await enrichRailwayReleases([p], (async () => {
    throw new Error("Le cache devrait être utilisé");
  }) as typeof fetch);
});
test("Panne de catalogue : versions et preuve conservées, aucun état à jour inventé", async () => {
  (await clearCache());
  const p = project();
  const result = await enrichRailwayReleases([p], (async () =>
    Response.json({}, { status: 503 })) as typeof fetch);
  const evidence = result[0].services[0].activeDeployments[0].evidence!;
  assert.equal(evidence.packages[0].version, "22.8.0");
  assert.equal(evidence.commit, "f".repeat(40));
  assert.equal(evidence.packages[0].release?.state, "unknown");
  assert.equal(evidence.packages[0].release?.checkedAt, null);
});
test("Versions : tentative échouée ou en construction ne devient jamais la version du conteneur actif", () => {
  const p = project(),
    s = p.services[0];
  s.activeDeployments[0].evidence!.packages[0].release = nodeRelease(
    "22.8.2",
    catalog,
  );
  const pending: RailwayDeployment = {
    id: randomUUID(),
    status: "BUILDING",
    createdAt: at,
    updatedAt: at,
    evidence: deploymentEvidence(meta),
  };
  pending.evidence!.packages[0].release = nodeRelease("22.8.0", catalog);
  s.activeDeployments.push(pending);
  s.latestDeployment = { ...pending, status: "FAILED" };
  assert.equal(railwayRuntimeDeployments(s).length, 1);
  assert.equal(railwayVersionAttention(s), false);
  s.activeDeployments[0].evidence!.packages[0].release = nodeRelease(
    "20.20.2",
    catalog,
  );
  assert.equal(railwayVersionAttention(s), true);
});
