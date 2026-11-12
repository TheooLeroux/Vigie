import { withAuditActor } from "../audit-context";
import { list, log, requireProject, transaction } from "../db";
import { ApiError } from "../http";
import type { Project } from "../types";
import { startProjectUpdate } from "./service";
import { updateStorage } from "./storage";
import type { UpdateRun } from "./types";
import { assessmentHasNoTarget } from "./assessment";

// Assessments can never have published anything. Only an unchanged report with
// no heartbeat for two hours may release its scopes after a dead runner.
export async function expireInterruptedAssessments(now = Date.now(), projectId?: string) {
  const db = await updateStorage();
  const scope = projectId ? " AND project_id=?" : "";
  const rows = await db.prepare("SELECT data FROM update_runs WHERE json_extract(data,'$.purpose')='assessment' AND stage IN ('queued','checking','updating')" + scope)
    .all(...(projectId ? [projectId] : [])) as { data: string }[];
  for (const row of rows) {
    const run = JSON.parse(row.data) as UpdateRun;
    if (now - Date.parse(run.updatedAt) < 2 * 60 * 60_000) continue;
    run.stage = "failed"; run.updatedAt = new Date(now).toISOString(); run.message = "Bilan préalable interrompu : aucun résultat actuel confirmé, aucune installation effectuée.";
    await transaction(async () => {
      const changed = await db.prepare("UPDATE update_runs SET stage=?,data=? WHERE id=? AND data=?").run(run.stage, JSON.stringify(run), run.id, row.data);
      if (changed.changes) {
        await db.prepare("DELETE FROM update_locks WHERE run_id=?").run(run.id);
        await withAuditActor(run.actor, () => log("live", "updates.assessment_failed", run.message, run.projectId));
      }
    });
  }
}

const dailyDependencies = {
  projects: async (projectId?: string) => projectId ? [await requireProject(projectId, "live")] : list<Project>("projects", "live"),
  start: startProjectUpdate,
  expire: (projectId?: string) => expireInterruptedAssessments(Date.now(), projectId),
};

export async function planDailyAssessments(dependencies = dailyDependencies, projectId?: string) {
  const projects = (await dependencies.projects(projectId)).filter(project => project.lifecycle === "active" && (!projectId || project.id === projectId));
  if (projectId && !projects.length) throw new ApiError("Le projet de la relance doit être actif.", 409);
  await dependencies.expire(projectId);
  const result = { runs: [] as string[], noEligibleTarget: 0, deferred: 0, failed: 0 };
  for (const project of projects) {
    try {
      const run = await dependencies.start({ projectId: project.id }, async () => {}, { assessment: true, retryAssessment: Boolean(projectId) });
      if (run.purpose === "assessment" && run.stage === "queued") result.runs.push(run.id);
      else if (assessmentHasNoTarget(run)) result.noEligibleTarget++;
      else result.deferred++;
    } catch (error) {
      if (projectId) throw error;
      result.failed++;
    }
  }
  if (result.runs.length > 256) throw new Error("Le parc dépasse le nombre de bilans admis par cette matrice.");
  return result;
}
