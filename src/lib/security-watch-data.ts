import { z } from "zod";
import { controlInterval } from "./automatic-control-state";
import { list } from "./db";
import { observedProjectDetail } from "./project-observations";
import { lastRecordedSecurity, projectSecurity } from "./project-security";
import { rankSecurityWatch, type ProjectFinding, type PublicAdvisory, type SecurityWatch } from "./security-watch";
import { railwayRuntimeDeployments } from "./railway-status";
import type { Project, Workspace } from "./types";
import { mapConcurrent } from "./updates/planning";
import { projectUpdates } from "./updates/service";

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
  const projects = (await list<Project>("projects", workspace)).filter(project => project.lifecycle === "active");
  const results = await mapConcurrent(projects, 4, async project => {
    if (signal.aborted) return null;
    try {
      const [detail, updates] = await Promise.all([observedProjectDetail(project.id, workspace), projectUpdates(project.id)]);
      if (detail.project.lifecycle !== "active") return null;
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
      const projectLabels = [detail.project.client, ...detail.project.tags, ...detail.services.flatMap(service => [service.technology, service.runtime])];
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
