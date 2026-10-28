"use client";

import { CircleHelp, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { projectHealth } from "@/lib/project-health";
import type { Project, ProjectDetail } from "@/lib/types";
import { activeUpdateStages, type UpdateState } from "@/lib/updates/types";
import { wordpressSecurityVersions } from "@/lib/updates/wordpress-security-key";
import { automaticControlFresh, controlSource, hasVerifiedSecurityControl } from "@/lib/automatic-control-state";

type Request = (path: string, method?: string, payload?: unknown) => Promise<any>;

export function ProjectListActions({ project, request, onOpen }: {
  project: Project;
  request: Request;
  onOpen: () => void;
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [updates, setUpdates] = useState<UpdateState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    async function refresh() {
      if (inFlight || cancelled) return;
      inFlight = true;
      const [details, state] = await Promise.allSettled([
        request(`projects/${encodeURIComponent(project.id)}`),
        request(`updates?projectId=${encodeURIComponent(project.id)}`),
      ]);
      inFlight = false;
      if (cancelled) return;
      setDetail(details.status === "fulfilled" ? details.value : null);
      setUpdates(state.status === "fulfilled" ? state.value : null);
      setLoading(false);
      timer = setTimeout(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    }
    const onVisible = () => { if (document.visibilityState === "visible") { clearTimeout(timer); void refresh(); } };
    void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [project.id, request]);

  const health = detail ? projectHealth(detail, updates) : null;
  const count = health?.security.length || 0;
  const controlsPending = !!updates?.automaticControls && updates.targets.some(target => !updates.automaticControls?.some(control => control.targetId === target.id && automaticControlFresh(control) && detail && controlSource(target, detail)?.identity === control.identity));
  const controlError = updates?.automaticControls?.find(control => control.error)?.error;
  const securityUnavailable = !updates || controlsPending || updates.currentSecurity?.some(item => {
    const target = updates.targets.find(target => target.id === item.targetId);
    const inventory = detail?.hosting?.find(site => site.id === target?.remoteId && site.connectionId === target.connectionId)?.inventory;
    return item.error || !inventory || item.versions !== wordpressSecurityVersions(inventory);
  });
  const known = !!health?.securityKnown && !securityUnavailable;
  const partial = !known && !!detail && !!updates && hasVerifiedSecurityControl(detail, updates);
  const active = !!updates?.runs[0] && activeUpdateStages.includes(updates.runs[0].stage);
  const attention = updates?.runs[0]?.stage === "attention";
  const available = updates?.targets.some(target => !target.unavailable);
  const disabledReason = project.lifecycle !== "active" ? "Projet archivé."
    : !updates ? "Le service de mise à jour est indisponible."
    : !updates.enabled ? "Le service de mise à jour n’est pas encore activé."
    : !available ? "Aucun service ne peut être mis à jour. Consultez la fiche du projet."
    : "";
  const securityTitle = count
    ? `${count} signalement(s) de sécurité dans les relevés ou contrôles applicables.${!known || health?.incomplete ? " Certains contrôles sont incomplets ou indisponibles." : ""}`
    : known ? "Aucun signalement connu sur le périmètre contrôlé."
    : partial ? `Aucun signalement connu sur les composants analysés. Contrôle partiel : ${controlError || "certains services restent à contrôler."}`
    : controlError || (controlsPending ? "L’analyse automatique est en attente ou doit être renouvelée. Cette liste actualise les résultats automatiquement." : "Les contrôles disponibles ne permettent pas de confirmer l’absence de faille.");
  const unknownLabel = !updates ? "Contrôle indisponible" : controlError ? "Contrôle en échec" : controlsPending ? updates.automaticControls?.length ? "À actualiser" : "Analyse en attente" : "Non vérifiable";
  const SecurityIcon = count ? ShieldAlert : known ? ShieldCheck : CircleHelp;

  return <>
    <td>
      {loading ? <span className="subtle" role="status"><Loader2 size={14} className="spin" aria-label="Chargement des contrôles" /></span> :
        <span className={`badge ${count ? "warning" : known ? "sage" : "neutral"}`} title={securityTitle}>
          <SecurityIcon size={13} aria-hidden="true" />
          {count || known || partial ? <>{count}{(!known || health?.incomplete) && <span aria-label="Contrôles incomplets">*</span>}</> : unknownLabel}
        </span>}
    </td>
    <td>
      <button
        type="button"
        className="button secondary small record-secondary"
        disabled={loading || busy || (!active && !attention && !!disabledReason)}
        title={active ? "Voir le suivi de la mise à jour" : attention ? "Vérifier le dernier traitement" : disabledReason || `Mettre à jour ${project.name}`}
        aria-label={`${active ? "Suivre la mise à jour de" : attention ? "Vérifier la mise à jour de" : "Mise à jour de"} ${project.name}`}
        onClick={async () => {
          if (active || attention) { onOpen(); return; }
          setBusy(true);
          setError("");
          try {
            await request("updates", "POST", { projectId: project.id });
            onOpen();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "La mise à jour n’a pas démarré.");
          } finally { setBusy(false); }
        }}
      >
        {busy || active ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
        {busy ? "Lancement…" : active ? "En cours" : attention ? "À vérifier" : "Mise à jour"}
      </button>
      {error && <p className="updates-error record-secondary" role="alert">{error}</p>}
    </td>
  </>;
}
