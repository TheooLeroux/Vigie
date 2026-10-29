import { CircleHelp, ShieldAlert, ShieldCheck } from "lucide-react";
import { coverageLabels, projectSecurity, type ProjectVulnerability } from "@/lib/project-security";
import type { ProjectHealth } from "@/lib/project-health";
import type { ProjectDetail } from "@/lib/types";
import type { UpdateState } from "@/lib/updates/types";

const severityLabels = { critical: "Critique", high: "Élevée", moderate: "Modérée", low: "Faible", unknown: "Non classée" };
const usageLabels = { runtime: "Dépendance de production", build: "Développement / construction", unknown: "Usage à qualifier" };
const date = (value: string) => new Date(value).toLocaleString("fr-FR");

function Findings({ items }: { items: ProjectVulnerability[] }) {
  return <ul className="security-findings">{items.map(item => <li key={item.key}>
    <strong>{item.package} {item.version}</strong> · {item.id}
    <small>{item.service} · {severityLabels[item.severity]} · {usageLabels[item.usage]}</small>
    {item.explanation && <small>{item.explanation}</small>}
    <small>Signalement relevé le {date(item.checkedAt)}</small>
  </li>)}</ul>;
}

export function ProjectSecurityPanel({ detail, updates, health, unavailable = false }: { detail: ProjectDetail; updates?: UpdateState | null; health: ProjectHealth; unavailable?: boolean }) {
  const security = projectSecurity(detail, updates, health);
  const hasAlerts = security.count > 0 || security.signals.length > 0 || security.alerts.length > 0;
  const loading = updates === undefined;
  const Icon = hasAlerts ? ShieldAlert : security.known ? ShieldCheck : CircleHelp;
  return <article className={`project-health-card ${hasAlerts ? "danger" : "neutral"}`}>
    <div className="project-health-title"><Icon size={20} aria-hidden="true" /><div><span>Sécurité</span><h2>{hasAlerts ? "Alertes de sécurité" : security.status === "error" && !loading ? "Contrôle de sécurité indisponible" : security.known ? "Aucune vulnérabilité connue" : "Sécurité à vérifier"}</h2></div></div>
    <p>{security.count || security.known || security.partial ? `${security.count} vulnérabilité(s) connue(s) sur les composants analysés.` : loading ? "Chargement des derniers contrôles…" : "Le nombre de vulnérabilités ne peut pas encore être établi."}</p>
    <div className="security-coverage-summary"><span className={`badge ${security.known ? "sage" : "neutral"}`}>{loading ? "Chargement des contrôles" : security.label}</span><small>{security.coveredServices}/{security.totalServices} service(s) au périmètre couvert</small></div>
    {!security.known && <small>Couverture partielle ou indisponible : les composants non analysés restent à vérifier.</small>}
    {(security.signals.length > 0 || security.alerts.length > 0) && <p>{security.signals.length} signalement(s) à confirmer · {security.alerts.length} autre(s) alerte(s), hors compteur de vulnérabilités.</p>}
    {security.count > 0 && <div className="security-severities">{Object.entries(security.severityCounts).filter(([, count]) => count > 0).map(([severity, count]) => <span key={severity}>{count} {severityLabels[severity as keyof typeof severityLabels].toLowerCase()}</span>)}</div>}
    <details className="health-details">
      <summary>{hasAlerts ? "Voir les alertes" : "Périmètre du contrôle"}</summary>
      {security.count > 0 && <><h3>Vulnérabilités connues</h3><Findings items={security.vulnerabilities} /></>}
      {security.signals.length > 0 && <><h3>Signalements à confirmer</h3><Findings items={security.signals} /></>}
      {security.alerts.length > 0 && <><h3>Support et autres alertes</h3><ul>{security.alerts.map(item => <li key={item}>{item}</li>)}</ul></>}
      <p>Une même vulnérabilité est comptée une fois par composant, version et service. Ses références CVE et GHSA sont regroupées. Une dépendance vulnérable ne prouve pas que le site a été compromis.</p>
    </details>
    <details className="health-details" open={!security.known && !loading}>
      <summary>Couverture et actions par service</summary>
      {!security.services.length && <p>Aucun service rattaché ne fournit de périmètre analysable. Relier le projet à son hébergement et identifier ses sources ou son inventaire.</p>}
      <div className="security-service-list">{security.services.map(service => <section className="security-service" key={service.id}>
        <div><strong>{service.name}</strong><span className={`badge ${service.status === "covered" ? "sage" : "neutral"}`}>{coverageLabels[service.status]}</span></div>
        <p>{service.scope}{service.packages !== undefined ? ` · ${service.packages} composant(s) identifié(s)` : ""}</p>
        <p>{service.reason}</p>
        {service.evidence?.source && <small>Lecture : {service.evidence.source === "vercel" ? "fichiers du déploiement Vercel" : service.evidence.source === "hosting" ? "fichiers de l’hébergement" : "sources GitHub"}{service.evidence.files !== undefined ? ` · ${service.evidence.files} fichier(s)` : ""}{service.evidence.deploymentId ? ` · ${service.evidence.deploymentId}` : ""}</small>}
        {!!service.evidence?.inventory?.length && <details><summary>Composants identifiés ({service.evidence.inventory.length})</summary><ul>{service.evidence.inventory.map(item => <li key={`${item.name}@${item.version}:${item.origin}`}>{item.name} {item.version} · {item.origin}</li>)}</ul></details>}
        {!!service.evidence?.filesRead?.length && <details><summary>Fichiers consultés ({service.evidence.filesRead.length})</summary><ul>{service.evidence.filesRead.map(path => <li key={path}>{path}</li>)}</ul></details>}
        {service.limitations.length > 0 && <ul>{service.limitations.map(item => <li key={item}>{item}</li>)}</ul>}
        {service.action && <p><strong>À faire :</strong> {service.action}</p>}
        {service.repository && <small>Source : {service.repository}{service.commit ? ` · commit ${service.commit.slice(0, 12)}` : ""}</small>}
        {service.checkedAt && <small>Dernier rapport enregistré : {date(service.checkedAt)}. {!["covered", "partial"].includes(service.status) ? "Ce rapport ne valide pas l’état actuel." : ""}</small>}
      </section>)}</div>
      <p>Le périmètre couvert concerne les composants identifiés ci-dessus. Le code métier, les secrets, la configuration et les couches d’hébergement non inventoriées demandent des contrôles complémentaires.</p>
      <p>Contrôle automatique toutes les heures et après détection d’un nouveau déploiement. Les erreurs techniques sont réessayées après cinq minutes.</p>
      {security.checkedAt && <p>Tous les services sont couverts ; le plus ancien contrôle date du {date(security.checkedAt)}.</p>}
      {unavailable && <p>Contrôle à actualiser ou indisponible. Les informations déjà connues restent affichées.</p>}
    </details>
  </article>;
}
