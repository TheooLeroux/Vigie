import type { ProjectVulnerability } from "./project-security";
import type { Project } from "./types";

type Severity = ProjectVulnerability["severity"];
const severityOrder: Severity[] = ["critical", "high", "moderate", "low", "unknown"];

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
  affected: ProjectFinding[];
};

type WatchGroup = {
  ids: Set<string>;
  advisories: PublicAdvisory[];
  affected: ProjectFinding[];
};

function publicLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Older findings may not contain a valid URL. */ }
}

export function rankSecurityWatch(advisories: PublicAdvisory[], findings: ProjectFinding[]) {
  const byId = new Map<string, WatchGroup>();
  function groupFor(ids: string[]) {
    const aliases = ids.map(id => id.toUpperCase());
    const existing = new Set(aliases.flatMap(id => byId.get(id) ?? []));
    const group: WatchGroup = existing.values().next().value ?? { ids: new Set(), advisories: [], affected: [] };
    existing.delete(group);
    // An advisory or scanner finding can connect two previously separate alias sets.
    for (const previous of existing) {
      previous.ids.forEach(id => group.ids.add(id));
      group.advisories = group.advisories.concat(previous.advisories);
      group.affected = group.affected.concat(previous.affected);
    }
    aliases.forEach(id => group.ids.add(id));
    group.ids.forEach(id => byId.set(id, group));
    return group;
  }

  for (const advisory of advisories) groupFor([advisory.id, ...advisory.aliases]).advisories.push(advisory);
  for (const item of findings) groupFor([item.finding.id, ...item.finding.aliases]).affected.push(item);

  const detected: WatchItem[] = [], recent: WatchItem[] = [];
  for (const group of new Set(byId.values())) {
    const ids = [...group.ids].sort();
    const id = ids.find(value => value.startsWith("CVE-")) ?? ids[0];
    const advisory = group.advisories.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
    const severities = [...group.advisories.map(item => item.severity), ...group.affected.map(item => item.finding.severity)];
    const item: WatchItem = {
      id,
      aliases: ids.filter(value => value !== id),
      title: advisory?.title || group.affected.find(item => item.finding.title)?.finding.title || id,
      severity: severityOrder.find(severity => severities.includes(severity)) ?? "unknown",
      url: advisory?.url || group.affected.map(item => publicLink(item.finding.url)).find(Boolean),
      publishedAt: advisory?.publishedAt,
      latestCheckedAt: group.affected.map(item => item.finding.checkedAt).sort().at(-1),
      packages: [...new Set(group.advisories.flatMap(item => item.packages))].sort(),
      affected: group.affected.sort((a, b) => a.project.name.localeCompare(b.project.name, "fr") || a.finding.key.localeCompare(b.finding.key)),
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
