import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { database, list } from "../src/lib/db";
import type { Client, Project } from "../src/lib/types";

test("migration : anciens noms clients regroupés sans perte et relation persistante", () => {
  process.env.VIGIE_DB_PATH = ":memory:";
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL); INSERT INTO migrations VALUES(1,'2026-01-01'); CREATE TABLE projects(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,project_id TEXT,data TEXT NOT NULL);",
  );
  const fields = {
    url: "",
    description: "À conserver",
    owner: "",
    criticality: "standard",
    lifecycle: "active",
    tags: [],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    reviewedAt: null,
  };
  for (const [id, client] of [
    ["a", "Client historique"],
    ["b", "client historique"],
    ["c", ""],
  ])
    legacy
      .prepare("INSERT INTO projects VALUES (?,'live',NULL,?)")
      .run(id, JSON.stringify({ ...fields, id, name: id, client }));
  (globalThis as unknown as { vigieDb: DatabaseSync }).vigieDb = legacy;
  database();
  database();
  const data = {
    clients: list<Client>("clients", "live"),
    projects: list<Project>("projects", "live"),
  };
  assert.equal(data.clients.length, 1);
  assert.equal(data.projects.length, 3);
  assert.equal(
    data.projects.find((p) => p.id === "a")!.clientId,
    data.projects.find((p) => p.id === "b")!.clientId,
  );
  assert.equal(data.projects.find((p) => p.id === "c")!.clientId, null);
  assert.equal(data.projects[0].description, "À conserver");
  assert.throws(
    () =>
      legacy.prepare("DELETE FROM clients WHERE id=?").run(data.clients[0].id),
    /FOREIGN KEY/,
  );
  assert.equal(legacy.prepare("PRAGMA foreign_key_check").all().length, 0);
});
