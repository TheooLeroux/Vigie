"use client";
import { Loader2, Wrench } from "lucide-react";
import type { MaintenanceState, MaintenanceTarget } from "@/lib/maintenance-contract";

export function MaintenanceQuickUpdate({
  state, targets, busy, onUpdate,
}: {
  state: MaintenanceState;
  targets: MaintenanceTarget[];
  busy: boolean;
  onUpdate: (targetId: string) => void;
}) {
  return (
    <section className="panel maintenance-quick-update">
      <h3>Tout mettre à jour</h3>
      <p>Node : dernière LTS supportée. Dépendances de production et de développement : dernières versions stables publiques, majeures comprises.</p>
      <p>Le clic autorise la création d’une PR et ses éventuelles previews, sans fusion ni déploiement en production. Si une compatibilité bloque, la préparation s’arrête sans forcer.</p>
      {!targets.length && <p>Aucun service compatible dans ce projet. WordPress, PHP et images externes ne sont pas pris en charge ici.</p>}
      {targets.map((target) => {
        const running = state.jobs.find((job) =>
          job.payload.repository.toLowerCase() === target.repository?.toLowerCase() &&
          !["planned", "closed", "merged"].includes(job.status),
        );
        const blocker = target.blocked || (running
          ? "Une préparation existe déjà sur ce dépôt. Consultez son suivi avant de relancer."
          : !state.configured ? "L’exécuteur doit être configuré." : null);
        return (
          <article className="maintenance-quick-service" key={target.id}>
            <div>
              <strong>{target.name}</strong>
              <small>{target.provider} · {target.directory || "/"}</small>
              {blocker && <p className="maintenance-warning">{blocker}</p>}
            </div>
            <button
              type="button"
              className="button primary"
              aria-label={`Tout mettre à jour — ${target.name}`}
              disabled={busy || !!blocker}
              onClick={() => onUpdate(target.id)}
            >
              {busy ? <Loader2 size={16} /> : <Wrench size={16} />}
              {busy ? "Préparation…" : "Tout mettre à jour"}
            </button>
          </article>
        );
      })}
    </section>
  );
}
