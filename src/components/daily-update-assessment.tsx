import { assessmentHasNoTarget, currentAssessmentResults, noAssessmentTargetMessage } from "@/lib/updates/assessment";
import { activeUpdateStages, type UpdateCheck, type UpdateState } from "@/lib/updates/types";
import type { ProjectDetail } from "@/lib/types";
import { formatDate } from "./ui";
import { FindingDetails, RemainingNpmFindings } from "./project-updates";

function AssessmentChecks({ checks }: { checks: UpdateCheck[] }) {
  const latest = new Map<string, UpdateCheck>();
  for (const check of checks) latest.set(`${check.tool}:${check.phase}`, check);
  return <details>
    <summary>Critères contrôlés et résultats</summary>
    {[...latest.values()].map(check => {
      const findings = check.blockers || check.findings;
      return <div key={`${check.tool}:${check.phase}`}>
        <p><strong>{check.tool} · {check.phase === "before" ? "État actuel" : "Proposition"} · {check.status === "blocked" ? "Bloquant" : check.status === "warning" ? "Avec réserves" : "Vérifié"}</strong></p>
        <p>{check.scope} · {check.message}</p>
        {findings.slice(0, 8).map((finding, index) => <FindingDetails key={`${finding.id}:${index}`} finding={finding} />)}
        {findings.length > 8 && <p>{findings.length - 8} autre(s) signalement(s) dans le rapport.</p>}
      </div>;
    })}
  </details>;
}

export function DailyUpdateAssessment({ detail, state }: { detail: ProjectDetail; state?: UpdateState | null }) {
  const run = state?.assessment;
  if (!run) return <small>Bilan quotidien des versions stables : premier résultat attendu.</small>;
  const active = activeUpdateStages.includes(run.stage);
  const noTarget = assessmentHasNoTarget(run);
  const verified = new Set(currentAssessmentResults(detail, state).map(result => result.targetId));
  const proposals = run.results.filter(result => verified.has(result.targetId) && result.assessment!.changes.length > 0).length;
  const stale = run.results.some(result => result.stage === "completed" && !verified.has(result.targetId));
  const status = active ? "En cours" : noTarget ? "Aucun service admissible" : stale ? "À actualiser" : run.stage === "failed" && !verified.size ? "Bilan bloqué" : run.stage !== "completed" || run.excludedTargets?.length ? "Bilan partiel" : proposals ? `${proposals} bloc(s) avec proposition validée` : "Aucune meilleure version validée";
  return <details className="updates-details daily-assessment" open={active}>
    <summary>{run.assessmentOrigin === "maintenance" ? "Bilan après maintenance" : "Bilan quotidien"} · {status} · {formatDate(run.updatedAt)}</summary>
    <p>Recherche de versions stables et contrôles avant maintenance. Aucune installation ni publication automatique.</p>
    {active && <p role="status">{run.message}</p>}
    {!run.results.length && !active && <p>{noTarget ? noAssessmentTargetMessage : run.stage === "failed" ? run.message : "Aucun bloc n’a pu être validé dans ce bilan."}</p>}
    {run.results.map(result => <section className="updates-target" key={result.targetId}>
      <strong>Bloc : {result.name}</strong>
      <p>{activeUpdateStages.includes(result.stage) ? "Vérification en cours." : result.stage === "completed" && !verified.has(result.targetId) ? "Ce bilan ne confirme plus l’état actuel du bloc : date, déploiement ou sources à actualiser." : result.message}</p>
      {!activeUpdateStages.includes(result.stage) && <RemainingNpmFindings result={result} proposal={run.assessmentOrigin !== "maintenance" || !verified.has(result.targetId)} />}
      {verified.has(result.targetId) && <>
        {!!result.assessment!.changes.length && <ul>{result.assessment!.changes.map(change => <li key={change}>{change}</li>)}</ul>}
        {result.assessment!.limitation && <p>{result.assessment!.limitation}</p>}
        {!!result.manualUpdates?.length && <p>{result.manualUpdates.length} composant(s) restent à traiter manuellement.</p>}
      </>}
      {result.warnings.length > 0 && <details><summary>Réserves et contrôles complémentaires</summary>{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      {!!result.checks?.length && <AssessmentChecks checks={result.checks} />}
    </section>)}
    {!!run.excludedTargets?.length && <details><summary>Blocs à qualifier ou à traiter séparément · {run.excludedTargets.length}</summary>{run.excludedTargets.map(target => <p key={target.targetId}><strong>{target.name} :</strong> {target.reason}</p>)}</details>}
  </details>;
}
