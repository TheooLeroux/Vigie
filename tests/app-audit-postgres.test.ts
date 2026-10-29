import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
test("PostgreSQL isolé : historique complet filtré et catalogue de reprise", { skip: !process.env.VIGIE_UPDATES_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.VIGIE_UPDATES_TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const admin = new Pool({ connectionString: url.href }), schema = "audit_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href; delete process.env.VIGIE_DB_PATH;
  const { postgresPool } = await import("../src/lib/storage");
  const pool = postgresPool();
  try {
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const { createProject, save } = await import("../src/lib/db");
    const { createProjectSchema } = await import("../src/lib/validation");
    const { activityPage } = await import("../src/lib/activity");
    const { recordedBackups } = await import("../src/lib/backups");
    const p = await createProject("live", createProjectSchema.parse({ name: "Audit PG" }));
    for (let index = 0; index < 105; index++) await save("activity", "live", { id: randomUUID(), projectId: p.id, projectName: p.name, action: "project.reviewed", detail: "PG archive 100%_" + index, createdAt: new Date(Date.UTC(2025, 0, 1) + index * 1000).toISOString() }, p.id);
    const result = await activityPage({ projectId: p.id, query: "PG archive", kind: "Revues", page: 4 }, "live");
    assert.equal(result.total, 105); assert.equal(result.items.length, 5);
    assert.equal((await activityPage({ projectId: p.id, query: "100%_0" }, "live")).total, 1);
    await pool.query("INSERT INTO update_runs(id,project_id,stage,data) VALUES($1,$2,$3,$4)", [randomUUID(), p.id, "completed", JSON.stringify({ id: "run", projectId: p.id, createdAt: new Date().toISOString(), targets: [{ id: "t", name: "WP", provider: "o2switch" }], results: [{ targetId: "t", stage: "completed", backup: "/home/test/.vigie-backups/fixture" }] })]);
    assert.equal((await recordedBackups()).items[0].kind, "wordpress");
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
