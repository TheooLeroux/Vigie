import { errorResponse, ApiError } from "@/lib/http";
import { runWordPressWebCheck, verifyWordPressWebSignature, wordpressWebCheckBody } from "@/lib/updates/wordpress-web-check";

export const runtime = "nodejs";
export const maxDuration = 240;
export async function POST(request: Request) {
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError("Contrôle web non autorisé.", 401);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 2048) { await reader.cancel(); throw new ApiError("Requête trop volumineuse.", 413); } chunks.push(next.value); }
    const raw = Buffer.concat(chunks).toString("utf8");
    verifyWordPressWebSignature(raw, request.headers.get("X-Vigie-Time") || "", request.headers.get("X-Vigie-Signature") || "");
    return Response.json(await runWordPressWebCheck(wordpressWebCheckBody.parse(JSON.parse(raw))), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
