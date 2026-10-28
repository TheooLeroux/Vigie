"use client";
import { ArrowDown, CircleHelp, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { projectHealth } from "@/lib/project-health";
import type { ProjectDetail } from "@/lib/types";
import type { UpdateState } from "@/lib/updates/types";

export function ProjectHealthSummary({ detail, updates, updatesUnavailable = false }: { detail: ProjectDetail; updates?: UpdateState | null; updatesUnavailable?: boolean }) {
  const health = projectHealth(detail, updates);
  const security = health.security.length > 0, available = health.updates.length > 0;
  const SecurityIcon = security ? ShieldAlert : health.securityKnown ? ShieldCheck : CircleHelp;
  return <section className="project-health-summary" aria-label="Sécurité et mises à jour du projet" aria-live="polite">
    <article className={`project-health-card ${security ? "danger" : "neutral"}`}>
      <div className="project-health-title"><SecurityIcon size={20} aria-hidden="true" /><div><span>Sécurité</span><h2>{security ? "Alertes de sécurité" : health.securityKnown ? "Aucune alerte connue" : "Sécurité à vérifier"}</h2></div></div>
      {security ? <><p>{health.security.length} point(s) signalé(s) dans les relevés ou contrôles applicables.</p><ul>{health.security.slice(0, 2).map(item => <li key={item}>{item}</li>)}</ul>{health.security.length > 2 && <small>Et {health.security.length - 2} autre(s) point(s) dans les détails.</small>}</> : <p>{health.securityKnown ? "Sur le périmètre contrôlé ; les composants non analysés restent à vérifier." : updates === undefined ? "Chargement des derniers contrôles. Les versions non analysées restent à vérifier." : "Aucun contrôle de sécurité exploitable pour l’état actuel."}</p>}
      {health.incomplete && <small>Certains relevés sont incomplets ou à actualiser.</small>}
      {updatesUnavailable && <small>Derniers contrôles indisponibles : les informations déjà connues restent affichées.</small>}
      <a href={health.securityFromScan ? "#project-updates" : "#project-technical"}>Voir les contrôles <ArrowDown size={13} aria-hidden="true" /></a>
    </article>
    <article className={`project-health-card ${available || health.attention ? "warning" : "neutral"}`}>
      <div className="project-health-title">{health.running ? <Loader2 size={20} className="spin" aria-hidden="true" /> : <RefreshCw size={20} aria-hidden="true" />}<div><span>Mises à jour</span><h2>{health.running ? "Mise à jour en cours" : health.attention ? "Vérification requise" : available ? "Mises à jour disponibles" : health.versionsKnown ? "Aucune mise à jour signalée" : "Versions à vérifier"}</h2></div></div>
      {available ? <><p>{health.updates.length} composant(s) à actualiser selon les relevés disponibles.</p><ul>{health.updates.slice(0, 2).map(item => <li key={item}>{item}</li>)}</ul>{health.updates.length > 2 && <small>Et {health.updates.length - 2} autre(s) composant(s) dans les détails.</small>}</> : <p>{health.attention ? "Le dernier traitement attend une vérification ; son succès n’est pas confirmé." : health.versionsKnown ? "Selon les versions relevées. Les dépendances non inventoriées restent à vérifier." : "Actualisez les inventaires pour connaître les mises à jour disponibles."}</p>}
      {available && health.attention && <small>Le dernier traitement attend une vérification ; son succès n’est pas confirmé.</small>}
      <a href="#project-updates">Voir les mises à jour <ArrowDown size={13} aria-hidden="true" /></a>
    </article>
  </section>;
}
