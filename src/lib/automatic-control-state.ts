import type { ProjectObservationDetail } from "./types";
import type { UpdateCheck, UpdateTarget, UpdateState } from "./updates/types";
import { railwayRuntimeDeployments } from "./railway-status";
import { wordpressSecurityVersions } from "./updates/wordpress-security-key";
import { deployedImageReference } from "./image-reference";
import { deploymentObservationLifetime, observationIsFresh, wordpressObservationLifetime } from "./observation-freshness";

export const controlInterval = 60 * 60_000;
export const controlRenewalInterval = controlInterval - 10 * 60_000;
export type SecurityCoverageDetails = {
  scope: "dependencies" | "wordpress" | "image" | "sources";
  limitations: string[];
  packages?: number;
  source?: "github" | "vercel" | "hosting" | "railway";
  deploymentId?: string;
  files?: number;
  filesRead?: string[];
  inventory?: { name: string; version: string; origin: string }[];
  observations?: string[];
};
export type AutomaticControl = {
  securityCoverage?: SecurityCoverageDetails;
  sourceQualification?: import("./updates/capabilities").SourceQualification;
  targetId: string;
  identity: string;
  attemptedAt: string;
  attemptRevision?: string;
  checkedAt?: string;
  checks: UpdateCheck[];
  updates: string[];
  warnings: string[];
  error?: string;
  coverage?: "partial";
};

// Include deployment IDs as well as commits: redeploying the same sources also
// invalidates the previous observation. Never substitute the branch head.
export function controlSource(target: UpdateTarget, detail: ProjectObservationDetail, now = Date.now()) {
  const root = (value?: string | null) => (value || "").replace(/^\/+|\/+$/g, "");
  const recent = (at?: string | null, maxAge = deploymentObservationLifetime) => observationIsFresh(at, maxAge, now);
  let commit: string | null = null;
  let image: string | undefined;
  let deploymentId: string | undefined;
  let hosting: boolean | undefined;
  let deployments: unknown[] = [];
  if (target.mode === "wordpress") {
    const site = detail.hosting?.find(site => site.id === target.remoteId && site.connectionId === target.connectionId && site.documentRoot === target.root && !site.missingSince && !site.ignored);
    if (!site?.inventory || site.inventory.error || !recent(site.inventory.observedAt, wordpressObservationLifetime)) return null;
    deployments = [wordpressSecurityVersions(site.inventory)];
  } else if (target.provider === "vercel") {
    const project = detail.vercel?.find(project => project.id === target.remoteId && project.connectionId === target.connectionId && project.configured !== false && !project.excluded && !project.missingSince && !project.connectionError);
    const deployment = project?.production;
    if (!project || !recent(project.observedAt) || !deployment || deployment.state !== "READY" || deployment.repository !== target.repository || root(deployment.rootDirectory ?? project.rootDirectory) !== target.root) return null;
    commit = deployment.commit;
    deploymentId = deployment.id;
    deployments = [[deployment.id, commit]];
  } else if (target.provider === "railway") {
    const project = detail.railway?.find(project => project.connectionId === target.connectionId && project.configured !== false && !project.missingSince && !project.connectionError && project.services.some(service => service.id === target.remoteId && service.environmentId === target.environmentId));
    const service = project?.services.find(service => service.id === target.remoteId && service.environmentId === target.environmentId);
    const active = service && railwayRuntimeDeployments(service);
    if (service?.image && !target.repository) {
      if (!project || !recent(project.observedAt) || !active?.length || active.some(deployment => deployment.status !== "SUCCESS")) return null;
      const digest = active[0].evidence?.imageDigest;
      const reference = deployedImageReference(service.image, digest);
      if (!reference || active.some(deployment => deployedImageReference(service.image!, deployment.evidence?.imageDigest) !== reference)) return null;
      image = reference;
      deployments = active.map(deployment => [deployment.id, reference]).sort((a, b) => a[0].localeCompare(b[0]));
      return { commit, image, identity: JSON.stringify([target.id, target.projectId, target.connectionId, target.repository, target.root, deployments]) };
    }
    if (!project || !recent(project.observedAt) || !active?.length || active.some(deployment => deployment.status !== "SUCCESS" || deployment.evidence?.repository !== target.repository || root(deployment.evidence?.rootDirectory) !== target.root)) return null;
    commit = active[0].evidence?.commit || null;
    if (active.length === 1) deploymentId = active[0].id;
    if (active.some(deployment => deployment.evidence?.commit !== commit)) return null;
    deployments = active.map(deployment => [deployment.id, deployment.evidence?.commit, deployment.evidence?.imageDigest]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  } else if (target.provider === "o2switch") {
    const site = detail.hosting?.find(site => site.id === target.remoteId && site.connectionId === target.connectionId && site.documentRoot === target.root && !site.ignored && !site.missingSince && !site.inspectionError);
    if (!site || !recent(site.observedAt, wordpressObservationLifetime)) return null;
    hosting = true; deployments = [site.observedAt, site.kind];
  } else return null;
  return { commit, image, deploymentId, hosting, identity: JSON.stringify([target.id, target.projectId, target.connectionId, target.repository, target.root, deployments]) };
}

export function automaticControlFresh(control: AutomaticControl, now = Date.now()) {
  const age = now - Date.parse(control.checkedAt || "");
  return !control.error && Number.isFinite(age) && age >= 0 && age < controlInterval;
}
export function controlMatches(control: AutomaticControl, target: UpdateTarget, detail: ProjectObservationDetail) {
  const source = controlSource(target, detail);
  return source?.identity === control.identity || control.coverage === "partial" && control.identity === "unavailable" && !source;
}

export function automaticControlDue(previous: AutomaticControl | null, identity: string, now = Date.now(), force = false, forceRevision?: string) {
  if (!previous || previous.identity !== identity || force && (!forceRevision || previous.attemptRevision !== forceRevision)) return true;
  // Retry failures after five minutes, independently of the hourly success cadence.
  const age = now - Date.parse(previous.attemptedAt);
  const checkedAge = now - Date.parse(previous.checkedAt || "");
  return previous.error ? !Number.isFinite(age) || age < 0 || age >= 5 * 60_000
    : !Number.isFinite(checkedAge) || checkedAge < 0 || checkedAge >= controlRenewalInterval;
}

export function hasVerifiedSecurityControl(detail: ProjectObservationDetail, state: UpdateState) {
  return state.automaticControls?.some(control => {
    const target = state.targets.find(target => target.id === control.targetId);
    return target && automaticControlFresh(control) && controlSource(target, detail)?.identity === control.identity && control.checks.some(check => ["OSV", "WPScan", "WPVulnerability", "Trivy"].includes(check.tool));
  }) || false;
}
