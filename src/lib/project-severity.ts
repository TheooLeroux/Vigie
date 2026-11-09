import type { ProjectSummary } from "./project-summary";
import { severityOrder } from "./vulnerability-references";

export function projectSeverityCounts(summary?: ProjectSummary) {
  if (summary?.lastKnown) return summary.lastKnown.severityCounts;
  if (summary && (summary.count > 0 || summary.known || summary.partial)) return summary.severityCounts;
}

export function compareProjectSeverity(a?: ProjectSummary, b?: ProjectSummary) {
  const left = projectSeverityCounts(a);
  const right = projectSeverityCounts(b);
  if (!left || !right) return Number(!!right) - Number(!!left);
  for (const severity of severityOrder) {
    const difference = right[severity] - left[severity];
    if (difference) return difference;
  }
  return Number(!!a?.lastKnown) - Number(!!b?.lastKnown);
}
