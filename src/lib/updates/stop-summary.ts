import type { SecurityFinding, UpdateCheck, UpdateRun } from "./types";
import { wordpressBlockingMessage } from "./wordpress-blocking";

const scanners = new Set<UpdateCheck["tool"]>(["OSV", "Trivy", "WPScan", "WPVulnerability"]);

// Derive the explanation from persisted evidence, including historical runs.
// A later passing scan replaces a rejected candidate for the same tool/service.
export function updateStopSummary(run: UpdateRun) {
  if (run.stage !== "failed" && run.stage !== "attention") return null;
  const findings: { target: string; tool: UpdateCheck["tool"]; finding: SecurityFinding }[] = [];
  const seen = new Set<string>();
  let wordpressReason: string | null = null;
  for (const result of run.results) {
    const latest = new Map<UpdateCheck["tool"], UpdateCheck>();
    for (const check of result.checks || []) if (scanners.has(check.tool)) latest.set(check.tool, check);
    for (const check of latest.values()) {
      if (check.status === "blocked") wordpressReason ||= wordpressBlockingMessage(check);
      for (const finding of check.findings) {
        const key = JSON.stringify([result.targetId, finding.package, finding.version, [...finding.aliases, finding.id].sort()[0]]);
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ target: result.name, tool: check.tool, finding });
      }
    }
  }
  const legacySearch = /Recherche d’une autre combinaison/.test(run.message);
  const reason = (legacySearch && wordpressReason ? wordpressReason : run.message).replace(/Recherche d’une autre combinaison(?: sans faille signalée)?[.;]?/g, "Aucune combinaison sans alerte n’a été validée pendant cette tentative.");
  const needsVerification = run.stage === "attention" || run.results.some(result => result.commit || result.deploymentId || result.backup || ["publishing", "verifying", "attention"].includes(result.stage));
  return {
    title: needsVerification ? "Mise à jour arrêtée — état à vérifier" : wordpressReason ? "Mise à jour bloquée" : "Mise à jour arrêtée",
    reason,
    notice: needsVerification
      ? "À vérifier. La tentative est arrêtée. Des opérations ont déjà pu être exécutées : vérifiez l’état des services avant toute nouvelle tentative. Le résultat global n’est pas validé."
      : "Aucune nouvelle version n’a été publiée par cette tentative. La mise à jour ne reprend pas automatiquement ; les contrôles de surveillance restent actifs.",
    findings: findings.slice(0, 8),
    additionalFindings: Math.max(0, findings.length - 8),
  };
}
