"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Download, Loader2, RefreshCw } from "lucide-react";
import { activeUpdateStages, type SecurityFinding, type UpdateRun, type UpdateStage, type UpdateState, type UpdateTarget } from "@/lib/updates/types";
import { formatDate } from "./ui";
import { updateStopSummary } from "@/lib/updates/stop-summary";
import { updateProgressStatus } from "@/lib/updates/progress";
import { createRefreshQueue } from "@/lib/project-realtime";
import { useProjectRealtime } from "./project-realtime";

type Request = (path: string, method?: string, payload?: unknown, options?: { signal?: AbortSignal }) => Promise<any>;
function FindingDetails({ finding }: { finding: SecurityFinding }) {
  const level = { critical: "critique", high: "élevée", moderate: "modérée", low: "faible", unknown: "non classée" }[finding.severity];
  return <div><p><strong>{finding.title || finding.package}</strong></p><p><code>{finding.package}@{finding.version}</code> · {finding.aliases[0] || finding.id} · sévérité {level}</p>{finding.explanation && <p>{finding.explanation}</p>}{finding.fixedVersions?.length ? <p>Version(s) correctrice(s) référencée(s) : {finding.fixedVersions.join(", ")}. Leur compatibilité doit être vérifiée avant installation.</p> : null}{finding.url && <a href={finding.url} target="_blank" rel="noreferrer">Consulter la source du signalement</a>}</div>;
}
export const updateStageLabels: Record<UpdateStage, string> = { queued: "En attente", checking: "Vérification", updating: "Mise à jour", publishing: "Publication", verifying: "Contrôle du déploiement", completed: "Terminé", failed: "Non publiée", attention: "À vérifier" };
export function MaintenanceScope({ targets }: { targets: UpdateTarget[] }) {
  if (!targets.some(target => target.capability)) return null;
  const deferred = targets.filter(target => target.capability?.status !== "automatic" || target.unavailable);
  return <div className="updates-scope" aria-label="Périmètre de maintenance">
    <p><strong>Maintenance selon le type de service</strong></p>
    {targets.map(target => <div className="updates-target" key={target.id}><strong>{target.name}</strong><p>{target.capability?.label || "Service à qualifier"} · {target.capability?.status === "manual" ? "Intervention séparée" : target.unavailable || target.capability?.status === "qualify" ? "Qualification nécessaire" : "Parcours automatique disponible"}</p><p>{target.unavailable || target.capability?.reason}</p></div>)}
    {deferred.length > 0 && <p className="updates-note">{deferred.length} service(s) restent à qualifier ou à traiter séparément. Le bouton traite les autres services admissibles ; les sources partagées restent vérifiées ensemble.</p>}
  </div>;
}
export function UpdateReadiness({ state }: { state: UpdateState }) {
  const ready = state.targets.filter(target => !target.unavailable);
  const wordpress = state.targets.some(target => target.mode === "wordpress");
  return <div className="updates-note" role="status">
    {!state.enabled && <p><strong>Maintenance non activée.</strong> {state.disabledReason || "L’exécuteur de maintenance doit être configuré et activé."}</p>}
    {state.targets.filter(target => target.unavailable).map(target => <p key={target.id}><strong>Vérification technique · {target.name} :</strong> {target.unavailable}</p>)}
    {state.enabled && ready.length > 0 && <p>{wordpress ? "WordPress est prêt pour une maintenance des composants compatibles." : `${ready.length} service(s) prêt(s) sur ${state.targets.length}.`}</p>}
    {state.targets.length === 0 && <p>Aucun service de mise à jour rattaché. Consultez les connexions et la configuration.</p>}
    {wordpress && <p>Les composants manuels sont conservés et signalés. Ils ne bloquent pas la mise à jour du cœur et des autres extensions compatibles.</p>}
  </div>;
}
export function WordPressManualUpdates({ run, observations, targets = [] }: { run?: UpdateRun; observations?: UpdateState["currentSecurity"]; targets?: UpdateTarget[] }) {
  const current = observations?.filter(item => !item.error && item.check && item.manualUpdates !== undefined) || [];
  const groups = current.length ? current.map(item => ({ targetId: item.targetId, name: targets.find(target => target.id === item.targetId)?.name || item.targetId, manualUpdates: item.manualUpdates })) : run?.results || [];
  if (!groups.some(result => result.manualUpdates?.length)) return null;
  const at = current.length ? current.map(item => item.check!.checkedAt).sort()[0] : run?.updatedAt;
  return <div className="updates-note" role="status">
    <strong>{current.length ? "Composants à traiter manuellement" : "Interventions manuelles restantes"}</strong>
    <p>{current.length ? "Selon le contrôle en lecture seule, ces composants demandent une intervention ou une vérification manuelle." : "Ces composants ont été conservés."} Ils n’empêchent pas la mise à jour des autres composants ; leurs alertes de sécurité restent à traiter. {at && <>Liste relevée le {formatDate(at)}.</>}</p>
    <ul>{groups.flatMap(result => (result.manualUpdates || []).map(item => <li key={`${result.targetId}:${item.package}`}>
      <strong>{result.name} · {item.package} · {item.version || "version inconnue"}{item.target ? ` → ${item.target}` : " · mise à jour à vérifier"}</strong>
      <p>{item.reason} {item.action}</p>
    </li>))}</ul>
  </div>;
}
export function ManagedNodeNotice({ run }: { run?: UpdateRun }) {
  const pending = run?.results.filter(result => result.managedNode?.updatePending || result.managedNode?.migrationAvailable) || [];
  if (!pending.length) return null;
  return <div className="updates-note" role="status"><strong>{pending.some(result => result.managedNode?.updatePending) ? "Correctif Node en attente chez Vercel" : "Migration Node à planifier"}</strong>
    {pending.map(result => <p key={result.targetId}>{result.name} : dernière version mesurée <strong>Node {result.managedNode!.version}</strong>. {result.managedNode!.updatePending && <>{result.managedNode!.securityUpdate ? "Correctif de sécurité" : "Correctif Node"} attendu : <strong>{result.managedNode!.branchLatest || result.managedNode!.latestLts}</strong>. La mise à jour du runtime dépend de Vercel et n’est pas confirmée. </>}{result.stage === "completed" ? "Les dépendances ont été validées avec la version mesurée. " : ""}{result.managedNode!.migrationAvailable && <>Migration vers la LTS {result.managedNode!.latestLts} à planifier séparément ; elle ne bloque pas les dépendances compatibles. </>}Relevé du {formatDate(result.managedNode!.checkedAt)}.</p>)}
  </div>;
}
export function UpdateProgress({ run }: { run: UpdateRun }) {
  const active = activeUpdateStages.includes(run.stage);
  const { heartbeatMissing: delayed, noConfirmedProgress } = updateProgressStatus(run);
  const stopped = updateStopSummary(run);
  return <div className={`updates-progress ${run.stage}`} role="status" aria-live="polite">
    {active ? <Loader2 size={18} className="spin" /> : run.stage === "completed" ? <Check size={18} /> : <CircleAlert size={18} />}
    <div><strong>{delayed ? "Le traitement met plus de temps que prévu" : stopped?.title || updateStageLabels[run.stage]}</strong><p>{delayed ? "Vigie attend une confirmation de l’exécuteur. Ne relancez pas une deuxième mise à jour." : stopped?.reason || run.message}</p>
      {stopped && <><p>{stopped.notice}</p>{stopped.findings.length > 0 && <><p>Derniers signalements relevés pendant cette tentative :</p><ul>{stopped.findings.map(({target, finding}, index) => <li key={index}><strong>{target} · {finding.package} {finding.version}</strong> : {finding.aliases[0] || finding.id}. {finding.fixedVersions?.length ? `Correctifs référencés : ${finding.fixedVersions.join(", ")} ; compatibilité à valider.` : "Aucun correctif référencé dans ce rapport."}</li>)}</ul>{stopped.additionalFindings > 0 && <p>{stopped.additionalFindings} autre(s) signalement(s) dans le compte rendu détaillé.</p>}</> }</>}
      {noConfirmedProgress && !delayed && <p>Aucune nouvelle étape confirmée depuis au moins 15 minutes. L’exécuteur répond encore ; l’étape en cours reste à vérifier.</p>}
      <small>{run.lastProgressAt ? `Dernière progression : ${formatDate(run.lastProgressAt)} · Activité de l’exécuteur : ` : ""}{formatDate(run.updatedAt)}</small></div>
  </div>;
}
function SourceSetup({ target, projectId, request, onSaved }: { target: UpdateTarget; projectId: string; request: Request; onSaved: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <form className="updates-setup" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      let payload: Record<string, unknown> = { targetId: target.id };
      if (target.mode === "archive") {
        if (!file || file.size > 2_000_000) throw new Error("Choisissez un ZIP de moins de 2 Mo, sans node_modules, fichiers .env ni clés privées.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        payload = { ...payload, archive: btoa(binary), filename: file.name };
      } else payload = { ...payload, localAgent: true };
      await request(`updates/${projectId}/source`, "POST", payload);
      setFile(null);
      await onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : "Configuration non enregistrée."); }
    finally { setBusy(false); }
  }}>
    {target.mode === "archive" ? <>
      <p>Ajoutez les sources complètes : package.json, fichier de verrouillage et code, avec le répertoire {target.root || "racine"}. Vigie conservera ensuite les sources actualisées pour les prochaines mises à jour. Réimportez-les après une modification externe du code.</p>
      <label>Sources du projet — ZIP, 2 Mo maximum<input type="file" accept=".zip,application/zip" onChange={event => setFile(event.target.files?.[0] || null)} required /></label>
      <a className="text-button" href={`/api/updates/${projectId}/source?targetId=${encodeURIComponent(target.id)}`}><Download size={13} /> Télécharger les sources conservées</a>
    </> : <>
      <p>L’agent local est installé automatiquement avec la connexion o2switch déjà enregistrée, sur les sites existants et lors de l’ajout d’un nouveau WordPress. Son démarrage est vérifié avant de rendre la maintenance disponible. Aucune mise à jour n’est lancée pendant cette installation.</p>
    </>}
    {error && <p role="alert" className="updates-error">{error}</p>}
    <button className="button secondary" disabled={busy}>{busy ? "Demande en cours…" : target.mode === "wordpress" ? "Réessayer l’installation automatique" : "Enregistrer la configuration"}</button>
  </form>;
}
export function ProjectUpdates({ projectId, request, onState, embedded = false }: { projectId: string; request: Request; onState?: (projectId: string, state: UpdateState | null) => void; embedded?: boolean }) {
  const [state, setState] = useState<UpdateState | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const refreshing = useRef(false);
  const { subscribe } = useProjectRealtime();
  const [refreshingHosting, setRefreshingHosting] = useState(false), [hostingError, setHostingError] = useState("");
  const refreshHosting = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true; setRefreshingHosting(true);
    try {
      const response = await request("updates/refresh", "POST", { projectId });
      if (alive.current) { setState(response.state); onState?.(projectId, response.state); setHostingError(response.errors.join(" ")); }
    } catch (error) { if (alive.current) setHostingError(error instanceof Error ? error.message : "Actualisation non confirmée."); }
    finally { refreshing.current = false; if (alive.current) setRefreshingHosting(false); }
  }, [projectId, request, onState]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next: UpdateState = await request(`updates?projectId=${encodeURIComponent(projectId)}`, "GET", undefined, { signal });
      if (alive.current && !signal?.aborted && !refreshing.current) { setState(next); setError(""); onState?.(projectId, next); }
      return next;
    } catch (error) { if (alive.current && !signal?.aborted) onState?.(projectId, null); throw error; }
  }, [projectId, request, onState]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const queue = createRefreshQueue(async () => { await refresh(controller.signal); }, error => { if (alive.current && !controller.signal.aborted) setError((error as Error).message); });
    const unsubscribe = subscribe(change => { if (change.all || change.projects.includes(projectId)) queue.invalidate([projectId]); });
    queue.invalidate([projectId]);
    return () => { alive.current = false; controller.abort(); queue.dispose(); unsubscribe(); };
  }, [refresh, subscribe, projectId]);
  const latest = state?.runs[0], active = latest && activeUpdateStages.includes(latest.stage);
  const assessmentActive = !!state?.assessment && activeUpdateStages.includes(state.assessment.stage);
  const available = state?.targets.filter(target => !target.unavailable && (!target.capability || target.capability.status === "automatic" && target.capability.adapter)) || [];
  const unresolved = latest?.stage === "attention";
  const newerObservation = latest?.stage === "failed" && state?.currentSecurity?.some(item => !item.error && item.check && Date.parse(item.check.checkedAt) > Date.parse(latest.updatedAt));
  async function startUpdate(targetIds?: string[]) {
    setBusy(true); setError("");
    try { await request("updates", "POST", { projectId, ...(targetIds ? { targetIds } : {}) }); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "La mise à jour n’a pas démarré."); }
    finally { setBusy(false); }
  }
  return <section id="project-updates" className={`project-updates ${embedded ? "updates-embedded" : "panel"}`} aria-label="Mises à jour du projet">
    <div className="updates-heading"><div>{!embedded && <h2>Mettre le projet à jour</h2>}<p>Mises à jour compatibles selon la technologie de chaque service.</p></div>
      <button className="button primary" disabled={busy || refreshingHosting || !!active || assessmentActive || !!unresolved || !state?.enabled || !available.length} onClick={() => void startUpdate()}>{busy || active ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}{active ? "Mise à jour en cours" : "Mettre à jour"}</button>
    </div>
    {error && <p role="alert" className="updates-error">{error} <button className="text-button" onClick={() => void refresh().catch(() => {})}>Réessayer le chargement</button></p>}
    {hostingError && <p role="alert" className="updates-error">{hostingError}</p>}
    {!state && !error && <p className="updates-note">Chargement des mises à jour…</p>}
    {state && (!embedded || !state.enabled || !state.targets.length || state.targets.some(target => target.unavailable)) && <UpdateReadiness state={state} />}
    {state?.targets.some(target => target.provider !== "o2switch") && <p className="updates-note"><button className="text-button" disabled={refreshingHosting} onClick={() => void refreshHosting()}>{refreshingHosting ? "Actualisation des hébergements…" : "Actualiser les relevés d’hébergement"}</button> · Lecture des déploiements, sans mise à jour des sites.</p>}
    {state?.targets.some(target => target.capability) && <details className="updates-details"><summary>Périmètre et conditions de maintenance</summary><MaintenanceScope targets={state.targets} />
    {state?.targets.some(target => target.mode === "image" && target.capability?.adapter === "railway-image") && <p className="updates-note">Images Tailscale Railway : le proxy SOCKS sortant standard dispose d’un parcours dédié. L’image stable est analysée puis la reconnexion et l’accès réseau sont contrôlés. Les alertes non classées déjà présentes restent visibles comme réserves ; les configurations persistantes ou personnalisées demandent une qualification séparée.</p>}
    {state?.targets.some(target => target.provider === "vercel" && target.capability?.workload === "static") && <p className="updates-note">Sites statiques Vercel : Vite, Astro et Create React App sont pris en charge après qualification des sources et de la sortie du build. Les fichiers publiés sont comparés aux empreintes du build validé ; Node sert à la construction locale. Les fonctions serveur, workspaces, variables externes et configurations particulières demandent une qualification séparée.</p>}
    </details>}
    {available.filter(target => target.mode === "image").map(target => <p className="updates-note" key={target.id}><button className="button secondary" disabled={busy || refreshingHosting || !!active || assessmentActive || !!unresolved || !state?.enabled} onClick={() => void startUpdate([target.id])}>Mettre à jour l’image de {target.name}</button> · Ce service uniquement.</p>)}
    {latest && (latest.stage === "completed" || newerObservation ? <details className="updates-details"><summary>{latest.stage === "completed" ? "Dernière mise à jour terminée" : "Dernière tentative arrêtée"} · {formatDate(latest.updatedAt)}</summary><UpdateProgress run={latest} /></details> : <UpdateProgress run={latest} />)}
    <ManagedNodeNotice run={latest} />
    {!!latest?.excludedTargets?.length && <details className="updates-details"><summary>Services hors de la dernière maintenance · {latest.excludedTargets.length}</summary>{latest.excludedTargets.map(target => <p key={target.targetId}><strong>{target.name}</strong> : {target.reason}</p>)}</details>}
    <WordPressManualUpdates run={latest} observations={state?.currentSecurity} targets={state?.targets} />
    {!!state?.currentSecurity?.length && <details className="updates-details"><summary>Rapports de sécurité</summary>
      {state.currentSecurity.map(observation => <details className="updates-security-report" key={observation.targetId}><summary>{state.targets.find(target => target.id === observation.targetId)?.name || "Service"}{observation.check ? ` · ${observation.check.findings.length} signalement(s)` : " · indisponible"}</summary>{observation.error && <p role="status">{observation.error}</p>}{observation.check && <><p>{formatDate(observation.check.checkedAt)} · Ce contrôle ne lance aucune mise à jour. Les rapports des exécutions précédentes restent dans l’historique.</p>{observation.check.findings.map(finding => <FindingDetails key={finding.id} finding={finding} />)}{!observation.check.findings.length && <p>Aucune vulnérabilité connue dans le périmètre contrôlé.</p>}</>}{observation.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>)}
    </details>}
    <details className="updates-details"><summary>Configuration et compte rendu</summary>
      <p className="updates-note">Les versions majeures sont incluses si leur validation réussit. {state?.targets.some(target => target.mode === "wordpress") && "Sauvegarde fichiers et base avant modification, contrôle gratuit WPVulnerability. PHP reste géré par l’hébergeur ; pour les thèmes, utilisez WordPress → Apparence → Thèmes."}</p>
      {state?.targets.map(target => <div className="updates-target" key={target.id}><strong>{target.name}</strong><p>{target.provider} · {target.mode === "git" ? "Sources GitHub" : target.mode === "archive" ? "Sources sans Git" : target.mode === "image" ? "Image officielle Railway" : "WordPress"}</p><p>{target.unavailable || "Prêt pour la mise à jour."}</p>{target.mode !== "git" && target.mode !== "image" && !(target.provider === "o2switch" && target.mode !== "wordpress") && !active && <details><summary>{target.mode === "wordpress" ? "Installation automatique de l’agent" : target.configured ? "Sources et accès" : "Configurer une première fois"}</summary><SourceSetup target={target} projectId={projectId} request={request} onSaved={async () => { await refresh(); }} /></details>}</div>)}
      {latest?.results.map(result => <div className="updates-target" key={result.targetId}><strong>{result.name} — {updateStageLabels[result.stage]}</strong><p>{result.message}</p>{result.commit && <p>Commit publié : <code>{result.commit.slice(0, 10)}</code></p>}{result.deploymentId && <p>Déploiement : <code>{result.deploymentId}</code></p>}{result.previousDeploymentId && <p>Déploiement précédent conservé : <code>{result.previousDeploymentId}</code></p>}{result.imageUpdate?.rollbackDeploymentId && <p>Retour et connexion contrôlés : <code>{result.imageUpdate.rollbackDeploymentId}</code></p>}{result.backup && <p>Sauvegarde privée sur o2switch : <code>{result.backup}</code>. Sa restauration reste manuelle pour ne pas écraser de nouvelles données.</p>}{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        {result.checks?.map((check, index) => <details key={index}><summary>{check.tool === "Static" ? "Fichiers statiques" : check.tool} · {check.phase === "before" ? "Avant mise à jour" : check.phase === "candidate" ? "Version candidate" : "Après installation"} · {check.status === "blocked" ? "Bloqué" : check.status === "warning" ? "Avec réserves" : "Vérifié"}</summary><p>{check.scope} · {formatDate(check.checkedAt)}</p><p>{check.message}</p>{check.staticEvidence && <p>{check.staticEvidence.fileCount} fichier(s) · Node du build de validation : {check.staticEvidence.buildNodeVersion} · Déploiement : <code>{check.staticEvidence.deploymentId}</code> · Empreinte SHA-256 : <code>{check.staticEvidence.artifactHash}</code></p>}{check.findings.slice(0, 20).map((finding, findingIndex) => <p key={findingIndex}><code>{finding.package}@{finding.version}</code> · {finding.id} · {finding.severity}</p>)}{check.findings.length > 20 && <p>{check.findings.length - 20} autre(s) alerte(s) conservée(s) dans le rapport.</p>}</details>)}
      </div>)}
      {latest && !["completed", "failed"].includes(latest.stage) && Date.now() - Date.parse(latest.updatedAt) > 30 * 60_000 && <button className="button secondary" onClick={async () => {
        if (!window.confirm("Confirmez avoir vérifié les déploiements et le site chez l’hébergeur. Clôturer ne restaure ni le code ni les données ; cela autorise une prochaine mise à jour.")) return;
        try { await request(`updates/${latest.id}/close`, "POST", { confirmed: true }); await refresh(); }
        catch (error) { setError(error instanceof Error ? error.message : "Clôture non confirmée."); }
      }}>Clôturer après vérification manuelle</button>}
      <p className="updates-note">Les tests automatiques et le contrôle HTTPS ne garantissent pas tous les parcours métier. Une restauration de base de données n’est jamais lancée automatiquement.</p>
    </details>
  </section>;
}
