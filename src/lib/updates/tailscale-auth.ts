import { z } from "zod";
import { ApiError } from "../http";

// Check that existing OAuth credentials still authorize the configured tags.
// No auth key/device is created, and the short-lived token is never retained.
export async function verifyTailscaleAuthorization(variables: Record<string, string>, transport: typeof fetch = fetch) {
  const [secret, query, extra] = (variables.TS_AUTHKEY || "").split("?");
  const parameters = new URLSearchParams(query || "");
  const tags = (variables.TS_EXTRA_ARGS || "").split(/\s+/).find(flag => flag.startsWith("--advertise-tags="))?.slice("--advertise-tags=".length).split(",");
  if (extra !== undefined || !/^tskey-client-[a-zA-Z0-9-]+$/.test(secret) || [...parameters.keys()].some(key => !["ephemeral", "preauthorized"].includes(key)) || [...parameters.values()].some(value => !["true", "false"].includes(value)) || !tags?.length || tags.some(tag => !/^tag:[a-z0-9-]+$/.test(tag))) throw new ApiError("La reconnexion de ce proxy exige un accès OAuth Tailscale existant et des tags qualifiés ; une clé ponctuelle ou expirante ne peut pas garantir sa récupération.", 422);
  try {
    const response = await transport("https://api.tailscale.com/api/v2/oauth/token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_secret: secret, scope: "auth_keys", tags: tags.join(" ") }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("authorization"); }
    const text = await response.text();
    if (text.length > 20_000) throw new Error("size");
    const result = z.object({ access_token: z.string().min(10).max(16_000), token_type: z.string().regex(/^Bearer$/i), expires_in: z.number().positive() }).safeParse(JSON.parse(text));
    if (!result.success) throw new Error("token");
  } catch { throw new ApiError("L’accès OAuth existant ne confirme pas les droits de reconnexion avec les tags actuels. Aucune image remplacée.", 422); }
}
