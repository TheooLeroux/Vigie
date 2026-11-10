import { list } from "./db";
import { projectHostingInstallationsByProject } from "./hosting-discovery";
import { vercelState } from "./vercel";
import { railwayState } from "./railway";
import { readAutomaticControls } from "./automatic-control-storage";
import { summarizeProject, type ProjectSummary } from "./project-summary";
import type { Project, ProjectObservationDetail } from "./types";
import { mapConcurrent } from "./updates/planning";
import { railpackImageIdentity } from "./updates/railpack-image-report";
import { projectRailpackReports, readRailpackScans } from "./updates/railpack-image-control";
import { updatesEnabled } from "./updates/service";
import { readConfiguredUpdateTargets, readUpdateHistory } from "./updates/storage";
import { prepareUpdateTargets } from "./updates/targets";
import { readWordPressSecurityReports } from "./updates/wordpress-current-security";

export async function projectSummaries(ids: string[], signal?: AbortSignal) {
  const summaries: Record<string, ProjectSummary> = {};
  if (signal?.aborted || !ids.length) return summaries;
  const requested = new Set(ids);
  const workspaceProjects = await list<Project>("projects", "live");
  const projects = workspaceProjects.filter(project => requested.has(project.id));
  if (signal?.aborted || !projects.length) return summaries;
  const projectIds = projects.map(project => project.id);
  for (const project of projects) summaries[project.id] = summarizeProject(project, null, null);
  const [hosting, vercel, railway] = await Promise.all([
    projectHostingInstallationsByProject(new Set(projectIds), workspaceProjects),
    vercelState({ includeDisplayLabels: false }),
    railwayState({ includeDisplayLabels: false }),
  ]).catch(() => []);
  if (signal?.aborted || !hosting || !vercel || !railway) return summaries;

  const details: ProjectObservationDetail[] = projects.map(project => ({
    project,
    hosting: hosting.get(project.id) || [],
    vercel: vercel.projects.filter(item => item.projectId === project.id),
    railway: railway.projects.filter(item => item.projectId === project.id),
  }));
  for (const detail of details) summaries[detail.project.id] = summarizeProject(detail.project, detail, null);
  const configured = await readConfiguredUpdateTargets(projectIds).catch(() => null);
  if (signal?.aborted || !configured) return summaries;
  const prepared = await mapConcurrent(details, 4, async detail => {
    if (signal?.aborted) return null;
    try { return await prepareUpdateTargets(detail, configured.get(detail.project.id)!); }
    catch { return null; }
  });
  if (signal?.aborted) return summaries;
  const [controls, history] = await Promise.all([
    readAutomaticControls(prepared.flatMap(targets => targets?.ids || [])),
    readUpdateHistory(projectIds),
  ]).catch(() => []);
  if (signal?.aborted || !controls || !history) return summaries;

  const batches = details.flatMap((detail, index) => {
    const preparation = prepared[index];
    if (!preparation) return [];
    const targets = preparation.qualify(controls);
    const identities = targets.map(target => railpackImageIdentity(target, detail.railway)).filter(identity => identity !== null);
    return [{ detail, targets, identities }];
  });
  const sites = new Map([...hosting.values()].flat().map(site => [site.id, site]));
  const [wordpress, scans] = await Promise.all([
    readWordPressSecurityReports(batches.flatMap(({ targets }) => targets.filter(target => target.mode === "wordpress")), sites),
    readRailpackScans(batches.flatMap(({ identities }) => identities.map(identity => identity.targetId))),
  ]).catch(() => []);
  if (signal?.aborted || !wordpress || !scans) return summaries;

  const enabled = updatesEnabled();
  await mapConcurrent(batches, 4, async ({ detail, targets, identities }) => {
    if (signal?.aborted) return;
    const { project } = detail;
    try {
      const { runs, assessment } = history.get(project.id)!;
      const railpackImageReports = await projectRailpackReports(project.id, identities, runs, scans);
      summaries[project.id] = summarizeProject(project, detail, {
        enabled, targets, runs, assessment, railpackImageReports,
        automaticControls: targets.flatMap(target => controls.has(target.id) ? [controls.get(target.id)!] : []),
        currentSecurity: targets.flatMap(target => wordpress.has(target.id) ? [wordpress.get(target.id)!] : []),
      });
    } catch { /* A failed project must not discard the other summaries. */ }
  });
  return summaries;
}
