import { createRealtime, rawSql } from "@neon/realtime/server";
import { requireSession } from "@/lib/auth";
import { assertLocal, ApiError, body, errorResponse } from "@/lib/http";
import { issueRealtimeGrant, verifyRealtimeGrant } from "@/lib/realtime-auth";
import { projectRealtimeSql } from "@/lib/project-realtime-query";
import type { ProjectRevision } from "@/lib/project-realtime";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertLocal(request);
    const input = await body(request);
    if (!input || typeof input !== "object" || Array.isArray(input) || (input.grant !== undefined && typeof input.grant !== "string")) throw new ApiError("Abonnement invalide.");
    const grant = input.grant === undefined ? issueRealtimeGrant(await requireSession(request.headers)) : input.grant;
    const identity = verifyRealtimeGrant(grant);
    const secret = process.env.NEON_REALTIME_SECRET, url = process.env.NEON_REALTIME_URL;
    if (!secret || !url || !process.env.DATABASE_URL) throw new ApiError("Le temps réel n’est pas encore configuré.", 503);
    const db = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
    const realtime = createRealtime({ secret, db });
    const query = rawSql<ProjectRevision>(projectRealtimeSql, [identity.sessionId, identity.userId, identity.email, identity.expiresAt]);
    const sealedQuery = await realtime.seal({ query });
    return Response.json({ url, grant, sealedQuery }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
