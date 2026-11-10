import type { Ref } from "react";
import { CircleAlert, CircleHelp, ShieldAlert, ShieldCheck } from "lucide-react";
import { projectRemediation, type RemediationReason } from "@/lib/project-remediation";
import { coverageLabels, projectSecurity, type ProjectVulnerability } from "@/lib/project-security";
import type { ProjectHealth } from "@/lib/project-health";
import type { ProjectDetail } from "@/lib/types";
import type { UpdateState } from "@/lib/updates/types";

const severityLabels = { critical: "Critique", high: "Élevée", moderate: "Modérée", low: "Faible", unknown: "Non classée" };
const usageLabels = { runtime: "Dépendance de production", build: "Développement / construction", unknown: "Usage à qualifier" };
const date = (value: string) => new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

type ExplainRemediation = (item: ProjectVulnerability) => RemediationReason | undefined;

function FindingRows({ rows }: { rows: { item: ProjectVulnerability; reason?: RemediationReason }[] }) {
  return <ul className="security-findings">
    {rows.map(({ item, reason }) => <li key={item.key}>
      <details className="security-finding">
        <summary>
          <span className={`security-severity ${item.severity}`}>{severityLabels[item.severity]}</span>
          <span className="security-finding-content">
            <strong>
              {item.title || `${item.kind === "vulnerability" ? "Vulnérabilité signalée" : "Signalement à confirmer"} dans ${item.package}`}
              {reason && !reason.manual && <span className="security-finding-reason" title="Voir pourquoi la faille persiste">
                <CircleAlert size={13} aria-hidden="true" />
                <span className="sr-only"> · Motif disponible</span>
              </span>}
            </strong>
            <span>
              <span className="security-version">{item.version}</span>
              {reason?.manual && <span className="security-finding-reason">
                <CircleAlert size={13} aria-hidden="true" /> {reason.label}
              </span>}
            </span>
          </span>
          <span className="security-finding-reference">{item.id}</span>
        </summary>
        <div className="security-finding-body">
          {reason && <div><p><strong>{reason.label}</strong></p>{reason.detail && <p>{reason.detail}</p>}</div>}
          {item.explanation && item.explanation !== reason?.detail && <p>{item.explanation}</p>}
          <p><strong>Correction :</strong> {item.fixedVersions?.length ? <>version(s) correctrice(s) indiquée(s) dans le rapport : {item.fixedVersions.join(", ")}.</> : "aucune version correctrice indiquée dans ce rapport."}</p>
          <small>{usageLabels[item.usage]} · Signalement relevé le {date(item.checkedAt)}</small>
          {!!item.scanners?.length && <small>{item.scanners.map(scan => `${scan.tool}${scan.tool === "Trivy" ? item.railpackImage ? " · image Railpack" : item.minimalStaticImage ? " · image statique" : "" : ""} · ${date(scan.checkedAt)}`).join(" / ")}</small>}
          <small>Références : {item.aliases.join(" · ") || item.id}</small>
          {item.url && /^https?:\/\//i.test(item.url) && <a href={item.url} target="_blank" rel="noreferrer">Consulter le signalement ↗</a>}
        </div>
      </details>
    </li>)}
  </ul>;
}

function Findings({ items, explain }: { items: ProjectVulnerability[]; explain?: ExplainRemediation }) {
  const blocks = new Map<string, ProjectVulnerability[]>();
  for (const item of items) {
    const entries = blocks.get(item.targetId) || [];
    entries.push(item);
    blocks.set(item.targetId, entries);
  }
  return <div className={explain ? "security-findings-group security-current-findings" : "security-findings-group"}>{[...blocks].map(([targetId, entries]) => {
    const packages = new Map<string, ProjectVulnerability[]>();
    for (const item of entries) {
      const findings = packages.get(item.package) || [];
      findings.push(item);
      packages.set(item.package, findings);
    }
    return <details className="security-findings-block" open key={targetId}>
      <summary className="security-group-heading"><span className="security-group-name">Bloc : <strong>{entries[0].service}</strong></span><small>{entries.length} signalement{entries.length > 1 ? "s" : ""}</small></summary>
      {[...packages].map(([name, findings]) => {
        const severity = findings[0].severity; // Les signalements sont déjà triés par gravité.
        const rows = findings.map(item => ({ item, reason: explain?.(item) }));
        const needsManualAction = rows.some(({ reason }) => reason?.manual);
        return <details className="security-findings-package" key={name}>
          <summary className="security-group-heading">
            <strong className="security-group-name">{name}</strong>
            <span className="security-package-meta">
              {needsManualAction && <span className="badge warning">Intervention manuelle requise</span>}
              <span className={`security-severity ${severity}`}><span className="sr-only">Gravité maximale : </span>{severityLabels[severity]}</span>
              <small>{findings.length} signalement{findings.length > 1 ? "s" : ""}</small>
            </span>
          </summary>
          <FindingRows rows={rows} />
        </details>;
      })}
    </details>;
  })}</div>;
}

export function ProjectSecurityPanel({ detail, updates, health, unavailable = false, updateActionRef }: { detail: ProjectDetail; updates?: UpdateState | null; health: ProjectHealth; unavailable?: boolean; updateActionRef?: Ref<HTMLDivElement> }) {
  const security = projectSecurity(detail, updates, health);
  const explain = projectRemediation(detail, updates);
  const historical = security.lastKnown;
  const hasAlerts = security.count > 0 || security.signals.length > 0 || security.alerts.length > 0;
  const loading = updates === undefined;
  const secondarySummary = [security.signals.length > 0 ? `${security.signals.length} signalement(s) à confirmer` : "", security.alerts.length > 0 ? `${security.alerts.length} autre(s) alerte(s)` : ""].filter(Boolean).join(" · ");
  const Icon = hasAlerts ? ShieldAlert : security.known ? ShieldCheck : CircleHelp;
  return <article className={`project-health-card project-security-card ${hasAlerts ? "danger" : "neutral"}`}>
    <div className="security-panel-heading"><div className="project-health-title"><Icon size={20} aria-hidden="true" /><div><span>Sécurité</span><h2>{security.count > 0 ? `${security.count} faille${security.count > 1 ? "s" : ""} connue${security.count > 1 ? "s" : ""}` : hasAlerts ? "Alertes de sécurité" : security.status === "error" && !loading ? "Contrôle de sécurité indisponible" : security.known ? "Aucune vulnérabilité connue" : "Sécurité à vérifier"}</h2></div></div>
      <div className="security-panel-actions">
        <div className="security-coverage-summary"><span className={`badge ${security.known ? "sage" : "neutral"}`}>{loading ? "Chargement des contrôles" : security.label}</span><small>{security.coveredServices}/{security.totalServices} service(s) au périmètre couvert</small></div>
        {updateActionRef && <div className="security-update-action" ref={updateActionRef} />}
      </div>
    </div>
    {security.count > 0 && <div className="security-severities" aria-label="Répartition par gravité">{Object.entries(security.severityCounts).filter(([, count]) => count > 0).map(([severity, count]) => <span className={`security-severity ${severity}`} key={severity}>{count} {severityLabels[severity as keyof typeof severityLabels].toLowerCase()}{count > 1 ? "s" : ""}</span>)}</div>}
    {!security.known && <p className="security-coverage-note">Couverture partielle ou indisponible : les composants non analysés restent à vérifier.</p>}
    {security.count > 0 && <Findings items={security.vulnerabilities} explain={explain} />}
    {historical && <div className="security-history"><p><strong>{historical.count} vulnérabilité(s)</strong> relevée(s) lors des derniers contrôles enregistrés.</p><small>Contrôles du {date(historical.checkedAt)}{historical.latestCheckedAt !== historical.checkedAt ? ` au ${date(historical.latestCheckedAt)}` : ""} · {historical.analyzedServices}/{historical.totalServices} service(s) analysé(s){historical.partial ? " · périmètre partiel" : ""}.</small><p>Ces résultats restent consultables, mais ne confirment pas l’état actuel.</p><details className="health-details"><summary>Voir le dernier rapport enregistré</summary>{historical.vulnerabilities.length > 0 ? <Findings items={historical.vulnerabilities} /> : <p>Aucune vulnérabilité n’avait été signalée dans le périmètre de ces contrôles.</p>}{historical.signals.length > 0 && <><h3>Signalements à confirmer dans ce rapport</h3><Findings items={historical.signals} /></>}</details></div>}
    {(security.signals.length > 0 || security.alerts.length > 0) && <details className="health-details security-secondary">
      <summary>{secondarySummary} · hors compteur de vulnérabilités</summary>
      {security.signals.length > 0 && <><h3>Signalements à confirmer</h3><Findings items={security.signals} /></>}
      {security.alerts.length > 0 && <><h3>Support et autres alertes</h3><ul>{security.alerts.map(item => <li key={item}>{item}</li>)}</ul></>}
    </details>}
    <details className="health-details security-secondary">
      <summary>Couverture et actions par service</summary>
      {!security.services.length && <p>Aucun service rattaché ne fournit de périmètre analysable. Relier le projet à son hébergement et identifier ses sources ou son inventaire.</p>}
      <div className="security-service-list">{security.services.map(service => <section className="security-service" key={service.id}>
        <div><strong>{service.name}</strong><span className={`badge ${service.status === "covered" ? "sage" : "neutral"}`}>{coverageLabels[service.status]}</span></div>
        <p>{service.scope}{service.packages !== undefined ? ` · ${service.packages} composant(s) identifié(s)` : ""}</p>
        <p>{service.reason}</p>
        {service.evidence?.source && <small>Lecture : {service.evidence.source === "vercel" ? "fichiers du déploiement Vercel" : service.evidence.source === "railway" ? "dépendances du conteneur Railway actif" : service.evidence.source === "hosting" ? "fichiers de l’hébergement" : "sources GitHub"}{service.evidence.files !== undefined ? ` · ${service.evidence.files} fichier(s)` : ""}{service.evidence.deploymentId ? ` · ${service.evidence.deploymentId}` : ""}</small>}
        {!!service.evidence?.inventory?.length && <details><summary>Composants identifiés ({service.evidence.inventory.length})</summary><ul>{service.evidence.inventory.map(item => <li key={`${item.name}@${item.version}:${item.origin}`}>{item.name} {item.version} · {item.origin}</li>)}</ul></details>}
        {!!service.evidence?.filesRead?.length && <details><summary>Fichiers consultés ({service.evidence.filesRead.length})</summary><ul>{service.evidence.filesRead.map(path => <li key={path}>{path}</li>)}</ul></details>}
        {service.limitations.length > 0 && <ul>{service.limitations.map(item => <li key={item}>{item}</li>)}</ul>}
        {service.action && <p><strong>À faire :</strong> {service.action}</p>}
        {service.repository && <small>Source : {service.repository}{service.commit ? ` · commit ${service.commit.slice(0, 12)}` : ""}</small>}
        {service.checkedAt && <small>Dernier rapport enregistré : {date(service.checkedAt)}. {!["covered", "partial"].includes(service.status) ? "Ce rapport ne valide pas l’état actuel." : ""}</small>}
        {service.railpackImageCheckedAt && <small>Trivy · {service.minimalStaticImage ? "Image statique déployée" : "Paquets de l’image Railpack"} contrôlés le {date(service.railpackImageCheckedAt)}.</small>}
      </section>)}</div>
      <p>Le périmètre couvert concerne les composants identifiés ci-dessus. Le code métier, les secrets, la configuration et les couches d’hébergement non inventoriées demandent des contrôles complémentaires.</p>
      <p>Le compteur compte chaque vulnérabilité une seule fois par projet, même si plusieurs blocs sont concernés. Ses références CVE et GHSA sont regroupées. Une dépendance vulnérable ne prouve pas que le site a été compromis.</p>
      <p>Contrôle automatique toutes les heures et après détection d’un nouveau déploiement. Les erreurs techniques sont réessayées après cinq minutes.</p>
      {security.checkedAt && <p>Tous les services sont couverts ; le plus ancien contrôle date du {date(security.checkedAt)}.</p>}
      {unavailable && <p>Contrôle à actualiser ou indisponible. Les informations déjà connues restent affichées.</p>}
    </details>
  </article>;
}
