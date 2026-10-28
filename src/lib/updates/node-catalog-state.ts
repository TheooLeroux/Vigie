import { ApiError } from "../http";
import { createHash } from "node:crypto";

export type NodeCatalogEntry = { url: string; accept: string; etag?: string; modified?: string; hash?: string };
const compact = "application/vnd.npm.install-v1+json";
const tag = (value: string | null) => value && /^(?:W\/)?"[^"\r\n]{1,200}"$/.test(value) ? value : null;
const sameTag = (left: string, right: string) => left.replace(/^W\//, "") === right.replace(/^W\//, "");

export function validCatalogEntry(entry: NodeCatalogEntry) {
  try {
    const url = new URL(entry.url), path = decodeURIComponent(url.pathname);
    const allowed = url.origin === "https://registry.npmjs.org" && !url.search && !url.hash && !url.username && !url.password && /^\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/latest)?$/i.test(path);
    return allowed && (path.endsWith("/latest") ? entry.accept === "application/json" && !!entry.hash && /^[a-f0-9]{64}$/.test(entry.hash) : [compact, "application/json"].includes(entry.accept) && !!tag(entry.etag || null) && !!entry.modified && Number.isFinite(Date.parse(entry.modified)));
  } catch { return false; }
}
async function latestBodyHash(response: Response) {
  if (response.status !== 200 || !response.body) return null;
  const reader = response.body.getReader(), hash = createHash("sha256");
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return hash.digest("hex");
    size += chunk.value.length;
    if (size > 2_000_000) { void reader.cancel().catch(() => {}); return null; }
    hash.update(chunk.value);
  }
}

async function mapCatalogs<T>(items: T[], action: (item: T, signal: AbortSignal) => Promise<boolean>) {
  let next = 0, valid = true;
  const deadline = Date.now() + 30_000;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (valid && next < items.length && Date.now() < deadline) {
      const item = items[next++];
      try { if (!await action(item, AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))))) valid = false; } catch { valid = false; }
    }
  }));
  return valid && next === items.length;
}

export async function unchangedNodeCatalogs(entries: NodeCatalogEntry[], transport: typeof fetch = fetch) {
  if (entries.length > 2500 || entries.some(entry => !validCatalogEntry(entry))) return false;
  return mapCatalogs(entries, async (entry, signal) => {
    if (entry.hash) {
      const response = await transport(entry.url, { headers: { Accept: entry.accept, "Cache-Control": "no-cache" }, redirect: "error", signal });
      return await latestBodyHash(response) === entry.hash;
    }
    const response = await transport(entry.url, { method: "HEAD", headers: { Accept: entry.accept, "If-None-Match": entry.etag!, "Cache-Control": "no-cache" }, redirect: "error", signal });
    const current = tag(response.headers.get("etag"));
    return response.status === 304 || response.status === 200 && !!current && sameTag(current, entry.etag!);
  });
}

export function nodeCatalogState(transport: typeof fetch = fetch, startedAt = Date.now()) {
  const entries = new Map<string, NodeCatalogEntry>(), observedPackages = new Map<string, Promise<void>>();
  let stable = true, active = 0;
  const waiting: (() => void)[] = [];
  async function slot(action: () => Promise<void>) {
    if (active < 8) active++; else await new Promise<void>(resolve => waiting.push(resolve));
    try { await action(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  function observe(url: string, accept: string, response: Response) {
    const etag = tag(response.headers.get("etag")), modified = response.headers.get("last-modified");
    // A catalog first discovered after native resolution is reusable only if it
    // was already unchanged when this job began. Never bless a mid-job release.
    if (response.status !== 200 || !etag || !modified || !Number.isFinite(Date.parse(modified)) || Date.parse(modified) > startedAt || entries.size >= 2500) { stable = false; return; }
    const key = url + "\n" + accept, previous = entries.get(key);
    if (previous && (!previous.etag || !sameTag(previous.etag, etag))) stable = false;
    const entry = { url, accept, etag, modified };
    if (!validCatalogEntry(entry)) { stable = false; return; }
    entries.set(key, entry);
  }
  const tracked: typeof fetch = async (input, init) => {
    if (!stable) return transport(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers), accept = headers.get("accept") || "application/json";
    const tracked = (!init?.method || init.method === "GET") && url.startsWith("https://registry.npmjs.org/");
    const latest = tracked && url.endsWith("/latest");
    if (latest) await packages([decodeURIComponent(new URL(url).pathname.slice(1, -7))]);
    const response = await transport(input, init);
    if (tracked) {
      if (headers.has("authorization") || headers.has("cookie")) stable = false;
      else if (latest) {
        // npm /latest has no ETag and its Last-Modified is a representation
        // timestamp. Hash the bounded body actually consumed by the solver.
        const bodyHash = await latestBodyHash(response.clone());
        if (!bodyHash || entries.size >= 2500) stable = false;
        else {
          const key = url + "\n" + accept, previous = entries.get(key);
          if (previous && previous.hash !== bodyHash) stable = false;
          entries.set(key, { url, accept, hash: bodyHash });
        }
      }
      else observe(url, accept, response);
    }
    return response;
  };
  async function packages(names: string[]) {
    if (!stable) return;
    const deadline = Date.now() + 30_000;
    const tasks: Promise<void>[] = [];
    for (const name of new Set(names)) {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || observedPackages.size >= 2500) { stable = false; continue; }
      if (!observedPackages.has(name)) observedPackages.set(name, slot(async () => {
        if (!stable || Date.now() >= deadline) { stable = false; return; }
        const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
        try {
          const response = await transport(url, { method: "HEAD", headers: { Accept: compact, "Cache-Control": "no-cache" }, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))) });
          observe(url, compact, response);
        } catch { stable = false; }
      }));
      tasks.push(observedPackages.get(name)!);
    }
    await Promise.all(tasks);
  }
  return { transport: tracked, packages, snapshot: async () => {
    await Promise.all(observedPackages.values());
    const values = [...entries.values()].sort((a, b) => a.url.localeCompare(b.url) || a.accept.localeCompare(b.accept));
    return stable && await unchangedNodeCatalogs(values, transport) ? values : null;
  } };
}

// Anonymous public-registry metadata only; the short-lived Docker token is
// never persisted, returned, logged, or sent outside these two fixed hosts.
export async function officialNodeImageDigest(image: string, transport: typeof fetch = fetch) {
  if (!/^node:\d+(?:\.\d+){0,2}(?:-[a-z0-9.-]+)?$/.test(image)) throw new ApiError("Image de catalogue non autorisée.");
  const auth = await transport("https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull", { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!auth.ok) throw new ApiError("Catalogue d’images indisponible.", 502);
  const data = await auth.json();
  if (typeof data.token !== "string" || data.token.length > 16_000 || /[\r\n]/.test(data.token)) throw new ApiError("Réponse du catalogue d’images invalide.", 502);
  const response = await transport(`https://registry-1.docker.io/v2/library/node/manifests/${image.slice(5)}`, { method: "HEAD", headers: { Authorization: `Bearer ${data.token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  const digest = response.headers.get("docker-content-digest");
  if (!response.ok || !digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new ApiError("Empreinte officielle de l’image non confirmée.", 502);
  return digest;
}
