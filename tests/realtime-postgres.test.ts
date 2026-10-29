import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { projectRealtimeSql } from "../src/lib/project-realtime-query";
import { changedProjects, hasProjectChanges } from "../src/lib/project-realtime";

test("PostgreSQL : événements de workers, rapports Railway sans sources, suppression et révocation", { skip: !process.env.VIGIE_UPDATES_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.VIGIE_UPDATES_TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const pool = new Pool({ connectionString: url.href });
  const db = await pool.connect(), schema = `realtime_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema}`);
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await db.query(`INSERT INTO "user" VALUES ('user', 'QA', 'qa@example.test', true, NULL, now(), now())`);
    await db.query(`INSERT INTO "session" (id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES ('session','2099-01-01','test',now(),now(),'user')`);
    for (const id of ["first", "second"]) await db.query("INSERT INTO projects(id,workspace,data) VALUES ($1,'live','{}')", [id]);
    await db.query("INSERT INTO railway_connections(id,workspace_id,data) VALUES ('connection','workspace','{}')");
    await db.query(`INSERT INTO railway_projects(connection_id,remote_id,project_id,observed_at,data) VALUES ('connection','remote','first','2026-10-29', $1)`, [JSON.stringify({ services: [{ id: "service", environmentId: "env" }] })]);
    const read = async () => (await db.query(projectRealtimeSql, ["session", "user", "qa@example.test", "2099-01-01"])).rows;
    const initial = await read();
    assert.ok(initial.some(row => row.key === "authorized"));
    await db.query(`INSERT INTO wordpress_catalog VALUES ('control:lease:1:railway:connection:service:env','not-json','2099-01-01')`);
    assert.equal(hasProjectChanges(changedProjects(initial, await read())), false);
    await db.query(`INSERT INTO wordpress_catalog VALUES ('control:report:1:railway:connection:service:env','{"identity":"unavailable","checks":[]}','2099-01-01')`);
    const report = await read();
    assert.deepEqual(changedProjects(initial, report).projects, ["first"]);
    await db.query("UPDATE railway_projects SET project_id='second'");
    const relinked = await read();
    assert.deepEqual(new Set(changedProjects(report, relinked).projects), new Set(["first", "second"]));
    await db.query(`INSERT INTO update_runs VALUES ('run','second','checking','{"stage":"checking"}')`);
    const running = await read();
    assert.deepEqual(changedProjects(relinked, running).projects, ["second"]);
    await db.query(`UPDATE update_runs SET stage='completed',data='{"stage":"completed"}' WHERE id='run'`);
    assert.deepEqual(changedProjects(running, await read()).projects, ["second"]);
    const beforeDelete = await read();
    await db.query("DELETE FROM wordpress_catalog WHERE cache_key LIKE 'control:report:%'");
    assert.deepEqual(changedProjects(beforeDelete, await read()).projects, ["second"]);
    await db.query(`UPDATE "user" SET "emailVerified"=false`);
    assert.deepEqual(await read(), []);
    await db.query(`UPDATE "user" SET "emailVerified"=true`);
    await db.query(`DELETE FROM "session" WHERE id='session'`);
    assert.deepEqual(await read(), []);
  } finally {
    await db.query("SET search_path TO public"); await db.query(`DROP SCHEMA ${schema} CASCADE`);
    db.release(); await pool.end();
  }
});
