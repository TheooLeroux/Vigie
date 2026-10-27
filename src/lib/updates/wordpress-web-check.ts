import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../http";
import { hostingInstallation } from "../hosting-discovery";
import { collectHostingInventories } from "../hosting-inventory";
import { checkPublicSite } from "./providers";
import type { UpdateTarget } from "./types";

export const wordpressWebCheckBody = z.object({ installationId: z.string().uuid(), action: z.enum(["inventory", "preflight", "postflight"]) }).strict();
function signingKey() {
  const key = process.env.VIGIE_CONNECTOR_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new ApiError("Clé du contrôle web manquante.", 503);
  return Buffer.from(hkdfSync("sha256", Buffer.from(key, "hex"), Buffer.alloc(0), "vigie:wordpress-web-check:v1", 32));
}
export function wordpressWebSignature(body: string, timestamp: string) {
  return createHmac("sha256", signingKey()).update(`POST\n/api/maintenance/wordpress\n${timestamp}\n${body}`).digest("hex");
}
export function verifyWordPressWebSignature(body: string, timestamp: string, signature: string) {
  if (Buffer.byteLength(body) > 2048 || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 90 || !/^[a-f0-9]{64}$/.test(signature)) throw new ApiError("Contrôle web non autorisé.", 401);
  if (!timingSafeEqual(Buffer.from(wordpressWebSignature(body, timestamp), "hex"), Buffer.from(signature, "hex"))) throw new ApiError("Contrôle web non autorisé.", 401);
}

export async function runWordPressWebCheck(input: z.infer<typeof wordpressWebCheckBody>) {
  const site = await hostingInstallation(input.installationId);
  if (site.kind !== "wordpress" || !site.project || site.project.lifecycle !== "active" || site.missingSince || site.ignored) throw new ApiError("Installation WordPress non éligible.", 409);
  let url = `https://${site.domains[0]}/`;
  try { const home = new URL(site.inventory?.site?.home || ""); if (home.protocol === "https:" && !home.username && !home.password && [...site.domains, ...site.aliases].includes(home.hostname)) url = home.href; } catch {}
  if (input.action !== "inventory") await checkPublicSite(url);
  await collectHostingInventories(site.connectionId, fetch, fetch, site.id);
  const fresh = (await hostingInstallation(site.id)).inventory;
  if (!fresh || fresh.error || !fresh.observedAt || Date.now() - Date.parse(fresh.observedAt) > 5 * 60_000) throw new ApiError(fresh?.error || "L’inventaire WordPress récent n’a pas pu être confirmé.", 502);
  return { ok: true as const, installationId: site.id, observedAt: fresh.observedAt };
}

/** Read-only checks go through Vigie when o2switch filters hosted runner IPs. */
export async function refreshWordPressWeb(target: Pick<UpdateTarget, "remoteId" | "connectionId" | "url">, action: z.infer<typeof wordpressWebCheckBody>["action"]) {
  const origin = process.env.VIGIE_WORDPRESS_CONTROL_URL;
  if (!origin) {
    if (action !== "inventory") await checkPublicSite(target.url!);
    await collectHostingInventories(target.connectionId, fetch, fetch, target.remoteId);
    return;
  }
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || (base.port && base.port !== "443")) throw new ApiError("Adresse du contrôle web Vigie invalide.");
  const body = JSON.stringify(wordpressWebCheckBody.parse({ installationId: target.remoteId, action })), timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(new URL("/api/maintenance/wordpress", base), { method: "POST", headers: { "Content-Type": "application/json", "X-Vigie-Time": timestamp, "X-Vigie-Signature": wordpressWebSignature(body, timestamp) }, body, redirect: "error", signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new ApiError("Le contrôle web depuis Vigie n’a pas pu être confirmé. Aucune nouvelle modification autorisée.", 502);
  const result = z.object({ ok: z.literal(true), installationId: z.string().uuid(), observedAt: z.string() }).parse(await response.json());
  if (result.installationId !== target.remoteId || !Number.isFinite(Date.parse(result.observedAt)) || Math.abs(Date.now() - Date.parse(result.observedAt)) > 5 * 60_000) throw new ApiError("Réponse du contrôle web Vigie non admissible.", 502);
}
