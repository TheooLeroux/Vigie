import { ZodError } from "zod";
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function assertLocal(request: Request, allowOAuthCallback = false) {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (
    !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ||
    (forwardedHost && forwardedHost !== host) ||
    request.headers.has("forwarded")
  )
    throw new ApiError("Cette version est réservée à un accès local.", 403);
  const origin = request.headers.get("origin");
  const oauthReturn =
    allowOAuthCallback &&
    request.method === "GET" &&
    url.pathname === "/api/auth/callback/google";
  if (!oauthReturn && origin && origin !== `${url.protocol}//${host}`)
    throw new ApiError("Origine de la requête non autorisée.", 403);
  if (!oauthReturn && request.headers.get("sec-fetch-site") === "cross-site")
    throw new ApiError("Requête externe non autorisée.", 403);
}
export async function body(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ApiError("Un corps JSON est requis.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("Corps de requête manquant.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8_000_000) {
      await reader.cancel();
      throw new ApiError("La requête est trop volumineuse.", 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("JSON invalide.");
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof ZodError)
    return Response.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")} : ${i.message}`)
          .slice(0, 5)
          .join(" · "),
      },
      { status: 400 },
    );
  if (error instanceof ApiError)
    return Response.json({ error: error.message }, { status: error.status });
  if (
    error instanceof Error &&
    /introuvable|Format|format|fichier|JSON|composant|lockfile|inventaire|CSV|colonne|ligne|Import|Imbrication/.test(
      error.message,
    )
  )
    return Response.json(
      { error: error.message },
      { status: error.message.includes("introuvable") ? 404 : 400 },
    );
  console.error(
    "Vigie: erreur interne",
    error instanceof Error ? error.name : "unknown",
  );
  return Response.json(
    { error: "L’opération n’a pas pu être enregistrée. Réessayez." },
    { status: 500 },
  );
}
