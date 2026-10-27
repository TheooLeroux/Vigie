import { z } from "zod";
import { ApiError } from "../http";
import { severity } from "./security";
import { shellQuote } from "./wordpress";
import type { SecurityFinding } from "./types";

const version = z.string().regex(/^\d+(?:\.\d+){1,3}$/);
const component = z.object({ slug: z.string().regex(/^[a-z0-9_-]+$/i).max(150), current: version, target: version, requiresPhp: z.string().max(40), requiresWordPress: z.string().max(40), requiresPlugins: z.array(z.string().regex(/^[a-z0-9_-]+$/i)).max(100).default([]) });
export const wordpressPlanSchema = z.object({ wordpress: z.object({ current: version, target: version, requiresPhp: z.string().max(40).default("") }), php: version, plugins: z.array(component).max(1000), themes: z.array(component).max(300) });
export type WordPressUpdatePlan = z.infer<typeof wordpressPlanSchema>;
export function compareWordPressVersions(first: string, second: string) {
  const left = version.parse(first).split(".").map(Number), right = version.parse(second).split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
  return 0;
}
export function checkWordPressRequirements(plan: WordPressUpdatePlan) {
  if (plan.wordpress.requiresPhp && compareWordPressVersions(plan.php, plan.wordpress.requiresPhp) < 0) throw new ApiError("La nouvelle version WordPress exige un PHP plus récent. Aucun fichier n’a été modifié.");
  for (const item of [...plan.plugins, ...plan.themes]) {
    if (item.requiresPhp && compareWordPressVersions(plan.php, item.requiresPhp) < 0) throw new ApiError(`${item.slug} exige un PHP plus récent. WordPress n’a pas été modifié.`);
    if (item.requiresWordPress && compareWordPressVersions(plan.wordpress.target, item.requiresWordPress) < 0) throw new ApiError(`${item.slug} exige un WordPress plus récent. Mise à jour annulée.`);
    if (item.requiresPlugins.some(slug => !plan.plugins.some(plugin => plugin.slug === slug))) throw new ApiError(`${item.slug} dépend d’une extension absente. Mise à jour annulée.`);
  }
}
export function wordpressPlanPhp() {
  const php = `require_once ABSPATH . 'wp-admin/includes/update.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
wp_version_check(); wp_update_plugins(); wp_update_themes();
$core = get_site_transient('update_core'); $target = get_bloginfo('version'); $requiresPhp = '';
foreach (($core->updates ?? array()) as $update) { if ($update->response === 'upgrade') { $target = $update->version; $requiresPhp = $update->php_version ?? ''; break; } }
$data = array('wordpress' => array('current' => get_bloginfo('version'), 'target' => $target, 'requiresPhp' => $requiresPhp), 'php' => PHP_VERSION, 'plugins' => array(), 'themes' => array());
$updates = get_site_transient('update_plugins');
foreach (get_plugins() as $file => $headers) {
  $update = $updates->response[$file] ?? null; $slug = $update->slug ?? (dirname($file) === '.' ? basename($file, '.php') : dirname($file));
  $dependencies = $update->requires_plugins ?? ($headers['RequiresPlugins'] ?? '');
  if (is_string($dependencies)) { $dependencies = array_values(array_filter(array_map('trim', explode(',', $dependencies)))); }
  $data['plugins'][] = array('slug' => $slug, 'current' => $headers['Version'], 'target' => $update->new_version ?? $headers['Version'], 'requiresPhp' => $update->requires_php ?? ($headers['RequiresPHP'] ?? ''), 'requiresWordPress' => $update->requires ?? ($headers['RequiresWP'] ?? ''), 'requiresPlugins' => $dependencies);
}
$updates = get_site_transient('update_themes');
foreach (wp_get_themes() as $slug => $theme) {
  $update = $updates->response[$slug] ?? array();
  $data['themes'][] = array('slug' => $slug, 'current' => $theme->get('Version'), 'target' => $update['new_version'] ?? $theme->get('Version'), 'requiresPhp' => $update['requires_php'] ?? $theme->get('RequiresPHP'), 'requiresWordPress' => $update['requires'] ?? $theme->get('RequiresWP'), 'requiresPlugins' => array());
}
echo 'VIGIE_PLAN=' . base64_encode(wp_json_encode($data)) . "\\n";`;
  return php;
}
export function wordpressPlanScript(root: string) {
  return `set -eu\nwp --path=${shellQuote(root)} eval ${shellQuote(wordpressPlanPhp())}\n`;
}
export function parseWordPressPlan(output: string) {
  const encoded = output.match(/^VIGIE_PLAN=([A-Za-z0-9+/]+=*)$/m)?.[1];
  if (!encoded || encoded.length > 1_000_000) throw new ApiError("Le plan WordPress n’a pas pu être vérifié.");
  try { return wordpressPlanSchema.parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))); }
  catch { throw new ApiError("Les versions WordPress ou ses extensions ne permettent pas une validation automatique fiable."); }
}
const rangeSchema = z.object({ introduced_in: z.string().nullish(), fixed_in: z.string().nullish() });
const advisorySchema = z.object({ vulnerabilities: z.array(z.object({ id: z.union([z.string(), z.number()]), cvss: z.object({ score: z.union([z.string(), z.number()]).nullish() }).nullish(), affected_versions: z.array(rangeSchema).nullish(), introduced_in: z.string().nullish(), fixed_in: z.string().nullish() })) });
export function wordpressVulnerabilities(raw: unknown, slug: string, installed: string): SecurityFinding[] {
  const data = advisorySchema.parse(raw);
  return data.vulnerabilities.filter(item => {
    const ranges = item.affected_versions?.length ? item.affected_versions : [{ introduced_in: item.introduced_in, fixed_in: item.fixed_in }];
    return ranges.some(range => {
      try { return (!range.introduced_in || compareWordPressVersions(installed, range.introduced_in) >= 0) && (!range.fixed_in || compareWordPressVersions(installed, range.fixed_in) < 0); }
      catch { return true; }
    });
  }).map(item => {
    const id = String(item.id);
    if (!/^[a-z0-9-]{1,100}$/i.test(id)) throw new ApiError("Référence WPScan invalide.");
    return { id: `WPSCAN-${id}`, aliases: [], package: slug, version: installed, severity: severity(item.cvss?.score) };
  });
}
export function wordPressScanner(transport: typeof fetch = fetch, token = process.env.VIGIE_UPDATES_WPSCAN_TOKEN) {
  const cache = new Map<string, unknown>();
  async function advisory(kind: string, slug: string) {
    if (!token) throw new ApiError("Le contrôle WordPress nécessite le jeton WPScan sur l’exécuteur. Aucun site n’a été modifié.", 503);
    const path = kind + "/" + (kind === "wordpresses" ? slug.replaceAll(".", "") : slug);
    if (cache.has(path)) return cache.get(path);
    const response = await transport(`https://wpscan.com/api/v3/${path}`, { headers: { Authorization: `Token token=${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new ApiError(response.status === 404 ? `WPScan ne couvre pas ${slug}. Une validation dédiée est nécessaire avant la mise à jour.` : "WPScan est indisponible ou son quota est atteint. Aucune publication supplémentaire autorisée.", 502);
    const content = await response.text();
    if (content.length > 3_000_000) throw new ApiError("Rapport WPScan trop volumineux.");
    let entry;
    try { entry = advisorySchema.parse(JSON.parse(content)[slug]); } catch { throw new ApiError("Le rapport WPScan est incomplet. Aucune publication supplémentaire autorisée.", 502); }
    cache.set(path, entry);
    return entry;
  }
  return async (plan: WordPressUpdatePlan, candidate: boolean) => {
    const findings: SecurityFinding[] = [];
    for (const [kind, items] of [["wordpresses", [{ slug: candidate ? plan.wordpress.target : plan.wordpress.current, current: plan.wordpress.current, target: plan.wordpress.target }]], ["plugins", plan.plugins], ["themes", plan.themes]] as const) {
      for (const item of items) findings.push(...wordpressVulnerabilities(await advisory(kind, item.slug), kind + "/" + (kind === "wordpresses" ? "wordpress" : item.slug), candidate ? item.target : item.current));
    }
    return findings;
  };
}
