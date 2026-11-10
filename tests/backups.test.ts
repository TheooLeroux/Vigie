import { authFixture } from "./auth-fixture";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GET } from "../src/app/api/[...path]/route";
import { dueBackupSlot, expiredBackupIds, runBackup } from "../src/lib/backups";
import { createProject } from "../src/lib/db";
import { sqliteDatabase } from "../src/lib/db-sqlite";
import { runCommand } from "../src/lib/updates/process";
import { createProjectSchema } from "../src/lib/validation";

test("Le passage de 03 h 13 suit le calendrier de Paris en hiver et en été", () => {
  assert.equal(dueBackupSlot(new Date("2026-11-09T02:12:59Z")), "2026-11-02");
  assert.equal(dueBackupSlot(new Date("2026-11-09T02:13:00Z")), "2026-11-09");
  assert.equal(dueBackupSlot(new Date("2026-07-06T01:12:59Z")), "2026-06-29");
  assert.equal(dueBackupSlot(new Date("2026-07-06T01:13:00Z")), "2026-07-06");
  assert.equal(dueBackupSlot(new Date("2026-07-08T19:00:00Z")), "2026-07-06");
});

test("La rétention garde cinq semaines et la dernière copie de chaque mois glissant", () => {
  const now = new Date("2026-11-30T07:00:00Z");
  const weeks = Array.from({ length: 120 }, (_, index) => {
    const created_at = new Date(now.getTime() - index * 7 * 24 * 60 * 60_000).toISOString();
    return { id: String(index), slot: created_at.slice(0, 10), created_at };
  });
  const expired = new Set(expiredBackupIds(weeks, now));
  const kept = weeks.filter(week => !expired.has(week.id));
  assert.ok(kept.length <= 17);
  assert.deepEqual(kept.slice(0, 5), weeks.slice(0, 5));
  assert.ok(kept.every(week => week.created_at >= "2025-12-01"));
  for (const month of new Set(weeks.slice(5).map(week => week.created_at.slice(0, 7)).filter(month => month >= "2025-12"))) {
    assert.ok(kept.includes(weeks.find(week => week.created_at.startsWith(month))!));
  }
});

const fixtureCapture = `
import io, pathlib, sys, tarfile
def add(tar, name, data):
    entry = tarfile.TarInfo(name)
    entry.size = len(data)
    tar.addfile(entry, io.BytesIO(data))
with tarfile.open(sys.argv[1], "w:gz") as tar:
    add(tar, "./wp-config.php", b"<?php /* fixture */")
    add(tar, "./index.php", b"<?php /* fixture */")
    entry = tarfile.TarInfo("./wp-content")
    entry.type = tarfile.DIRTYPE
    tar.addfile(entry)
    add(tar, "./wp-content/photo.txt", b"fixture-media")
if sys.argv[3] == "valid":
    pathlib.Path(sys.argv[2]).write_bytes(b"-- MariaDB dump\\nCREATE TABLE wp_posts (id int);\\n-- Dump completed on 2026-11-09\\n")
`;

test("Le ZIP vérifié s’affiche une seule fois et se télécharge uniquement avec une session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vigie-backup-test-"));
  process.env.VIGIE_BACKUP_DIRECTORY = directory;
  const python = process.env.VIGIE_BACKUP_PYTHON || (process.platform === "win32" ? "python" : "python3");
  try {
    const project = await createProject("live", createProjectSchema.parse({ name: "Copie WP" }));
    const sqlite = sqliteDatabase();
    sqlite.exec(`CREATE TABLE project_backups (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slot TEXT NOT NULL, state TEXT NOT NULL,
      owner TEXT NOT NULL, next_attempt_at TEXT NOT NULL, created_at TEXT, bytes BIGINT, UNIQUE(project_id, slot)
    );`);
    const legacyId = randomUUID();
    sqlite.prepare("INSERT INTO project_backups VALUES(?,?,?,'expired',?,?,?,NULL)")
      .run(legacyId, project.id, "2025-11-03", randomUUID(), "2025-11-03", "2025-11-03");
    let packs = 0;
    const capture = (mode: "valid" | "partial") => async (folder: string, output: string) => {
      packs++;
      const files = join(folder, "files.tar.gz");
      const database = join(folder, "database.sql");
      await runCommand(python, ["-c", fixtureCapture, files, database, mode]);
      await runCommand(python, ["scripts/pack-site-backup.py", files, database, output, project.id, "wp.example.test"]);
    };
    const slot = new Date("2026-11-09T02:13:00Z");
    const results = await Promise.all([runBackup(project.id, capture("valid"), slot), runBackup(project.id, capture("valid"), slot)]);
    assert.equal(packs, 1);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(sqlite.prepare("SELECT source_id FROM project_backups WHERE id=?").get(legacyId)?.source_id, "project:" + project.id);
    await assert.rejects(runBackup(project.id, capture("partial"), new Date("2026-11-16T02:13:00Z")));
    const [{ cookie }, [name]] = await Promise.all([authFixture(), readdir(directory)]);
    assert.match(name, /^[a-f0-9-]+\.zip$/);
    const get = (path: string[], authenticated = true) => GET(
      new Request(`http://127.0.0.1:3001/api/${path.join("/")}`, { headers: authenticated ? { cookie } : {} }),
      { params: Promise.resolve({ path }) },
    );
    const listing = await get(["backups"]);
    assert.equal(listing.status, 200);
    const groups = await listing.json();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].projectName, project.name);
    assert.equal(groups[0].backups.length, 1);
    const [{ id, createdAt }] = groups[0].backups;
    assert.equal(createdAt, slot.toISOString());
    assert.doesNotMatch(JSON.stringify(groups), /sha256|transfer|example\.test/);

    const route = ["backups", id, "download"];
    assert.equal((await get(route, false)).status, 401);
    assert.equal((await get(["backups", randomUUID(), "download"])).status, 404);
    const response = await get(route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(response.headers.get("content-disposition")!, /attachment;.*2026-11-09\.zip/);
    const downloaded = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get("content-length")), downloaded.length);
    const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    assert.equal(sha(downloaded), sha(await readFile(join(directory, name))));
    await unlink(join(directory, name));
    assert.equal((await get(route)).status, 404);
    assert.deepEqual(await (await get(["backups"])).json(), []);

    const sites = [
      { installationId: "one", projectId: project.id, domain: "one.example.test" },
      { installationId: "two", projectId: project.id, domain: "two.example.test" },
      { installationId: "unlinked", projectId: null, domain: "unlinked.example.test" },
    ];
    const copy = (_folder: string, output: string) => writeFile(output, downloaded);
    assert.deepEqual(await Promise.all(sites.map(site => runBackup(site, copy, slot))), [true, true, true]);
    assert.deepEqual(await Promise.all(sites.map(site => runBackup(site, copy, slot))), [false, false, false]);
    const bySite = await (await get(["backups"])).json();
    assert.deepEqual(bySite.map((site: { projectName: string }) => site.projectName), sites.map(site => site.domain));
    assert.ok(bySite.every((site: { backups: unknown[] }) => site.backups.length === 1));
    const unlinked = await get(["backups", bySite[2].backups[0].id, "download"]);
    assert.equal(unlinked.status, 200);
    assert.equal((await unlinked.arrayBuffer()).byteLength, downloaded.length);
  } finally {
    delete process.env.VIGIE_BACKUP_DIRECTORY;
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  }
});
