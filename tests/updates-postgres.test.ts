import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import type { VercelProject } from "../src/lib/vercel-types";

test("PostgreSQL isolé : migration et concurrence réelle des mises à jour", { skip: !process.env.VIGIE_UPDATES_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.VIGIE_UPDATES_TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Ce test crée un schéma jetable uniquement dans un PostgreSQL local de test.");
  const admin = new Pool({ connectionString: url.href });
  const schema = `vigie_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href;
  delete process.env.VIGIE_DB_PATH;
  process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.VIGIE_UPDATES_ENABLED = "1";
  process.env.VIGIE_UPDATES_RUNNER_REPOSITORY = "qa/runner";
  process.env.VIGIE_UPDATES_GITHUB_TOKENS = '{"qa":"unit-test-no-real-token"}';
  process.env.VIGIE_UPDATES_REPOSITORIES = "qa/shared";
  const { postgresPool } = await import("../src/lib/storage");
  const pool = postgresPool();
  try {
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const { createProject } = await import("../src/lib/db");
    const { createProjectSchema } = await import("../src/lib/validation");
    const { saveVercelConnection, applyVercelSnapshot, linkVercelProject } = await import("../src/lib/vercel");
    const { startProjectUpdate, projectUpdates } = await import("../src/lib/updates/service");
    const first = await createProject("live", createProjectSchema.parse({ name: "First", url: "https://first.example.test" }));
    const second = await createProject("live", createProjectSchema.parse({ name: "Second", url: "https://second.example.test" }));
    const connection = await saveVercelConnection({ name: "QA", teamId: "team_test", secret: "fake-unit-token" });
    const remotes: VercelProject[] = [first, second].map(project => ({ id: `prj_${project.id.replaceAll("-", "")}`, name: project.name, teamId: connection.teamId, teamSlug: "qa", teamName: "QA", framework: "nextjs", nodeBranch: "24.x", rootDirectory: null, repository: "qa/shared", productionBranch: "main", domains: [{ name: new URL(project.url).hostname, verified: true, redirect: null, environment: "production" }], production: null, latest: null, excluded: false, clientSuggestion: null }));
    await applyVercelSnapshot(connection.id, remotes);
    await linkVercelProject(connection.id, remotes[0].id, first.id);
    await linkVercelProject(connection.id, remotes[1].id, second.id);
    let dispatched = 0;
    const dispatch = async () => { dispatched++; };
    const [primary, duplicate] = await Promise.all([startProjectUpdate({ projectId: first.id }, dispatch), startProjectUpdate({ projectId: first.id }, dispatch)]);
    assert.equal(primary.id, duplicate.id);
    assert.equal(dispatched, 1);
    assert.equal((await projectUpdates(first.id)).runs.length, 1);
    await assert.rejects(startProjectUpdate({ projectId: second.id }, dispatch), /déjà ces sources/);
    assert.equal((await projectUpdates(second.id)).runs.length, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM update_locks")).rows[0].count, 1);
    const demo = await createProject("demo", createProjectSchema.parse({ name: "Demo" }));
    await assert.rejects(pool.query("INSERT INTO update_runs(id,project_id,stage,data) VALUES($1,$2,'queued','{}')", [randomUUID(), demo.id]), /hors périmètre/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
