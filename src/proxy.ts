import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { trustedRequestOrigin } from "./lib/request-origin";
export function proxy(request: NextRequest) {
  if (!trustedRequestOrigin(request))
    return new NextResponse(
      "Vigie : hôte non autorisé.",
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
