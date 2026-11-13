import { randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError, assertLocal, errorResponse } from "@/lib/http";
import { claimScheduledMaintenance } from "@/lib/scheduled-maintenance";
import { productionMaintenanceCache } from "@/lib/scheduled-maintenance-cache";
import { refreshSecurityWatchSnapshot } from "@/lib/security-watch-cache";
import { githubRequest, updateRunner } from "@/lib/updates/github";
import { maintenanceHasWork } from "@/lib/maintenance-plan";

export const runtime = "nodejs";
export const maxDuration = 120;

async function dispatchSecurityControls() {
  const runner = updateRunner();
  if (!runner) throw new ApiError("Le contrôle automatique n’est pas configuré.", 503);
  const cache = productionMaintenanceCache(runner);
  const decision = await cache?.plan();
  let requestId: string | undefined;
  if (cache) {
    const id = `maintenance-${Date.now()}-${randomBytes(16).toString("hex")}`;
    try {
      if (decision) await cache.publishPlan(id, decision);
      requestId = id;
    }
    catch { console.warn("Vigie : plan GitHub non mis en cache."); }
  }
  const noWork = !!requestId && !!decision && !maintenanceHasWork(decision.plan);
  if (!noWork) await cache?.clearIdle().catch(() => {});
  const lease = noWork ? undefined : await claimScheduledMaintenance("primary").catch(() => {
    console.warn("Vigie : réservation du cycle automatique indisponible.");
    return undefined;
  });
  if (lease === null) return;
  try {
    console.info("Vigie : cycle automatique", { mode: requestId ? noWork ? "no-work" : "scoped" : "full" });
    await githubRequest(`/repos/${runner.repository}/actions/workflows/vigie-wordpress-agents.yml/dispatches`, runner.token, "POST", {
      ref: runner.ref,
      inputs: { security_only: true, ...(requestId && { request_id: requestId }) },
    });
    if (noWork && decision) await cache?.recordIdle(decision).catch(() => console.warn("Vigie : cycle sans travail non mis en cache."));
  } catch (error) {
    await lease?.().catch(() => console.warn("Vigie : réservation du cycle non libérée."));
    throw error;
  }
  // The successful observation jobs publish the fresh state after writing it.
}

export async function GET(request: Request) {
  try {
    assertLocal(request);
    const secret = process.env.CRON_SECRET;
    const authorization = Buffer.from(request.headers.get("authorization") || "");
    const expected = Buffer.from(`Bearer ${secret || ""}`);
    if (!secret || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      throw new ApiError("Contrôle automatique non autorisé.", 401);
    }
    const [dispatch, cache] = await Promise.allSettled([
      dispatchSecurityControls(),
      refreshSecurityWatchSnapshot(AbortSignal.timeout(85_000)),
    ]);
    if (cache.status === "rejected") console.warn("Vigie : cache de surveillance non renouvelé.");
    if (dispatch.status === "rejected") throw dispatch.reason;
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
