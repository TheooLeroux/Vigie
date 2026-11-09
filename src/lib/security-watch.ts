import type { ProjectVulnerability } from "./project-security";
import type { Project } from "./types";
import { groupVulnerabilityReferences, severityOrder } from "./vulnerability-references";

type Severity = ProjectVulnerability["severity"];

export const severityLabels: Record<Severity, string> = {
  critical: "Critique",
  high: "Élevée",
  moderate: "Modérée",
  low: "Faible",
  unknown: "Non classée",
};

export type PublicAdvisory = {
  id: string;
  aliases: string[];
  title: string;
  severity: Severity;
  url: string;
  publishedAt: string;
  packages: string[];
};

export type ProjectFinding = {
  project: Pick<Project, "id" | "name">;
  finding: ProjectVulnerability;
  historical?: boolean;
};

export type WatchItem = {
  id: string;
  aliases: string[];
  title: string;
  severity: Severity;
  url?: string;
  publishedAt?: string;
  latestCheckedAt?: string;
  packages: string[];
  affected: { project: ProjectFinding["project"]; historical: boolean }[];
};

function publicLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Older findings may not contain a valid URL. */ }
}

export function rankSecurityWatch(advisories: PublicAdvisory[], findings: ProjectFinding[]) {
  const groups = groupVulnerabilityReferences([...advisories, ...findings], item => "finding" in item ? item.finding : item);
  const detected: WatchItem[] = [], recent: WatchItem[] = [];
  for (const group of groups) {
    const ids = [...group.ids].sort();
    const id = ids.find(value => value.startsWith("CVE-")) ?? ids[0];
    const publicItems = group.items.filter(item => "publishedAt" in item);
    const projectFindings = group.items.filter(item => "finding" in item);
    const advisory = publicItems.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
    const severities = [...publicItems.map(item => item.severity), ...projectFindings.map(item => item.finding.severity)];
    const projects = new Map<string, WatchItem["affected"][number]>();
    for (const { project, historical } of projectFindings) {
      if (!projects.has(project.id) || !historical) projects.set(project.id, { project, historical: !!historical });
    }
    const item: WatchItem = {
      id,
      aliases: ids.filter(value => value !== id),
      title: advisory?.title || projectFindings.find(item => item.finding.title)?.finding.title || id,
      severity: severityOrder.find(severity => severities.includes(severity)) ?? "unknown",
      url: advisory?.url || projectFindings.map(item => publicLink(item.finding.url)).find(Boolean),
      publishedAt: advisory?.publishedAt,
      latestCheckedAt: projectFindings.map(item => item.finding.checkedAt).sort().at(-1),
      packages: [...new Set(publicItems.flatMap(item => item.packages))].sort(),
      affected: [...projects.values()].sort((a, b) => a.project.name.localeCompare(b.project.name, "fr") || a.project.id.localeCompare(b.project.id)),
    };
    (item.affected.length ? detected : recent).push(item);
  }
  const date = (item: WatchItem) => Date.parse(item.publishedAt || item.latestCheckedAt || "") || 0;
  const byDate = (a: WatchItem, b: WatchItem) => date(b) - date(a) || a.id.localeCompare(b.id);
  detected.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) || byDate(a, b));
  recent.sort(byDate);
  return { detected, recent };
}

export type SecurityWatch = ReturnType<typeof rankSecurityWatch> & {
  feedCheckedAt: string | null;
  coverage: { projects: number; fullyCovered: number } | null;
};
export type SecurityWatchSnapshot = { savedAt: string; watch: SecurityWatch };
