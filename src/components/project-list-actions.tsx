"use client";

import { CircleHelp, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { Project } from "@/lib/types";
import { useProjectSummary } from "./project-summaries";

type Request = (path: string, method?: string, payload?: unknown) => Promise<any>;

export function ProjectListActions({ project, request, onOpen }: {
  project: Project;
  request: Request;
  onOpen: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { summary, loading } = useProjectSummary(project.id);
  const { count, known, partial, incomplete, active, attention, refreshNeeded, disabledReason, securityTitle, unknownLabel } = summary || { count: 0, known: false, partial: false, incomplete: true, active: false, attention: false, refreshNeeded: false, disabledReason: "Résumé indisponible ; réessayez le chargement de la liste.", securityTitle: "Contrôles indisponibles : l’absence de faille n’est pas confirmée.", unknownLabel: "Contrôle indisponible" };
  const SecurityIcon = count ? ShieldAlert : known ? ShieldCheck : CircleHelp;

  return <>
    <td>
      {loading ? <span className="subtle" role="status"><Loader2 size={14} className="spin" aria-label="Chargement des contrôles" /></span> :
        <span className={`badge ${count ? "warning" : known ? "sage" : "neutral"}`} title={securityTitle}>
          <SecurityIcon size={13} aria-hidden="true" />
          {count || known || partial ? <>{count}{(!known || incomplete) && <span aria-label="Contrôles incomplets">*</span>}</> : unknownLabel}
        </span>}
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
