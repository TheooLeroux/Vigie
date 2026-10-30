import { ApiError } from "../http";
import type { SecurityFinding, UpdateCheck, UpdateResult } from "./types";

// Image adapters are explicit profiles, not arbitrary database/image upgrades.
export function tailscaleImage(image: string | null | undefined) {
  return !!image && /^(?:(?:docker\.io|index\.docker\.io)\/)?tailscale\/tailscale(?::(?:stable|latest|v?\d+\.\d+\.\d+))?(?:@sha256:[a-f0-9]{64})?$/.test(image);
}
export const tailscaleChannel = "docker.io/tailscale/tailscale:stable";
export function uniqueImageFindings(findings: SecurityFinding[]) {
  return [...new Map(findings.map(finding => [JSON.stringify([finding.package, finding.version, [...finding.aliases, finding.id].sort()]), finding])).values()];
}
export function retainedImageFindings(findings: SecurityFinding[], before: SecurityFinding[]) {
  const available = uniqueImageFindings(before);
  return uniqueImageFindings(findings).every(finding => {
    if (finding.kind === "supply-chain" || finding.severity !== "unknown") return false;
    const match = available.findIndex(previous => previous.kind !== "supply-chain" && previous.package === finding.package && previous.severity === "unknown" && [previous.id, ...previous.aliases].some(id => [finding.id, ...finding.aliases].includes(id)));
    if (match < 0) return false;
    available.splice(match, 1); return true;
  });
}
export function imageSecurityCheck(phase: "before" | "candidate" | "after", image: string, findings: SecurityFinding[], before: SecurityFinding[] = []): UpdateCheck {
  const unique = uniqueImageFindings(findings), accepted = phase === "before" || retainedImageFindings(unique, before);
  return { tool: "Trivy", phase, scope: image, checkedAt: new Date().toISOString(), findings: unique, status: !accepted ? "blocked" : unique.length ? "warning" : "passed",
    message: !accepted ? "Image refusée : nouveau signalement, sévérité aggravée ou vulnérabilité de sévérité connue non corrigée. Aucun remplacement autorisé."
      : unique.length ? `${unique.length} signalement(s)${phase === "before" ? " dans l’image actuelle" : " non classé(s), déjà présents avant maintenance et toujours à qualifier ; l’image n’est pas déclarée sans faille"}.`
      : "Aucune vulnérabilité connue signalée dans l’image analysée.", ...(!accepted ? { blockers: unique } : {}) };
}
// The generic zero-finding guard has one narrowly bound exception: a completed
// image replacement with a fresh scan and runtime proof for that exact digest.
export function verifiedImageResiduals(result: UpdateResult, check: UpdateCheck) {
  const image = result.imageUpdate;
  if (!image?.verified || !tailscaleImage(image.candidate) || !image.candidate.endsWith(`@${image.digest}`) || image.remainingFindings !== check.findings.length || result.stage !== "completed" || result.deploymentId !== image.verified.deploymentId || image.verified.digest !== image.digest || check.tool !== "Trivy" || check.phase !== "after" || check.scope !== image.candidate || check.status === "blocked") return false;
  const baseline = result.checks?.find(entry => entry.tool === "Trivy" && entry.phase === "before" && entry.scope === image.previous);
  return !!baseline && retainedImageFindings(check.findings, baseline.findings);
}
export function requireImageTarget(target: { provider: string; mode: string; image?: string }) {
  if (target.provider !== "railway" || target.mode !== "image" || !tailscaleImage(target.image)) throw new ApiError("Cette image ne dispose pas d’un adaptateur de maintenance qualifié.", 422);
}
