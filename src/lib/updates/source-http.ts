import { ApiError } from "../http";

export async function boundedSourceJson(response: Response, limit = 9_000_000) {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError("Réponse de source vide.", 502);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new ApiError("Réponse de source trop volumineuse.", 502);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}
