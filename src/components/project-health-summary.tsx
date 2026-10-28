"use client";
import { CircleHelp, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { projectHealth } from "@/lib/project-health";
import type { ProjectDetail } from "@/lib/types";
import type { UpdateState } from "@/lib/updates/types";
import { wordpressSecurityVersions } from "@/lib/updates/wordpress-security-key";
import { wordpressBlockingMessage } from "@/lib/updates/wordpress-blocking";

export function ProjectHealthSummary({ detail, updates, updatesUnavailable = false }: { detail: ProjectDetail; updates?: UpdateState | null; updatesUnavailable?: boolean }) {
  const health = projectHealth(detail, updates);
  const wordpressBlocked = updates?.runs[0]?.stage === "failed" && updates.runs[0].results.some(result => result.checks?.some(check => wordpressBlockingMessage(check)));
  const securityUnavailable = updates?.currentSecurity?.some(item => {
    const target = updates.targets.find(target => target.id === item.targetId);
    const inventory = detail.hosting?.find(site => site.id === target?.remoteId && site.connectionId === target.connectionId)?.inventory;
    return item.error || !inventory || item.versions !== wordpressSecurityVersions(inventory);
  });
  const securityLoading = updates === undefined && detail.hosting?.some(site => site.kind === "wordpress");
  const manualLabels = new Set(health.manualUpdates.map(item => item.label));
  const security = health.security.length > 0;
  const pendingUpdates = [...health.securityFixes, ...health.updates.filter(item => !manualLabels.has(item))];
  const available = pendingUpdates.length > 0;
  const SecurityIcon = security ? ShieldAlert : securityUnavailable || securityLoading ? CircleHelp : health.securityKnown ? ShieldCheck : CircleHelp;
  return <section className="project-health-summary" aria-label="Sécurité et mises à jour du projet" aria-live="polite">
    <article className={`project-health-card ${security ? "danger" : "neutral"}`}>
      <div className="project-health-title"><SecurityIcon size={20} aria-hidden="true" /><div><span>Sécurité</span><h2>{security ? "Alertes de sécurité" : securityLoading ? "Chargement des contrôles" : securityUnavailable ? "Contrôle de sécurité indisponible" : health.securityKnown ? "Aucune alerte connue" : "Sécurité à vérifier"}</h2></div></div>
      <p>{security ? `${health.security.length} point(s) à examiner.` : securityUnavailable ? "Le contrôle actuel n’a pas abouti." : health.securityKnown ? "Sur les composants contrôlés." : updates === undefined ? "Chargement des derniers contrôles…" : "Aucun contrôle exploitable pour l’état actuel."}</p>
      {(health.incomplete || updatesUnavailable) && <small>{updatesUnavailable ? "Derniers contrôles indisponibles." : "Relevés incomplets ou à actualiser."}</small>}
      <details className="health-details">
        <summary>{security ? "Voir les alertes" : "Périmètre du contrôle"}</summary>
        {security && <ul>{health.security.map(item => <li key={item}>{item}</li>)}</ul>}
        <p>Les composants non analysés restent à vérifier.</p>
        {securityUnavailable && <p>Les anciens signalements restent visibles ; l’absence de faille n’est pas confirmée.</p>}
        {updatesUnavailable && <p>Les informations déjà connues restent affichées.</p>}
      </details>
    </article>
    <article className={`project-health-card ${available || health.attention || security || health.securitySearchIncomplete ? "warning" : "neutral"}`}>
      <div className="project-health-title">{health.running ? <Loader2 size={20} className="spin" aria-hidden="true" /> : <RefreshCw size={20} aria-hidden="true" />}<div><span>Mises à jour</span><h2>{health.running ? "Mise à jour en cours" : health.attention ? "Vérification requise" : health.securitySearchIncomplete ? wordpressBlocked ? "Mise à jour WordPress bloquée" : "Combinaison sûre non validée" : health.securityFixes.length ? "Correctifs de sécurité à valider" : available ? "Mises à jour disponibles" : health.manualUpdates.length ? "Mises à jour à traiter séparément" : security ? "Sécurité non résolue" : health.versionsKnown ? "Aucune mise à jour signalée" : "Versions à vérifier"}</h2></div></div>
      <p>{available ? `${pendingUpdates.length} correctif(s) ou mise(s) à jour à examiner.` : health.manualUpdates.length ? `${health.manualUpdates.length} mise(s) à jour à traiter manuellement.` : health.securitySearchIncomplete ? "Aucune combinaison sûre validée. Les contrôles restent actifs." : health.attention ? "Le résultat du dernier traitement reste à vérifier." : security ? "Aucun correctif compatible validé pour les alertes signalées." : health.versionsKnown ? "Selon les versions relevées." : "Consultez l’onglet Technique pour actualiser les inventaires."}</p>
      {available && health.attention && <small>Le dernier traitement attend une vérification ; son succès n’est pas confirmé.</small>}
      {(available || health.manualUpdates.length > 0) && <details className="health-details">
        <summary>Voir les composants concernés</summary>
        {available && <ul>{pendingUpdates.map(item => <li key={item}>{item}</li>)}</ul>}
        {health.manualUpdates.length > 0 && <><p>À traiter séparément du bouton automatique :</p><ul>{health.manualUpdates.map(item => <li key={item.label}>{item.label} {item.reason}</li>)}</ul></>}
      </details>}
    </article>
  </section>;
}
