import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
export function proxy(request: NextRequest) {
  const host = request.headers.get("host") || "";
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (
    !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ||
    (forwardedHost && forwardedHost !== host) ||
    request.headers.has("forwarded")
  )
    return new NextResponse(
      "Vigie V1 : accès local uniquement. L’authentification d’équipe doit être configurée avant une exposition réseau.",
      { status: 403 },
    );
  const path = request.nextUrl.pathname;
  const publicRoute =
    path === "/connexion" ||
    path.startsWith("/api/auth/") ||
    path === "/icon.svg" ||
    path === "/favicon.ico";
  if (
    !publicRoute &&
    !path.startsWith("/api/") &&
    !getSessionCookie(request, { cookiePrefix: "vigie" })
  )
    return NextResponse.redirect(new URL("/connexion", request.url));
  return NextResponse.next();
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
