import { projectHealth } from "./project-health";
import { projectSecurity } from "./project-security";
import { controlInterval } from "./automatic-control-state";
import { projectObservations } from "./observation-freshness";
import { activeUpdateStages, type UpdateState } from "./updates/types";
import type { Project, ProjectObservationDetail } from "./types";
export function observedInventory(detail?: ProjectObservationDetail | null) {
  return !!(detail?.hosting?.some(site => site.inventory && !site.inventory.error && site.inventory.collectionMode !== "early") || detail?.vercel?.some(project => project.production?.state === "READY" && !!project.production.id) || detail?.railway?.some(project => project.services.some(service => service.activeDeployments.some(deployment => deployment.status === "SUCCESS"))));
}
export function summarizeProject(project: Project, detail: ProjectObservationDetail | null, updates: UpdateState | null) {
  const health = detail ? projectHealth(detail, updates) : null;
  const security = detail ? projectSecurity(detail, updates, health!) : null;
  const count = security?.count || 0, known = security?.known || false, partial = security?.partial || false;
  const active = !!updates?.runs[0] && activeUpdateStages.includes(updates.runs[0].stage);
  const now = Date.now();
  const observations = detail ? projectObservations(detail, now) : [];
  const refreshNeeded = project.lifecycle === "active" && observations.some(item => item.refreshable && ["stale", "error", "unverified"].includes(item.status));
  const deadlines = [
    ...observations.filter(item => item.status === "fresh" || item.status === "partial").map(item => Date.parse(item.at || "") + item.lifetime),
    ...(security?.services || []).filter(item => item.status === "covered" || item.status === "partial").map(item => Date.parse(item.checkedAt || "") + controlInterval),
  ].filter(Number.isFinite);
  const revalidateAfterMs = deadlines.length ? Math.max(0, Math.min(...deadlines) - now) : undefined;
  const attention = updates?.runs[0]?.stage === "attention";
  const disabledReason = project.lifecycle !== "active" ? "Projet archivé." : !updates ? "Mise à jour indisponible." : !updates.enabled ? "Mises à jour désactivées." : !updates.targets.some(target => !target.unavailable) ? "Aucun service éligible." : "";
  const unknownLabel = security?.label || "Contrôle indisponible";
  const signalCount = security?.signals.length || 0, alertCount = security?.alerts.length || 0;
  const last = security?.lastKnown;
  const lastKnown = last ? { count: last.count, severityCounts: last.severityCounts, signalCount: last.signalCount, checkedAt: last.checkedAt, latestCheckedAt: last.latestCheckedAt, analyzedServices: last.analyzedServices, totalServices: last.totalServices, partial: last.partial } : undefined;
  const securityTitle = lastKnown ? `${lastKnown.count} vulnérabilité(s) relevée(s) lors des derniers contrôles enregistrés, à partir du ${lastKnown.checkedAt}. Résultat historique : le périmètre actuel reste à vérifier. ${unknownLabel}.` : `${count || known || partial ? `${count} vulnérabilité(s) connue(s) sur les composants analysés.` : "Le nombre de vulnérabilités ne peut pas encore être établi."} ${unknownLabel}. ${security?.coveredServices || 0}/${security?.totalServices || 0} service(s) au périmètre couvert. ${signalCount} signalement(s) à confirmer ; ${alertCount} autre(s) alerte(s).`;
  return { count, known, partial, incomplete: !known, signalCount, alertCount, coverageStatus: security?.status || "error", coveredServices: security?.coveredServices || 0, totalServices: security?.totalServices || 0, checkedAt: security?.checkedAt, severityCounts: security?.severityCounts, active, attention, refreshNeeded, revalidateAfterMs, disabledReason, securityTitle, unknownLabel, lastKnown, observed: observedInventory(detail), inventoryKnown: !!detail };
}
export type ProjectSummary = ReturnType<typeof summarizeProject>;
