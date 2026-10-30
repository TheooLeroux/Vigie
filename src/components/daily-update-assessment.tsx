import { currentAssessmentResults } from "@/lib/updates/assessment";
import { activeUpdateStages, type UpdateState } from "@/lib/updates/types";
import type { ProjectDetail } from "@/lib/types";
import { formatDate } from "./ui";

export function DailyUpdateAssessment({ detail, state }: { detail: ProjectDetail; state?: UpdateState | null }) {
  const run = state?.assessment;
  if (!run) return <small>Bilan quotidien des versions stables : premier résultat attendu.</small>;
  const active = activeUpdateStages.includes(run.stage);
  const verified = new Set(currentAssessmentResults(detail, state).map(result => result.targetId));
  const proposals = run.results.filter(result => verified.has(result.targetId) && result.assessment!.changes.length > 0).length;
  const stale = run.results.some(result => result.stage === "completed" && !verified.has(result.targetId));
  const status = active ? "En cours" : stale ? "À actualiser" : run.stage !== "completed" || run.excludedTargets?.length ? "Bilan partiel" : proposals ? `${proposals} bloc(s) avec proposition validée` : "Aucune meilleure version validée";
  return <details className="updates-details daily-assessment" open={active}>
    <summary>{run.assessmentOrigin === "maintenance" ? "Bilan après maintenance" : "Bilan quotidien"} · {status} · {formatDate(run.updatedAt)}</summary>
    <p>Recherche de versions stables et contrôles avant maintenance. Aucune installation ni publication automatique.</p>
    {active && <p role="status">{run.message}</p>}
    {!run.results.length && !active && <p>Aucun bloc n’a pu être validé dans ce bilan.</p>}
    {run.results.map(result => <section className="updates-target" key={result.targetId}>
      <strong>Bloc : {result.name}</strong>
      <p>{activeUpdateStages.includes(result.stage) ? "Vérification en cours." : result.stage !== "completed" ? `Vérification bloquée : ${result.message}` : !verified.has(result.targetId) ? "Ce bilan ne confirme plus l’état actuel du bloc : date, déploiement ou sources à actualiser." : result.message}</p>
      {verified.has(result.targetId) && <>
        {!!result.assessment!.changes.length && <ul>{result.assessment!.changes.map(change => <li key={change}>{change}</li>)}</ul>}
        {result.assessment!.limitation && <p>{result.assessment!.limitation}</p>}
        {!!result.manualUpdates?.length && <p>{result.manualUpdates.length} composant(s) restent à traiter manuellement.</p>}
      </>}
      {result.warnings.length > 0 && <details><summary>Réserves et contrôles complémentaires</summary>{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
    </section>)}
    {!!run.excludedTargets?.length && <details><summary>Blocs à qualifier ou à traiter séparément · {run.excludedTargets.length}</summary>{run.excludedTargets.map(target => <p key={target.targetId}><strong>{target.name} :</strong> {target.reason}</p>)}</details>}
  </details>;
}
