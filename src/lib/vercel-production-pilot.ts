import { createHash } from "node:crypto";
import { getCache } from "@vercel/functions";
import { after } from "next/server";
import { readVercelProductionPointers } from "./connectors/vercel";

const probeInterval = 5 * 60_000;
type PilotCache = Pick<ReturnType<typeof getCache>, "get" | "set">;
type Baseline = { digest: string; checkedAt: number };

export async function observeVercelProduction(
  { teamId, token }: { teamId: string; token: string },
  cache: PilotCache,
  transport: typeof fetch = fetch,
) {
  try {
    const checkedAt = Date.now();
    const key = `vigie:vercel-production-pilot:1:${teamId}`;
    const [previous, pointers] = await Promise.all([
      cache.get(key) as Promise<Baseline | null>,
      readVercelProductionPointers(teamId, token, transport),
    ]);
    if (!pointers.length) return "unavailable";
    const digest = createHash("sha256").update(JSON.stringify(pointers)).digest("hex");
    const age = previous ? checkedAt - previous.checkedAt : NaN;
    if (age < 0) return "unavailable";
    await cache.set(key, { digest, checkedAt }, { ttl: 20 * 60, name: "Vigie · sonde Vercel" });
    if (!previous || !/^[a-f0-9]{64}$/.test(previous.digest) || !Number.isFinite(age) || age >= 2 * probeInterval) {
      return "baseline";
    }
    return previous.digest === digest ? "unchanged" : "changed";
  } catch {
    return "unavailable";
  }
}

export function scheduleVercelProductionPilot() {
  const teamId = process.env.VIGIE_VERCEL_PILOT_TEAM_ID;
  const token = process.env.VIGIE_VERCEL_PILOT_TOKEN;
  if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "production" || !teamId || !token) return;
  after(async () => {
    const status = await observeVercelProduction({ teamId, token }, getCache());
    console.info("Vigie : sonde Vercel", { status });
  });
}
