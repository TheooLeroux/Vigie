"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { Project } from "@/lib/types";
import { useProjectSummary } from "./project-summaries";
import { ProjectSecurityBadge } from "./project-security-badge";

type Request = (path: string, method?: string, payload?: unknown) => Promise<any>;

export function ProjectListActions({ project, request, onOpen }: {
  project: Project;
  request: Request;
  onOpen: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { summary, loading } = useProjectSummary(project.id);
  const { active, attention, refreshNeeded, disabledReason } = summary || { active: false, attention: false, refreshNeeded: false, disabledReason: "Résumé indisponible ; réessayez le chargement de la liste." };

  return <>
    <td>
      {loading ? <span className="subtle" role="status"><Loader2 size={14} className="spin" aria-label="Chargement des contrôles" /></span> :
        <ProjectSecurityBadge summary={summary} onOpen={onOpen} />}
    </td>
    <td>
      <button
        type="button"
        className="button secondary small record-secondary"
        disabled={loading || busy || (!active && !attention && !refreshNeeded && !!disabledReason)}
        title={active ? "Voir le suivi de la mise à jour" : attention ? "Vérifier le dernier traitement" : refreshNeeded ? "Ouvrir la fiche et actualiser les relevés" : disabledReason || `Mettre à jour ${project.name}`}
        aria-label={`${active ? "Suivre la mise à jour de" : attention ? "Vérifier la mise à jour de" : refreshNeeded ? "Actualiser les relevés de" : "Mise à jour de"} ${project.name}`}
        onClick={async () => {
          if (active || attention || refreshNeeded) { onOpen(); return; }
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
        {busy ? "Lancement…" : active ? "En cours" : attention ? "À vérifier" : refreshNeeded ? "Actualiser" : "Mise à jour"}
      </button>
      {error && <p className="updates-error record-secondary" role="alert">{error}</p>}
    </td>
  </>;
}
