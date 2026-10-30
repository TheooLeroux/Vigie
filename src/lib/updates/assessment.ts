import { controlSource } from "../automatic-control-state";
import type { ProjectDetail } from "../types";
import type { UpdateResult, UpdateState, UpdateTarget } from "./types";

export const assessmentInterval = 24 * 60 * 60_000;

export function finishAssessment(result: UpdateResult, changes: string[], limitation?: string) {
  result.assessment = { changes: [...new Set(changes)], ...(limitation ? { limitation } : {}) };
  result.stage = "completed";
  result.message = changes.length ? "Une proposition stable a passé les contrôles avant installation." : "Aucune meilleure combinaison stable retenue par le parcours de maintenance.";
}

export function currentAssessmentResults(detail: ProjectDetail, state?: UpdateState | null, now = Date.now()) {
  const run = state?.assessment;
  if (!run || run.purpose !== "assessment" || !["completed", "failed"].includes(run.stage)) return [];
  const age = now - Date.parse(run.updatedAt);
  if (!Number.isFinite(age) || age < 0 || age >= assessmentInterval) return [];
  return run.results.filter(result => {
    const target = state!.targets.find(target => target.id === result.targetId);
    if (!target || result.stage !== "completed" || !result.assessment || !run.assessmentSources?.[target.id]) return false;
    if (state!.runs.some(update => Date.parse(update.updatedAt) > Date.parse(run.createdAt) && update.targets.some(selected => selected.id === target.id))) return false;
    if (result.assessment.sourceCommit && target.repository && controlSource(target, detail)?.commit !== result.assessment.sourceCommit) return false;
    return controlSource(target, detail)?.identity === run.assessmentSources[target.id];
  });
}

// Report only manifest version declarations and known version files. No source
// code, registry credentials or environment values enter the public assessment.
export function nodeAssessmentChanges(target: UpdateTarget, before: Record<string, any>, after: Record<string, any>, paths: string[]) {
  const prefix = target.root ? target.root + "/" : "";
  const selected = paths.filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
  const changes: string[] = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "engines"])
    for (const [name, version] of Object.entries(after[section] || {})) {
      const previous = before[section]?.[name];
      const safeVersion = (value: string) => /^[v~^<>= *|\d][\dA-Za-z v~^<>=.*+|_-]{0,99}$/.test(value) ? value : "déclaration modifiée";
      if (typeof previous === "string" && typeof version === "string" && previous !== version) changes.push(`${name} : ${safeVersion(previous)} → ${safeVersion(version)} (déclaration ${section})`);
    }
  if (selected.some(path => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path))) changes.push("Verrou des dépendances actualisé et validé.");
  for (const path of selected.filter(path => /(^|\/)(Dockerfile|\.nvmrc|\.node-version)$/.test(path))) changes.push(`${path.slice(prefix.length)} : version de l’environnement actualisée et validée.`);
  if (selected.length && !changes.length) changes.push(`Fichiers de versions actualisés et validés : ${selected.map(path => path.slice(prefix.length)).join(", ")}.`);
  return changes;
}

export function assessmentResultIsSafe(result: UpdateResult) {
  return result.stage === "completed" && !!result.assessment && !result.commit && !result.deploymentId && !result.backup
    && !!result.checks?.some(check => check.phase === "candidate")
    && !result.checks.some(check => check.status === "blocked");
}

export function wordpressAssessmentChanges(plan: { wordpress: { current: string; target: string }; plugins: { slug: string; current: string; target: string }[] }) {
  return [
    ...(plan.wordpress.current !== plan.wordpress.target ? [`WordPress : ${plan.wordpress.current} → ${plan.wordpress.target}`] : []),
    ...plan.plugins.filter(item => item.current !== item.target).map(item => `${item.slug} : ${item.current} → ${item.target}`),
  ];
}
