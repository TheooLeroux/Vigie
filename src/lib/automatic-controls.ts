import { get, list, log, requireProject } from "./db";
import { observedProjectDetail } from "./project-observations";
import { projectHostingInstallationsByProject } from "./hosting-discovery";
import { vercelState } from "./vercel";
import { railwayState } from "./railway";
import type { Project, ProjectObservationDetail } from "./types";
import { ApiError } from "./http";
import { prepareUpdateTargets, updateTargets } from "./updates/targets";
import { readConfiguredUpdateTargets } from "./updates/storage";
import { currentWordPressSecurity } from "./updates/wordpress-current-security";
import { scanCurrentDependencies } from "./updates/source-monitor";
import { automaticControlDue, controlSource } from "./automatic-control-state";
import type { UpdateTarget } from "./updates/types";
import { mapConcurrent } from "./updates/planning";
import { readAutomaticControl, readAutomaticControls, readAutomaticControlSchedules, writeAutomaticControl, claimAutomaticControl } from "./automatic-control-storage";
import { CoverageLimit, SourceQualificationError } from "./updates/capabilities";
import type { AutomaticControl } from "./automatic-control-state";
import { scanDeployedImage } from "./updates/image-monitor";
import { scanVercelSources } from "./updates/vercel-source-monitor";
import { scanHostingSources } from "./updates/hosting-source-monitor";
import { scanRailwaySources } from "./updates/railway-source-monitor";
import { GitHubAccessError } from "./updates/github";
import { railpackImageIdentity } from "./updates/railpack-image-report";
import { minimalStaticWitnessId } from "./updates/minimal-static-migration";
import { railpackScanDue, readRailpackScans, refreshRailpackImage } from "./updates/railpack-image-control";
export { readAutomaticControl, writeAutomaticControl, claimAutomaticControl } from "./automatic-control-storage";

async function activeProjects(projectId?: string, projectIds?: readonly string[]) {
  if (!projectId) {
    if (projectIds) return (await mapConcurrent([...new Set(projectIds)], 4, id => get<Project>("projects", id, "live")))
      .filter((project): project is Project => project?.lifecycle === "active");
    return (await list<Project>("projects", "live")).filter(project => project.lifecycle === "active");
  }
  const project = await get<Project>("projects", projectId, "live");
  return project?.lifecycle === "active" ? [project] : [];
}

async function readControlProjects(projects: Project[], provider?: UpdateTarget["provider"]) {
  const ids = projects.map(project => project.id);
  const query = { includeDisplayLabels: false, projectIds: ids };
  const [hosting, vercel, railway, configured] = await Promise.all([
    !provider || provider === "o2switch" ? projectHostingInstallationsByProject(new Set(ids), projects, false) : null,
    !provider || provider === "vercel" ? vercelState(query) : null,
    !provider || provider === "railway" ? railwayState(query) : null,
    readConfiguredUpdateTargets(ids),
  ]);
  return mapConcurrent(projects, 4, async project => {
    const detail: ProjectObservationDetail = {
      project,
      hosting: hosting?.get(project.id) ?? [],
      vercel: vercel?.projects.filter(item => item.projectId === project.id),
      railway: railway?.projects.filter(item => item.projectId === project.id),
    };
    try {
      return { detail, targets: await prepareUpdateTargets(detail, configured.get(project.id)!) };
    } catch { return null; }
  });
}

async function readCurrentControlProject(project: Project, provider: UpdateTarget["provider"]) {
  const [prepared] = await readControlProjects([project], provider);
  if (!prepared) return null;
  const reports = await readAutomaticControls(prepared.targets.ids);
  return { detail: prepared.detail, targets: prepared.targets.qualify(reports), reports };
}

function imageToCheck(target: UpdateTarget, detail: ProjectObservationDetail) {
  const image = railpackImageIdentity(target, detail.railway);
  return image && (image.caddy !== "minimal-static" || minimalStaticWitnessId(target)) ? image : null;
}

async function planAutomaticControls(projects: Project[], provider?: UpdateTarget["provider"], force?: boolean, revision?: string) {
  if (!projects.length) return [];
  const batch = await readControlProjects(projects, provider);
  const checks = await readControlSchedules(batch);
  const now = Date.now();
  return batch.map(project => project && {
    detail: project.detail,
    targets: project.targets.targets.filter(target => checks(project.detail, target, now, force, revision)),
  });
}

async function readControlSchedules(batch: Awaited<ReturnType<typeof readControlProjects>>) {
  const [schedules, scans] = await Promise.all([
    readAutomaticControlSchedules(batch.flatMap(project => project?.targets.ids ?? [])),
    readRailpackScans(batch.flatMap(project =>
      project?.targets.targets.filter(target => imageToCheck(target, project.detail)).map(target => target.id) ?? [])),
  ]);
  return (detail: ProjectObservationDetail, target: UpdateTarget, now: number, force?: boolean, revision?: string, sourceAt = now) => {
    const identity = controlSource(target, detail, sourceAt)?.identity || "unavailable";
    if (automaticControlDue(schedules.get(target.id) ?? null, identity, now, force, revision)) return true;
    const image = imageToCheck(target, detail);
    return !!image && railpackScanDue(image, scans.get(target.id), now, force, revision);
  };
}

export async function scheduledControlDeadlines() {
  const batch = await readControlProjects(await activeProjects());
  const due = await readControlSchedules(batch);
  if (batch.some(project => !project)) return null;
  const now = Date.now();
  return batch.flatMap(project => project!.targets.targets.map(target => {
    // Search the monotonic deadline using the same rules as the worker.
    let earliest = now, latest = now + 60 * 60_000;
    while (earliest < latest) {
      const middle = Math.floor((earliest + latest) / 2);
      if (due(project!.detail, target, middle, false, undefined, now)) latest = middle;
      else earliest = middle + 1;
    }
    return { provider: target.provider, projectId: target.projectId, dueAt: earliest };
  }));
}

export async function automaticControlsNeeded(provider: UpdateTarget["provider"], force = false, projectId?: string, forceRevision?: string, projectIds?: readonly string[]) {
  const plan = await planAutomaticControls(await activeProjects(projectId, projectIds), provider, force, forceRevision);
  // A failed preparation should reach the worker instead of being treated as up to date.
  return plan.some(project => !project || project.targets.length > 0);
}

export async function scanAutomaticTarget(target: UpdateTarget, source: NonNullable<ReturnType<typeof controlSource>>, readers = { dependencies: scanCurrentDependencies, railway: scanRailwaySources }): Promise<Pick<AutomaticControl, "checks" | "updates" | "warnings" | "sourceQualification" | "securityCoverage" | "coverage" | "sourceDigest">> {
  if (source.image) return scanDeployedImage(source.image);
  if (source.hosting) return scanHostingSources(target);
  if (target.provider === "vercel" && source.deploymentId) {
    if (target.repository && source.commit) {
      try { return await scanCurrentDependencies(target, source.commit); }
      catch { /* Try the independently retrievable deployed files. */ }
    }
    return scanVercelSources(target, source.deploymentId);
  }
  if (target.mode !== "wordpress") {
    try { return await readers.dependencies(target, source.commit); }
    catch (error) {
      if (error instanceof GitHubAccessError && target.provider === "railway" && source.deploymentId && source.commit) return readers.railway(target, source.deploymentId, source.commit);
      throw error;
    }
  }
  const observation = await currentWordPressSecurity(target, { fresh: true });
  if (observation.error || !observation.check) throw new ApiError(observation.error || "Inventaire ou contrôle de sécurité WordPress indisponible.");
  return { checks: [observation.check], updates: [], warnings: observation.warnings, securityCoverage: observation.securityCoverage };
}

const defaultControls = { projects: () => list<Project>("projects", "live"), detail: observedProjectDetail, targets: updateTargets, scan: scanAutomaticTarget, read: readAutomaticControl, write: writeAutomaticControl, claim: claimAutomaticControl, log, scanRailpack: refreshRailpackImage };

type ControlDependencies = Omit<typeof defaultControls, "scanRailpack"> & { scanRailpack?: typeof refreshRailpackImage };

export async function reconcileAutomaticControls(options: { force?: boolean; forceRevision?: string; provider?: UpdateTarget["provider"]; projectId?: string; projectIds?: readonly string[] } = {}, dependencies?: ControlDependencies) {
  const controls = dependencies ?? defaultControls;
  const result = { checked: 0, failed: 0, deferred: 0, limited: 0 };
  const attemptRevision = options.forceRevision || (/^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA || "") ? process.env.GITHUB_SHA : undefined);
  const projects = dependencies
    ? (await dependencies.projects()).filter(project => project.lifecycle === "active" &&
      (!options.projectId || project.id === options.projectId) && (!options.projectIds || options.projectIds.includes(project.id)))
    : await activeProjects(options.projectId, options.projectIds);
  const plan = dependencies ? null : await planAutomaticControls(projects, options.provider, options.force, options.forceRevision);
  await mapConcurrent(projects, 3, async (project, index) => {
    try {
      const planned = plan?.[index];
      if (plan && !planned) { result.failed++; return; }
      const plannedDetail = planned?.detail ?? await controls.detail(project.id, "live");
      const targets = planned?.targets ?? (await controls.targets(project.id)).filter(target => !options.provider || target.provider === options.provider);
      for (let target of targets) {
        const release = await controls.claim(target.id);
        if (!release) { result.deferred++; continue; }
        try {
          let detail = plannedDetail;
          let previous: AutomaticControl | null;
          if (planned) {
            // Reports and deployments may have changed while this project waited for its turn.
            const currentProject = await get<Project>("projects", project.id, "live");
            if (currentProject?.lifecycle !== "active") continue;
            const current = await readCurrentControlProject(currentProject, target.provider);
            if (!current) { result.failed++; continue; }
            const currentTarget = current.targets.find(item => item.id === target.id);
            if (!currentTarget) continue;
            detail = current.detail;
            target = currentTarget;
            previous = current.reports.get(target.id) ?? null;
          } else previous = await controls.read(target.id);
          const railpack = controls.scanRailpack && imageToCheck(target, detail);
          if (railpack) {
            const image = await controls.scanRailpack!(target, railpack, options.force, attemptRevision).catch(() => "failed" as const);
            if (image) result[image]++;
          }
          const source = controlSource(target, detail);
          const identity = source?.identity || "unavailable";
          if (!automaticControlDue(previous, identity, Date.now(), options.force, options.forceRevision)) continue;
          const attemptedAt = new Date().toISOString();
          try {
            if (target.mode !== "wordpress" && !target.repository && !source?.image && !source?.deploymentId && !source?.hosting) throw new CoverageLimit(["database", "network", "image"].includes(target.capability?.family || "") ? "Image externe : une image publique accessible et une empreinte identique sur les déploiements actifs sont nécessaires au contrôle." : "Sources non disponibles ; relier un dépôt ou un inventaire vérifiable au déploiement.");
            if (!source) throw new ApiError("Le relevé de l’hébergeur ou l’inventaire actuel est manquant, périmé ou non vérifiable.");
            const observation = await controls.scan(target, source);
            // A deployment or inventory may change while the scanner is running.
            const freshProject = dependencies
              ? { detail: await controls.detail(project.id, "live"), targets: await controls.targets(project.id) }
              : await readCurrentControlProject(await requireProject(project.id, "live"), target.provider);
            if (!freshProject) throw new ApiError("Le relevé a changé pendant le contrôle. Une reprise automatique est prévue.");
            const { detail: fresh, targets: currentTargets } = freshProject;
            const current = currentTargets.find(item => item.id === target.id);
            if (fresh.project.lifecycle !== "active" || !current || controlSource(current, fresh)?.identity !== identity) throw new ApiError("Le déploiement a changé pendant le contrôle. Une reprise automatique est prévue.");
            await controls.write({ targetId: target.id, identity, attemptedAt, attemptRevision, checkedAt: new Date().toISOString(), ...observation });
            result.checked++;
          } catch (error) {
            if (error instanceof CoverageLimit) {
              await controls.write({ targetId: target.id, identity, attemptedAt, attemptRevision, checkedAt: attemptedAt, coverage: "partial", checks: [], updates: [], warnings: [error.message], ...(error instanceof SourceQualificationError ? { sourceQualification: error.sourceQualification } : {}) });
              result.limited++; continue;
            }
            if (!(error instanceof ApiError)) {
              // Do not log arbitrary exception messages, response bodies or secrets.
              const kind = error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "UnknownError";
              const frames = error instanceof Error ? error.stack?.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 6) : [];
              console.error(JSON.stringify({ targetId: target.id, kind, frames }));
            }
            const message = error instanceof ApiError ? error.message : "Le contrôle automatique n’a pas abouti. Nouvelle tentative au prochain passage ; consultez les accès et l’inventaire du projet.";
            await controls.write({ ...(previous?.identity === identity ? previous : { checks: [], updates: [], warnings: [] }), ...(error instanceof SourceQualificationError ? { sourceQualification: error.sourceQualification } : {}), targetId: target.id, identity, attemptedAt, attemptRevision, error: message });
            result.failed++;
          }
        } finally { await release(); }
      }
    } catch { result.failed++; }
  });
  if (result.checked || result.failed || result.limited) await controls.log("live", "hosting.automatic_control", `Contrôle automatique : ${result.checked} analyse(s) réussie(s), ${result.limited} couverture(s) limitée(s), ${result.failed} échec(s), ${result.deferred} différé(s).`);
  return result;
}
