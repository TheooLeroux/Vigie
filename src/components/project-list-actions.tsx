"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { Project } from "@/lib/types";
import { useProjectSummary } from "./project-summaries";
import { ProjectSecurityBadge } from "./project-security-badge";

type Request = (path: string, method?: string, payload?: unknown) => Promise<any>;

export function ProjectListActions({ project, request, onOpen, layout = "list" }: {
  project: Project;
  request: Request;
  onOpen: () => void;
  layout?: "list" | "card";
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { summary, loading } = useProjectSummary(project.id);
  const { active, attention, refreshNeeded, disabledReason } = summary || { active: false, attention: false, refreshNeeded: false, disabledReason: "État du projet indisponible." };
  const action = active ? "Suivre la mise à jour" : attention ? "Vérifier le résultat" : refreshNeeded ? "Actualiser les relevés" : "Lancer la mise à jour";
  const unavailable = !active && !attention && !refreshNeeded && disabledReason;

  async function performAction() {
    if (active || attention) { onOpen(); return; }
    setBusy(true);
    setError("");
    try {
      const result = await request(refreshNeeded ? "updates/refresh" : "updates", "POST", { projectId: project.id });
      if (refreshNeeded && result.errors?.length) {
        setError(result.errors.join(" "));
        return;
      }
      onOpen();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : refreshNeeded ? "L’actualisation a échoué." : "La mise à jour n’a pas démarré.");
    } finally { setBusy(false); }
  }

  const security = loading ? <span className="subtle" role="status"><Loader2 size={14} className="spin" aria-label="Chargement des contrôles" /></span> :
    <ProjectSecurityBadge summary={summary} onOpen={onOpen} />;
  const maintenance = <>
      {loading ? <span className="subtle">Chargement…</span> : unavailable ? <span className="project-action-unavailable">{unavailable}</span> : <button
        type="button"
        className="button secondary small record-secondary"
        disabled={busy}
        aria-label={`${action} pour ${project.name}`}
        onClick={() => void performAction()}
      >
        {busy || active ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
        {busy ? refreshNeeded ? "Actualisation…" : "Lancement…" : action}
      </button>}
      {error && <p className="updates-error record-secondary" role="alert">{error}</p>}
  </>;

  if (layout === "card") return <div className="project-card-actions">
    <div><h4>Failles connues</h4>{security}</div>
    <div>{maintenance}</div>
  </div>;
  return <><td>{security}</td><td>{maintenance}</td></>;
}
