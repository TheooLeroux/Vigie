import { ApiError, errorResponse } from "@/lib/http";
import { answerRuntimeChallenge } from "@/lib/updates/vercel-runtime-protocol";

export const runtime = "nodejs";
export const maxDuration = 15;
export async function POST(request: Request) {
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError("Sonde Vercel non autorisée.", 401);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 2048) { await reader.cancel(); throw new ApiError("Requête trop volumineuse.", 413); }
      chunks.push(next.value);
    }
    const result = answerRuntimeChallenge(Buffer.concat(chunks).toString("utf8"), request.headers.get("X-Vigie-Time") || "", request.headers.get("X-Vigie-Signature") || "");
    return Response.json(result, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) { return errorResponse(error); }
}
