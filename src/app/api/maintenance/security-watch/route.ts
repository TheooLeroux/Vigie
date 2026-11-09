import { timingSafeEqual } from "node:crypto";
import { ApiError, assertLocal, errorResponse } from "@/lib/http";
import { refreshSecurityWatchSnapshot } from "@/lib/security-watch-cache";
import { githubRequest, updateRunner } from "@/lib/updates/github";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    assertLocal(request);
    const secret = process.env.CRON_SECRET;
    const authorization = Buffer.from(request.headers.get("authorization") || "");
    const expected = Buffer.from(`Bearer ${secret || ""}`);
    if (!secret || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      throw new ApiError("Contrôle automatique non autorisé.", 401);
    }
    const runner = updateRunner();
    if (!runner) throw new ApiError("Le contrôle automatique n’est pas configuré.", 503);
    const [dispatch, cache] = await Promise.allSettled([
      githubRequest(`/repos/${runner.repository}/actions/workflows/vigie-wordpress-agents.yml/dispatches`, runner.token, "POST", {
        ref: runner.ref,
        inputs: { security_only: true },
      }),
      refreshSecurityWatchSnapshot(AbortSignal.timeout(85_000)),
    ]);
    if (cache.status === "rejected") console.warn("Vigie : cache de surveillance non renouvelé.");
    if (dispatch.status === "rejected") throw dispatch.reason;
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
