import { z } from "zod";
import { controlInterval } from "./automatic-control-state";
import { list } from "./db";
import { observedProjectDetail } from "./project-observations";
import { projectSecurity } from "./project-security";
import { rankSecurityWatch, type PublicAdvisory, type SecurityWatch } from "./security-watch";
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
      const now = Date.now();
      const findings = security.vulnerabilities.filter(finding => {
        const age = now - Date.parse(finding.checkedAt);
        return age >= 0 && age < controlInterval && monitored.has(finding.targetId);
      });
      return { known: security.known, findings: findings.map(finding => ({
        project: { id: detail.project.id, name: detail.project.name },
        finding,
      })) };
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
