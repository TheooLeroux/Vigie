import { projectSeverityCounts } from "@/lib/project-severity";
import type { ProjectSummary } from "@/lib/project-summary";
import { severityLabels } from "@/lib/security-watch";
import { severityOrder } from "@/lib/vulnerability-references";
import { formatDate } from "./ui";

export function ProjectSecurityBadge({ summary, onOpen }: { summary?: ProjectSummary; onOpen: () => void }) {
  const historical = summary?.lastKnown;
  const counts = projectSeverityCounts(summary);
  const populated = counts ? severityOrder.filter(severity => counts[severity] > 0) : [];
  const coverage = historical ? `Ancien relevé${historical.partial ? " · partiel" : ""}` : summary?.unknownLabel ?? "Contrôle indisponible";
  const checkedServices = historical?.analyzedServices ?? summary?.coveredServices;
  const totalServices = historical?.totalServices ?? summary?.totalServices;
  const serviceCoverage = totalServices && totalServices > 1 ? ` · ${checkedServices}/${totalServices} services` : "";
  const signals = historical?.signalCount ?? summary?.signalCount ?? 0;
  const alerts = summary?.alertCount ?? 0;
  const countLabel = populated.map(severity => `${counts![severity]} · ${severityLabels[severity]}`).join(", ") || (counts ? "0 faille" : "Nombre de failles indisponible");
  const details = [coverage + serviceCoverage, historical && `Relevé du ${formatDate(historical.checkedAt)}`, signals > 0 && `${signals} à confirmer`, alerts > 0 && `${alerts} autre${alerts > 1 ? "s" : ""} alerte${alerts > 1 ? "s" : ""}`].filter(Boolean).join(". ");
  return <button type="button" className="security-summary-button record-secondary" onClick={onOpen} title={summary?.securityTitle} aria-label={`${countLabel}. ${details}. Voir les vulnérabilités du projet.`}>
    <span className="project-severity-counts">
      {counts && populated.length ? populated.map(severity => <span key={severity} className={`project-severity ${severity}`} title={severityLabels[severity]}>{counts[severity]}</span>)
        : <span className="project-severity">{counts ? "0" : "—"}</span>}
    </span>
    <small>{coverage}{serviceCoverage}</small>
    {historical && <small><time dateTime={historical.checkedAt}>{formatDate(historical.checkedAt)}</time></small>}
    {(signals > 0 || alerts > 0) && <small>{signals > 0 && `${signals} à confirmer`}{signals > 0 && alerts > 0 && " · "}{alerts > 0 && `${alerts} autre${alerts > 1 ? "s" : ""} alerte${alerts > 1 ? "s" : ""}`}</small>}
  </button>;
}
