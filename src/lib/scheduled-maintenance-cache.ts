import { getCache } from "@vercel/functions";
import { scheduledControlsCurrent } from "./automatic-controls";
import { openConnectorSecret, sealConnectorSecret } from "./connector-secrets";
import { successfulPrimaryCycle } from "./scheduled-maintenance";
import { maintenanceProbesUnchanged, readMaintenanceProbes, type MaintenanceProbes } from "./scheduled-maintenance-probes";
import type { updateRunner } from "./updates/github";

type Runner = NonNullable<ReturnType<typeof updateRunner>>;
type MaintenanceCache = Pick<ReturnType<typeof getCache>, "get" | "set">;
type Evidence = { requestedAt: number; probes: MaintenanceProbes };
const evidenceLifetime = 7 * 60_000;
const schedulingHorizon = 10 * 60_000;

const dependencies = {
  recentCycle: successfulPrimaryCycle,
  controlsCurrent: scheduledControlsCurrent,
  readProbes: readMaintenanceProbes,
  unchanged: maintenanceProbesUnchanged,
};

export function productionMaintenanceCache(runner: Runner) {
  const revision = process.env.VERCEL_GIT_COMMIT_SHA;
  if (process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production" && revision && /^[a-f0-9]{40}$/i.test(revision)) {
    return maintenanceCache(runner, revision, getCache());
  }
}

export function maintenanceCache(runner: Runner, revision: string, cache: MaintenanceCache, checks = dependencies) {
  const key = `vigie:scheduled-maintenance:1:${runner.repository}:${runner.ref}:${revision}`;
  function fresh(requestedAt: number) {
    const age = Date.now() - requestedAt;
    return age >= 0 && age < evidenceLifetime;
  }
  return {
    async prepare(requestedAt: number) {
      try {
        const until = requestedAt + schedulingHorizon;
        if (!await checks.controlsCurrent(until)) return null;
        const probes = await checks.readProbes(until);
        if (!probes || !fresh(requestedAt)) return null;
        return sealConnectorSecret(JSON.stringify({ requestedAt, probes } satisfies Evidence), key);
      } catch {
        return null;
      }
    },
    async publish(evidence: string) {
      await cache.set(key, evidence, { ttl: evidenceLifetime / 1000, name: "Vigie · dernier cycle automatique" });
    },
    async decision() {
      try {
        const encrypted = await cache.get(key);
        if (typeof encrypted !== "string") return "cache-miss";
        const evidence: Evidence = JSON.parse(openConnectorSecret(encrypted, key));
        if (!fresh(evidence.requestedAt)) return "cache-expired";
        const cycle = await checks.recentCycle(runner.repository, runner.ref, fetch, { revision, token: runner.token });
        // GitHub timestamps runs at second resolution. Never accept a cycle that
        // was already running before this request was made.
        if (!cycle || cycle.startedAt < Math.floor(evidence.requestedAt / 1000) * 1000) return "cycle-unconfirmed";
        if (!await checks.unchanged(evidence.probes)) return "observations-changed-or-unavailable";
        return fresh(evidence.requestedAt) ? "skip" : "cache-expired";
      } catch {
        return "cache-unavailable";
      }
    },
  };
}
