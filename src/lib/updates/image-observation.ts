import { normalizeImageDigest } from "../image-reference";
import { railwayRuntimeDeployments } from "../railway-status";
import type { ProjectDetail } from "../types";
import type { UpdateResult, UpdateState, UpdateTarget } from "./types";

// A recent inventory can still predate a proven image replacement. Its scan
// remains historical until the provider confirms which deployment is active.
export function imageObservationPending(target: UpdateTarget, detail: ProjectDetail, state?: UpdateState | null) {
  if (target.provider !== "railway") return false;
  const project = detail.railway?.find(project => project.connectionId === target.connectionId && project.services.some(service => service.id === target.remoteId && service.environmentId === target.environmentId));
  const service = project?.services.find(service => service.id === target.remoteId && service.environmentId === target.environmentId);
  if (!project || !service) return false;
  let latest: { result: UpdateResult; at: number } | undefined;
  for (const run of state?.runs || []) {
    if (run.projectId !== detail.project.id || !run.targets.some(previous => previous.id === target.id && previous.connectionId === target.connectionId && previous.remoteId === target.remoteId && previous.environmentId === target.environmentId)) continue;
    for (const result of run.results) {
      if (result.targetId !== target.id || !result.imageUpdate) continue;
      const replaced = result.stage === "completed" && result.imageUpdate.verified && result.deploymentId !== result.previousDeploymentId;
      if (!replaced && result.stage !== "attention") continue;
      const at = Date.parse(replaced ? result.checks?.findLast(check => check.tool === "Trivy" && check.phase === "after")?.checkedAt || run.updatedAt : run.updatedAt);
      if (Number.isFinite(at) && (!latest || at > latest.at)) latest = { result, at };
    }
  }
  if (!latest || !(latest.at > Date.parse(project.observedAt))) return false;
  const result = latest.result, image = result.imageUpdate!;
  const expectedId = image.rollbackDeploymentId || image.verified?.deploymentId || result.deploymentId;
  const expectedDigest = image.rollbackDeploymentId ? normalizeImageDigest(image.previous.split("@")[1]) : image.digest;
  const active = railwayRuntimeDeployments(service);
  return !expectedId || active.length !== 1 || active.some(deployment => deployment.id !== expectedId || deployment.status !== "SUCCESS" || normalizeImageDigest(deployment.evidence?.imageDigest) !== expectedDigest);
}
