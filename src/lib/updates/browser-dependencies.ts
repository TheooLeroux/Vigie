import { valid } from "semver";
import { ApiError } from "../http";
import { parseOsv } from "./security";
import { mapConcurrent } from "./planning";
import { boundedSourceJson } from "./source-http";

export type BrowserPackage = { name: string; version: string; origin: string };
const aliases: Record<string, string> = { jquery: "jquery", "jquery-ui": "jquery-ui", bootstrap: "bootstrap", "chart.js": "chart.js", Chart: "chart.js", lodash: "lodash", moment: "moment", dompurify: "dompurify", jspdf: "jspdf", html2canvas: "html2canvas", xlsx: "xlsx", axios: "axios", "pdf.js": "pdfjs-dist", vue: "vue", react: "react", "react-dom": "react-dom", three: "three", d3: "d3" };
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

// Only parse references: do not execute code or fetch arbitrary URLs from sources.
export function browserDependencies(files: { path: string; content: string }[]) {
  const inventory: BrowserPackage[] = [], limitations = new Set<string>();
  for (const file of files) {
    const urls = new Set<string>();
    for (const match of file.content.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      if (/^<link/i.test(match[0]) && !/stylesheet|modulepreload/i.test(match[0])) continue;
      if (/^(?:https?:)?\/\//i.test(match[1])) urls.add(match[1]);
    }
    // Includes import maps, ESM imports and URL strings used to load scripts.
    for (const match of file.content.matchAll(/["'`](https?:\/\/[^\s"'`<>]+|\/\/[^\s"'`<>]+)["'`]/g)) {
      if (/\.(?:m?js|css)(?:[?#]|$)|(?:cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|cdnjs\.cloudflare\.com|cdn\.skypack\.dev|cdn\.tailwindcss\.com)\//i.test(match[1])) urls.add(match[1]);
    }
    for (const raw of urls) {
      let url: URL;
      try { url = new URL(raw.startsWith("//") ? `https:${raw}` : raw); } catch { limitations.add(`${file.path} : référence externe non interprétable.`); continue; }
      let name: string | undefined, version: string | undefined;
      if (["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) continue;
      const pathname = decodeURIComponentSafe(url.pathname);
      const npm = url.hostname === "cdn.jsdelivr.net" ? pathname.match(/^\/npm\/((?:@[^/]+\/)?[^/@]+)@([^/]+)/) : ["unpkg.com", "esm.sh", "cdn.skypack.dev"].includes(url.hostname) ? pathname.match(/^\/((?:@[^/]+\/)?[^/@]+)@([^/]+)/) : null;
      if (npm) [, name, version] = npm;
      if (url.hostname === "cdnjs.cloudflare.com") { const match = pathname.match(/^\/ajax\/libs\/([^/]+)\/([^/]+)\//); if (match) { name = match[1].toLowerCase() === "font-awesome" ? Number(match[2].split(".")[0]) >= 5 ? "@fortawesome/fontawesome-free" : "font-awesome" : aliases[match[1].toLowerCase()]; version = match[2]; } }
      if (url.hostname === "code.jquery.com") { const match = pathname.match(/^\/jquery-([0-9.]+)(?:\.slim)?(?:\.min)?\.js$/); if (match) { name = "jquery"; version = match[1]; } }
      if (name && packageName.test(name) && version && valid(version)) inventory.push({ name, version: valid(version)!, origin: file.path });
      else limitations.add(`${file.path} : bibliothèque externe sans identité/version vérifiable (${url.hostname}).`);
    }
    if (/\b(?:import\s*\(|require\s*\(|createElement\s*\(\s*["']script["'])/.test(file.content)) limitations.add(`${file.path} : chargements dynamiques à compléter ; l’exécution du code n’est pas simulée.`);
    if (/(?:^|\/)(?:vendor|vendors|dist|build|bundles?)(?:\/|\.)|\.min\.js$/.test(file.path)) limitations.add(`${file.path} : code précompilé ou bibliothèque locale sans inventaire exhaustif.`);
  }
  return { inventory: [...new Map(inventory.map(item => [`${item.name}@${item.version}`, item])).values()], limitations: [...limitations] };
}
function decodeURIComponentSafe(value: string) { try { return decodeURIComponent(value); } catch { return value; } }

export async function queryKnownPackages(packages: BrowserPackage[], transport: typeof fetch = fetch) {
  if (packages.length > 250 || packages.some(item => !packageName.test(item.name) || !valid(item.version))) throw new ApiError("Inventaire des bibliothèques invalide ou trop volumineux.");
  const deadline = AbortSignal.timeout(120_000);
  return (await mapConcurrent(packages, 4, async item => {
    let pageToken: string | undefined;
    const vulnerabilities: unknown[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const response = await transport("https://api.osv.dev/v1/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ package: { name: item.name, ecosystem: "npm" }, version: item.version, ...(pageToken ? { page_token: pageToken } : {}) }), redirect: "error", signal: AbortSignal.any([deadline, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new ApiError("Le catalogue OSV des bibliothèques n’est pas disponible.", 502);
      const body = await boundedSourceJson(response, 8_000_000);
      if (!body || typeof body !== "object" || Array.isArray(body) || body.vulns !== undefined && !Array.isArray(body.vulns)) throw new ApiError("Rapport OSV non exploitable.", 502);
      vulnerabilities.push(...(body.vulns || []));
      if (!body.next_page_token) return parseOsv(JSON.stringify({ results: [{ source: { path: item.origin }, packages: [{ package: { name: item.name, version: item.version, ecosystem: "npm" }, vulnerabilities }] }] })).findings.map(finding => ({ ...finding, usage: "runtime" as const }));
      if (typeof body.next_page_token !== "string" || seen.has(body.next_page_token)) break;
      pageToken = body.next_page_token; seen.add(body.next_page_token);
    }
    throw new ApiError("Le catalogue OSV a fourni un rapport incomplet.", 502);
  })).flat();
}
