import { wordpressSecurityVersions } from "./updates/wordpress-security-key";
import { projectHealth } from "./project-health";
import { automaticControlFresh, controlMatches, hasVerifiedSecurityControl } from "./automatic-control-state";
import { activeUpdateStages, type UpdateState } from "./updates/types";
import type { Project, ProjectDetail } from "./types";
export function observedInventory(detail?: ProjectDetail | null) {
  return !!(detail?.hosting?.some(site => site.inventory && !site.inventory.error && site.inventory.collectionMode !== "early") || detail?.vercel?.some(project => project.production?.state === "READY" && !!project.production.id) || detail?.railway?.some(project => project.services.some(service => service.activeDeployments.some(deployment => deployment.status === "SUCCESS"))));
}
export function summarizeProject(project: Project, detail: ProjectDetail | null, updates: UpdateState | null) {
  const health = detail ? projectHealth(detail, updates) : null;
  const count = health?.security.length || 0;
  const controlsPending = !!updates?.automaticControls && updates.targets.some(target => !updates.automaticControls?.some(control => control.targetId === target.id && automaticControlFresh(control) && detail && controlMatches(control, target, detail)));
  const controlError = updates?.automaticControls?.find(control => control.error)?.error;
  const known = !!health?.securityKnown && !!updates && !controlsPending && !updates.automaticControls?.some(control => control.coverage === "partial") && !updates.currentSecurity?.some(item => {
    const target = updates.targets.find(target => target.id === item.targetId);
    const inventory = detail?.hosting?.find(site => site.id === target?.remoteId && site.connectionId === target.connectionId)?.inventory;
    return item.error || !inventory || item.versions !== wordpressSecurityVersions(inventory);
  });
  const partial = !known && !!detail && !!updates && hasVerifiedSecurityControl(detail, updates);
  const active = !!updates?.runs[0] && activeUpdateStages.includes(updates.runs[0].stage);
  const refreshNeeded = !!updates?.targets.some(target => target.provider !== "o2switch" && /expiré|contrôle .*indisponible/.test(target.unavailable || ""));
  const attention = updates?.runs[0]?.stage === "attention";
  const disabledReason = project.lifecycle !== "active" ? "Projet archivé." : !updates ? "Le service de mise à jour est indisponible." : !updates.enabled ? "Le service de mise à jour n’est pas encore activé." : !updates.targets.some(target => !target.unavailable) ? "Aucun service ne peut être mis à jour. Consultez la fiche du projet." : "";
  const securityTitle = count ? `${count} signalement(s) de sécurité.${!known || health?.incomplete ? " Contrôles incomplets ou indisponibles." : ""}` : known ? "Aucun signalement connu sur le périmètre contrôlé." : partial ? "Aucun signalement connu sur les composants analysés ; couverture partielle." : controlError || "Les contrôles disponibles ne confirment pas l’absence de faille.";
  const unknownLabel = !updates ? "Contrôle indisponible" : controlError ? "Contrôle en échec" : updates.automaticControls?.some(control => control.coverage === "partial") ? "Couverture limitée" : controlsPending ? "À actualiser" : "Non vérifiable";
  return { count, known, partial, incomplete: !!health?.incomplete, active, attention, refreshNeeded, disabledReason, securityTitle, unknownLabel, observed: observedInventory(detail), inventoryKnown: !!detail };
}
export type ProjectSummary = ReturnType<typeof summarizeProject>;
