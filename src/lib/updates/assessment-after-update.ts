import { randomUUID } from "node:crypto";
import { transaction } from "../db";
import { observedProjectDetail } from "../project-observations";
import { controlSource } from "../automatic-control-state";
import { updateTargets } from "./targets";
import { updateStorage } from "./storage";
import { activeUpdateStages, type UpdateRun, type UpdateResult } from "./types";

// A successful installation already ran the solver. Bind that result to the
// newly observed deployment instead of immediately re-advertising registry
// versions the solver could not validate. Never manufacture a proof if provider
// refresh failed or a different deployment is now active.
export async function recordAssessmentAfterUpdate(run: UpdateRun, dependencies = { detail: observedProjectDetail, targets: updateTargets, save: saveAssessment }) {
  if (run.purpose || run.stage !== "completed") return;
  const detail = await dependencies.detail(run.projectId, "live");
  const targets = await dependencies.targets(run.projectId);
  const assessmentSources: Record<string, string> = {};
  const results: UpdateResult[] = [];
  for (const result of run.results.filter(result => result.stage === "completed")) {
    const target = targets.find(target => target.id === result.targetId);
    if (!target) continue;
    const source = controlSource(target, detail);
    if (!source) continue;
    const proof = result.checks?.findLast(check => check.phase === "after" && check.status !== "blocked" && (check.nodeEvidence || check.staticEvidence));
    const node = proof?.nodeEvidence || proof?.staticEvidence;
    const wp = result.checks?.findLast(check => check.tool === "WPVulnerability" && check.phase === "after" && check.status !== "blocked");
    const inventory = detail.hosting?.find(site => site.id === target.remoteId && site.connectionId === target.connectionId)?.inventory;
    const bound = target.mode === "image" ? !!result.imageUpdate?.verified && source.image === result.imageUpdate.candidate
      : target.mode === "wordpress" ? !!wp && !!inventory?.observedAt && Date.parse(inventory.observedAt) >= Date.parse(wp.checkedAt) - 5000
      : !!node && node.deploymentId === source.deploymentId && (!node.commit || node.commit === source.commit);
    if (!bound) continue;
    assessmentSources[target.id] = source.identity;
    results.push({ targetId: target.id, name: target.name, stage: "completed", message: "La combinaison stable retenue a été installée et contrôlée lors de la dernière maintenance.", warnings: result.warnings, manualUpdates: result.manualUpdates, assessment: { changes: [], limitation: "Les versions de catalogue non retenues ne sont pas annoncées comme des propositions validées. La recherche quotidienne comparera les nouvelles publications." } });
  }
  if (!results.length) return;
  const now = new Date().toISOString();
  const report: UpdateRun = { id: randomUUID(), projectId: run.projectId, purpose: "assessment", assessmentOrigin: "maintenance", stage: "completed", createdAt: now, updatedAt: now, actor: run.actor, targets: targets.filter(target => results.some(result => result.targetId === target.id)), results, assessmentSources, message: "Bilan des versions installées après maintenance.", excludedTargets: targets.filter(target => !results.some(result => result.targetId === target.id)).map(target => ({ targetId: target.id, name: target.name, reason: "Ce bloc n’est pas confirmé par la dernière maintenance ; son bilan reste séparé." })) };
  await dependencies.save(report);
}

async function saveAssessment(report: UpdateRun) {
  const db = await updateStorage();
  await transaction(async () => {
    const rows = await db.prepare("SELECT data FROM update_runs WHERE project_id=?").all(report.projectId) as { data: string }[];
    if (rows.some(row => activeUpdateStages.includes((JSON.parse(row.data) as UpdateRun).stage))) return;
    await db.prepare("INSERT INTO update_runs(id,project_id,stage,data) VALUES(?,?,?,?)").run(report.id, report.projectId, report.stage, JSON.stringify(report));
  });
}
