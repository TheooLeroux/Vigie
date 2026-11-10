"use client";

import { useEffect, useState, type ReactNode } from "react";
import { deploymentObservationLifetime, observationIsFresh } from "@/lib/observation-freshness";
import { formatDate } from "./ui";

export function useObservationTime(observedAt: string | null | undefined, lifetime: number) {
  const [time, setTime] = useState(Date.now);
  useEffect(() => {
    const now = Date.now();
    setTime(now);
    if (!observedAt || !observationIsFresh(observedAt, lifetime, now)) return;
    const expiresAt = Date.parse(observedAt) + lifetime;
    const timer = window.setTimeout(() => setTime(expiresAt), expiresAt - now);
    return () => window.clearTimeout(timer);
  }, [observedAt, lifetime]);
  return time;
}

export function ObservationDetails({ label, action }: { label: ReactNode; action?: ReactNode }) {
  if (!action) return <p>{label}</p>;
  return <details className="observation-details">
    <summary>{label}</summary>
    {action}
  </details>;
}

export function ConnectionReading({ configured, error, lastSuccessAt }: {
  configured: boolean;
  error?: string | null;
  lastSuccessAt?: string | null;
}) {
  const time = useObservationTime(lastSuccessAt, deploymentObservationLifetime);
  let label = "À synchroniser";
  let tone = "neutral";
  if (!configured) {
    label = "Déconnecté";
  } else if (error) {
    label = "Relevé en échec";
    tone = "warning";
  } else if (lastSuccessAt) {
    const fresh = observationIsFresh(lastSuccessAt, deploymentObservationLifetime, time);
    label = fresh ? "Relevé récent" : "Relevé expiré";
    tone = fresh ? "sage" : "warning";
  }
  return <div className="connection-reading">
    <span className={`badge ${tone}`}>{label}</span>
    {lastSuccessAt && <small>Dernier relevé réussi le {formatDate(lastSuccessAt)}</small>}
  </div>;
}
