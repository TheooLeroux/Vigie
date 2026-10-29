import { CircleHelp, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ProjectSummary } from "@/lib/project-summary";

export function ProjectSecurityBadge({ summary, onOpen }: { summary?: ProjectSummary; onOpen: () => void }) {
  const count = summary?.count || 0;
  const attention = count > 0 || !!summary?.signalCount || !!summary?.alertCount;
  const measurable = !!summary && (count > 0 || summary.known || summary.partial);
  const Icon = attention ? ShieldAlert : summary?.known ? ShieldCheck : CircleHelp;
  return <button type="button" className="security-summary-button record-secondary" onClick={onOpen} title={summary?.securityTitle || "Les rapports sont indisponibles."} aria-label="Voir les vulnérabilités et la couverture du projet">
    <span className={`badge ${attention ? "warning" : summary?.known ? "sage" : "neutral"}`}><Icon size={13} aria-hidden="true" />{measurable ? `${count} faille${count > 1 ? "s" : ""}` : summary?.unknownLabel || "Contrôle indisponible"}</span>
    {measurable && <small>{summary!.unknownLabel}</small>}
    {!!summary && summary.totalServices > 1 && <small>{summary.coveredServices}/{summary.totalServices} services couverts</small>}
    {!!summary && (summary.signalCount > 0 || summary.alertCount > 0) && <small>{summary.signalCount > 0 ? `${summary.signalCount} à confirmer` : ""}{summary.signalCount > 0 && summary.alertCount > 0 ? " · " : ""}{summary.alertCount > 0 ? `${summary.alertCount} autre${summary.alertCount > 1 ? "s" : ""} alerte${summary.alertCount > 1 ? "s" : ""}` : ""}</small>}
  </button>;
}
