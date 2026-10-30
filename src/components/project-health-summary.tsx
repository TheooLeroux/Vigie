"use client";
import type { ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { projectHealth } from "@/lib/project-health";
import type { ProjectDetail } from "@/lib/types";
import type { UpdateState } from "@/lib/updates/types";
import { ProjectSecurityPanel } from "./project-security-panel";

export function ProjectHealthSummary({ detail, updates, updatesUnavailable = false, maintenance }: { detail: ProjectDetail; updates?: UpdateState | null; updatesUnavailable?: boolean; maintenance?: ReactNode }) {
  const health = projectHealth(detail, updates);
  const wordpress = detail.hosting?.some(site => site.kind === "wordpress") || updates?.targets.some(target => target.mode === "wordpress");
  const manualLabels = new Set(health.manualUpdates.map(item => item.label));
  const security = health.security.length > 0;
  const manualFixes = new Set(health.manualSecurityFixes);
  const automaticFixes = health.securityFixes.filter(item => !manualFixes.has(item));
  const pendingUpdates = [...automaticFixes, ...health.updates.filter(item => !manualLabels.has(item))];
  const available = pendingUpdates.length > 0;
  const unavailableTargets = updates?.targets.filter(target => target.unavailable) || [];
  const wordpressTitle = updates && !updates.enabled ? "Maintenance non activée" : updates?.targets.length && unavailableTargets.length === updates.targets.length ? "Vérification technique requise" : automaticFixes.length ? "Correctifs de sécurité à valider" : available ? "Mises à jour disponibles" : health.manualUpdates.length ? "Interventions manuelles requises" : security ? "Sécurité à traiter" : health.versionsKnown ? "Aucune mise à jour signalée" : "Versions à vérifier";
  return <section className="project-health-summary" aria-label="Sécurité et mises à jour du projet" aria-live="polite">
    <ProjectSecurityPanel detail={detail} updates={updates} health={health} unavailable={updatesUnavailable} />
    <article className={`project-health-card project-maintenance-card ${available || health.attention || security || health.securitySearchIncomplete ? "warning" : "neutral"}`}>
      <div className="project-health-title">{health.running ? <Loader2 size={20} className="spin" aria-hidden="true" /> : <RefreshCw size={20} aria-hidden="true" />}<div><span>Mises à jour</span><h2>{health.running ? "Mise à jour en cours" : health.attention ? "Vérification requise" : wordpress ? wordpressTitle : health.securitySearchIncomplete ? "Combinaison sûre non validée" : automaticFixes.length ? "Correctifs de sécurité à valider" : available ? "Mises à jour disponibles" : health.manualUpdates.length ? "Mises à jour à traiter séparément" : security ? "Sécurité non résolue" : health.versionsKnown ? "Aucune mise à jour signalée" : "Versions à vérifier"}</h2></div></div>
      <p>{wordpress && updates && !updates.enabled ? updates.disabledReason || "L’exécuteur de maintenance doit être configuré et activé." : wordpress && updates?.targets.length && unavailableTargets.length === updates.targets.length ? "Le contrôle de l’agent ou de la configuration doit être renouvelé avant un lancement." : available ? `${pendingUpdates.length} correctif(s) ou mise(s) à jour à examiner.` : health.manualUpdates.length ? `${health.manualUpdates.length} composant(s) à mettre à jour ou à vérifier manuellement.` : !wordpress && health.securitySearchIncomplete ? "Aucune combinaison sûre validée. Les contrôles restent actifs." : health.attention ? "Le résultat du dernier traitement reste à vérifier." : security ? "Aucun correctif compatible validé pour les alertes signalées." : health.versionsKnown ? "Selon les versions relevées." : "Consultez l’onglet Technique pour actualiser les inventaires."}</p>
      {wordpress && health.manualUpdates.length > 0 && <small>{health.manualUpdates.length} composant(s) à traiter manuellement. Ils ne bloquent pas les autres mises à jour compatibles.</small>}
      {available && health.attention && <small>Le dernier traitement attend une vérification ; son succès n’est pas confirmé.</small>}
      {(available || health.manualUpdates.length > 0) && <details className="health-details">
        <summary>Voir les composants concernés</summary>
        {available && <ul>{pendingUpdates.map(item => <li key={item}>{item}</li>)}</ul>}
        {health.manualUpdates.length > 0 && <><p>À traiter séparément du bouton automatique :</p><ul>{health.manualUpdates.map(item => <li key={item.label}>{item.label} {item.reason}</li>)}</ul></>}
        {health.manualSecurityFixes.length > 0 && <><p>Correctifs de sécurité à traiter manuellement :</p><ul>{health.manualSecurityFixes.map(item => <li key={item}>{item}</li>)}</ul></>}
      </details>}
      {maintenance}
    </article>
  </section>;
}
