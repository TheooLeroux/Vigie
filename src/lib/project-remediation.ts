import { controlInterval, controlSource } from "./automatic-control-state";
import type { ProjectVulnerability } from "./project-security";
import type { ProjectDetail } from "./types";
import { currentAssessmentEvidence } from "./updates/assessment";
import { remainingNpmFindings, type SecurityFinding, type UpdateState } from "./updates/types";
import { wordpressSecurityVersions } from "./updates/wordpress-security-key";

export type RemediationReason = { label: string; detail?: string };

export function projectRemediation(detail: ProjectDetail, state?: UpdateState | null, now = Date.now()) {
  const assessments = new Map(currentAssessmentEvidence(detail, state, now).map(result => [result.targetId, result]));
  const targets = new Map(state?.targets.map(target => [target.id, target]));
  const observations = new Map(state?.currentSecurity?.map(observation => [observation.targetId, observation]));

  return (item: ProjectVulnerability): RemediationReason => {
    const target = targets.get(item.targetId);
    const result = assessments.get(item.targetId);
    const matches = (finding: SecurityFinding) => finding.package === item.package && finding.version === item.version &&
      [finding.id, ...finding.aliases].some(id => item.aliases.includes(id.toUpperCase()));

    if (target?.mode === "wordpress") {
      const observation = observations.get(item.targetId);
      const inventory = detail.hosting?.find(site => site.id === target.remoteId && site.connectionId === target.connectionId)?.inventory;
      const age = now - Date.parse(observation?.check?.checkedAt || "");
      const fresh = inventory && observation && !observation.error && age >= 0 && age < controlInterval &&
        controlSource(target, detail, now) && observation.versions === wordpressSecurityVersions(inventory);
      const manual = (fresh ? observation.manualUpdates : undefined)?.find(entry => entry.package === item.package && entry.version === item.version)
        || (result?.stage === "completed" ? result.manualUpdates : undefined)?.find(entry => entry.package === item.package && entry.version === item.version);
      if (manual) return { label: "Intervention manuelle", detail: [manual.reason, manual.action].filter(Boolean).join(" ") };
    }

    if (result?.stage === "completed" && result.assessment) {
      const retained = remainingNpmFindings(result).find(matches);
      if (retained) return {
        label: state?.assessment?.assessmentOrigin === "maintenance" ? "Toujours présente après la mise à jour" : "Toujours présente dans la proposition",
        detail: retained.explanation,
      };
    }
    if (result?.stage === "failed") {
      const checks = new Map(result.checks?.filter(check => check.phase === "candidate").map(check => [check.tool, check]));
      for (const check of checks.values()) {
        if (check.status !== "blocked") continue;
        const blocker = (check.blockers ?? check.findings).find(matches);
        if (blocker) return { label: "La faille bloque la proposition de mise à jour", detail: blocker.explanation };
      }
    }

    if (target?.unavailable) return { label: "Mise à jour automatique indisponible", detail: target.unavailable };
    if (state && !state.enabled) return { label: "Maintenance automatique désactivée", detail: state.disabledReason };
    return item.fixedVersions?.length
      ? { label: "Compatibilité du correctif à confirmer", detail: "Le rapport indique une version correctrice, mais aucun correctif compatible n’est confirmé pour ce bloc." }
      : { label: "Aucun correctif indiqué dans le rapport", detail: "Le rapport ne permet pas de déterminer ce qui empêche la correction." };
  };
}
