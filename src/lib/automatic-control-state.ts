import type { ProjectDetail } from "./types";
import type { UpdateCheck, UpdateTarget, UpdateState } from "./updates/types";
import { railwayRuntimeDeployments } from "./railway-status";
import { wordpressSecurityVersions } from "./updates/wordpress-security-key";

export const controlInterval = 60 * 60_000;
export type AutomaticControl = {
  sourceQualification?: import("./updates/capabilities").SourceQualification;
  targetId: string;
  identity: string;
  attemptedAt: string;
  checkedAt?: string;
  checks: UpdateCheck[];
  updates: string[];
  warnings: string[];
  error?: string;
  coverage?: "partial";
};

// Include deployment IDs as well as commits: redeploying the same sources also
// invalidates the previous observation. Never substitute the branch head.
export function controlSource(target: UpdateTarget, detail: ProjectDetail) {
  const root = (value?: string | null) => (value || "").replace(/^\/+|\/+$/g, "");
  const recent = (at?: string | null, maxAge = 15 * 60_000) => {
    const age = Date.now() - Date.parse(at || "");
    return Number.isFinite(age) && age >= -30_000 && age < maxAge;
  };
  let commit: string | null = null;
  let deployments: unknown[] = [];
  if (target.mode === "wordpress") {
    const site = detail.hosting?.find(site => site.id === target.remoteId && site.connectionId === target.connectionId && site.documentRoot === target.root && !site.missingSince && !site.ignored);
    if (!site?.inventory || site.inventory.error || !recent(site.inventory.observedAt, controlInterval)) return null;
    deployments = [wordpressSecurityVersions(site.inventory)];
  } else if (target.provider === "vercel") {
    const project = detail.vercel?.find(project => project.id === target.remoteId && project.connectionId === target.connectionId && !project.excluded && !project.missingSince && !project.connectionError);
    const deployment = project?.production;
    if (!project || !recent(project.observedAt) || !deployment || deployment.state !== "READY" || deployment.repository !== target.repository || root(deployment.rootDirectory ?? project.rootDirectory) !== target.root) return null;
    commit = deployment.commit;
    deployments = [[deployment.id, commit]];
  } else if (target.provider === "railway") {
    const project = detail.railway?.find(project => project.connectionId === target.connectionId && !project.missingSince && !project.connectionError && project.services.some(service => service.id === target.remoteId && service.environmentId === target.environmentId));
    const service = project?.services.find(service => service.id === target.remoteId && service.environmentId === target.environmentId);
    const active = service && railwayRuntimeDeployments(service);
    if (!project || !recent(project.observedAt) || !active?.length || active.some(deployment => deployment.status !== "SUCCESS" || deployment.evidence?.repository !== target.repository || root(deployment.evidence?.rootDirectory) !== target.root)) return null;
    commit = active[0].evidence?.commit || null;
    if (active.some(deployment => deployment.evidence?.commit !== commit)) return null;
    deployments = active.map(deployment => [deployment.id, deployment.evidence?.commit, deployment.evidence?.imageDigest]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  } else return null;
  return { commit, identity: JSON.stringify([target.id, target.projectId, target.connectionId, target.repository, target.root, deployments]) };
}

export function automaticControlFresh(control: AutomaticControl, now = Date.now()) {
  const age = now - Date.parse(control.checkedAt || "");
  return !control.error && Number.isFinite(age) && age >= 0 && age < controlInterval;
}
export function controlMatches(control: AutomaticControl, target: UpdateTarget, detail: ProjectDetail) {
  const source = controlSource(target, detail);
  return source?.identity === control.identity || control.coverage === "partial" && control.identity === "unavailable" && !source;
}

export function automaticControlDue(previous: AutomaticControl | null, identity: string, now = Date.now(), force = false) {
  if (!previous || previous.identity !== identity || force) return true;
  // Retry failures after five minutes, independently of the hourly success cadence.
  const age = now - Date.parse(previous.attemptedAt);
  return previous.error ? !Number.isFinite(age) || age < 0 || age >= 5 * 60_000 : !automaticControlFresh(previous, now);
}

export function hasVerifiedSecurityControl(detail: ProjectDetail, state: UpdateState) {
  return state.automaticControls?.some(control => {
    const target = state.targets.find(target => target.id === control.targetId);
    return target && automaticControlFresh(control) && controlSource(target, detail)?.identity === control.identity && control.checks.some(check => ["OSV", "WPScan", "WPVulnerability", "Trivy"].includes(check.tool));
  }) || false;
}
