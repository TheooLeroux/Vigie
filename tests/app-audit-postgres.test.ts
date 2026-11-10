import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
test("PostgreSQL isolé : historique complet filtré et catalogue des sauvegardes", { skip: !process.env.VIGIE_UPDATES_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.VIGIE_UPDATES_TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const admin = new Pool({ connectionString: url.href }), schema = "audit_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href; delete process.env.VIGIE_DB_PATH;
  const { postgresPool } = await import("../src/lib/storage");
  const pool = postgresPool();
  const directory = await mkdtemp(join(tmpdir(), "vigie-backup-pg-"));
  process.env.VIGIE_BACKUP_DIRECTORY = directory;
  try {
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const { createProject, save } = await import("../src/lib/db");
    const { createProjectSchema } = await import("../src/lib/validation");
    const { activityPage } = await import("../src/lib/activity");
    const { listBackups, runBackup } = await import("../src/lib/backups");
    const p = await createProject("live", createProjectSchema.parse({ name: "Audit PG" }));
    for (let index = 0; index < 105; index++) await save("activity", "live", { id: randomUUID(), projectId: p.id, projectName: p.name, action: "project.reviewed", detail: "PG archive 100%_" + index, createdAt: new Date(Date.UTC(2025, 0, 1) + index * 1000).toISOString() }, p.id);
    const result = await activityPage({ projectId: p.id, query: "PG archive", kind: "Revues", page: 4 }, "live");
    assert.equal(result.total, 105); assert.equal(result.items.length, 5);
    assert.equal((await activityPage({ projectId: p.id, query: "100%_0" }, "live")).total, 1);
    const collectionId = randomUUID();
    for (const [index, action] of ["hosting.inventory", "hosting.inventory", "hosting.inventory_failed"].entries()) {
      await save("activity", "live", {
        id: randomUUID(), projectId: p.id, projectName: p.name, action,
        collectionId: index < 2 ? collectionId : undefined,
        detail: "PG collection", createdAt: new Date(Date.UTC(2025, 0, 2) + index * 1000).toISOString(),
      }, p.id);
    }
    const complete = await activityPage({ projectId: p.id, query: "PG collection", view: "complete" }, "live");
    assert.equal(complete.total, 2);
    assert.deepEqual(complete.items.map(item => item.collectionId), [undefined, collectionId, collectionId]);
    const focus = await activityPage({ projectId: p.id, query: "PG collection", view: "focus" }, "live");
    assert.deepEqual(focus.items.map(item => item.action), ["hosting.inventory_failed"]);
    const writeFixture = (_folder: string, zip: string) => writeFile(zip, "fixture");
    assert.equal(await runBackup(p.id, writeFixture), true);
    assert.equal(await runBackup(p.id, writeFixture), false);
    assert.deepEqual((await listBackups()).map(group => [group.projectName, group.backups.length]), [["Audit PG", 1]]);
  } finally {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
