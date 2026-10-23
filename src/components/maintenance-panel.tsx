"use client";
import { useEffect, useRef, useState } from "react";
import type { MaintenanceJob, MaintenanceState } from "@/lib/maintenance-contract";
import { maintenanceScope } from "@/lib/maintenance-scope";
import { MaintenanceQuickUpdate } from "./maintenance-quick-update";

type RequestApi = (path: string, method?: string, payload?: unknown) => Promise<any>;
export function updateStatus(job: MaintenanceJob) {
  if (job.status === "failed") return "Échec de la mise à jour";
  if (job.status === "merged") return job.deployment === "observed"
    ? "Mise à jour déployée" : "Déploiement en cours";
  return "Mise à jour en cours";
}
export function MaintenancePanel({ request, projectId }: {
  request: RequestApi;
  projectId?: string;
  embedded?: boolean;
}) {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const { targets, jobs } = maintenanceScope(state, projectId);
  const executions = jobs.filter((job) => job.payload.execute && job.status !== "closed");
  useEffect(() => {
    let cancelled = false;
    request("maintenance").then((next) => { if (!cancelled) setState(next); })
      .catch(() => { if (!cancelled) setError("Impossible de charger les mises à jour."); });
    return () => { cancelled = true; };
  }, [request]);
  useEffect(() => {
    const pending = executions.filter((job) =>
      ["queued", "dispatching"].includes(job.status) ||
      (job.status === "merged" && job.deployment !== "observed"),
    );
    if (busy || !pending.length) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        for (const job of pending) await request(`maintenance/${job.id}/refresh`, "POST", {});
        const next = await request("maintenance");
        if (!cancelled) setState(next);
      } catch {
        if (!cancelled) {
          setError("Le suivi est temporairement indisponible. Ne relancez pas l’opération.");
          setState((previous) => previous ? { ...previous } : previous);
        }
      }
    }, pending.some((job) => job.status === "merged") ? 45_000 : 15_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [state, projectId, busy, request]);
  async function execute(targetId: string) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request("maintenance/execute", "POST", { targetId });
      setNotice(result.current ? "Déjà à jour." : "Mise à jour lancée. Vous pouvez quitter cette page.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Mise à jour impossible.");
    } finally {
      try { setState(await request("maintenance")); } catch {}
      setBusy(false);
      submitting.current = false;
    }
  }
  return (
    <section className="maintenance-panel">
      {error && <p role="alert" className="maintenance-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!state && !error && <p role="status">Chargement…</p>}
      {state && <MaintenanceQuickUpdate state={state} targets={targets} busy={busy} onUpdate={(id) => void execute(id)} />}
      {executions.slice(0, 5).map((job) => (
        <article className="panel maintenance-setup" key={job.id}>
          <strong>{job.targetName}</strong>
          <p role="status">{updateStatus(job)}</p>
          {job.error && <p role="alert">{job.error}</p>}
          {job.runUrl && <details><summary>Diagnostic technique</summary><a href={job.runUrl} target="_blank" rel="noreferrer">Voir l’exécution</a></details>}
        </article>
      ))}
    </section>
  );
}
