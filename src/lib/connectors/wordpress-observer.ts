import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
const nextRequestAt = new Map<string, number>();
async function pace(address: string) {
  const now = Date.now(),
    start = Math.max(now, nextRequestAt.get(address) || 0);
  nextRequestAt.set(address, start + 2000);
  if (start > now)
    await new Promise((resolve) => setTimeout(resolve, start - now));
}
import { z } from "zod";
import { parseWordPressLoadFailure, wordpressLoadFailureMessage } from "./wordpress-load-failure";
import { ApiError } from "../http";
import type { SiteInventory } from "../types";
const text = z.string().max(500),
  nullable = text.nullable();
const update = {
  latestVersion: nullable,
  updateState: z.enum(["available", "current", "ahead", "unknown"]),
  updateCheckedAt: z.iso.datetime({ offset: true }).nullable(),
  updateSource: z.literal("wordpress"),
};
const component = z.object({
  updateOrigin: z.enum(["wordpress.org", "external", "unknown"]).optional(),
  ...update,
  file: text,
  slug: text,
  name: text,
  version: nullable,
  active: z.boolean(),
  mustUse: z.boolean(),
  autoUpdate: z.boolean().nullable(),
  requiresPhp: nullable,
  requiresWordPress: nullable,
  template: nullable,
});
export const observerPayloadSchema = z.object({
  localAgent: z.object({ detected: z.literal(true), lastSeenAt: z.iso.datetime({ offset: true }) }).optional(),
  format: z.literal("vigie.wordpress.v1"),
  collectionMode: z.enum(["normal", "early"]).optional(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  collectedAt: z.iso.datetime({ offset: true }),
  documentRoot: z.string().max(2000),
  wordpress: z.object({ ...update, version: text }),
  php: z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+[a-zA-Z0-9.+_-]*$/),
    scope: z.literal("web"),
    sapi: text,
    limits: z
      .record(z.string().max(60), text)
      .refine((v) => Object.keys(v).length <= 20),
    extensions: z.array(text).max(300),
  }),
  site: z.object({
    name: text,
    url: text,
    home: text,
    locale: text,
    timezone: text,
    multisite: z.boolean(),
    searchEnginesVisible: z.boolean(),
    https: z.boolean(),
  }),
  configuration: z.object({
    debug: z.boolean(),
    debugDisplay: z.boolean(),
    cronDisabled: z.boolean(),
    fileEditDisabled: z.boolean(),
    fileModsDisabled: z.boolean(),
    pageCache: z.boolean(),
    objectCache: z.boolean(),
  }),
  database: z.object({ version: text }),
  plugins: z.array(component).max(1000),
  themes: z.array(component).max(300),
});
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const a = address.split(".").map(Number);
    return !(
      a[0] === 0 ||
      a[0] === 10 ||
      a[0] === 127 ||
      (a[0] === 169 && a[1] === 254) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && (a[1] === 168 || a[1] === 0 || a[1] === 2)) ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      a[0] >= 224 ||
      (a[0] === 198 && (a[1] === 18 || a[1] === 19 || a[1] === 51)) ||
      (a[0] === 203 && a[1] === 0 && a[2] === 113)
    );
  }
  // Public global-unicast IPv6 only; reject mapped IPv4, loopback and local ranges.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:db8:/i.test(address)
  );
}
export async function observerUrl(url: string, resolve = lookup) {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ApiError("URL du WordPress invalide.");
  }
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    (target.port && target.port !== "443") ||
    target.search ||
    target.hash
  )
    throw new ApiError(
      "Le connecteur exige une URL HTTPS publique sans identifiant.",
    );
  const addresses = await resolve(target.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new ApiError(
      "Le connecteur ne peut pas interroger une adresse locale ou privée.",
    );
  target.searchParams.set("vigie_observer", "v1");
  return target;
}
export function observerHeaders(
  secret: string,
  body: string,
  nonce: string,
  time = Math.floor(Date.now() / 1000).toString(),
) {
  if (!/^[a-f0-9]{64}$/.test(secret))
    throw new ApiError("Clé de connecteur invalide.");
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "Vigie/1.0",
    "X-Vigie-Time": time,
    "X-Vigie-Nonce": nonce,
    "X-Vigie-Signature": createHmac("sha256", Buffer.from(secret, "hex"))
      .update(`v1\n${time}\n${nonce}\n${body}`)
      .digest("hex"),
  };
}
export function parseObserverPayload(
  raw: unknown,
  nonce: string,
  root: string,
): SiteInventory {
  const parsed = observerPayloadSchema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      "Le connecteur n’a pas renvoyé un inventaire interprétable.",
      502,
    );
  const data = parsed.data;
  if (
    data.nonce !== nonce ||
    data.documentRoot.replace(/\/$/, "") !== root ||
    Math.abs(Date.now() - Date.parse(data.collectedAt)) > 5 * 60_000
  )
    throw new ApiError(
      "La réponse ne correspond pas à cette installation ou à cette collecte.",
      502,
    );
  const warnings: string[] = [];
  if (data.collectionMode === "early")
    warnings.push(
      "WordPress n’a pas pu répondre après le chargement des extensions. Relevé effectué avant leur chargement ; les mises à jour proviennent des derniers caches disponibles et certains réglages dynamiques ne sont pas vérifiables.",
    );
  if (data.configuration.debug)
    warnings.push("Le mode debug WordPress est activé.");
  if (data.configuration.debug && data.configuration.debugDisplay)
    warnings.push(
      "Les erreurs WordPress peuvent être affichées aux visiteurs.",
    );
  if (!data.site.searchEnginesVisible)
    warnings.push("WordPress demande aux moteurs de ne pas indexer ce site.");
  if (data.configuration.cronDisabled)
    warnings.push(
      "Le cron WordPress est désactivé ; vérifier qu’une tâche serveur prend le relais.",
    );
  if (!data.site.https)
    warnings.push(
      "WordPress ne reconnaît pas cette requête en HTTPS ; vérifier la configuration du proxy.",
    );
  const items = [data.wordpress, ...data.plugins, ...data.themes];
  if (
    items.some(
      (i) =>
        i.updateCheckedAt &&
        Date.now() - Date.parse(i.updateCheckedAt) > 24 * 3600_000,
    )
  )
    warnings.push(
      "Certaines vérifications de mises à jour ont plus de 24 heures.",
    );
  return {
    source: "wordpress-observer",
    ...(data.localAgent ? { localAgent: data.localAgent } : {}),
    collectionMode: data.collectionMode || "normal",
    observedAt: data.collectedAt,
    lastAttemptAt: new Date().toISOString(),
    error: null,
    wordpress: data.wordpress,
    php: data.php,
    site: data.site,
    configuration: data.collectionMode === "early" ? null : data.configuration,
    database: data.database,
    plugins: data.plugins,
    themes: data.themes,
    warnings,
  };
}
export async function collectObserver(
  url: string,
  root: string,
  secret: string,
  transport: typeof fetch = fetch,
  resolve = lookup,
  early = false,
): Promise<SiteInventory> {
  const target = await observerUrl(url, resolve),
    body = JSON.stringify(
      early ? { refresh: false, mode: "early" } : { refresh: true },
    ),
    nonce = randomBytes(16).toString("hex");
  try {
    const headers = observerHeaders(secret, body, nonce);
    // Pin a checked IP, preserving the domain for SNI and certificate validation.
    const checked =
      transport === fetch ? await resolve(target.hostname, { all: true }) : [];
    if (checked.some((a) => !publicAddress(a.address)))
      throw new ApiError("Adresse locale ou privée refusée.");
    if (checked[0]) await pace(checked[0].address);
    const response =
      transport === fetch
        ? await new Promise<Response>((resolveResponse, reject) => {
            if (!checked.length) {
              reject(new ApiError("Aucune adresse publique pour ce site."));
              return;
            }
            const req = httpsRequest(
              {
                hostname: checked[0].address,
                family: checked[0].family,
                port: 443,
                servername: target.hostname,
                path: target.pathname + target.search,
                method: "POST",
                headers: {
                  ...headers,
                  Host: target.hostname,
                  "Content-Length": Buffer.byteLength(body),
                },
                signal: AbortSignal.timeout(90_000),
              },
              (res) => {
                const chunks: Buffer[] = [];
                let bytes = 0;
                res.on("data", (chunk) => {
                  bytes += chunk.length;
                  if (bytes > 2_000_000) {
                    res.destroy();
                    reject(
                      new ApiError(
                        "Inventaire WordPress trop volumineux.",
                        502,
                      ),
                    );
                  } else chunks.push(chunk);
                });
                res.on("error", reject);
                res.on("end", () => {
                  try {
                    const status = res.statusCode || 502;
                    resolveResponse(
                      new Response(
                        [204, 205, 304].includes(status)
                          ? null
                          : Buffer.concat(chunks),
                        {
                          status,
                          headers: res.headers["retry-after"]
                            ? {
                                "retry-after": String(
                                  res.headers["retry-after"],
                                ),
                              }
                            : {},
                        },
                      ),
                    );
                  } catch (error) {
                    reject(error);
                  }
                });
              },
            );
            req.on("error", reject);
            req.end(body);
          })
        : await transport(target.href, {
            method: "POST",
            headers,
            body,
            redirect: "manual",
            cache: "no-store",
            signal: AbortSignal.timeout(90_000),
          });
    if (response.status === 429) {
      const retry = response.headers.get("retry-after"),
        seconds =
          retry && /^\d+$/.test(retry)
            ? Number(retry)
            : retry
              ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
              : 60;
      if (checked[0])
        nextRequestAt.set(
          checked[0].address,
          Date.now() + Math.max(60, Math.min(seconds || 60, 300)) * 1000,
        );
      throw new ApiError(
        "Le site limite temporairement les requêtes. Réessayez après le délai du serveur (au moins une minute).",
        429,
      );
    }
    if (response.status >= 500 && !early) {
      let failure: SiteInventory["loadFailure"];
      const reader = response.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { failure = parseWordPressLoadFailure(JSON.parse(Buffer.concat(chunks).toString("utf8")), root); break; }
            bytes += value.length;
            if (bytes > 8192) { await reader.cancel(); break; }
            chunks.push(value);
          }
        } catch { /* A diagnostic failure must not suppress the bounded fallback. */ }
      }
      const fallback = await collectObserver(url, root, secret, transport, resolve, true);
      return failure && fallback.collectionMode === "early"
        ? { ...fallback, loadFailure: failure, warnings: [...fallback.warnings, wordpressLoadFailureMessage(failure)] }
        : fallback;
    }
    if (!response.ok)
      throw new ApiError(
        response.status >= 300 && response.status < 400
          ? "Le site redirige la requête. Vérifiez son URL canonique avant la collecte."
          : `Le connecteur WordPress n’est pas joignable (HTTP ${response.status}).`,
        502,
      );
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError("Réponse WordPress vide.", 502);
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new ApiError("Inventaire WordPress trop volumineux.", 502);
      }
      chunks.push(value);
    }
    return parseObserverPayload(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      nonce,
      root,
    );
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      "La collecte WordPress a échoué. Le dernier relevé est conservé.",
      502,
    );
  }
}
