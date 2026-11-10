import type { SecurityFinding } from "./types";

const levels = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };

export function sameNpmAdvisory(first: SecurityFinding, second: SecurityFinding) {
  return first.scope === second.scope && first.package === second.package &&
    [first.id, ...first.aliases].some(id => id === second.id || second.aliases.includes(id));
}

export function npmRiskReduction(baseline: SecurityFinding[], candidate: SecurityFinding[], introduced: SecurityFinding[]) {
  if (!introduced.length || introduced.some(finding => finding.scope === undefined || finding.usage !== "build" ||
    (finding.severity !== "low" && finding.severity !== "moderate") ||
    finding.kind === "supply-chain" || finding.kind === "unconfirmed" || [finding.id, ...finding.aliases].some(id => id.startsWith("MAL-")) ||
    baseline.some(item => sameNpmAdvisory(item, finding)))) return;

  const removed = baseline.filter((finding, index) => !candidate.some(item => sameNpmAdvisory(item, finding)) &&
    !baseline.slice(0, index).some(item => sameNpmAdvisory(item, finding)));
  const scopes = new Set(introduced.map(finding => finding.scope));
  for (const scope of scopes) {
    for (const level of [1, 2]) {
      const added = introduced.filter(finding => finding.scope === scope && levels[finding.severity] >= level).length;
      const fixed = removed.filter(finding => finding.scope === scope && levels[finding.severity] >= level).length;
      if (fixed < 2 * added) return;
    }
  }
  return removed.filter(finding => scopes.has(finding.scope)).length;
}
