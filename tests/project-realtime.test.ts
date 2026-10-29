import test from "node:test";
import assert from "node:assert/strict";
import { changedProjects, createRefreshQueue, hasProjectChanges, type ProjectRevision } from "../src/lib/project-realtime";

const row = (key: string, project_id: string | null, revision = "1", kind = "detail"): ProjectRevision => ({ key, project_id, revision, kind });
test("Realtime : mises à jour ciblées, suppressions et changement de rattachement", () => {
  const previous = [row("v1", "first"), row("v2", "second"), row("u1", "third")];
  assert.equal(hasProjectChanges(changedProjects(previous, [...previous].reverse())), false);
  assert.deepEqual(changedProjects(previous, [row("v1", "first", "2"), previous[1], previous[2]]).projects, ["first"]);
  const change = changedProjects(previous, [row("v1", "fourth"), previous[1]]);
  assert.deepEqual(new Set(change.projects), new Set(["first", "fourth", "third"]));
  assert.equal(change.workspace, false);
  assert.equal(changedProjects([], [row("project", "new", "1", "project")]).workspace, true);
  assert.equal(changedProjects([], [row("release", null, "1", "all")]).all, true);
  assert.equal(changedProjects(undefined, previous).all, true);
});
test("Realtime : un changement d’historique ne relit pas les synthèses", () => {
  const change = changedProjects([], [row("activity", "first", "1", "activity")]);
  assert.deepEqual(change.projects, []);
  assert.deepEqual(change.activityProjects, ["first"]);
  assert.equal(change.workspace, false);
});
test("Realtime : rafales regroupées, invalidations en vol conservées, aucune boucle au repos", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[][] = [];
  let finish!: () => void;
  const queue = createRefreshQueue(async keys => { calls.push(keys); if (calls.length === 1) await new Promise<void>(resolve => { finish = resolve; }); });
  queue.invalidate(["one"]); queue.invalidate(["one", "two"]);
  t.mock.timers.tick(250);
  assert.deepEqual(calls, [["one", "two"]]);
  queue.invalidate(["three"]); queue.invalidate(["three", "one"]);
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 1);
  finish(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(250); await Promise.resolve();
  assert.deepEqual(calls[1], ["three", "one"]);
  t.mock.timers.tick(600_000);
  assert.equal(calls.length, 2);
  queue.invalidate(["cancelled"]); queue.dispose();
  t.mock.timers.tick(600_000);
  assert.equal(calls.length, 2);
});
