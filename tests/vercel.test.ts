import { authFixture } from "./auth-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { GET, POST, PATCH, DELETE } from "../src/app/api/[...path]/route";
import {
  database,
  list,
  get,
  save,
  transaction,
  createProject,
  createClient,
  remove,
} from "../src/lib/db";
import {
  createProjectSchema,
  clientSchema,
  accessSchema,
} from "../src/lib/validation";
import type { Project, Client, Access } from "../src/lib/types";
import type { VercelProject } from "../src/lib/vercel-types";
import {
  vercelState,
  saveVercelConnection,
  applyVercelSnapshot,
  synchronizeVercel,
  createVercelProject,
  linkVercelProject,
  disconnectVercel,
  vercelMatches,
} from "../src/lib/vercel";
import { collectVercel } from "../src/lib/connectors/vercel";
import {
  VERCEL_SOURCE_TEAM,
  VERCEL_CLIENT_PROJECTS,
  vercelSuggestedClient,
  vercelExcluded,
} from "../src/lib/vercel-client-mapping";
import { openConnectorSecret } from "../src/lib/connector-secrets";
import {
  analyzeVercelBuild,
  runtimeEvidence,
  enrichVercelTechnologies,
} from "../src/lib/connectors/vercel-analysis";
process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secret = "vercel-private-unit-test";
const freshTeam = () => `team_${randomUUID().replaceAll("-", "")}`;
const connection = (teamId = freshTeam()) =>
  saveVercelConnection({ name: "Test Vercel", teamId, secret });
const local = (name: string, url = "") =>
  transaction(() =>
    createProject("live", createProjectSchema.parse({ name, url })),
  );
function remote(teamId: string, name = "reborn-studio-site"): VercelProject {
  const id = "prj_" + randomUUID().replaceAll("-", "");
  return {
    id,
    name,
    teamId,
    teamSlug:
      teamId === VERCEL_SOURCE_TEAM
        ? "janssens-projects-d88e1ede"
        : teamId.toLowerCase(),
    teamName: "Team test",
    framework: "nextjs",
    nodeBranch: "24.x",
    rootDirectory: null,
    repository: "team/app",
    productionBranch: "main",
    domains: [
      {
        name: `${id.toLowerCase().replaceAll("_", "-")}.test`,
        verified: true,
        redirect: null,
        environment: "production",
      },
    ],
    production: null,
    latest: null,
    excluded: vercelExcluded(teamId, name),
    clientSuggestion: vercelSuggestedClient(teamId, name, []),
  };
}
function expire(id: string) {
  const c = vercelState().connections.find((c) => c.id === id)!;
  database()
    .prepare("UPDATE vercel_connections SET data=? WHERE id=?")
    .run(JSON.stringify({ ...c, lastAttemptAt: "2026-01-01T00:00:00Z" }), id);
}
function fakeApi(
  team = VERCEL_SOURCE_TEAM,
  options: {
    fail?: number;
    truncated?: boolean;
    wrongOwner?: boolean;
    pages?: boolean;
  } = {},
) {
  const calls: URL[] = [];
  const rawProject = {
    id: "prj_TestMain",
    accountId: team,
    name: "reborn-studio-site",
    framework: "nextjs",
    nodeVersion: "24.x",
    env: [{ key: "SECRET", value: secret }],
    link: {
      type: "github",
      org: "team",
      repo: "configured",
      productionBranch: "main",
    },
    targets: { production: { id: "dpl_Stable" } },
  };
  const excluded = ["released-scan-demo", "mtt-lab"].map((name, i) => ({
    ...rawProject,
    id: `prj_Excluded${i}`,
    name,
  }));
  const deployment = {
    id: "dpl_Stable",
    ownerId: options.wrongOwner ? freshTeam() : team,
    projectId: "prj_TestMain",
    url: "stable.vercel.app",
    createdAt: Date.parse("2026-09-01T12:00:00Z"),
    readyState: "READY",
    target: "production",
    projectSettings: { nodeVersion: "22.x", framework: "nextjs" },
    regions: ["iad1"],
    env: { SECRET: secret },
    meta: {
      lambdaRuntimeStats: '{"nodejs":2}',
      githubCommitOrg: "team",
      githubCommitRepo: "deployed",
      githubCommitRef: "release",
      githubCommitSha: "a".repeat(40),
      githubCommitMessage: secret,
      githubCommitAuthorEmail: secret,
    },
    gitSource: { sha: "a".repeat(40), ref: "release", type: "github" },
  };
  const transport = (async (url, init) => {
    const u = new URL(String(url));
    calls.push(u);
    assert.equal(init?.redirect, "error");
    if (u.hostname !== "api.vercel.com") {
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      if (u.hostname === "registry.npmjs.org")
        return Response.json({ name: "next", version: "16.3.5" });
      if (u.hostname === "nodejs.org")
        return Response.json([
          {
            version: "v24.22.1",
            date: "2026-10-01",
            lts: "Krypton",
            security: true,
          },
          {
            version: "v22.23.4",
            date: "2026-10-01",
            lts: "Jod",
            security: true,
          },
        ]);
      if (u.hostname === "raw.githubusercontent.com")
        return Response.json({
          v22: { start: "2024-01-01", end: "2999-04-30" },
          v24: { start: "2025-01-01", end: "2999-04-30" },
        });
      throw new Error("Source inattendue");
    }
    assert.equal(init?.method, "GET");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${secret}`,
    );
    assert.ok(!/env|logs|delete/.test(u.pathname));
    if (u.pathname === "/v3/deployments/dpl_Stable/events") {
      assert.equal(u.searchParams.get("builds"), "1");
      assert.equal(u.searchParams.get("follow"), "0");
      return Response.json([
        { type: "stdout", text: "Detected Next.js version: 16.3.4" },
        { type: "stdout", text: secret },
      ]);
    }
    if (options.fail)
      return Response.json(
        { error: { message: secret } },
        { status: options.fail },
      );
    if (u.pathname === "/v2/teams/" + team)
      return Response.json({
        id: team,
        slug: "janssens-projects-d88e1ede",
        name: "Team test",
        billing: { secret },
      });
    assert.equal(u.searchParams.get("teamId"), team);
    if (u.pathname === "/v10/projects")
      return Response.json({
        projects: options.pages
          ? u.searchParams.has("until")
            ? excluded
            : [rawProject]
          : [rawProject, ...excluded],
        pagination: options.truncated
          ? {}
          : {
              next: options.pages && !u.searchParams.has("until") ? 100 : null,
            },
      });
    if (u.pathname === "/v9/projects/prj_TestMain/domains")
      return Response.json({
        domains: [{ name: "unit-vercel.test", verified: true }],
        pagination: { next: null },
      });
    if (u.pathname === "/v13/deployments/dpl_Stable")
      return Response.json(deployment);
    if (
      u.pathname === "/v6/deployments" &&
      u.searchParams.get("projectId") === "prj_TestMain"
    )
      return Response.json({
        deployments: [
          {
            uid: "dpl_FailedPreview",
            projectId: "prj_TestMain",
            url: "preview.vercel.app",
            state: "ERROR",
            target: null,
            created: Date.parse("2026-10-20T12:00:00Z"),
            meta: {
              githubCommitOrg: "team",
              githubCommitRepo: "deployed",
              githubCommitSha: "b".repeat(40),
            },
          },
        ],
      });
    throw new Error("Lecture non prévue : " + u.pathname);
  }) as typeof fetch;
  return { transport, calls };
}
test("Vercel : découverte complète paginée, GET uniquement, exclusions sans collecte complémentaire", async () => {
  const api = fakeApi(VERCEL_SOURCE_TEAM, { pages: true }),
    result = await collectVercel(VERCEL_SOURCE_TEAM, secret, api.transport);
  assert.equal(result.length, 3);
  assert.equal(result.filter((p) => p.excluded).length, 2);
  assert.equal(
    api.calls.filter((u) => u.pathname === "/v10/projects").length,
    2,
  );
  assert.ok(!api.calls.some((u) => u.pathname.includes("prj_Excluded")));
  assert.ok(!JSON.stringify(result).includes(secret));
  const p = result[0];
  assert.equal(p.nodeBranch, "24.x");
  assert.equal(p.production?.nodeBranch, "22.x");
  assert.equal(p.production?.id, "dpl_Stable");
  assert.equal(p.latest?.id, "dpl_FailedPreview");
  assert.equal(p.production?.repository, "team/deployed");
  assert.equal(p.repository, "team/configured");
  assert.equal(p.production?.nodeRelease?.state, "unknown");
  assert.equal(p.production?.nodeRelease?.securityUpdate, null);
  assert.equal(p.production?.nodeRelease?.supported, true);
  assert.equal(p.production?.analysis?.technologies[0].version, "16.3.4");
  assert.equal(p.production?.analysis?.technologies[0].update, "available");
  assert.equal(p.production?.analysis?.runtimes[0].name, "nodejs");
});

test("Vercel : preuves de build filtrées, contraintes et avertissements exclus, catalogue indisponible sans perte", async () => {
  const events = [
    "Detected Next.js version: 16.3.4",
    "▲ Next.js 16.3.4",
    "vite v7.1.2 building for production...",
    "+ typescript 5.9.3",
    "+ react 19.3.1",
    "Using pnpm@11.23.0 based on project creation date",
    "next ^16.0.0",
    "+ next 16.0.0-beta.1",
    "Warning: please upgrade next to 99.9.9",
    "npm install next@99.9.9",
    "PRIVATE_SECRET=never-store",
    "Running TypeScript ...",
  ].map((text) => ({ type: "stdout", text }));
  const a = analyzeVercelBuild(
    events,
    runtimeEvidence('{"nodejs":2,"python3.12":1,"private-secret":3,"ruby":-1}'),
  );
  assert.equal(a.technologies.filter((t) => t.name === "next").length, 1);
  assert.deepEqual(a.runtimes, [
    { name: "nodejs", functions: 2 },
    { name: "python3.12", functions: 1 },
  ]);
  assert.ok(a.languages.includes("Python"));
  assert.ok(a.languages.includes("TypeScript (vérification de types)"));
  assert.ok(!JSON.stringify(a).includes("never-store"));
  assert.ok(!JSON.stringify(a).includes("99.9.9"));
  assert.equal(
    a.technologies.find((t) => t.name === "pnpm")?.version,
    "11.23.0",
  );
  await enrichVercelTechnologies(
    [a],
    (async () => new Response("", { status: 503 })) as typeof fetch,
  );
  assert.equal(
    a.technologies.find((t) => t.name === "react")?.update,
    "unknown",
  );
  assert.equal(
    a.technologies.find((t) => t.name === "react")?.version,
    "19.3.1",
  );
  assert.equal(analyzeVercelBuild(null).status, "unavailable");
  assert.equal(analyzeVercelBuild(Array(1000).fill({})).truncated, true);
});

test("Vercel : dernier build conservé seulement pour le même déploiement en cas d’échec d’analyse", () => {
  const c = connection(),
    p = remote(c.teamId);
  p.production = {
    id: "dpl_Proof",
    url: null,
    state: "READY",
    target: "production",
    createdAt: new Date().toISOString(),
    framework: "nextjs",
    nodeBranch: "24.x",
    repository: "team/app",
    branch: "main",
    commit: "a".repeat(40),
    regions: [],
    analysis: analyzeVercelBuild([
      { type: "stdout", text: "Detected Next.js version: 16.3.4" },
    ]),
  };
  applyVercelSnapshot(c.id, [p]);
  p.production.analysis = analyzeVercelBuild(null);
  let saved = applyVercelSnapshot(c.id, [p]).projects.find(
    (x) => x.id === p.id,
  )!;
  assert.equal(saved.production?.analysis?.refreshFailed, true);
  assert.equal(saved.production?.analysis?.technologies[0].version, "16.3.4");
  p.production.id = "dpl_Other";
  p.production.analysis = analyzeVercelBuild(null);
  saved = applyVercelSnapshot(c.id, [p]).projects.find((x) => x.id === p.id)!;
  assert.equal(saved.production?.analysis?.status, "unavailable");
  assert.equal(saved.production?.analysis?.technologies.length, 0);
});
test("Vercel : refus, redirections, pagination incomplète et déploiement hors périmètre ne produisent pas de relevé réussi", async () => {
  for (const fail of [401, 403, 429, 503, 302])
    await assert.rejects(
      () =>
        collectVercel(
          VERCEL_SOURCE_TEAM,
          secret,
          fakeApi(VERCEL_SOURCE_TEAM, { fail }).transport,
        ),
      (e) => e instanceof Error && !e.message.includes(secret),
    );
  await assert.rejects(
    () =>
      collectVercel(
        VERCEL_SOURCE_TEAM,
        secret,
        fakeApi(VERCEL_SOURCE_TEAM, { truncated: true }).transport,
      ),
    /incomplète/,
  );
  await assert.rejects(
    () =>
      collectVercel(
        VERCEL_SOURCE_TEAM,
        secret,
        fakeApi(VERCEL_SOURCE_TEAM, { wrongOwner: true }).transport,
      ),
    /hors périmètre/,
  );
});
test("Vercel : répartition explicite des clients, périmètre équipe et budget reconnu par domaine", () => {
  for (const [client, names] of Object.entries(VERCEL_CLIENT_PROJECTS))
    for (const name of names)
      assert.equal(vercelSuggestedClient(VERCEL_SOURCE_TEAM, name, []), client);
  assert.equal(
    vercelSuggestedClient(VERCEL_SOURCE_TEAM, "budget-quotidien-pwa", [
      "budget-quotidien-pwa.vercel.app",
    ]),
    "Perso Janssen",
  );
  assert.equal(
    vercelSuggestedClient(freshTeam(), "reborn-studio-site", []),
    null,
  );
  assert.equal(
    vercelSuggestedClient(VERCEL_SOURCE_TEAM, "lescabines-staff", []),
    null,
  );
});
let policyConnection: ReturnType<typeof connection>;
test("Vercel : aucun projet ou client créé à la découverte ; ajout en un clic atomique et sans doublon", () => {
  policyConnection = connection(VERCEL_SOURCE_TEAM);
  const c = policyConnection,
    p = remote(c.teamId),
    other = remote(c.teamId, "reborn-projets-test");
  other.domains = [
    {
      name: "second-vercel.test",
      verified: true,
      redirect: null,
      environment: "production",
    },
  ];
  const projectsBefore = list("projects", "live").length,
    clientsBefore = list("clients", "live").length;
  applyVercelSnapshot(c.id, [p, other]);
  applyVercelSnapshot(c.id, [p, other]);
  assert.equal(list("projects", "live").length, projectsBefore);
  assert.equal(list("clients", "live").length, clientsBefore);
  assert.equal(
    vercelState().projects.filter((v) => v.connectionId === c.id).length,
    2,
  );
  const one = createVercelProject(c.id, p.id),
    again = createVercelProject(c.id, p.id),
    two = createVercelProject(c.id, other.id);
  assert.equal(one.projectId, again.projectId);
  assert.equal(list("projects", "live").length, projectsBefore + 2);
  const a = get<Project>("projects", one.projectId, "live")!,
    b = get<Project>("projects", two.projectId, "live")!;
  assert.equal(a.client, "Reborn Studio");
  assert.equal(a.clientId, b.clientId);
  assert.equal(list("clients", "live").length, clientsBefore + 1);
  assert.equal(list("accesses", "live", one.projectId).length, 1);
  const client = get<Client>("clients", a.clientId!, "live")!;
  save("clients", "live", { ...client, name: "Client renommé" });
  const changed = get<Project>("projects", one.projectId, "live")!;
  save("projects", "live", {
    ...changed,
    description: "Notes manuelles",
    url: "https://manual-vercel.test",
  });
  applyVercelSnapshot(c.id, [p, other]);
  assert.equal(
    get<Project>("projects", one.projectId, "live")!.description,
    "Notes manuelles",
  );
  assert.equal(
    get<Project>("projects", one.projectId, "live")!.clientId,
    client.id,
  );
  const third = remote(c.teamId, "reporting-reborn");
  applyVercelSnapshot(c.id, [p, other, third]);
  assert.equal(
    vercelState().projects.find((v) => v.id === third.id)?.clientSuggestion,
    "Client renommé",
  );
  const addedAfterRename = createVercelProject(c.id, third.id);
  assert.equal(
    get<Project>("projects", addedAfterRename.projectId, "live")!.clientId,
    client.id,
  );
  assert.equal(list("clients", "live").length, clientsBefore + 1);
});
test("Vercel : les deux projets à virer restent visibles mais ne peuvent être ajoutés ni rattachés", () => {
  const c = policyConnection,
    a = remote(c.teamId, "released-scan-demo"),
    b = remote(c.teamId, "mtt-lab"),
    p = local("Autre fiche");
  applyVercelSnapshot(c.id, [a, b]);
  const count = list("projects", "live").length;
  for (const v of [a, b]) {
    assert.throws(() => createVercelProject(c.id, v.id), /exclu/);
    assert.throws(() => linkVercelProject(c.id, v.id, p.id), /exclu/);
  }
  assert.equal(list("projects", "live").length, count);
  assert.equal(
    vercelState().projects.filter((v) => v.connectionId === c.id && v.excluded)
      .length,
    2,
  );
});
test("Vercel : rapprochement exact, ambiguïtés et clients manuels conservés", () => {
  const c = connection(),
    r = remote(c.teamId),
    a = local("A", `https://${r.domains[0].name}`),
    b = local("B", `https://${r.domains[0].name}`);
  assert.equal(vercelMatches(r).length, 2);
  applyVercelSnapshot(c.id, [r]);
  assert.throws(() => createVercelProject(c.id, r.id), /Plusieurs fiches/);
  save<Access>(
    "accesses",
    "live",
    {
      ...accessSchema.parse({
        label: "Vercel",
        kind: "hosting",
        url: `https://vercel.com/${r.teamSlug}/${r.name}`,
      }),
      id: randomUUID(),
      projectId: a.id,
    },
    a.id,
  );
  assert.deepEqual(
    vercelMatches(r).map((p) => p.id),
    [a.id],
  );
  const client = createClient(
    "live",
    clientSchema.parse({ name: "Client manuel" }),
  );
  save("projects", "live", { ...b, clientId: client.id, client: client.name });
  r.clientSuggestion = "Reborn Studio";
  linkVercelProject(c.id, r.id, b.id);
  applyVercelSnapshot(c.id, [r]);
  assert.equal(get<Project>("projects", b.id, "live")!.clientId, client.id);
  assert.equal(
    vercelState().projects.find((v) => v.id === r.id)!.projectId,
    b.id,
  );
});
test("Vercel : secret chiffré, échecs sans perte, absence conservée et déconnexion locale", async () => {
  const c = connection(),
    r = remote(c.teamId);
  applyVercelSnapshot(c.id, [r]);
  const stored = database()
    .prepare("SELECT secret_cipher FROM vercel_connections WHERE id=?")
    .get(c.id) as { secret_cipher: string };
  assert.ok(!stored.secret_cipher.includes(secret));
  assert.equal(
    openConnectorSecret(
      stored.secret_cipher,
      `vigie:vercel:v1:${c.id}:${c.teamId}`,
    ),
    secret,
  );
  assert.throws(() =>
    openConnectorSecret(stored.secret_cipher, "wrong-context"),
  );
  assert.throws(
    () => saveVercelConnection({ ...c, teamId: freshTeam() }, c.id),
    /autre connexion/,
  );
  assert.throws(() => saveVercelConnection({ ...c, secret }), /déjà connectée/);
  const success = vercelState().connections.find(
    (v) => v.id === c.id,
  )!.lastSuccessAt;
  await assert.rejects(
    () => synchronizeVercel(c.id, fakeApi(c.teamId).transport),
    /30 secondes/,
  );
  expire(c.id);
  await assert.rejects(
    () => synchronizeVercel(c.id, fakeApi(c.teamId, { fail: 503 }).transport),
    /impossible/,
  );
  assert.equal(
    vercelState().connections.find((v) => v.id === c.id)!.lastSuccessAt,
    success,
  );
  assert.ok(vercelState().projects.some((v) => v.id === r.id));
  applyVercelSnapshot(c.id, []);
  assert.ok(vercelState().projects.find((v) => v.id === r.id)?.missingSince);
  assert.throws(() => createVercelProject(c.id, r.id), /plus présent/);
  applyVercelSnapshot(c.id, [r]);
  assert.equal(
    vercelState().projects.find((v) => v.id === r.id)?.missingSince,
    null,
  );
  const created = createVercelProject(c.id, r.id);
  disconnectVercel(c.id);
  await assert.rejects(() => synchronizeVercel(c.id), /manquant/);
  assert.equal(
    vercelState().projects.find((v) => v.id === r.id)?.projectId,
    created.projectId,
  );
  remove("projects", created.projectId, "live");
  assert.equal(
    vercelState().projects.find((v) => v.id === r.id)?.projectId,
    null,
  );
});
test("Vercel : routes protégées, aucune fuite dans les réponses et ajout authentifié", async () => {
  const c = connection(),
    p = remote(c.teamId);
  applyVercelSnapshot(c.id, [p]);
  const existing = local("Route existante");
  async function call(
    method: string,
    path: string,
    payload?: unknown,
    cookie = "",
    origin = "http://127.0.0.1:3001",
  ) {
    return { GET, POST, PATCH, DELETE }[method as "GET"](
      new Request(`http://127.0.0.1:3001/api/${path}`, {
        method,
        headers: { cookie, origin, "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
  }
  for (const [method, path, value] of [
    ["GET", "vercel", undefined],
    ["POST", "vercel", {}],
    ["PATCH", `vercel/${c.id}`, {}],
    ["POST", `vercel/${c.id}/sync`, {}],
    ["POST", `vercel/${c.id}/projects/${p.id}/create`, {}],
    [
      "POST",
      `vercel/${c.id}/projects/${p.id}/link`,
      { projectId: existing.id },
    ],
    ["DELETE", `vercel/${c.id}/token`, undefined],
  ] as const)
    assert.equal((await call(method, path, value)).status, 401);
  const cookie = (await authFixture()).cookie;
  assert.equal(
    (
      await call(
        "POST",
        `vercel/${c.id}/projects/${p.id}/create`,
        {},
        cookie,
        "https://attacker.test",
      )
    ).status,
    403,
  );
  const response = await call("GET", "vercel", undefined, cookie);
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes(secret));
  const create = await call(
    "POST",
    `vercel/${c.id}/projects/${p.id}/create`,
    {},
    cookie,
  );
  assert.equal(create.status, 200);
  const id = (await create.json()).projectId;
  const detail = await call("GET", `projects/${id}`, undefined, cookie);
  assert.ok(
    (await detail.json()).vercel.some((v: { id: string }) => v.id === p.id),
  );
});
