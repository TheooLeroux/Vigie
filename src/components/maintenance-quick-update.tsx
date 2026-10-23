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
      <p>Vigie vérifie la nouvelle version, puis la publie et déclenche son déploiement.</p>
      {!targets.length && <p>Aucun service compatible avec la mise à jour automatique.</p>}
      {targets.map((target) => {
        const running = state.jobs.find((job) =>
          job.payload.repository.toLowerCase() === target.repository?.toLowerCase() &&
          job.payload.execute &&
          !["planned", "closed", "merged", "failed"].includes(job.status),
        );
        const blocker = target.blocked || (running
          ? "Mise à jour en cours."
          : !state.configured ? "L’exécuteur doit être configuré." : null);
        return (
          <article className="maintenance-quick-service" key={target.id}>
            <div>
              <strong>{target.name}</strong>
              {running && <small>Mise à jour en cours.</small>}
              {blocker && !running && <details><summary>Mise à jour automatique indisponible</summary><p>{blocker}</p></details>}
            </div>
            <button
              type="button"
              className="button primary"
              aria-label={`Mettre à jour — ${target.name}`}
              disabled={busy || !!blocker}
              onClick={() => onUpdate(target.id)}
            >
              {busy ? <Loader2 size={16} /> : <Wrench size={16} />}
              {busy ? "Démarrage…" : "Mettre à jour"}
            </button>
          </article>
        );
      })}
    </section>
  );
}
