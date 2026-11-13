import { assertLocal, ApiError, errorResponse } from "@/lib/http";
import { authenticateMaintenancePlan } from "@/lib/maintenance-plan";
import { productionMaintenanceCache } from "@/lib/scheduled-maintenance-cache";
import { updateRunner } from "@/lib/updates/github";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    assertLocal(request);
    const query = new URL(request.url).searchParams;
    const id = query.get("id") || "";
    const signature = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] || "";
    const fallback = query.get("fallback") === "1";
    if (!fallback && !authenticateMaintenancePlan(id, signature)) throw new ApiError("Plan de maintenance non autorisé.", 401);
    const runner = updateRunner();
    const cache = runner && productionMaintenanceCache(runner);
    if (!cache) throw new ApiError("Cache de maintenance indisponible.", 503);
    const headers = { "Cache-Control": "private, no-store" };
    if (fallback) return Response.json({ recent: await cache.recentlyIdle() }, { headers });
    return Response.json(await cache.readPlan(id), { headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocal(request);
    const id = new URL(request.url).searchParams.get("id") || "";
    const signature = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] || "";
    if (!authenticateMaintenancePlan(id, signature) || Math.abs(Date.now() - Number(id.split("-")[1])) >= 4 * 60_000) {
      throw new ApiError("Publication du plan non autorisée.", 401);
    }
    const runner = updateRunner();
    const cache = runner && productionMaintenanceCache(runner);
    if (!cache) throw new ApiError("Cache de maintenance indisponible.", 503);
    if (!await cache.refresh()) throw new ApiError("État des contrôles indisponible.", 503);
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
