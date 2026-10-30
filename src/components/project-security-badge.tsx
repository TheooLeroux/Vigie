import { CircleHelp, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ProjectSummary } from "@/lib/project-summary";

export function ProjectSecurityBadge({ summary, onOpen }: { summary?: ProjectSummary; onOpen: () => void }) {
  const historical = summary?.lastKnown;
  const count = historical?.count ?? summary?.count ?? 0;
  const signals = historical?.signalCount ?? summary?.signalCount ?? 0;
  const attention = count > 0 || signals > 0 || !!summary?.alertCount;
  const measurable = !!summary && (!!historical || count > 0 || summary.known || summary.partial);
  const Icon = attention ? ShieldAlert : summary?.known ? ShieldCheck : CircleHelp;
  return <button type="button" className="security-summary-button record-secondary" onClick={onOpen} title={summary?.securityTitle || "Les rapports sont indisponibles."} aria-label="Voir les vulnérabilités et la couverture du projet">
    <span className={`badge ${attention ? "warning" : summary?.known ? "sage" : "neutral"}`}><Icon size={13} aria-hidden="true" />{measurable ? historical ? `${count} au dernier contrôle` : `${count} faille${count > 1 ? "s" : ""}` : summary?.unknownLabel || "Contrôle indisponible"}</span>
    {measurable && <small>{summary!.unknownLabel}</small>}
    {historical && <small><time dateTime={historical.checkedAt}>{new Date(historical.checkedAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })}</time>{historical.partial ? " · partiel" : ""}</small>}
    {!!summary && summary.totalServices > 1 && <small>{summary.coveredServices}/{summary.totalServices} services couverts</small>}
    {!!summary && (signals > 0 || summary.alertCount > 0) && <small>{signals > 0 ? `${signals} à confirmer` : ""}{signals > 0 && summary.alertCount > 0 ? " · " : ""}{summary.alertCount > 0 ? `${summary.alertCount} autre${summary.alertCount > 1 ? "s" : ""} alerte${summary.alertCount > 1 ? "s" : ""}` : ""}</small>}
  </button>;
}
