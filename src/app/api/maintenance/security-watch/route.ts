import { timingSafeEqual } from "node:crypto";
import { ApiError, assertLocal, errorResponse } from "@/lib/http";
import { claimScheduledMaintenance } from "@/lib/scheduled-maintenance";
import { productionMaintenanceCache } from "@/lib/scheduled-maintenance-cache";
import { refreshSecurityWatchSnapshot } from "@/lib/security-watch-cache";
import { githubRequest, updateRunner } from "@/lib/updates/github";

export const runtime = "nodejs";
export const maxDuration = 120;

async function dispatchSecurityControls() {
  const runner = updateRunner();
  if (!runner) throw new ApiError("Le contrôle automatique n’est pas configuré.", 503);
  const cache = productionMaintenanceCache(runner);
  const decision = await cache?.decision();
  if (decision) console.info("Vigie : décision du cycle automatique", { decision });
  if (decision === "skip") return;
  const lease = await claimScheduledMaintenance("primary").catch(() => {
    console.warn("Vigie : réservation du cycle automatique indisponible.");
    return undefined;
  });
  if (lease === null) return;
  const evidence = cache?.prepare(Date.now());
  try {
    await githubRequest(`/repos/${runner.repository}/actions/workflows/vigie-wordpress-agents.yml/dispatches`, runner.token, "POST", {
      ref: runner.ref,
      inputs: { security_only: true },
    });
  } catch (error) {
    await lease?.().catch(() => console.warn("Vigie : réservation du cycle non libérée."));
    throw error;
  }
  const prepared = await evidence;
  if (prepared && cache) {
    await cache.publish(prepared).catch(() => console.warn("Vigie : cache du cycle automatique indisponible."));
  } else if (cache) {
    console.info("Vigie : état du parc insuffisant pour ignorer le prochain cycle.");
  }
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
