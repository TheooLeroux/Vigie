import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateProgressTracker, updateProgressStatus } from "../src/lib/updates/progress";
import { healthCheck, healthUpdates } from "./project-health-fixture";

test("Progression : le battement et les messages répétés ne masquent pas une étape prolongée", () => {
  const run = healthUpdates().runs[0], start = Date.parse(run.createdAt);
  const track = createUpdateProgressTracker(run);
  assert.equal(track("updating", "Contrôle OSV candidat", start), true);
  run.updatedAt = new Date(start + 16 * 60_000).toISOString();
  assert.equal(track("updating", "Contrôle OSV candidat", start + 16 * 60_000), false);
  assert.equal(run.lastProgressAt, new Date(start).toISOString());
  assert.deepEqual(updateProgressStatus(run, start + 16 * 60_000), { heartbeatMissing: false, noConfirmedProgress: true });
  run.results[0].checks!.push(healthCheck({ checkedAt: new Date(start + 16 * 60_000).toISOString() }));
  assert.equal(track("updating", "Contrôle OSV candidat", start + 16 * 60_000), true);
  assert.equal(updateProgressStatus(run, start + 16 * 60_000).noConfirmedProgress, false);
  track("completed", "Terminé", start + 17 * 60_000);
  assert.deepEqual(updateProgressStatus(run, start + 40 * 60_000), { heartbeatMissing: false, noConfirmedProgress: false });
});

test("Progression : exécuteur muet et historique sans horloge de progression restent distincts", () => {
  const run = healthUpdates().runs[0], now = Date.parse(run.updatedAt) + 16 * 60_000;
  run.stage = "checking";
  assert.deepEqual(updateProgressStatus(run, now), { heartbeatMissing: true, noConfirmedProgress: false });
  run.lastProgressAt = "invalid";
  assert.equal(updateProgressStatus(run, now).noConfirmedProgress, false);
});
