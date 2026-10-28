import { createHash } from "node:crypto";
import { hostingInstallation } from "../hosting-discovery";
import { hostingStorage } from "../hosting-storage";
import { freeWordPressScanner } from "./wordpress-free-security";
import { wordpressPlanSchema } from "./wordpress-security";
import { wordpressSecurityVersions } from "./wordpress-security-key";
import { securityCheck } from "./security";
import type { UpdateState, UpdateTarget } from "./types";

type Observation = NonNullable<UpdateState["currentSecurity"]>[number];
const pending = new Map<string, Promise<Observation>>();
export async function currentWordPressSecurity(target: UpdateTarget, dependencies: { site?: typeof hostingInstallation; transport?: typeof fetch; cacheOnly?: boolean; fresh?: boolean } = {}): Promise<Observation> {
  const site = await (dependencies.site || hostingInstallation)(target.remoteId), inventory = site.inventory;
  const versions = inventory ? wordpressSecurityVersions(inventory) : "";
  const unavailable = { targetId: target.id, versions, warnings: [], error: "Actualisez l’inventaire WordPress pour contrôler les versions actuelles." };
  if (target.mode !== "wordpress" || site.project?.id !== target.projectId || site.connectionId !== target.connectionId || site.documentRoot !== target.root || site.missingSince || !inventory?.wordpress || !inventory.php || inventory.error || (inventory.collectionMode === "early" && inventory.source !== "wordpress-observer") || !inventory.observedAt || !Number.isFinite(Date.parse(inventory.observedAt)) || Date.now() - Date.parse(inventory.observedAt) > 24 * 3600_000) return unavailable;
  const key = "security:wp-current:1:" + createHash("sha256").update(JSON.stringify([target.id, target.projectId, target.connectionId, target.root, versions, ...(inventory.collectionMode === "early" ? ["early"] : [])])).digest("hex");
  const db = await hostingStorage();
  const cached = await db.prepare("SELECT data FROM wordpress_catalog WHERE cache_key=? AND expires_at>?").get(key, new Date().toISOString()) as { data: string } | undefined;
  if (cached && !dependencies.fresh) return JSON.parse(cached.data) as Observation;
  if (dependencies.cacheOnly) return { ...unavailable, error: "Le contrôle automatique est attendu. Il s’exécute sans ouvrir cette fiche." };
  if (pending.has(key)) return pending.get(key)!;
  const task = (async () => {
    let result: Observation;
    try {
      const deadline = AbortSignal.timeout(60_000);
      const transport: typeof fetch = (input, options) => (dependencies.transport || fetch)(input, { ...options, signal: AbortSignal.any([deadline, ...(options?.signal ? [options.signal] : [])]) });
      const scan = freeWordPressScanner(transport, { persistentCache: !dependencies.transport && !dependencies.fresh });
      const plan = wordpressPlanSchema.parse({ wordpress: { current: inventory.wordpress!.version, target: inventory.wordpress!.version, requiresPhp: "" }, php: inventory.php!.version, plugins: inventory.plugins.filter(item => !item.mustUse).map(item => ({ slug: item.slug, current: item.version || "", target: item.version || "", requiresPhp: "", requiresWordPress: "" })), themes: [] });
      const findings = await scan(await scan.prepare(plan), false);
      const order = ["critical", "high", "moderate", "low", "unknown"];
      findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || Number(a.kind === "supply-chain") - Number(b.kind === "supply-chain"));
      // A signed early inventory still identifies installed core/plugin files.
      // It proves no runtime health and must never enable maintenance operations.
      result = { targetId: target.id, versions, check: securityCheck("WPVulnerability", "before", "Contrôle en lecture seule des versions actuellement installées", findings), warnings: [...scan.warnings, "Les thèmes et extensions MU ne sont pas analysés par ce contrôle.", ...(inventory.collectionMode === "early" ? ["Inventaire signé en mode de secours : analyse des versions installées uniquement. Le chargement complet de WordPress et la disponibilité de la maintenance ne sont pas confirmés."] : [])] };
    } catch { result = { ...unavailable, error: "Le contrôle de sécurité actuel est indisponible. Les anciens rapports restent dans l’historique et ne constituent pas un nouveau contrôle." }; }
    await db.prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at").run(key, JSON.stringify(result), new Date(Date.now() + (result.error ? 60_000 : 3600_000)).toISOString());
    return result;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
