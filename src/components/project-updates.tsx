"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, RefreshCw } from "lucide-react";
import { activeUpdateStages, type SecurityFinding, type UpdateRun, type UpdateStage, type UpdateState, type UpdateTarget } from "@/lib/updates/types";
import { formatDate } from "./ui";
import { wordpressBlockingMessage } from "@/lib/updates/wordpress-blocking";

type Request = (path: string, method?: string, payload?: unknown) => Promise<any>;
function FindingDetails({ finding }: { finding: SecurityFinding }) {
  const level = { critical: "critique", high: "élevée", moderate: "modérée", low: "faible", unknown: "non classée" }[finding.severity];
  return <div><p><strong>{finding.title || finding.package}</strong></p><p><code>{finding.package}@{finding.version}</code> · {finding.aliases[0] || finding.id} · sévérité {level}</p>{finding.explanation && <p>{finding.explanation}</p>}{finding.fixedVersions?.length ? <p>Version(s) correctrice(s) référencée(s) : {finding.fixedVersions.join(", ")}. Leur compatibilité doit être vérifiée avant installation.</p> : null}{finding.url && <a href={finding.url} target="_blank" rel="noreferrer">Consulter la source du signalement</a>}</div>;
}
export const updateStageLabels: Record<UpdateStage, string> = { queued: "En attente", checking: "Vérification", updating: "Mise à jour", publishing: "Publication", verifying: "Contrôle du déploiement", completed: "Terminé", failed: "Non publiée", attention: "À vérifier" };
export function UpdateProgress({ run }: { run: UpdateRun }) {
  const active = activeUpdateStages.includes(run.stage);
  const delayed = active && Date.now() - Date.parse(run.updatedAt) > 10 * 60_000;
  const blocked = run.stage === "failed" ? run.results.flatMap(result => result.checks || []).findLast(check => wordpressBlockingMessage(check)) : undefined;
  const blockedMessage = wordpressBlockingMessage(blocked);
  return <div className={`updates-progress ${run.stage}`} role="status" aria-live="polite">
    {active ? <Loader2 size={18} className="spin" /> : run.stage === "completed" ? <Check size={18} /> : <RefreshCw size={18} />}
    <div><strong>{delayed ? "Le traitement met plus de temps que prévu" : blockedMessage ? "Mise à jour bloquée" : updateStageLabels[run.stage]}</strong><p>{delayed ? "Vigie attend une confirmation de l’exécuteur. Ne relancez pas une deuxième mise à jour." : blockedMessage || run.message}</p><small>{formatDate(run.updatedAt)}</small></div>
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
export function ProjectUpdates({ projectId, request, onComplete, onState }: { projectId: string; request: Request; onComplete: () => Promise<void>; onState?: (projectId: string, state: UpdateState | null) => void }) {
  const [state, setState] = useState<UpdateState | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const alive = useRef(true), completed = useRef("");
  const refresh = useCallback(async () => {
    try {
      const next: UpdateState = await request(`updates?projectId=${encodeURIComponent(projectId)}`);
      if (alive.current) { setState(next); setError(""); onState?.(projectId, next); }
      return next;
    } catch (error) { if (alive.current) onState?.(projectId, null); throw error; }
  }, [projectId, request, onState]);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(error => { if (alive.current) setError(error.message); });
    const timer = setInterval(() => {
      void refresh().then(next => {
        const latest = next.runs[0];
        if (latest?.stage === "completed" && completed.current !== latest.id) { completed.current = latest.id; void onComplete().catch(() => {}); }
      }).catch(error => { if (alive.current) setError(error.message); });
    }, 8000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh, onComplete]);
  const latest = state?.runs[0], active = latest && activeUpdateStages.includes(latest.stage);
  const available = state?.targets.filter(target => !target.unavailable) || [];
  const unresolved = latest?.stage === "attention";
  return <section id="project-updates" className="panel project-updates" aria-label="Mises à jour du projet">
    <div className="updates-heading"><div><h2>Mises à jour</h2><p>Node LTS et dépendances stables, ou WordPress et extensions.</p></div>
      <button className="button primary" disabled={busy || !!active || !!unresolved || !state?.enabled || !available.length} onClick={async () => {
        setBusy(true); setError("");
        try { await request("updates", "POST", { projectId }); await refresh(); }
        catch (error) { setError(error instanceof Error ? error.message : "La mise à jour n’a pas démarré."); }
        finally { setBusy(false); }
      }}>{busy || active ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}{active ? "Mise à jour en cours" : "Mettre à jour"}</button>
    </div>
    {error && <p role="alert" className="updates-error">{error} <button className="text-button" onClick={() => void refresh().catch(() => {})}>Réessayer le chargement</button></p>}
    {!state && !error && <p className="updates-note">Chargement des mises à jour…</p>}
    {state && !state.enabled && <p className="updates-note">Le service de mise à jour doit être activé une première fois par un administrateur.</p>}
    {state && <p className="updates-note">{available.length} service(s) prêt(s) sur {state.targets.length}. Les versions majeures sont incluses si leur validation réussit. {state.targets.some(target => target.mode === "wordpress") && "Sauvegarde fichiers et base avant modification, contrôle gratuit WPVulnerability. PHP est affiché et reste géré par l’hébergeur ; Vigie ne met pas les thèmes à jour : utilisez WordPress → Apparence → Thèmes."}</p>}
    {state?.targets.filter(target => target.mode === "wordpress" && target.unavailable).map(target => <p key={target.id} className="updates-note" role="status"><strong>{target.name} : </strong>{target.unavailable}</p>)}
    {latest && <UpdateProgress run={latest} />}
    {state?.currentSecurity?.map(observation => <details className="updates-details" key={observation.targetId}><summary>Contrôle de sécurité actuel · lecture seule{observation.check ? ` · ${observation.check.findings.length} signalement(s)` : " · indisponible"}</summary>{observation.error && <p role="status">{observation.error}</p>}{observation.check && <><p>{formatDate(observation.check.checkedAt)} · Ce contrôle ne lance aucune mise à jour. Les rapports des exécutions précédentes restent dans l’historique.</p>{observation.check.findings.map(finding => <FindingDetails key={finding.id} finding={finding} />)}{!observation.check.findings.length && <p>Aucune vulnérabilité connue dans le périmètre contrôlé.</p>}</>}{observation.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>)}
    <details className="updates-details"><summary>Services, configuration et détails</summary>
      {state?.targets.map(target => <div className="updates-target" key={target.id}><strong>{target.name}</strong><p>{target.provider} · {target.mode === "git" ? "Sources GitHub" : target.mode === "archive" ? "Sources sans Git" : "WordPress"}</p><p>{target.unavailable || "Prêt pour la mise à jour."}</p>{target.mode !== "git" && !active && <details><summary>{target.mode === "wordpress" ? "Installation automatique de l’agent" : target.configured ? "Sources et accès" : "Configurer une première fois"}</summary><SourceSetup target={target} projectId={projectId} request={request} onSaved={async () => { await refresh(); }} /></details>}</div>)}
      {latest?.results.map(result => <div className="updates-target" key={result.targetId}><strong>{result.name} — {updateStageLabels[result.stage]}</strong><p>{result.message}</p>{result.commit && <p>Commit publié : <code>{result.commit.slice(0, 10)}</code></p>}{result.deploymentId && <p>Déploiement : <code>{result.deploymentId}</code></p>}{result.previousDeploymentId && <p>Déploiement précédent conservé : <code>{result.previousDeploymentId}</code></p>}{result.backup && <p>Sauvegarde privée sur o2switch : <code>{result.backup}</code>. Sa restauration reste manuelle pour ne pas écraser de nouvelles données.</p>}{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        {result.checks?.map((check, index) => <details key={index}><summary>{check.tool} · {check.phase === "before" ? "Avant mise à jour" : check.phase === "candidate" ? "Version candidate" : "Après installation"} · {check.status === "blocked" ? "Bloqué" : check.status === "warning" ? "Avec réserves" : "Vérifié"}</summary><p>{check.scope} · {formatDate(check.checkedAt)}</p><p>{check.message}</p>{check.findings.slice(0, 20).map((finding, findingIndex) => <p key={findingIndex}><code>{finding.package}@{finding.version}</code> · {finding.id} · {finding.severity}</p>)}{check.findings.length > 20 && <p>{check.findings.length - 20} autre(s) alerte(s) conservée(s) dans le rapport.</p>}</details>)}
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
