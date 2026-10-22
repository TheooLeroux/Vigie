import type { RailwayService } from "./railway-types";
const labels: Record<string, string> = {
  SUCCESS: "Déployé",
  CRASHED: "Arrêt avec erreur",
  FAILED: "Échec",
  REMOVED: "Retiré",
  CANCELED: "Annulé",
  CANCELLED: "Annulé",
  BUILDING: "Construction",
  DEPLOYING: "Déploiement",
  INITIALIZING: "Initialisation",
  QUEUED: "En attente",
  WAITING: "En attente",
  SLEEPING: "En veille",
  SKIPPED: "Ignoré",
  REMOVING: "Retrait",
};
export function deploymentLabel(status: string) {
  return labels[status] || status;
}
export function deploymentTone(status: string) {
  return status === "SUCCESS"
    ? "sage"
    : ["FAILED", "CRASHED"].includes(status)
      ? "warning"
      : "neutral";
}
export function railwayServiceState(service: RailwayService) {
  const active = service.activeDeployments;
  if (active.some((d) => d.status === "SUCCESS"))
    return { label: "Déployé", tone: "sage" };
  if (active.some((d) => d.status === "CRASHED"))
    return { label: "Arrêt avec erreur", tone: "warning" };
  if (active.length)
    return {
      label: deploymentLabel(active[0].status),
      tone: deploymentTone(active[0].status),
    };
  return { label: "Aucun déploiement actif", tone: "neutral" };
}
export function railwayAttention(service: RailwayService) {
  return (
    railwayVersionAttention(service) ||
    service.activeDeployments.some((d) => d.status === "CRASHED") ||
    ["FAILED", "CRASHED"].includes(service.latestDeployment?.status || "")
  );
}
export function railwayVersionAttention(service: RailwayService) {
  return railwayRuntimeDeployments(service).some((d) =>
    d.evidence?.packages.some(
      (p) => p.release?.state === "available" || p.release?.supported === false,
    ),
  );
}
export function railwayRuntimeDeployments(service: RailwayService) {
  return service.activeDeployments.filter((d) =>
    ["SUCCESS", "CRASHED", "SLEEPING", "REMOVING"].includes(d.status),
  );
}
