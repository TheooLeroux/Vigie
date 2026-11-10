import { normalizeImageDigest } from "../image-reference";
import { deploymentObservationLifetime, observationIsFresh } from "../observation-freshness";
import { railwayRuntimeDeployments } from "../railway-status";
import type { ProjectDetail } from "../types";
import type { UpdateCheck, UpdateRun, UpdateState, UpdateTarget } from "./types";

export type RailpackImageIdentity = { targetId: string; projectId: string; deploymentId: string; imageDigest: string; commit: string; caddy: string };
export type RailpackImageReport = RailpackImageIdentity & { check: UpdateCheck; error?: string };

export function sameRailpackImage(a: RailpackImageIdentity, b: RailpackImageIdentity) {
  return a.targetId === b.targetId && a.projectId === b.projectId && a.deploymentId === b.deploymentId &&
    a.imageDigest === b.imageDigest && a.commit === b.commit && a.caddy === b.caddy;
}

export function railpackImageIdentity(target: UpdateTarget, railway: ProjectDetail["railway"]): RailpackImageIdentity | null {
  if (target.provider !== "railway" || target.mode !== "git") return null;
  const project = railway?.find(item => item.projectId === target.projectId && item.connectionId === target.connectionId &&
    item.services.some(service => service.id === target.remoteId && service.environmentId === target.environmentId));
  if (!project?.configured || project.missingSince || project.connectionError || !observationIsFresh(project.observedAt, deploymentObservationLifetime)) return null;
  const service = project.services.find(item => item.id === target.remoteId && item.environmentId === target.environmentId)!;
  const active = railwayRuntimeDeployments(service);
  const deployment = active[0], evidence = deployment?.evidence;
  if (active.length !== 1 || deployment.status !== "SUCCESS" || !evidence ||
    evidence.repository !== target.repository || evidence.branch !== target.branch ||
    (evidence.rootDirectory || "").replace(/^\/+|\/+$/g, "") !== target.root) return null;
  const imageDigest = normalizeImageDigest(evidence.imageDigest);
  const caddy = evidence.railpackVersion ? (service.builder === "RAILPACK" && evidence.staticSite ? evidence.packages.find(pkg => pkg.name === "caddy" && pkg.usage === "runtime")?.version : undefined) : "minimal-static";
  if (!imageDigest || !evidence.commit || !caddy) return null;
  return { targetId: target.id, projectId: target.projectId, deploymentId: deployment.id, imageDigest, commit: evidence.commit, caddy };
}

export function railpackImageReport(run: UpdateRun, identity: RailpackImageIdentity): RailpackImageReport | null {
  if (identity.caddy === "minimal-static") return null;
  if (run.projectId !== identity.projectId || run.purpose || !["completed", "failed", "attention"].includes(run.stage)) return null;
  const result = run.results.find(item => item.targetId === identity.targetId && item.stage === "completed" && item.commit === identity.commit && item.deploymentId === identity.deploymentId);
  const proof = result?.checks?.findLast(check => check.tool === "Caddy" && check.phase === "after" && check.status === "passed");
  const observed = proof?.caddyEvidence;
  if (observed?.deploymentId !== identity.deploymentId || observed.version !== identity.caddy || normalizeImageDigest(observed.imageDigest) !== identity.imageDigest ||
    !observed.instances.length || !/^[a-f0-9]{64}$/.test(observed.binaryHash) || !/^[a-f0-9]{64}$/.test(observed.packagesHash)) return null;
  const deployed = result?.checks?.findLast(check => check.tool === "Trivy" && check.phase === "after" && check.scope === "Image Railpack déployée après correctifs Debian");
  const candidate = result?.checks?.findLast(check => check.tool === "Trivy" && check.phase === "candidate" && check.scope === `Image Railpack Caddy ${identity.caddy}`);
  const scan = deployed && Date.parse(deployed.checkedAt) >= Date.parse(proof!.checkedAt) ? deployed
    : candidate && Date.parse(candidate.checkedAt) <= Date.parse(proof!.checkedAt) ? candidate : undefined;
  if (!scan || scan.status === "blocked") return null;
  const { caddyRetained: _retained, debianUpgrades: _upgrades, ...check } = scan;
  return { ...identity, check };
}

export function activeRailpackImageReport(target: UpdateTarget, detail: ProjectDetail, state?: UpdateState | null) {
  const identity = railpackImageIdentity(target, detail.railway);
  if (!identity) return null;
  const report = state?.railpackImageReports?.find(item => sameRailpackImage(item, identity));
  return report || state?.runs.map(run => railpackImageReport(run, identity)).find(item => item !== null) || null;
}
