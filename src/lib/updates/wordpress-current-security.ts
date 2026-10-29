import { createHash } from "node:crypto";
import { hostingInstallation } from "../hosting-discovery";
import { hostingStorage } from "../hosting-storage";
import { freeWordPressScanner } from "./wordpress-free-security";
import { wordpressPlanSchema } from "./wordpress-security";
import { wordpressSecurityVersions } from "./wordpress-security-key";
import { securityCheck } from "./security";
import { recordWordPressManualUpdates } from "./wordpress-maintenance";
import type { UpdateResult } from "./types";
import type { UpdateState, UpdateTarget } from "./types";

type Observation = NonNullable<UpdateState["currentSecurity"]>[number];
const pending = new Map<string, Promise<Observation>>();
export async function currentWordPressSecurity(target: UpdateTarget, dependencies: { site?: typeof hostingInstallation; transport?: typeof fetch; cacheOnly?: boolean; fresh?: boolean } = {}): Promise<Observation> {
  const site = await (dependencies.site || hostingInstallation)(target.remoteId), inventory = site.inventory;
  const versions = inventory ? wordpressSecurityVersions(inventory) : "";
  const unavailable = { targetId: target.id, versions, warnings: [], error: "Actualisez l’inventaire WordPress pour contrôler les versions actuelles." };
  if (target.mode !== "wordpress" || site.project?.id !== target.projectId || site.connectionId !== target.connectionId || site.documentRoot !== target.root || site.missingSince || !inventory?.wordpress || !inventory.php || inventory.error || (inventory.collectionMode === "early" && inventory.source !== "wordpress-observer") || !inventory.observedAt || !Number.isFinite(Date.parse(inventory.observedAt)) || Date.now() - Date.parse(inventory.observedAt) > 24 * 3600_000) return unavailable;
  const key = "security:wp-current:4:" + createHash("sha256").update(JSON.stringify([target.id, target.projectId, target.connectionId, target.root, versions, ...(inventory.collectionMode === "early" ? ["early"] : [])])).digest("hex");
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
      const component = (item: (typeof inventory.plugins)[number]) => ({ slug: item.slug, current: item.version || "", target: item.version || "", requiresPhp: "", requiresWordPress: "", updateOrigin: item.updateOrigin, template: item.template || "" });
      const plan = wordpressPlanSchema.parse({ wordpress: { current: inventory.wordpress!.version, target: inventory.wordpress!.version, requiresPhp: "" }, php: inventory.php!.version, plugins: inventory.plugins.filter(item => !item.mustUse).map(component), themes: inventory.themes.map(component) });
      const prepared = await scan.prepare(plan);
      const findings = await scan(prepared, false);
      const manual: UpdateResult = { targetId: target.id, name: target.name, stage: "checking", message: "Contrôle en lecture seule, aucune maintenance exécutée.", warnings: [] };
      // A read-only scan must not call a public plugin's available update manual
      // simply because this observation deliberately proposes no installation.
      const retainedFindings = findings.filter(finding => {
        const slug = finding.package.replace(/^plugins\//, "");
        return !finding.package.startsWith("plugins/") || inventory.plugins.find(item => item.slug === slug)?.updateState !== "available" || prepared.plugins.find(item => item.slug === slug)?.manualReason;
      });
      recordWordPressManualUpdates(manual, prepared, inventory, retainedFindings);
      if (!prepared.wordpress.manualReason && inventory.wordpress!.updateState === "available") manual.manualUpdates = manual.manualUpdates?.filter(item => item.package !== "wordpress/wordpress");
      const order = ["critical", "high", "moderate", "low", "unknown"];
      findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || Number(a.kind === "supply-chain") - Number(b.kind === "supply-chain"));
      // A signed early inventory still identifies installed core/plugin files.
      // It proves no runtime health and must never enable maintenance operations.
      result = { targetId: target.id, versions, check: securityCheck("WPVulnerability", "before", "Contrôle en lecture seule des versions actuellement installées", findings), manualUpdates: manual.manualUpdates, warnings: [...scan.warnings, "Les extensions MU et le code personnalisé restent à contrôler manuellement. Les thèmes publics identifiables sont analysés, y compris inactifs.", ...(inventory.collectionMode === "early" ? ["Inventaire signé en mode de secours : analyse des versions installées uniquement. Le chargement complet de WordPress et la disponibilité de la maintenance ne sont pas confirmés."] : [])] };
      result.securityCoverage = {
        scope: "wordpress",
        packages: 1 + [...prepared.plugins, ...prepared.themes].filter(item => !item.manualReason && !item.template && !scan.warnings.some(warning => warning.startsWith(item.slug + " :"))).length,
        limitations: [...scan.warnings,
          ...inventory.plugins.filter(item => item.mustUse).map(item => `${item.name} : extension MU à contrôler manuellement.`),
          ...(inventory.collectionMode === "early" ? ["Inventaire de secours : le chargement complet de WordPress n’est pas confirmé."] : []),
        ],
      };
    } catch { result = { ...unavailable, error: "Le contrôle de sécurité actuel est indisponible. Les anciens rapports restent dans l’historique et ne constituent pas un nouveau contrôle." }; }
    await db.prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at").run(key, JSON.stringify(result), new Date(Date.now() + (result.error ? 60_000 : 3600_000)).toISOString());
    return result;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
