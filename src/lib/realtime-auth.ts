import { createHmac, timingSafeEqual } from "node:crypto";
import { isAllowedGoogleUser } from "./auth-policy";
import { ApiError } from "./http";

type Grant = { purpose: "project-realtime"; sessionId: string; userId: string; email: string; expiresAt: string };
function sign(payload: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new ApiError("Authentification non configurée.", 503);
  return createHmac("sha256", secret).update(`vigie:project-realtime:v1:${payload}`).digest();
}
export function issueRealtimeGrant(session: { session: { id: string; expiresAt: Date }; user: { id: string; email: string } }) {
  const grant: Grant = { purpose: "project-realtime", sessionId: session.session.id, userId: session.user.id, email: session.user.email, expiresAt: session.session.expiresAt.toISOString() };
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${sign(payload).toString("base64url")}`;
}
// The grant only renews this fixed read-only query. Revocations and changes to
// the user are checked LIVE by the SQL query, not by polling the auth database.
export function verifyRealtimeGrant(token: string, now = Date.now()): Grant {
  const denied = () => new ApiError("Reconnectez-vous pour rétablir le temps réel.", 401);
  if (token.length > 4096) throw denied();
  const parts = token.split(".");
  if (parts.length !== 2) throw denied();
  const signature = Buffer.from(parts[1], "base64url"), expected = sign(parts[0]);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw denied();
  let grant: Grant;
  try { grant = JSON.parse(Buffer.from(parts[0], "base64url").toString()); } catch { throw denied(); }
  if (!grant || grant.purpose !== "project-realtime" || typeof grant.sessionId !== "string" || !grant.sessionId || typeof grant.userId !== "string" || !grant.userId || typeof grant.email !== "string" || !isAllowedGoogleUser({ email: grant.email, emailVerified: true }) || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now) throw denied();
  return grant;
}
