import { claimHostingObservation } from "./hosting-storage";

// Both schedulers share the same lease. The primary ticks every five minutes.
// The fallback waits ten minutes since the last reservation before taking over.
const leaseMs = 4 * 60_000;
const fallbackGraceMs = 6 * 60_000;

export function claimScheduledMaintenance(source: "primary" | "fallback") {
  return claimHostingObservation("scheduled-maintenance", leaseMs, source === "fallback" ? fallbackGraceMs : 0);
}
