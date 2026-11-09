export function trustedRequestOrigin(request: Request): string | null {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  const forwardedHost = request.headers.get("x-forwarded-host");
  const vercel = process.env.VERCEL === "1";
  const protocol = vercel && request.headers.get("x-forwarded-proto") === "https"
    ? "https:" : url.protocol;
  if ((forwardedHost && forwardedHost !== host) || (!vercel && request.headers.has("forwarded")))
    return null;
  try {
    const configured = new URL(process.env.BETTER_AUTH_URL || "http://127.0.0.1:3001");
    if (configured.username || configured.password || configured.pathname !== "/" || configured.search || configured.hash)
      return null;
    const local = ["localhost", "127.0.0.1"].includes(configured.hostname);
    if (local && process.env.NODE_ENV !== "production")
      return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && url.protocol === "http:"
        ? `http://${host}` : null;
    // Vercel invokes Cron Jobs on the production deployment's generated host.
    // The scheduled route separately verifies its bearer secret.
    const cronHost = vercel && process.env.VERCEL_ENV === "production" && request.method === "GET" &&
      url.pathname === "/api/maintenance/security-watch" ? process.env.VERCEL_URL : undefined;
    return configured.protocol === "https:" && protocol === "https:" && (host === configured.host || host === cronHost)
      ? `https://${host}` : null;
  } catch { return null; }
}
