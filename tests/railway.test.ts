import { authFixture } from "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { GET, POST, PATCH, DELETE } from "../src/app/api/[...path]/route";
import {
  collectRailway,
  RAILWAY_INVENTORY_QUERY,
} from "../src/lib/connectors/railway";
import {
  railwayState,
  saveRailwayConnection,
  synchronizeRailway,
  applyRailwaySnapshot,
  railwayMatches,
  linkRailwayProject,
  createRailwayProject,
  disconnectRailway,
} from "../src/lib/railway";
import {
  database,
  createProject,
  transaction,
  save,
  list,
  remove,
} from "../src/lib/db";
import { createProjectSchema, accessSchema } from "../src/lib/validation";
import { openConnectorSecret } from "../src/lib/connector-secrets";
import {
  railwayServiceState,
  railwayAttention,
} from "../src/lib/railway-status";
import type { RailwayProject, RailwayService } from "../src/lib/railway-types";
import type { Access, Service } from "../src/lib/types";
process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const token = "railway-unit-test-private";
async function connection() {
  return (await saveRailwayConnection({
    name: "Test Railway",
    workspaceId: randomUUID(),
    secret: token,
  }));
}
async function project(name: string, url = "") {
  return (await transaction(async () =>
    (await createProject(
      "live",
      createProjectSchema.parse({ name, url, provider: "Railway" }),
    )),
  ));
}
function remote(workspaceId: string, name = "app"): RailwayProject {
  const environmentId = randomUUID();
  return {
    id: randomUUID(),
    name,
    workspaceId,
    workspaceName: "Workspace test",
    environments: [{ id: environmentId, name: "production", ephemeral: false }],
    services: [
      {
        id: randomUUID(),
        name: "web",
        environmentId,
        environmentName: "production",
        domains: ["example.test"],
        repository: "team/repository",
        image: null,
        builder: "RAILPACK",
        region: "europe-west4",
        replicas: 1,
        rootDirectory: "/web",
        healthcheckPath: "/health",
        cronSchedule: null,
        latestDeployment: null,
        activeDeployments: [],
      },
    ],
  };
}
function apiData(
  p: RailwayProject,
  hasNext = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      workspace: { id: p.workspaceId, name: p.workspaceName },
      projects: {
        pageInfo: { hasNextPage: hasNext, endCursor },
        edges: [
          {
            node: {
              id: p.id,
              name: p.name,
              workspaceId: p.workspaceId,
              environments: {
                pageInfo: { hasNextPage: false },
                edges: p.environments.map((e) => ({
                  node: {
                    id: e.id,
                    name: e.name,
                    isEphemeral: e.ephemeral,
                    serviceInstances: {
                      pageInfo: { hasNextPage: false },
                      edges: p.services
                        .filter((s) => s.environmentId === e.id)
                        .map((s) => ({
                          node: {
                            serviceId: s.id,
                            serviceName: s.name,
                            environmentId: e.id,
                            builder: s.builder,
                            region: s.region,
                            numReplicas: s.replicas,
                            rootDirectory: s.rootDirectory,
                            healthcheckPath: s.healthcheckPath,
                            cronSchedule: s.cronSchedule,
                            source: { repo: s.repository, image: s.image },
                            domains: {
                              customDomains: [],
                              serviceDomains: s.domains.map((domain) => ({
                                domain,
                              })),
                            },
                            latestDeployment: s.latestDeployment,
                            activeDeployments: s.activeDeployments,
                          },
                        })),
                    },
                  },
                })),
              },
            },
          },
        ],
      },
    },
  };
}
const transport = (value: unknown, status = 200) =>
  (async () => Response.json(value, { status })) as typeof fetch;

test("Railway : conserver les images figées par digest sans accepter de credentials dans les sources", async () => {
  const workspace = randomUUID(), digest = "sha256:" + "a".repeat(64);
  for (const image of [`docker.io/tailscale/tailscale@${digest}`, `tailscale/tailscale:stable@${digest}`, `registry.example.test:5000/team/image:v1@${digest}`]) {
    const project = remote(workspace); project.services[0].repository = null; project.services[0].image = image;
    assert.equal((await collectRailway(workspace, token, transport(apiData(project))))[0].services[0].image, image);
  }
  for (const image of [`user:secret@registry.example.test/image`, `https://user:secret@registry.example.test/image@${digest}`, `image@sha256:abc`, `image@${digest}?token=secret`, `image@${digest}@${digest}`]) {
    const project = remote(workspace); project.services[0].image = image; project.services[0].repository = image;
    const service = (await collectRailway(workspace, token, transport(apiData(project))))[0].services[0];
    assert.equal(service.image, null); assert.equal(service.repository, null);
  }
});
test("Railway : métadonnées brutes éliminées avant stockage et réponse API", async () => {
  const c = (await connection()),
    p = remote(c.workspaceId),
    raw = apiData(p),
    service =
      raw.data.projects.edges[0].node.environments.edges[0].node
        .serviceInstances.edges[0].node;
  service.activeDeployments = [
    {
      id: randomUUID(),
      status: "SUCCESS",
      createdAt: "2026-10-22T10:00:00.000Z",
      updatedAt: "2026-10-22T10:00:00.000Z",
      meta: {
        repo: "team/deployed",
        commitHash: "a".repeat(40),
        branch: "release",
        serviceManifest: { secrets: "do-not-persist-fixture-secret" },
        commitMessage: "do-not-persist-fixture-secret",
      },
    } as any,
  ];
  await synchronizeRailway(c.id, transport(raw));
  const stored = (await database()
    .prepare("SELECT data FROM railway_projects WHERE connection_id=?")
    .get(c.id)) as { data: string };
  assert.doesNotMatch(
    stored.data,
    /do-not-persist-fixture-secret|serviceManifest|commitMessage|"meta"/,
  );
  const state = (await railwayState()).projects.find((v) => v.id === p.id)!;
  assert.equal(
    state.services[0].activeDeployments[0].evidence?.repository,
    "team/deployed",
  );
  const response = await GET(
    new Request("http://127.0.0.1:3001/api/railway", {
      headers: { cookie: (await authFixture()).cookie },
    }),
    { params: Promise.resolve({ path: ["railway"] }) },
  );
  assert.equal(response.status, 200);
  assert.doesNotMatch(
    await response.text(),
    /do-not-persist-fixture-secret|serviceManifest|commitMessage|"meta"/,
  );
});
async function expireAttempt(id: string) {
  const c = (await railwayState()).connections.find((c) => c.id === id)!;
  (await database()
    .prepare("UPDATE railway_connections SET data=? WHERE id=?")
    .run(JSON.stringify({ ...c, lastAttemptAt: "2026-01-01T00:00:00Z" }), id));
}

test("Railway : requête fixe de lecture, pagination et secret uniquement dans le header", async () => {
  const c = (await connection()),
    a = remote(c.workspaceId),
    b = remote(c.workspaceId);
  let calls = 0;
  const data = await collectRailway(c.workspaceId, token, (async (
    url,
    options,
  ) => {
    assert.equal(url, "https://backboard.railway.com/graphql/v2");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      `Bearer ${token}`,
    );
    const body = JSON.parse(options?.body as string);
    assert.equal(body.query, RAILWAY_INVENTORY_QUERY);
    assert.equal(body.variables.workspaceId, c.workspaceId);
    assert.doesNotMatch(body.query, /\b(mutation|variables|logs|config)\b/);
    assert.equal(body.variables.after, calls === 0 ? null : "page-2");
    return Response.json(
      calls++ === 0 ? apiData(a, true, "page-2") : apiData(b),
    );
  }) as typeof fetch);
  assert.equal(calls, 2);
  assert.deepEqual(
    data.map((p) => p.id),
    [a.id, b.id],
  );
});
test("Railway : relevés incomplets, secrets dans erreurs et périmètres incohérents rejetés", async () => {
  const c = (await connection()),
    p = remote(c.workspaceId);
  const truncated = apiData(p);
  truncated.data.projects.edges[0].node.environments.pageInfo.hasNextPage = true;
  await assert.rejects(
    async () => (await collectRailway(c.workspaceId, token, transport(truncated))),
    /relevé partiel/,
  );
  await assert.rejects(
    async () => (await collectRailway(randomUUID(), token, transport(apiData(p)))),
    /autre workspace/,
  );
  await assert.rejects(
    async () =>
      (await collectRailway(
        c.workspaceId,
        token,
        transport({ errors: [{ message: `secret=${token}` }] }),
      )),
    (e) => e instanceof Error && !e.message.includes(token),
  );
  await assert.rejects(
    async () => (await collectRailway(c.workspaceId, token, transport({}, 429))),
    /Limite API/,
  );
  await assert.rejects(
    async () => (await collectRailway(c.workspaceId, token, transport({}, 403))),
    /refuse/,
  );
  await assert.rejects(
    async () =>
      (await collectRailway(c.workspaceId, token, transport(apiData(p, true, null)))),
    /Pagination/,
  );
  const bad = apiData(p);
  bad.data.projects.edges[0].node.environments.edges[0].node.serviceInstances.edges[0].node.source.repo =
    "https://user:password@example.test/private";
  const safe = await collectRailway(c.workspaceId, token, transport(bad));
  assert.equal(safe[0].services[0].repository, null);
});
test("Railway : jeton chiffré, scope immuable, absence des réponses publiques et retrait local", async () => {
  const c = (await connection()),
    stored = (await database()
      .prepare("SELECT secret_cipher FROM railway_connections WHERE id=?")
      .get(c.id)) as { secret_cipher: string };
  assert.ok(!stored.secret_cipher.includes(token));
  assert.equal(
    openConnectorSecret(
      stored.secret_cipher,
      `vigie:railway:v1:${c.id}:${c.workspaceId}`,
    ),
    token,
  );
  assert.throws(() =>
    openConnectorSecret(
      stored.secret_cipher,
      `vigie:railway:v1:${randomUUID()}:${c.workspaceId}`,
    ),
  );
  assert.ok(!JSON.stringify((await railwayState())).includes(token));
  await assert.rejects(
    async () => (await saveRailwayConnection({ ...c, workspaceId: randomUUID() }, c.id)),
    /changer de workspace/,
  );
  await assert.rejects(
    async () => (await saveRailwayConnection({ ...c, secret: token })),
    /déjà connecté/,
  );
  (await saveRailwayConnection({ ...c, name: "Renommé" }, c.id));
  assert.equal(
    (
      (await database()
        .prepare("SELECT secret_cipher FROM railway_connections WHERE id=?")
        .get(c.id)) as { secret_cipher: string }
    ).secret_cipher,
    stored.secret_cipher,
  );
  (await disconnectRailway(c.id));
  assert.equal(
    (await railwayState()).connections.find((v) => v.id === c.id)?.configured,
    false,
  );
});
test("Railway : rattachement exact, sans noms approximatifs, ambiguïtés ni clients écrasés", async () => {
  const c = (await connection()),
    r = remote(c.workspaceId),
    p = (await project("Même nom", "https://unique-railway.test"));
  r.services[0].domains = ["unique-railway.test"];
  const service = (await list<Service>("services", "live", p.id))[0];
  (await save(
    "services",
    "live",
    { ...service, runtime: "Node manuel", version: "22" },
    p.id,
  ));
  const other = (await project("Autre", "https://unique-railway.test"));
  assert.equal((await railwayMatches(r)).length, 2);
  (await save<Access>(
    "accesses",
    "live",
    {
      ...accessSchema.parse({
        label: "Railway",
        kind: "hosting",
        url: `https://railway.com/project/${r.id}`,
      }),
      id: randomUUID(),
      projectId: p.id,
    },
    p.id,
  ));
  assert.deepEqual(
    (await railwayMatches(r)).map((p) => p.id),
    [p.id],
  );
  (await applyRailwaySnapshot(c.id, [r]));
  (await applyRailwaySnapshot(c.id, [r]));
  assert.equal(
    (await railwayState()).projects.filter((v) => v.connectionId === c.id).length,
    1,
  );
  assert.equal(
    (await railwayState()).projects.find((v) => v.id === r.id)?.projectId,
    p.id,
  );
  assert.equal(
    (await list<Service>("services", "live", p.id))[0].runtime,
    "Node manuel",
  );
  const archived = (await project("Archivé"));
  (await save("projects", "live", { ...archived, lifecycle: "archived" }));
  await assert.rejects(
    async () => (await linkRailwayProject(c.id, r.id, archived.id)),
    /actif introuvable/,
  );
  (await linkRailwayProject(c.id, r.id, other.id));
  (await applyRailwaySnapshot(c.id, [r]));
  assert.equal(
    (await railwayState()).projects.find((v) => v.id === r.id)?.projectId,
    other.id,
  );
  const unknown = remote(c.workspaceId, p.name);
  unknown.services[0].domains = [];
  assert.equal((await railwayMatches(unknown)).length, 0);
});
test("Railway : dernière observation préservée après panne, absence et déconnexion", async () => {
  const c = (await connection()),
    r = remote(c.workspaceId);
  r.services[0].domains = ["retained-railway.test"];
  await synchronizeRailway(c.id, transport(apiData(r)));
  const before = (await railwayState()).projects.find((v) => v.id === r.id)!;
  const success = (await railwayState()).connections.find(
    (v) => v.id === c.id,
  )!.lastSuccessAt;
  await assert.rejects(
    async () => (await synchronizeRailway(c.id, transport(apiData(r)))),
    /30 secondes/,
  );
  (await expireAttempt(c.id));
  await assert.rejects(
    async () => (await synchronizeRailway(c.id, transport({}, 503))),
    /indisponible/,
  );
  assert.equal(
    (await railwayState()).connections.find((v) => v.id === c.id)!.lastSuccessAt,
    success,
  );
  assert.deepEqual(
    (await railwayState()).projects.find((v) => v.id === r.id)!.services,
    before.services,
  );
  (await applyRailwaySnapshot(c.id, []));
  assert.ok((await railwayState()).projects.find((v) => v.id === r.id)?.missingSince);
  await assert.rejects(async () => (await createRailwayProject(c.id, r.id)), /plus présent/);
  (await applyRailwaySnapshot(c.id, [r]));
  assert.equal(
    (await railwayState()).projects.find((v) => v.id === r.id)?.missingSince,
    null,
  );
  const first = (await createRailwayProject(c.id, r.id)),
    second = (await createRailwayProject(c.id, r.id));
  assert.equal(first.projectId, second.projectId);
  (await disconnectRailway(c.id));
  await assert.rejects(async () => (await synchronizeRailway(c.id)), /manquant/);
  assert.equal(
    (await railwayState()).projects.find((v) => v.id === r.id)?.projectId,
    first.projectId,
  );
  (await remove("projects", first.projectId, "live"));
  assert.equal(
    (await railwayState()).projects.find((v) => v.id === r.id)?.projectId,
    null,
  );
});
test("Railway : une dernière tentative échouée ne masque pas le déploiement actif", () => {
  const s = remote(randomUUID()).services[0],
    at = "2026-10-22T10:00:00.000Z";
  s.latestDeployment = {
    id: randomUUID(),
    status: "FAILED",
    createdAt: at,
    updatedAt: at,
  };
  s.activeDeployments = [
    { id: randomUUID(), status: "SUCCESS", createdAt: at, updatedAt: at },
  ];
  assert.equal(railwayServiceState(s).label, "Déployé");
  assert.equal(railwayAttention(s), true);
  s.activeDeployments[0].status = "CRASHED";
  assert.equal(railwayServiceState(s).tone, "warning");
  s.activeDeployments = [];
  assert.equal(railwayServiceState(s).tone, "neutral");
});
test("Railway : toutes les routes exigent une session et bloquent les origines externes", async () => {
  const c = (await connection()),
    r = remote(c.workspaceId),
    p = (await project("Route"));
  (await applyRailwaySnapshot(c.id, [r]));
  const call = async (
    method: string,
    path: string,
    payload?: unknown,
    cookie = "",
    origin = "http://127.0.0.1:3001",
  ) =>
    ({ GET, POST, PATCH, DELETE })[method as "GET"](
      new Request(`http://127.0.0.1:3001/api/${path}`, {
        method,
        headers: { origin, cookie, "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
  for (const [method, path, payload] of [
    ["GET", "railway", undefined],
    ["POST", "railway", {}],
    ["PATCH", `railway/${c.id}`, {}],
    ["POST", `railway/${c.id}/sync`, {}],
    ["POST", `railway/${c.id}/projects/${r.id}/link`, { projectId: p.id }],
    ["POST", `railway/${c.id}/projects/${r.id}/create`, {}],
    ["DELETE", `railway/${c.id}/token`, undefined],
  ] as const)
    assert.equal((await call(method, path, payload)).status, 401);
  const cookie = (await authFixture()).cookie;
  assert.equal(
    (
      await call(
        "POST",
        `railway/${c.id}/sync`,
        {},
        cookie,
        "https://attacker.test",
      )
    ).status,
    403,
  );
  const response = await call("GET", "railway", undefined, cookie);
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes(token));
  assert.equal(
    (
      await call(
        "POST",
        `railway/${c.id}/projects/${r.id}/link`,
        { projectId: p.id },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("GET", "railway?workspace=demo", undefined, cookie)).status,
    400,
  );
});
