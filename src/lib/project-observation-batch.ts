import { projectHostingInstallationsByProject } from "./hosting-discovery";
import { vercelState } from "./vercel";
import { railwayState } from "./railway";
import { readAutomaticControls } from "./automatic-control-storage";
import type { Project, ProjectObservationDetail } from "./types";
import { mapConcurrent } from "./updates/planning";
import { railpackImageIdentity } from "./updates/railpack-image-report";
import { projectRailpackReports, readRailpackScans } from "./updates/railpack-image-control";
import { updatesEnabled } from "./updates/service";
import type { UpdateState } from "./updates/types";
import { readConfiguredUpdateTargets, readUpdateHistory } from "./updates/storage";
import { prepareUpdateTargets } from "./updates/targets";
import { readWordPressSecurityReports } from "./updates/wordpress-current-security";

type ProjectObservation = { detail: ProjectObservationDetail; updates: UpdateState | null };

export async function readProjectObservationBatch(projects: Project[], workspaceProjects: Project[], signal?: AbortSignal) {
  const batch = new Map<string, ProjectObservation>();
  if (signal?.aborted || !projects.length) return batch;
  const projectIds = projects.map(project => project.id);
  const [hosting, vercel, railway] = await Promise.all([
    projectHostingInstallationsByProject(new Set(projectIds), workspaceProjects),
    vercelState({ includeDisplayLabels: false }),
    railwayState({ includeDisplayLabels: false }),
  ]).catch(() => []);
  if (signal?.aborted || !hosting || !vercel || !railway) return batch;

  const details: ProjectObservationDetail[] = projects.map(project => ({
    project,
    hosting: hosting.get(project.id) || [],
    vercel: vercel.projects.filter(item => item.projectId === project.id),
    railway: railway.projects.filter(item => item.projectId === project.id),
  }));
  for (const detail of details) batch.set(detail.project.id, { detail, updates: null });
  const configured = await readConfiguredUpdateTargets(projectIds).catch(() => null);
  if (signal?.aborted || !configured) return batch;
  const prepared = await mapConcurrent(details, 4, async detail => {
    if (signal?.aborted) return null;
    try { return await prepareUpdateTargets(detail, configured.get(detail.project.id)!); }
    catch { return null; }
  });
  if (signal?.aborted) return batch;
  const [controls, history] = await Promise.all([
    readAutomaticControls(prepared.flatMap(targets => targets?.ids || [])),
    readUpdateHistory(projectIds),
  ]).catch(() => []);
  if (signal?.aborted || !controls || !history) return batch;

  const batches = details.flatMap((detail, index) => {
    const preparation = prepared[index];
    if (!preparation) return [];
    try {
      const targets = preparation.qualify(controls);
      const identities = targets.map(target => railpackImageIdentity(target, detail.railway)).filter(identity => identity !== null);
      return [{ detail, targets, identities }];
    } catch { return []; }
  });
  const sites = new Map([...hosting.values()].flat().map(site => [site.id, site]));
  const [wordpress, scans] = await Promise.all([
    readWordPressSecurityReports(batches.flatMap(({ targets }) => targets.filter(target => target.mode === "wordpress")), sites),
    readRailpackScans(batches.flatMap(({ identities }) => identities.map(identity => identity.targetId))),
  ]).catch(() => []);
  if (signal?.aborted || !wordpress || !scans) return batch;

  const enabled = updatesEnabled();
  await mapConcurrent(batches, 4, async ({ detail, targets, identities }) => {
    if (signal?.aborted) return;
    const { project } = detail;
    try {
      const { runs, assessment } = history.get(project.id)!;
      const railpackImageReports = await projectRailpackReports(project.id, identities, runs, scans);
      const updates: UpdateState = {
        enabled, targets, runs, assessment, railpackImageReports,
        automaticControls: targets.flatMap(target => controls.has(target.id) ? [controls.get(target.id)!] : []),
        currentSecurity: targets.flatMap(target => wordpress.has(target.id) ? [wordpress.get(target.id)!] : []),
      };
      batch.set(project.id, { detail, updates });
    } catch { /* Keep the observation and mark only this project's updates unavailable. */ }
  });
  return batch;
}
