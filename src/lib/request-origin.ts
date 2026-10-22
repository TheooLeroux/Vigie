export function trustedRequestOrigin(request: Request): string | null {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  const forwardedHost = request.headers.get("x-forwarded-host");
  if ((forwardedHost && forwardedHost !== host) || request.headers.has("forwarded"))
    return null;
  try {
    const configured = new URL(process.env.BETTER_AUTH_URL || "http://127.0.0.1:3001");
    if (configured.username || configured.password || configured.pathname !== "/" || configured.search || configured.hash)
      return null;
    const local = ["localhost", "127.0.0.1"].includes(configured.hostname);
    if (local && process.env.NODE_ENV !== "production")
      return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && url.protocol === "http:"
        ? `http://${host}` : null;
    return configured.protocol === "https:" && host === configured.host && url.protocol === "https:"
      ? configured.origin : null;
  } catch { return null; }
}
