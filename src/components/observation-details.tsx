"use client";

import { useEffect, useState, type ReactNode } from "react";
import { observationIsFresh } from "@/lib/observation-freshness";

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
