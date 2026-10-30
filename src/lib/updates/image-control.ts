import { controlSource, type AutomaticControl } from "../automatic-control-state";
import { writeAutomaticControl } from "../automatic-control-storage";
import { observedProjectDetail } from "../project-observations";
import { railwayRuntimeDeployments } from "../railway-status";
import type { ProjectDetail } from "../types";
import type { UpdateResult, UpdateRun, UpdateTarget } from "./types";
import { normalizeImageDigest } from "../image-reference";

export function completedImageControl(target: UpdateTarget, result: UpdateResult, detail: ProjectDetail): AutomaticControl | null {
  const proof = result.imageUpdate?.verified, source = controlSource(target, detail);
  const check = result.checks?.findLast(check => check.tool === "Trivy" && check.phase === "after");
  const service = detail.railway?.find(project => project.connectionId === target.connectionId)?.services.find(service => service.id === target.remoteId && service.environmentId === target.environmentId);
  const active = service && railwayRuntimeDeployments(service);
  if (result.stage !== "completed" || !proof || result.deploymentId !== proof.deploymentId || !source?.image || source.image !== result.imageUpdate!.candidate || !check || check.scope !== source.image || check.status === "blocked" || !active?.length || active.some(deployment => deployment.id !== proof.deploymentId || normalizeImageDigest(deployment.evidence?.imageDigest) !== proof.digest)) return null;
  return { targetId: target.id, identity: source.identity, attemptedAt: check.checkedAt, checkedAt: check.checkedAt, checks: [check], updates: [], warnings: [...result.warnings], securityCoverage: { scope: "image", deploymentId: proof.deploymentId, limitations: ["Paquets de l’image contrôlés ; les données, les volumes et l’ensemble des parcours métier restent hors de ce rapport."] } };
}
export async function recordCompletedImageControls(run: UpdateRun, dependencies = { detail: observedProjectDetail, write: writeAutomaticControl }) {
  const images = run.targets.filter(target => target.mode === "image" && run.results.some(result => result.targetId === target.id && result.stage === "completed" && result.imageUpdate?.verified));
  if (!images.length) return [] as string[];
  // A synchronization failure cannot turn an old image's scan into proof for the
  // new one. The normal monitoring workflow will retry the missing observation.
  const pending: string[] = [];
  try {
    const detail = await dependencies.detail(run.projectId, "live");
    for (const target of images) {
      const control = completedImageControl(target, run.results.find(result => result.targetId === target.id)!, detail);
      try { if (control) await dependencies.write(control); else pending.push(target.id); }
      catch { pending.push(target.id); }
    }
  } catch { return images.map(target => target.id); }
  return pending;
}
