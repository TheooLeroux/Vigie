import { automaticControlFresh, controlMatches, controlSource } from "./automatic-control-state";
import { projectHealth, type ProjectHealth } from "./project-health";
import type { ProjectDetail } from "./types";
import type { SecurityFinding, UpdateState, UpdateTarget } from "./updates/types";

export type CoverageStatus = "covered" | "partial" | "missing" | "pending" | "stale" | "error" | "unsupported";
export const coverageLabels: Record<CoverageStatus, string> = {
  covered: "Périmètre couvert", partial: "Couverture partielle", missing: "Sources manquantes",
  pending: "Analyse attendue", stale: "À actualiser", error: "Contrôle en erreur", unsupported: "Analyse à compléter",
};
export type ServiceCoverage = {
  id: string; name: string; provider: string; status: CoverageStatus; scope: string;
  reason: string; action: string; limitations: string[]; checkedAt?: string; packages?: number;
  repository?: string | null; commit?: string | null;
  evidence?: import("./automatic-control-state").SecurityCoverageDetails;
};
export type ProjectVulnerability = {
  key: string; id: string; aliases: string[]; targetId: string; service: string;
  package: string; version: string; severity: SecurityFinding["severity"]; usage: NonNullable<SecurityFinding["usage"]>;
  kind: NonNullable<SecurityFinding["kind"]>; checkedAt: string; explanation?: string;
};
const securityTools = new Set(["OSV", "WPScan", "WPVulnerability", "Trivy"]);
const severityOrder = ["critical", "high", "moderate", "low", "unknown"];

// Merge overlapping alias sets, including bridges (CVE -> GHSA -> another CVE).
// Each affected component/version is counted once per service, regardless of paths or scanners.
export function normalizedVulnerabilities(evidence: ProjectHealth["securityEvidence"]): ProjectVulnerability[] {
  const components = new Map<string, { evidence: typeof evidence; ids: Set<string> }[]>();
  for (const entry of evidence) {
    if (!securityTools.has(entry.tool)) continue;
    const { finding } = entry;
    const component = JSON.stringify([entry.targetId, finding.package, finding.version]);
    const groups = components.get(component) || [];
    components.set(component, groups);
    const ids = new Set([finding.id, ...finding.aliases].map(id => id.toUpperCase()));
    const matching = groups.filter(group => [...ids].some(id => group.ids.has(id)));
    const group = { ids, evidence: [entry] };
    for (const previous of matching) {
      previous.ids.forEach(id => ids.add(id));
      group.evidence.push(...previous.evidence);
      groups.splice(groups.indexOf(previous), 1);
    }
    groups.push(group);
  }
  return [...components.values()].flat().map(group => {
    const confirmed = group.evidence.filter(entry => (!entry.finding.kind || entry.finding.kind === "vulnerability") && !/^EOL-|^WPV-SUPPLY-/.test(entry.finding.id));
    const entries = confirmed.length ? confirmed : group.evidence;
    const entry = [...entries].sort((a, b) => severityOrder.indexOf(a.finding.severity) - severityOrder.indexOf(b.finding.severity))[0];
    const ids = [...group.ids].sort((a, b) => Number(!a.startsWith("CVE-")) - Number(!b.startsWith("CVE-")) || a.localeCompare(b));
    const { finding } = entry;
    return {
      key: JSON.stringify([entry.targetId, finding.package, finding.version, ids[0]]), id: ids[0], aliases: ids,
      targetId: entry.targetId, service: entry.name, package: finding.package, version: finding.version,
      severity: finding.severity, usage: finding.usage || "unknown",
      kind: confirmed.length ? "vulnerability" as const : finding.kind || "unconfirmed" as const,
      checkedAt: entries.map(item => item.checkedAt).sort().at(-1)!, explanation: finding.explanation,
    };
  }).sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) || a.key.localeCompare(b.key));
}

function expectedTargets(detail: ProjectDetail, state?: UpdateState | null) {
  const targets = (state?.targets || []).filter(target => !(target.provider === "o2switch" && detail.hosting?.some(item => item.id === target.remoteId && item.connectionId === target.connectionId && item.ignored)) && !(target.provider === "vercel" && detail.vercel?.some(item => item.id === target.remoteId && item.connectionId === target.connectionId && item.excluded)));
  const add = (target: UpdateTarget) => {
    if (!targets.some(item => item.provider === target.provider && item.connectionId === target.connectionId && item.remoteId === target.remoteId && item.environmentId === target.environmentId)) targets.push(target);
  };
  const base = { projectId: detail.project.id, branch: null, url: null, configured: false, unavailable: null };
  for (const item of detail.vercel || []) if (!item.excluded) add({ ...base, id: `vercel:${item.connectionId}:${item.id}`, name: item.name, provider: "vercel", connectionId: item.connectionId, remoteId: item.id, environmentId: null, repository: item.production?.repository || item.repository, root: (item.production?.rootDirectory || item.rootDirectory || "").replace(/^\/+|\/+$/g, ""), mode: item.repository ? "git" : "archive" });
  for (const item of detail.railway || []) for (const service of item.services) if (service.environmentName.toLowerCase() === "production") add({ ...base, id: `railway:${item.connectionId}:${service.id}:${service.environmentId}`, name: service.name, provider: "railway", connectionId: item.connectionId, remoteId: service.id, environmentId: service.environmentId, repository: service.repository, root: (service.rootDirectory || "").replace(/^\/+|\/+$/g, ""), mode: service.repository ? "git" : "archive" });
  for (const item of detail.hosting || []) if (!item.ignored) add({ ...base, id: `${item.kind === "wordpress" ? "wordpress" : "hosting"}:${item.id}`, name: item.domains[0] || detail.project.name, provider: "o2switch", connectionId: item.connectionId, remoteId: item.id, environmentId: null, repository: null, root: item.documentRoot, mode: item.kind === "wordpress" ? "wordpress" : "archive" });
  return targets;
}

function serviceCoverage(target: UpdateTarget, detail: ProjectDetail, state?: UpdateState | null): ServiceCoverage {
  const control = state?.automaticControls?.find(item => item.targetId === target.id);
  const service = detail.railway?.flatMap(item => item.connectionId === target.connectionId ? item.services : []).find(item => item.id === target.remoteId && item.environmentId === target.environmentId);
  const image = control?.securityCoverage?.scope === "image" || !!service?.image && !target.repository;
  const scope = control?.securityCoverage?.scope === "sources" ? "Sources récupérées, dépendances et bibliothèques identifiables" : target.mode === "wordpress" ? "Cœur, extensions et thèmes WordPress identifiables" : image ? "Paquets de l’image déployée" : "Dépendances verrouillées du commit déployé";
  const base = { id: target.id, name: target.name, provider: target.provider, scope, limitations: [] as string[], repository: target.repository, commit: controlSource(target, detail)?.commit, evidence: control?.securityCoverage };
  const outcome = (status: CoverageStatus, reason: string, action: string, extra: Partial<ServiceCoverage> = {}): ServiceCoverage => ({ ...base, status, reason, action, ...extra });
  if (!state) return outcome("error", "Les rapports de sécurité sont indisponibles.", "Recharger les contrôles du projet.");
  const last = control?.checkedAt ? { checkedAt: control.checkedAt } : {};
  if (control?.error) return outcome("error", control.error, /GitHub|dépôt|accès/.test(control.error) ? "Vérifier l’accès en lecture au dépôt et au commit déployé." : "Actualiser les relevés ; le contrôle sera réessayé automatiquement.", last);
  if (control?.coverage === "partial" && !control.checks.some(check => securityTools.has(check.tool))) return outcome(target.repository || image || target.mode === "wordpress" || control.securityCoverage?.scope === "sources" ? "unsupported" : "missing", control.warnings[0] || "Aucun analyseur disponible pour ce service.", control.securityCoverage?.scope === "sources" ? "Compléter les versions ou les fichiers signalés ; les sources disponibles ont été récupérées." : image ? "Rendre l’image exacte accessible au scanner." : target.repository ? "Fournir un verrou résolu et un analyseur adapté à la technologie." : "Relier les sources ou fournir un inventaire lié au déploiement.", { ...last, limitations: control.warnings });
  if (!control) {
    const observation = state.currentSecurity?.find(item => item.targetId === target.id);
    if (observation?.error) return outcome("error", observation.error, "Actualiser l’inventaire WordPress et attendre le prochain contrôle.");
    if (!target.repository && target.mode !== "wordpress" && !image && target.provider !== "vercel") return outcome("missing", "Les sources déployées ne sont pas identifiées.", "Relier le dépôt source ou un inventaire vérifiable au déploiement.");
    return outcome("pending", "Aucun rapport automatique enregistré pour ce service.", "Attendre le prochain contrôle ou actualiser les relevés.");
  }
  if (!controlMatches(control, target, detail) || !automaticControlFresh(control)) return outcome("stale", "Le rapport a expiré, le déploiement a changé ou le relevé hébergeur doit être renouvelé.", "Actualiser les relevés et analyser le déploiement actuel.", last);
  if (!control.checks.some(check => securityTools.has(check.tool))) return outcome("pending", "Le contrôle n’a pas fourni de rapport de vulnérabilités exploitable.", "Relancer le contrôle automatique.", last);
  const limitations = [...(control.securityCoverage?.limitations || [])];
  // Legacy reports have no structured coverage: retain concrete WordPress reservations.
  if (!control.securityCoverage && target.mode === "wordpress") limitations.push(...control.warnings);
  if (!control.securityCoverage && control.sourceQualification?.sharedLock) limitations.push("Le verrou est partagé avec d’autres services ; le périmètre exact reste à confirmer.");
  if (control.checks.some(check => check.findings.some(finding => finding.kind === "unconfirmed"))) limitations.push("L’applicabilité de certains signalements au service reste à confirmer.");
  if (control.coverage === "partial" && !limitations.length) limitations.push(...control.warnings, "Une partie du service n’est pas analysée.");
  return outcome(limitations.length ? "partial" : "covered", limitations.length ? "Certains composants restent à vérifier." : "Le périmètre déclaré a été analysé pour l’état actuel.", limitations.length ? "Compléter les composants ou preuves indiqués ci-dessous." : "", { ...last, limitations: [...new Set(limitations)], packages: control.securityCoverage?.packages });
}

// Historical evidence is separate from current coverage. Expiring an observation
// must not erase a recorded count, nor turn an old clean scan into a current zero.
function lastRecordedSecurity(detail: ProjectDetail, targets: UpdateTarget[], state?: UpdateState | null) {
  const evidence: ProjectHealth["securityEvidence"] = [], dates: string[] = [];
  let analyzedServices = 0, limited = false;
  for (const target of targets) {
    const control = state?.automaticControls?.find(item => item.targetId === target.id);
    if (!control?.checkedAt || !Number.isFinite(Date.parse(control.checkedAt))) continue;
    if (control.identity !== "unavailable") {
      try { if (JSON.parse(control.identity)[1] !== detail.project.id) continue; } catch { continue; }
    }
    const checks = control.checks.filter(check => securityTools.has(check.tool) && Number.isFinite(Date.parse(check.checkedAt)) && (check.status !== "blocked" || check.findings.length > 0));
    if (!checks.length) continue;
    analyzedServices++; dates.push(...checks.map(check => check.checkedAt));
    limited ||= control.coverage === "partial" || !!control.securityCoverage?.limitations.length;
    for (const check of checks) for (const finding of check.findings) evidence.push({ targetId: target.id, name: target.name, tool: check.tool, checkedAt: check.checkedAt, finding });
  }
  if (!analyzedServices) return undefined;
  const entries = normalizedVulnerabilities(evidence), vulnerabilities = entries.filter(item => item.kind === "vulnerability");
  const signals = entries.filter(item => item.kind !== "vulnerability" && !item.id.startsWith("EOL-"));
  dates.sort((a, b) => Date.parse(a) - Date.parse(b));
  return { count: vulnerabilities.length, signalCount: signals.length, checkedAt: dates[0], latestCheckedAt: dates.at(-1)!, analyzedServices, totalServices: targets.length, partial: limited || analyzedServices < targets.length, vulnerabilities, signals };
}

export function projectSecurity(detail: ProjectDetail, state?: UpdateState | null, health = projectHealth(detail, state)) {
  const entries = normalizedVulnerabilities(health.securityEvidence);
  const vulnerabilities = entries.filter(item => item.kind === "vulnerability");
  const signals = entries.filter(item => item.kind !== "vulnerability" && !item.id.startsWith("EOL-"));
  const alerts = [...health.securityOtherAlerts, ...entries.filter(item => item.id.startsWith("EOL-")).map(item => `${item.service} · ${item.package} : système en fin de support.`)];
  const targets = expectedTargets(detail, state);
  const services = targets.map(target => serviceCoverage(target, detail, state));
  const coveredServices = services.filter(item => item.status === "covered").length;
  const analyzedServices = services.filter(item => item.status === "covered" || item.status === "partial").length;
  const known = services.length > 0 && coveredServices === services.length;
  const partial = !known && analyzedServices > 0;
  const status: CoverageStatus = known ? "covered" : partial ? "partial" : services.some(item => item.status === "error") ? "error" : services.some(item => item.status === "stale") ? "stale" : services.some(item => item.status === "missing") || !services.length ? "missing" : services.some(item => item.status === "unsupported") ? "unsupported" : "pending";
  const severityCounts = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  vulnerabilities.forEach(item => severityCounts[item.severity]++);
  const checkedAt = known ? services.map(item => item.checkedAt!).sort()[0] : undefined;
  const lastKnown = !known && !partial ? lastRecordedSecurity(detail, targets, state) : undefined;
  return { count: vulnerabilities.length, vulnerabilities, signals, alerts, severityCounts, services, known, partial, status, label: coverageLabels[status], coveredServices, analyzedServices, totalServices: services.length, checkedAt, lastKnown };
}
