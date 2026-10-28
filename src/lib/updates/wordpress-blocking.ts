import type { UpdateCheck } from "./types";

export function wordpressBlockingMessage(check?: UpdateCheck) {
  if (!check || check.status !== "blocked" || !["WPVulnerability", "WPScan"].includes(check.tool)) return null;
  const signals = check.findings.filter(finding => finding.kind === "supply-chain" || finding.kind === "unconfirmed" || finding.id.startsWith("WPV-SUPPLY-")).length;
  const known = check.findings.length - signals;
  const reasons = [known ? `${known} faille${known > 1 ? "s" : ""} connue${known > 1 ? "s" : ""}` : "", signals ? `${signals} signalement${signals > 1 ? "s" : ""} à vérifier` : ""].filter(Boolean).join(" et ");
  const outcome = check.phase === "candidate" ? "Le contrôle s’arrête avant toute modification du site." : "Le contrôle de sécurité n’est pas validé ; vérifiez l’état installé avant de relancer.";
  return `Mise à jour WordPress bloquée : ${reasons || "des signalements"}. La présence d’alertes non résolues empêche la validation. ${outcome} Consultez les composants et les actions nécessaires dans les détails.`;
}
