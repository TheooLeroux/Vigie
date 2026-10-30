import { activeUpdateStages, type UpdateRun, type UpdateStage } from "./types";

function evidence(run: UpdateRun) {
  return JSON.stringify([run.stage, run.message, run.results.map(result => [result.targetId, result.stage, result.message, result.commit, result.deploymentId, result.warnings.length, (result.checks || []).map(check => [check.tool, check.phase, check.checkedAt, check.status, check.findings.length])])]);
}

// A worker heartbeat proves liveness only. Advance this clock for a changed
// phase/message or a new validation result, including repeated candidate checks.
export function createUpdateProgressTracker(run: UpdateRun) {
  let previous = evidence(run);
  return (stage: UpdateStage, message: string, now = Date.now()) => {
    run.stage = stage; run.message = message;
    const next = evidence(run), changed = next !== previous;
    if (changed) run.lastProgressAt = new Date(now).toISOString();
    previous = next;
    return changed;
  };
}

export function updateProgressStatus(run: UpdateRun, now = Date.now()) {
  const active = activeUpdateStages.includes(run.stage);
  const age = now - Date.parse(run.lastProgressAt || "");
  return {
    heartbeatMissing: active && now - Date.parse(run.updatedAt) > 10 * 60_000,
    noConfirmedProgress: active && Number.isFinite(age) && age >= 15 * 60_000,
  };
}
