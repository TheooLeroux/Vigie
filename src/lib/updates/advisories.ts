import { z } from "zod";
import { ApiError } from "../http";
import { mapConcurrent, planningCatalog } from "./planning";

export type PackageIdentity = { name: string; version: string };
export const packageIdentity = (item: PackageIdentity) => JSON.stringify([item.name, item.version]);
const reportSchema = z.object({ results: z.array(z.object({
  vulns: z.array(z.object({ id: z.string().min(1) })).optional(),
  next_page_token: z.string().optional(),
}).passthrough()) });

// Planning hints only: the resolved graph and the final sources still require
// their own complete scans. Cache belongs to this update, never to another job.
export async function checkPackageVersions(items: PackageIdentity[], transport: typeof fetch = fetch): Promise<Set<string>> {
  const unique = [...new Map(items.map(item => [packageIdentity(item), item])).values()].sort((a, b) => packageIdentity(a).localeCompare(packageIdentity(b)));
  const batches: PackageIdentity[][] = [];
  for (let offset = 0; offset < unique.length; offset += 128) batches.push(unique.slice(offset, offset + 128));
  const results = await mapConcurrent(batches, 4, async batch => {
    const queries = batch.map(item => ({ package: { name: item.name, ecosystem: "npm" }, version: item.version }));
    const safe = await planningCatalog(`osv:${JSON.stringify(queries)}`, transport, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let response: Response;
        try {
          response = await transport("https://api.osv.dev/v1/querybatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries }), redirect: "error", signal: AbortSignal.timeout(30_000) });
        } catch {
          if (attempt < 1) continue;
          throw new ApiError(`OSV est injoignable pour ${[...new Set(batch.map(item => item.name))].slice(0, 5).join(", ")} après deux tentatives. Aucun candidat non vérifié retenu.`, 502);
        }
        if (!response.ok) {
          if (attempt < 1 && (response.status === 429 || response.status >= 500)) {
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
            continue;
          }
          throw new ApiError("OSV ne permet pas de vérifier les versions candidates. Remédiation arrêtée.", 502);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new ApiError("La vérification OSV est incomplète.", 502);
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 4_000_000) { await reader.cancel(); throw new ApiError("La réponse OSV est trop volumineuse.", 502); }
          chunks.push(part.value);
        }
        let parsed: z.infer<typeof reportSchema>;
        try { parsed = reportSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { throw new ApiError("La vérification OSV est incomplète ou inexploitable.", 502); }
        if (parsed.results.length !== batch.length || parsed.results.some(item => item.next_page_token || "error" in item)) throw new ApiError("La vérification OSV est incomplète.", 502);
        return { value: batch.filter((_, index) => !parsed.results[index].vulns?.length).map(packageIdentity), bytes: size };
      }
      throw new ApiError("La vérification OSV a échoué.", 502);
    });
    return safe;
  });
  return new Set(results.flat());
}

export async function safeVersions<T extends { version: string }>(name: string, items: T[], transport: typeof fetch = fetch) {
  const safe = await checkPackageVersions(items.map(item => ({ name, version: item.version })), transport);
  return items.filter(item => safe.has(packageIdentity({ name, version: item.version })));
}
