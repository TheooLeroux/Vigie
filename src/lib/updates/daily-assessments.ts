import { list, transaction } from "../db";
import type { Project } from "../types";
import { startProjectUpdate } from "./service";
import { updateStorage } from "./storage";
import type { UpdateRun } from "./types";

// Assessments can never have published anything. Only an unchanged report with
// no heartbeat for two hours may release its scopes after a dead runner.
export async function expireInterruptedAssessments(now = Date.now()) {
  const db = await updateStorage();
  const rows = await db.prepare("SELECT data FROM update_runs WHERE json_extract(data,'$.purpose')='assessment' AND stage IN ('queued','checking','updating')").all() as { data: string }[];
  for (const row of rows) {
    const run = JSON.parse(row.data) as UpdateRun;
    if (now - Date.parse(run.updatedAt) < 2 * 60 * 60_000) continue;
    run.stage = "failed"; run.updatedAt = new Date(now).toISOString(); run.message = "Bilan préalable interrompu : aucun résultat actuel confirmé, aucune installation effectuée.";
    await transaction(async () => {
      const changed = await db.prepare("UPDATE update_runs SET stage=?,data=? WHERE id=? AND data=?").run(run.stage, JSON.stringify(run), run.id, row.data);
      if (changed.changes) await db.prepare("DELETE FROM update_locks WHERE run_id=?").run(run.id);
    });
  }
}

export async function planDailyAssessments(dependencies = { projects: () => list<Project>("projects", "live"), start: startProjectUpdate, expire: expireInterruptedAssessments }) {
  await dependencies.expire();
  const result = { runs: [] as string[], deferred: 0, failed: 0 };
  for (const project of (await dependencies.projects()).filter(project => project.lifecycle === "active")) {
    try {
      const run = await dependencies.start({ projectId: project.id }, async () => {}, { assessment: true });
      if (run.purpose === "assessment" && run.stage === "queued") result.runs.push(run.id);
      else result.deferred++;
    } catch { result.failed++; }
  }
  if (result.runs.length > 256) throw new Error("Le parc dépasse le nombre de bilans admis par cette matrice.");
  return result;
}
