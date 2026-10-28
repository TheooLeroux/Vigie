"use client";
import { ArrowDown, CircleHelp, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
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
      {security ? <><p>{health.security.length} point(s) signalé(s) dans les relevés ou contrôles applicables.</p><ul>{health.security.slice(0, 2).map(item => <li key={item}>{item}</li>)}</ul>{health.security.length > 2 && <small>Et {health.security.length - 2} autre(s) point(s) dans les détails.</small>}</> : <p>{health.securityKnown ? "Sur le périmètre contrôlé ; les composants non analysés restent à vérifier." : updates === undefined ? "Chargement des derniers contrôles. Les versions non analysées restent à vérifier." : "Aucun contrôle de sécurité exploitable pour l’état actuel."}</p>}
      {health.incomplete && <small>Certains relevés sont incomplets ou à actualiser.</small>}
      {securityUnavailable && <small>Le contrôle actuel n’a pas abouti. Les anciens signalements restent visibles ; l’absence de faille n’est pas confirmée.</small>}
      {updatesUnavailable && <small>Derniers contrôles indisponibles : les informations déjà connues restent affichées.</small>}
      <a href={health.securityFromScan ? "#project-updates" : "#project-technical"}>Voir les contrôles <ArrowDown size={13} aria-hidden="true" /></a>
    </article>
    <article className={`project-health-card ${available || health.attention || security || health.securitySearchIncomplete ? "warning" : "neutral"}`}>
      <div className="project-health-title">{health.running ? <Loader2 size={20} className="spin" aria-hidden="true" /> : <RefreshCw size={20} aria-hidden="true" />}<div><span>Mises à jour</span><h2>{health.running ? "Mise à jour en cours" : health.attention ? "Vérification requise" : health.securitySearchIncomplete ? wordpressBlocked ? "Mise à jour WordPress bloquée" : "Combinaison sûre non validée" : health.securityFixes.length ? "Correctifs de sécurité à valider" : available ? "Mises à jour disponibles" : health.manualUpdates.length ? "Mises à jour à traiter séparément" : security ? "Sécurité non résolue" : health.versionsKnown ? "Aucune mise à jour signalée" : "Versions à vérifier"}</h2></div></div>
      {available ? <><p>{pendingUpdates.length} correctif(s) ou mise(s) à jour à examiner.</p><ul>{pendingUpdates.slice(0, 2).map(item => <li key={item}>{item}</li>)}</ul>{pendingUpdates.length > 2 && <small>Et {pendingUpdates.length - 2} autre(s) composant(s) dans les détails.</small>}</> : <p>{health.manualUpdates.length ? "Ces composants sont conservés par le bouton automatique. Leur mise à jour reste à traiter séparément." : health.securitySearchIncomplete ? "La recherche n’a pas permis de valider une combinaison sans faille connue dans ses limites. Les contrôles restent actifs." : health.attention ? "Le dernier traitement attend une vérification ; son succès n’est pas confirmé." : security ? "Des vulnérabilités restent signalées. Aucun correctif compatible n’est encore validé ; la sécurité n’est pas résolue." : health.versionsKnown ? "Selon les versions relevées. Les dépendances non inventoriées restent à vérifier." : "Actualisez les inventaires pour connaître les mises à jour disponibles."}</p>}
      {health.manualUpdates.length > 0 && <><p>{health.manualUpdates.length} mise(s) à jour hors du traitement automatique :</p><ul>{health.manualUpdates.map(item => <li key={item.label}>{item.label} {item.reason}</li>)}</ul></>}
      {available && health.attention && <small>Le dernier traitement attend une vérification ; son succès n’est pas confirmé.</small>}
      <a href="#project-updates">Voir les mises à jour <ArrowDown size={13} aria-hidden="true" /></a>
    </article>
  </section>;
}
