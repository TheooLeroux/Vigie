import { z } from "zod";
import { controlInterval } from "./automatic-control-state";
import { list } from "./db";
import { readProjectObservationBatch } from "./project-observation-batch";
import { lastRecordedSecurity, projectSecurity } from "./project-security";
import { rankSecurityWatch, type ProjectFinding, type PublicAdvisory, type SecurityWatch } from "./security-watch";
import { railwayRuntimeDeployments } from "./railway-status";
import type { Project, Service, Workspace } from "./types";

const ghsa = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;
const advisorySchema = z.array(z.object({
  ghsa_id: z.string().regex(ghsa),
  cve_id: z.string().regex(/^CVE-\d{4}-\d{4,}$/i).nullable(),
  summary: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "unknown"]),
  published_at: z.iso.datetime({ offset: true }),
  withdrawn_at: z.string().nullable(),
  vulnerabilities: z.array(z.object({ package: z.object({ ecosystem: z.string(), name: z.string() }) })),
})).max(30);

const feedUrl = "https://api.github.com/advisories?type=reviewed&sort=published&direction=desc&per_page=30";
const feedInterval = 15 * 60_000;
type Feed = { items: PublicAdvisory[]; checkedAt: string };
let cachedFeed: Feed | undefined;
let pendingFeed: Promise<Feed> | undefined;

async function readPublicFeed(): Promise<Feed> {
  const response = await fetch(feedUrl, {
    headers: { Accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Le flux GitHub Advisory Database est indisponible.");
  const advisories = advisorySchema.parse(await response.json());
  return {
    checkedAt: new Date().toISOString(),
    items: advisories.filter(item => !item.withdrawn_at).map(item => ({
      id: item.ghsa_id,
      aliases: item.cve_id ? [item.cve_id] : [],
      title: item.summary,
      severity: item.severity === "medium" ? "moderate" : item.severity,
      url: `https://github.com/advisories/${item.ghsa_id}`,
      publishedAt: new Date(item.published_at).toISOString(),
      packages: item.vulnerabilities.map(({ package: pkg }) => `${pkg.name} (${pkg.ecosystem})`),
    })),
  };
}

function publicFeed() {
  if (cachedFeed && Date.now() - Date.parse(cachedFeed.checkedAt) < feedInterval) return Promise.resolve(cachedFeed);
  pendingFeed ??= readPublicFeed().then(feed => cachedFeed = feed).finally(() => { pendingFeed = undefined; });
  return pendingFeed;
}

async function readProjectFindings(workspace: Workspace, signal: AbortSignal) {
  const workspaceProjects = await list<Project>("projects", workspace);
  const projects = workspaceProjects.filter(project => project.lifecycle === "active");
  if (!projects.length) return { projects: 0, fullyCovered: 0, findings: [] };
  const [batch, services] = await Promise.all([
    readProjectObservationBatch(projects, workspaceProjects, signal),
    list<Service>("services", workspace),
  ]);
  if (signal.aborted || ![...batch.values()].some(observation => observation.updates)) {
    throw new Error("Les relevés de sécurité du parc sont indisponibles.");
  }
  const serviceLabels = new Map<string, Set<string>>();
  for (const service of services) {
    const labels = serviceLabels.get(service.projectId) ?? new Set<string>();
    labels.add(service.technology).add(service.runtime);
    serviceLabels.set(service.projectId, labels);
  }
  const results = projects.map(project => {
    const observation = batch.get(project.id);
    if (!observation?.updates) return null;
    const { detail, updates } = observation;
    try {
      const security = projectSecurity(detail, updates);
      const monitored = new Set(security.services.map(service => service.id));
      const unverifiedServices = security.services.filter(service => service.status !== "covered" && service.status !== "partial");
      const lastKnown = security.lastKnown ?? lastRecordedSecurity(detail.project.id, unverifiedServices, updates);
      const historical = lastKnown?.vulnerabilities ?? [];
      const historicalKeys = new Set(historical.map(finding => finding.key));
      const now = Date.now();
      const current = security.vulnerabilities.filter(finding => {
        const age = now - Date.parse(finding.checkedAt);
        return age >= 0 && age < controlInterval && monitored.has(finding.targetId) && !historicalKeys.has(finding.key);
      });
      const projectRef = { id: detail.project.id, name: detail.project.name };
      const projectLabels = [project.client, ...project.tags, ...(serviceLabels.get(project.id) ?? [])];
      const targetLabels = new Map(updates.targets.map(target => {
        const vercel = detail.vercel?.find(item => target.provider === "vercel" && item.id === target.remoteId && item.connectionId === target.connectionId);
        const railway = detail.railway?.find(item => target.provider === "railway" && item.connectionId === target.connectionId && item.services.some(service => service.id === target.remoteId && service.environmentId === target.environmentId))
          ?.services.find(service => service.id === target.remoteId && service.environmentId === target.environmentId);
        const hosting = detail.hosting?.find(item => target.provider === "o2switch" && item.id === target.remoteId);
        const evidence = railway ? railwayRuntimeDeployments(railway).flatMap(item => item.evidence ? [item.evidence] : []) : [];
        const labels = [vercel?.production?.framework ?? vercel?.framework, vercel?.production?.nodeBranch ? "Node.js" : null, railway?.image, hosting?.kind,
          ...evidence.flatMap(item => [item.framework, ...item.packages.map(pkg => pkg.name)])];
        return [target.id, labels.filter((label): label is string => !!label)];
      }));
      const providers = new Map(security.services.map(service => [service.id, service.provider]));
      const searchable = (finding: ProjectFinding["finding"], historical = false): ProjectFinding => ({
        project: projectRef, finding, historical,
        searchLabels: [...projectLabels, providers.get(finding.targetId) || "", ...(targetLabels.get(finding.targetId) ?? [])],
      });
      return { known: security.known, findings: [
        ...current.map(finding => searchable(finding)),
        ...historical.map(finding => searchable(finding, true)),
      ] };
    } catch {
      // Count a project whose data is unavailable as a gap in coverage.
      return null;
    }
  });
  if (!results.some(result => result !== null)) {
    throw new Error("Les relevés de sécurité du parc sont indisponibles.");
  }
  return { projects: projects.length, fullyCovered: results.filter(result => result?.known).length, findings: results.flatMap(result => result?.findings ?? []) };
}

export async function securityWatch(workspace: Workspace, signal: AbortSignal): Promise<SecurityWatch> {
  const [feed, inventory] = await Promise.allSettled([publicFeed(), readProjectFindings(workspace, signal)]);
  const recent = feed.status === "fulfilled" ? feed.value : null;
  const park = inventory.status === "fulfilled" ? inventory.value : null;
  return {
    ...rankSecurityWatch(recent?.items ?? [], park?.findings ?? []),
    feedCheckedAt: recent?.checkedAt ?? null,
    coverage: park && { projects: park.projects, fullyCovered: park.fullyCovered },
  };
}
