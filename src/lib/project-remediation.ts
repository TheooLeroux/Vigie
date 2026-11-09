import { controlInterval, controlSource } from "./automatic-control-state";
import type { ProjectVulnerability } from "./project-security";
import type { ProjectDetail } from "./types";
import { currentAssessmentEvidence } from "./updates/assessment";
import { remainingNpmFindings, type SecurityFinding, type UpdateResult, type UpdateState } from "./updates/types";
import { wordpressSecurityVersions } from "./updates/wordpress-security-key";

export type RemediationReason = { label: string; detail?: string };

function blockedCandidateChecks(result: UpdateResult) {
  const checks = new Map(result.checks?.filter(check => check.phase === "candidate").map(check => [check.tool, check]));
  return [...checks.values()].filter(check => check.status === "blocked");
}

export function projectRemediation(detail: ProjectDetail, state?: UpdateState | null, now = Date.now()) {
  const assessments = new Map(currentAssessmentEvidence(detail, state, now).map(result => [result.targetId, result]));
  const targets = new Map(state?.targets.map(target => [target.id, target]));
  const observations = new Map(state?.currentSecurity?.map(observation => [observation.targetId, observation]));
  const latest = state?.runs[0];
  const rejected = new Map<string, ReturnType<typeof blockedCandidateChecks>>();
  const installed = new Map<string, SecurityFinding[]>();
  for (const result of latest?.results || []) {
    const target = targets.get(result.targetId);
    const source = target && controlSource(target, detail, now);
    if (!source) continue;
    if (result.stage === "completed" && source.deploymentId) {
      const verified = result.checks?.some(check => {
        const proof = check.nodeEvidence || check.staticEvidence;
        return check.phase === "after" && check.status === "passed" && proof && proof.deploymentId === source.deploymentId &&
          (!proof.commit || proof.commit === source.commit);
      });
      if (verified) installed.set(result.targetId, remainingNpmFindings(result));
    }
    if ((latest?.stage === "failed" || latest?.stage === "attention") && (result.stage === "failed" || result.stage === "attention")) {
      // A rejected version can only explain findings on the same running deployment or image.
      const sameSource = source.image
        ? result.checks?.some(check => check.tool === "Trivy" && check.phase === "before" && check.scope === source.image)
        : result.previousDeploymentId && result.previousDeploymentId === source.deploymentId;
      if (sameSource) rejected.set(result.targetId, blockedCandidateChecks(result));
    }
  }

  return (item: ProjectVulnerability): RemediationReason | undefined => {
    const target = targets.get(item.targetId);
    const result = assessments.get(item.targetId);
    const sameVulnerability = (finding: SecurityFinding) => finding.package === item.package &&
      [finding.id, ...finding.aliases].some(id => item.aliases.includes(id.toUpperCase()));
    const matches = (finding: SecurityFinding) => finding.version === item.version && sameVulnerability(finding);

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
      if (retained?.explanation) return {
        label: state?.assessment?.assessmentOrigin === "maintenance" ? "Toujours présente après la mise à jour" : "Toujours présente dans la proposition",
        detail: retained.explanation,
      };
    }
    const retained = installed.get(item.targetId)?.find(matches);
    if (retained?.explanation) return { label: "Toujours présente après la mise à jour", detail: retained.explanation };

    if (result?.stage === "failed") {
      for (const check of blockedCandidateChecks(result)) {
        const blocker = (check.blockers ?? check.findings).find(matches);
        if (blocker) return { label: "La faille bloque la proposition de mise à jour", detail: blocker.explanation };
      }
    }

    for (const check of rejected.get(item.targetId) || []) {
      const blocker = (check.blockers ?? check.findings).find(sameVulnerability);
      if (blocker) return { label: "La version proposée contient encore cette faille. Son installation a été bloquée.", detail: blocker.explanation };
    }

    if (target?.unavailable) return { label: "Mise à jour automatique indisponible", detail: target.unavailable };
    if (state && !state.enabled && state.disabledReason) {
      return { label: "Maintenance automatique désactivée", detail: state.disabledReason };
    }
  };
}
