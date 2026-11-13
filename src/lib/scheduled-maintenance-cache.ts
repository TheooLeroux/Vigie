import { getCache } from "@vercel/functions";
import { createHash, randomUUID } from "node:crypto";
import { scheduledControlDeadlines } from "./automatic-controls";
import { openConnectorSecret, sealConnectorSecret } from "./connector-secrets";
import { fullMaintenancePlan, maintenancePlanSchema, type MaintenancePlan } from "./maintenance-plan";
import { probeMaintenance, readMaintenanceProbes, type MaintenanceProbes } from "./scheduled-maintenance-probes";
import type { updateRunner } from "./updates/github";

type Runner = NonNullable<ReturnType<typeof updateRunner>>;
type RuntimeCache = Pick<ReturnType<typeof getCache>, "get" | "set">;
type Snapshot = {
  capturedAt: number;
  generation: string | null;
  deadlines: Awaited<ReturnType<typeof scheduledControlDeadlines>>;
  probes: MaintenanceProbes;
};
type MaintenanceDecision = { plan: MaintenancePlan; generation: string | null; capturedAt: number };

const snapshotLifetime = 11 * 60_000;
const planLifetime = 4 * 60_000;
const generationKey = "vigie:scheduled-maintenance:2:generation";
const dependencies = { deadlines: scheduledControlDeadlines, readProbes: readMaintenanceProbes, probe: probeMaintenance };
const isProduction = () => process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production";
const runtimeCache = () => getCache({
  namespace: "vigie-maintenance",
  keyHashFunction: key => createHash("sha256").update(key).digest("hex"),
});

export function productionMaintenanceCache(runner: Runner) {
  const revision = process.env.VERCEL_GIT_COMMIT_SHA;
  if (isProduction() && revision && /^[a-f0-9]{40}$/i.test(revision)) {
    try { return maintenanceCache(runner, revision, runtimeCache()); }
    catch { /* The cron and workers can still run the full cycle. */ }
  }
}

export async function invalidateMaintenanceCache() {
  if (!isProduction()) return;
  try { await runtimeCache().set(generationKey, randomUUID()); }
  catch { console.warn("Vigie : invalidation du cache des contrôles indisponible."); }
}

export function maintenanceCache(runner: Runner, revision: string, cache: RuntimeCache, checks = dependencies) {
  const key = `vigie:scheduled-maintenance:2:${runner.repository}:${runner.ref}:${revision}`;
  const planKey = (id: string) => `${key}:plan:${id}`;
  const idleKey = `${key}:last-idle`;
  const generation = () => cache.get(generationKey) as Promise<string | null>;
  function fresh(at: number, lifetime: number) {
    const age = Date.now() - at;
    return age >= 0 && age < lifetime;
  }
  return {
    async refresh() {
      const capturedAt = Date.now();
      try {
        const capturedGeneration = await generation();
        const [deadlines, probes] = await Promise.all([checks.deadlines(), checks.readProbes()]);
        if (!deadlines || !fresh(capturedAt, snapshotLifetime) || capturedGeneration !== await generation()) return false;
        const value = sealConnectorSecret(JSON.stringify({ capturedAt, generation: capturedGeneration, deadlines, probes } satisfies Snapshot), key);
        await cache.set(key, value, { ttl: snapshotLifetime / 1000, name: "Vigie · état des contrôles" });
        return true;
      } catch {
        console.warn("Vigie : état des contrôles non mis en cache.");
        return false;
      }
    },
    async plan(): Promise<MaintenanceDecision | null> {
      try {
        const encrypted = await cache.get(key);
        if (typeof encrypted !== "string") return null;
        const snapshot: Snapshot = JSON.parse(openConnectorSecret(encrypted, key));
        if (!snapshot.deadlines || !fresh(snapshot.capturedAt, snapshotLifetime) || snapshot.generation !== await generation()) return null;
        const plan: MaintenancePlan = {
          observations: { vercel: false, railway: false, o2switch: false },
          security: { vercel: [], railway: [], o2switch: [] },
          wordpress: [], agents: [],
        };
        await checks.probe(snapshot.probes, plan);
        const now = Date.now();
        if (!fresh(snapshot.capturedAt, snapshotLifetime)) return null;
        for (const { provider, projectId, dueAt } of snapshot.deadlines) {
          const scope = plan.security[provider];
          if (dueAt <= now && scope !== "all" && !scope.includes(projectId)) scope.push(projectId);
        }
        if (snapshot.generation !== await generation()) return null;
        return { plan: maintenancePlanSchema.parse(plan), generation: snapshot.generation, capturedAt: snapshot.capturedAt };
      } catch { return null; }
    },
    async publishPlan(id: string, decision: MaintenanceDecision) {
      await cache.set(planKey(id), { at: Date.now(), ...decision }, { ttl: planLifetime / 1000, name: "Vigie · plan GitHub" });
    },
    async readPlan(id: string) {
      try {
        const entry = await cache.get(planKey(id)) as ({ at: number } & MaintenanceDecision) | null;
        return entry && fresh(entry.at, planLifetime) && fresh(entry.capturedAt, snapshotLifetime) && entry.generation === await generation()
          ? maintenancePlanSchema.parse(entry.plan) : fullMaintenancePlan;
      } catch { return fullMaintenancePlan; }
    },
    async recordIdle(decision: MaintenanceDecision) {
      await cache.set(idleKey, { at: Date.now(), generation: decision.generation }, { ttl: 5 * 60, name: "Vigie · dernier cycle sans travail" });
    },
    async clearIdle() {
      await cache.set(idleKey, null, { ttl: 1 });
    },
    async recentlyIdle() {
      try {
        const entry = await cache.get(idleKey) as { at: number; generation: string | null } | null;
        return !!entry && fresh(entry.at, 5 * 60_000) && entry.generation === await generation();
      } catch { return false; }
    },
  };
}
