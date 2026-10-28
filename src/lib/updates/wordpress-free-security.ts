import { z } from "zod";
import { ApiError } from "../http";
import { hostingStorage } from "../hosting-storage";
import { severity } from "./security";
import { compareWordPressVersions, wordpressPlanSchema, type WordPressUpdatePlan } from "./wordpress-security";
import type { SecurityFinding } from "./types";

const numeric = /^\d+(?:\.\d+){0,7}$/;
const operators = z.enum(["lt", "le", "eq", "ne", "gt", "ge"]);
const range = z.object({ min_version: z.string().max(80).nullable().optional(), min_operator: operators.nullable().optional(), max_version: z.string().max(80).nullable().optional(), max_operator: operators.nullable().optional() });
const vulnerability = z.object({ uuid: z.string().regex(/^[a-z0-9-]{1,128}$/i), name: z.string().max(2000).nullable().optional(), operator: range.extend({ unfixed: z.string().optional() }).optional(), impact: z.unknown().optional(), source: z.array(z.object({ id: z.string().max(160).nullable().optional(), name: z.string().max(2000).nullable().optional(), link: z.string().max(3000).nullable().optional() })).max(1000).optional() });
const advisory = z.object({ error: z.literal(0), updated: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]), data: z.object({ core: z.string().optional(), plugin: z.string().optional(), theme: z.string().optional(), name: z.string().nullable().optional(), link: z.string().nullable().optional(), closed: z.number().int().nullable().optional(), vulnerability: z.array(vulnerability).max(20000).nullable(), supplychain: z.array(z.object({ verdict: z.enum(["malicious", "suspicious", "cleaned"]), audit_id: z.number().int(), affected_versions: range.optional() })).max(1000).optional() }) });
type Advisory = z.infer<typeof advisory>;

// Advisory bounds may contain PHP-style prereleases, unlike installable stable plans.
export function compareAdvisoryVersions(first: string, second: string) {
  const parse = (value: string) => {
    const match = /^(\d+(?:\.\d+){0,7})(?:[._+-]?(dev|alpha|a|beta|b|rc|pl|p)[._-]?(\d*))?$/i.exec(value);
    if (!match || value.length > 80) throw new Error("Unsupported advisory version");
    const ranks: Record<string, number> = { dev: -4, alpha: -3, a: -3, beta: -2, b: -2, rc: -1, pl: 1, p: 1 };
    return { parts: match[1].split(".").map(BigInt), rank: match[2] ? ranks[match[2].toLowerCase()] : 0, number: BigInt(match[3] || "0") };
  };
  const a = parse(first), b = parse(second);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const x = a.parts[i] || 0n, y = b.parts[i] || 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.rank !== b.rank ? Math.sign(a.rank - b.rank) : a.number === b.number ? 0 : a.number < b.number ? -1 : 1;
}
function sourceUrl(value?: string | null) {
  try { const url = new URL(value || ""); if (url.protocol === "https:" && !url.username && !url.password && ["www.wordfence.com", "wordfence.com", "patchstack.com", "www.cve.org", "wpscan.com", "wpbeacon.io"].includes(url.hostname)) return url.href; } catch {}
}

function affected(version: string, bounds?: z.infer<typeof range>) {
  if (!bounds) return true;
  try {
    const test = (bound?: string | null, op?: z.infer<typeof operators> | null) => {
      if (!bound) return true;
      if (!op) throw new Error("Incomplete version range");
      const compared = compareAdvisoryVersions(version, bound);
      return ({ lt: compared < 0, le: compared <= 0, eq: compared === 0, ne: compared !== 0, gt: compared > 0, ge: compared >= 0 })[op];
    };
    return test(bounds.min_version, bounds.min_operator) && test(bounds.max_version, bounds.max_operator);
  } catch { return true; } // Never interpret an unsupported range as proof of safety.
}
export function freeWordPressFindings(raw: unknown, kind: "core" | "plugin" | "theme", identity: string, version: string): SecurityFinding[] {
  const data = advisory.parse(raw).data;
  if (data[kind] !== identity) throw new ApiError("Le rapport WPVulnerability ne correspond pas au composant demandé.", 502);
  const findings: SecurityFinding[] = (data.vulnerability || []).filter(item => kind === "core" || affected(version, item.operator)).map(item => {
    const impact = item.impact && !Array.isArray(item.impact) && typeof item.impact === "object" ? item.impact as Record<string, { score?: unknown; severity?: unknown }> : {};
    const scores = [impact.cvss, impact.cvss3].flatMap(value => value ? [severity(value.score ?? value.severity)] : []);
    const levels = ["critical", "high", "moderate", "low", "unknown"] as const;
    const source = item.source?.find(source => sourceUrl(source.link)?.includes("wordfence.com/")) || item.source?.find(source => sourceUrl(source.link));
    let confirmed = true;
    try { if (item.operator?.min_version) compareAdvisoryVersions(version, item.operator.min_version); if (item.operator?.max_version) compareAdvisoryVersions(version, item.operator.max_version); } catch { confirmed = false; }
    if (kind !== "core" && (!item.operator || (item.operator.min_version && !item.operator.min_operator) || (item.operator.max_version && !item.operator.max_operator))) confirmed = false;
    const fixed = item.operator?.max_operator === "lt" && item.operator.unfixed !== "1" && item.operator.max_version;
    return { id: `WPV-${item.uuid}`, aliases: [...new Set((item.source || []).map(source => source.id || "").filter(id => /^CVE-\d{4}-\d+$/i.test(id)))], package: kind === "core" ? "wordpress/wordpress" : `${kind}s/${identity}`, version, severity: levels.find(level => scores.includes(level)) || "unknown", title: source?.name || item.name || "Vulnérabilité connue", url: sourceUrl(source?.link), kind: confirmed ? "vulnerability" : "unconfirmed", ...(!confirmed ? { explanation: "La plage de versions publiée n’a pas pu être interprétée ; applicabilité à vérifier." } : {}), ...(fixed && confirmed ? { fixedVersions: [fixed] } : {}) };
  });
  for (const entry of data.supplychain || []) {
    if (!affected(version, entry.affected_versions)) continue;
    findings.push({ id: `${entry.verdict === "suspicious" ? "WPV-SUPPLY" : "MAL-WPV"}-${entry.audit_id}`, aliases: [], package: kind === "core" ? "wordpress/wordpress" : `${kind}s/${identity}`, version, severity: entry.verdict === "suspicious" ? "unknown" : "critical", kind: "supply-chain", title: entry.verdict === "suspicious" ? "Signal suspect sur la distribution du composant" : "Versions signalées comme malveillantes", explanation: entry.verdict === "suspicious" ? "Signal à vérifier : aucune compromission du site n’est confirmée par ce contrôle. Une mise à jour seule ne lève pas nécessairement ce signal." : "L’audit signale des versions malveillantes ; une vérification de l’installation est nécessaire.", url: `https://wpbeacon.io/audits/${entry.audit_id}/` });
  }
  return findings;
}

export function selectCompatibleWordPressUpdates(raw: WordPressUpdatePlan) {
  const plan = wordpressPlanSchema.parse(structuredClone(raw));
  if (plan.wordpress.current !== plan.wordpress.target && plan.wordpress.requiresPhp) {
    try {
      if (compareWordPressVersions(plan.php, plan.wordpress.requiresPhp) < 0) throw new Error();
    } catch {
      plan.warnings.push(`WordPress ${plan.wordpress.target} nécessite PHP ${plan.wordpress.requiresPhp} ; PHP ${plan.php}, fourni par l’hébergement, est conservé. Mise à jour du cœur différée.`);
      plan.wordpress.target = plan.wordpress.current; plan.wordpress.requiresPhp = "";
      plan.wordpress.manualReason = "La version cible du cœur exige un PHP plus récent.";
    }
  }
  for (const item of plan.plugins) {
    if (item.current === item.target) continue;
    try {
      if ((item.requiresPhp && compareWordPressVersions(plan.php, item.requiresPhp) < 0) || (item.requiresWordPress && compareWordPressVersions(plan.wordpress.target, item.requiresWordPress) < 0) || item.requiresPlugins.some(slug => !plan.plugins.some(plugin => plugin.slug === slug))) throw new Error();
    } catch {
      item.target = item.current;
      item.manualReason = "Prérequis PHP/WordPress ou extension requise non satisfaits.";
      plan.warnings.push(`${item.slug} : mise à jour différée, prérequis PHP/WordPress ou extension requise non satisfaits. La configuration de l’hébergement est conservée.`);
    }
  }
  return plan;
}

/** Public CC0 data, no account/key; cache across sites for one hour to limit service load. */
export function freeWordPressScanner(transport: typeof fetch = fetch, options: { persistentCache?: boolean } = {}) {
  const cache = new Map<string, Advisory>(), warnings: string[] = [];
  const retainedScanFailures = new Set<string>();
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  async function load(kind: "core" | "plugin" | "theme", identity: string) {
    if (!(kind === "core" ? numeric : /^[a-z0-9_-]{1,150}$/i).test(identity)) throw new ApiError("Identifiant de contrôle WordPress invalide.");
    const key = `security:wpv:4:${kind}:${identity}`;
    if (cache.has(key)) return cache.get(key)!;
    const persistent = options.persistentCache ?? transport === fetch;
    if (persistent) {
      const row = await (await hostingStorage()).prepare("SELECT data FROM wordpress_catalog WHERE cache_key=? AND expires_at>?").get(key, new Date().toISOString()) as { data: string } | undefined;
      if (row) { const parsed = advisory.safeParse(JSON.parse(row.data)); if (parsed.success) { cache.set(key, parsed.data); return parsed.data; } }
    }
    let report: Advisory;
    try {
      const response = await transport(`https://www.wpvulnerability.net/${kind}/${encodeURIComponent(identity)}/`, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error();
      const body = await response.text();
      if (Buffer.byteLength(body) > 3_000_000) throw new Error();
      report = advisory.parse(JSON.parse(body));
      if (report.data[kind] !== identity) throw new Error();
    } catch { throw new ApiError("Le contrôle gratuit WPVulnerability est indisponible ou son rapport est incomplet. Aucune mise à jour supplémentaire autorisée.", 502); }
    cache.set(key, report);
    if (persistent) await (await hostingStorage()).prepare("INSERT INTO wordpress_catalog(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at").run(key, JSON.stringify(report), new Date(Date.now() + 3600_000).toISOString());
    return report;
  }
  const prepare = async (raw: WordPressUpdatePlan) => {
    const plan = selectCompatibleWordPressUpdates(raw);
    for (const item of plan.plugins) {
      if (item.updateOrigin === "external") { item.target = item.current; item.manualReason ||= "Distribution privée ou personnalisée : origine publique non établie."; warn(`${item.slug} : ${item.manualReason} Extension conservée ; intervention manuelle requise, couverture de sécurité limitée.`); continue; }
      if (item.manualReason) { item.target = item.current; warn(`${item.slug} : ${item.manualReason} Extension conservée ; intervention manuelle requise.`); continue; }
      if (!numeric.test(item.current)) { item.target = item.current; item.manualReason ||= "Version absente ou non standard."; warn(`${item.slug} : version non standard, extension conservée et hors du contrôle de vulnérabilités.`); continue; }
      const report = await load("plugin", item.slug);
      let publicPackage = false;
      try { const url = new URL(report.data.link || ""); publicPackage = ["wordpress.org", "www.wordpress.org"].includes(url.hostname) && url.pathname.replace(/\/+$/, "") === `/plugins/${item.slug}`; } catch {}
      if (!report.data.name || report.data.closed === 1 || !publicPackage) {
        item.target = item.current;
        item.manualReason ||= "Catalogue privé, non identifié ou fermé ; téléchargement automatique non qualifié.";
        warn(`${item.slug} : catalogue privé, non identifié ou fermé ; extension conservée, couverture de sécurité limitée.`);
      }
    }
    plan.warnings.forEach(warn);
    return plan;
  };
  const scan = async (plan: WordPressUpdatePlan, candidate: boolean) => {
    const core = candidate ? plan.wordpress.target : plan.wordpress.current;
    const findings = freeWordPressFindings(await load("core", core), "core", core, core);
    for (const kind of ["plugin", "theme"] as const) for (const item of plan[`${kind}s`]) {
      if (item.updateOrigin === "external" || (kind === "theme" && item.template) || !numeric.test(item.current)) { warn(`${item.slug} : composant privé, personnalisé ou version non standard ; conservé, contrôle de sécurité manuel nécessaire.`); continue; }
      const retained = item.current === item.target && (item.manualReason || kind === "theme");
      const key = `${kind}:${item.slug}:${item.current}`;
      if (retained && retainedScanFailures.has(key)) continue;
      let report: Advisory;
      try { report = await load(kind, item.slug); }
      catch (error) {
        if (!(error instanceof ApiError) || !retained) throw error;
        retainedScanFailures.add(key);
        warn(`${item.slug} : contrôle de sécurité indisponible pour ce composant conservé. Vérification manuelle nécessaire ; les autres mises à jour restent admissibles.`);
        continue;
      }
      if (!report.data.name) { if (!warnings.some(message => message.startsWith(`${item.slug} :`))) warn(`${item.slug} : composant absent du catalogue public, couverture de sécurité limitée.`); continue; }
      findings.push(...freeWordPressFindings(report, kind, item.slug, candidate ? item.target : item.current));
    }
    return findings;
  };
  return Object.assign(scan, { prepare, warnings });
}
