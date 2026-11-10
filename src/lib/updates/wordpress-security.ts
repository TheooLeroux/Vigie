import { z } from "zod";
import { ApiError } from "../http";
import { severity } from "./security";
import { shellQuote } from "./wordpress";
import type { SecurityFinding } from "./types";

const version = z.string().max(80).regex(/^\d+(?:\.\d+){0,7}$/);
export const wordpressPluginSlug = z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,149}$/i);
const component = z.object({ slug: z.string().regex(/^[a-z0-9_-]+$/i).max(150), current: z.string().max(80).regex(/^[^\x00-\x1f]*$/), target: z.string().max(80).regex(/^[^\x00-\x1f]*$/), requiresPhp: z.string().max(40), requiresWordPress: z.string().max(40), requiresPlugins: z.array(z.string().regex(/^[a-z0-9_-]+$/i)).max(100).default([]), updateOrigin: z.enum(["wordpress.org", "external", "unknown"]).optional(), manualReason: z.string().max(500).optional(), closed: z.literal(true).optional(), template: z.string().max(150).optional(), officialOffer: z.object({ source: z.enum(["wordpress.org", "vendor"]), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).optional() });
export const wordpressPlanSchema = z.object({ wordpress: z.object({ current: version, target: version, requiresPhp: z.string().max(40).default(""), manualReason: z.string().max(500).optional(), integrity: z.enum(["verified", "unverified"]).optional() }), php: version, plugins: z.array(component).max(1000), themes: z.array(component).max(300), warnings: z.array(z.string().max(500)).max(1500).default([]), licenses: z.array(z.object({ component: z.enum(["wp-rocket", "Divi"]), status: z.enum(["active", "expired", "disconnected", "unknown"]) })).max(2).optional(), removePlugins: z.array(wordpressPluginSlug).max(1000).optional(), removalDependencies: z.array(wordpressPluginSlug).max(1000).optional() }).superRefine((plan, context) => {
  for (const item of plan.plugins) if (item.current !== item.target && (!version.safeParse(item.current).success || !version.safeParse(item.target).success || compareWordPressVersions(item.target, item.current) < 0)) context.addIssue({ code: "custom", message: "Version d’extension non admissible.", path: ["plugins"] });
  for (const item of plan.themes) if (item.current !== item.target && (!item.officialOffer || !version.safeParse(item.current).success || !version.safeParse(item.target).success || compareWordPressVersions(item.target, item.current) <= 0)) context.addIssue({ code: "custom", message: "Mise à jour de thème non admissible.", path: ["themes"] });
});
export type WordPressUpdatePlan = z.infer<typeof wordpressPlanSchema>;
export function compareWordPressVersions(first: string, second: string) {
  const left = version.parse(first).split(".").map(Number), right = version.parse(second).split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
  return 0;
}
export function checkWordPressRequirements(plan: WordPressUpdatePlan) {
  if (plan.wordpress.requiresPhp && compareWordPressVersions(plan.php, plan.wordpress.requiresPhp) < 0) throw new ApiError("La nouvelle version WordPress exige un PHP plus récent. Aucun fichier n’a été modifié.");
  for (const item of [...plan.plugins, ...plan.themes].filter(item => item.current !== item.target)) {
    if (item.requiresPhp && compareWordPressVersions(plan.php, item.requiresPhp) < 0) throw new ApiError(`${item.slug} exige un PHP plus récent. WordPress n’a pas été modifié.`);
    if (item.requiresWordPress && compareWordPressVersions(plan.wordpress.target, item.requiresWordPress) < 0) throw new ApiError(`${item.slug} exige un WordPress plus récent. Mise à jour annulée.`);
    if (item.requiresPlugins.some(slug => !plan.plugins.some(plugin => plugin.slug === slug))) throw new ApiError(`${item.slug} dépend d’une extension absente. Mise à jour annulée.`);
  }
}
export function wordpressPlanPhp() {
  const php = `require_once ABSPATH . 'wp-admin/includes/update.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
// Older Divi loads the vendor updater only in wp-admin or cron. Enable its
// updater after CLI bootstrap, without running the admin menus or cron jobs.
if (get_template() === 'Divi' && defined('ET_CORE_URL') && function_exists('et_core_enable_automatic_updates') && !isset($GLOBALS['et_core_updates'])) {
  if (!defined('DOING_CRON')) { define('DOING_CRON', true); }
  et_core_enable_automatic_updates('', wp_get_theme('Divi')->get('Version'));
}
$pluginSlug = static fn($file) => dirname($file) === '.' ? basename($file, '.php') : dirname($file);
$officialOffer = static function ($kind, $slug, $offer) {
  $offer = (array)$offer;
  $package = $offer['package'] ?? '';
  $url = is_string($package) ? wp_parse_url($package) : false;
  if (!$url || ($url['scheme'] ?? '') !== 'https' || isset($url['user']) || isset($url['pass']) || (isset($url['port']) && $url['port'] !== 443)) { return null; }
  $host = strtolower($url['host'] ?? '');
  $path = $url['path'] ?? '';
  $public = $host === 'downloads.wordpress.org' && preg_match('#^/'.($kind === 'plugin' ? 'plugin' : 'theme').'/'.preg_quote($slug, '#').'(?:[.][a-zA-Z0-9._-]+)?[.]zip$#D', $path);
  $vendor = ($kind === 'plugin' && $slug === 'wp-rocket' && in_array($host, array('wp-rocket.me', 'api.wp-rocket.me'), true))
    || ($kind === 'theme' && $slug === 'Divi' && in_array($host, array('elegantthemes.com', 'www.elegantthemes.com', 'api.elegantthemes.com', 'cdn.elegantthemes.com'), true));
  if (!$public && !$vendor) { return null; }
  return array('source' => $public ? 'wordpress.org' : 'vendor', 'fingerprint' => hash('sha256', $package));
};
if (($args[0] ?? '') === 'apply-offer') {
  [, $kind, $slug, $target, $fingerprint] = $args;
  if (!in_array($kind, array('plugin', 'theme'), true)) { WP_CLI::error('invalid_update_kind'); }
  $file = $slug;
  if ($kind === 'plugin') {
    $matches = array_values(array_filter(array_keys(get_plugins()), static fn($file) => $pluginSlug($file) === $slug));
    if (count($matches) !== 1) { WP_CLI::error('component_not_found'); }
    $file = $matches[0];
  }
  if ($kind === 'plugin') { wp_update_plugins(); } else { wp_update_themes(); }
  $offer = (array)(get_site_transient('update_'.$kind.'s')->response[$file] ?? null);
  $trusted = $officialOffer($kind, $slug, $offer);
  if (!$trusted || $trusted['fingerprint'] !== $fingerprint || ($offer['new_version'] ?? '') !== $target) { WP_CLI::error('official_offer_changed'); }
  require_once ABSPATH . 'wp-admin/includes/file.php';
  require_once ABSPATH . 'wp-admin/includes/misc.php';
  require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
  add_filter('upgrader_pre_download', static function ($reply, $package) use ($fingerprint) {
    return hash_equals($fingerprint, hash('sha256', $package)) ? $reply : new WP_Error('official_offer_changed');
  }, PHP_INT_MAX, 2);
  $skin = new Automatic_Upgrader_Skin();
  $upgrader = $kind === 'plugin' ? new Plugin_Upgrader($skin) : new Theme_Upgrader($skin);
  if ($upgrader->upgrade($file, array('clear_update_cache' => false)) !== true) { WP_CLI::error('component_update_failed'); }
  return;
}
wp_version_check(); wp_update_plugins(); wp_update_themes();
$core = get_site_transient('update_core'); $target = get_bloginfo('version'); $requiresPhp = '';
foreach (($core->updates ?? array()) as $update) { if ($update->response === 'upgrade') { $target = $update->version; $requiresPhp = $update->php_version ?? ''; break; } }
$data = array('wordpress' => array('current' => get_bloginfo('version'), 'target' => $target, 'requiresPhp' => $requiresPhp), 'php' => PHP_VERSION, 'plugins' => array(), 'themes' => array(), 'warnings' => array(), 'licenses' => array(), 'removalDependencies' => array());
$declaredDependencies = static function ($headers) {
  $slugs = array_map('trim', explode(',', $headers['RequiresPlugins'] ?? ''));
  return array_filter($slugs, static fn($slug) => preg_match('/^[a-z0-9_][a-z0-9_-]{0,149}$/iD', $slug));
};
foreach (get_mu_plugins() as $file => $_headers) {
  $headers = get_file_data(WPMU_PLUGIN_DIR.'/'.$file, array('RequiresPlugins' => 'Requires Plugins'));
  $data['removalDependencies'] = array_merge($data['removalDependencies'], $declaredDependencies($headers));
}
$check = WP_CLI::runcommand('core verify-checksums --quiet', array('return' => 'all', 'exit_error' => false));
$data['wordpress']['integrity'] = 'verified';
if ($check->return_code !== 0 || trim($check->stderr) !== '' || trim($check->stdout) !== '') {
    $data['wordpress']['integrity'] = 'unverified';
    $data['wordpress']['target'] = $data['wordpress']['current']; $data['wordpress']['requiresPhp'] = '';
    $data['wordpress']['manualReason'] = 'Fichiers du cœur personnalisés ou intégrité non vérifiable : intervention manuelle requise.';
    $data['warnings'][] = 'WordPress : '.$data['wordpress']['manualReason'];
}
$origin = static function ($uri, $slug, $kind) {
  $uri = rtrim(trim((string)$uri), '/');
  if ($uri === '') { return 'unknown'; }
  return in_array($uri, array('https://wordpress.org/'.$kind.'s/'.$slug, 'http://wordpress.org/'.$kind.'s/'.$slug, 'w.org/'.$kind.'/'.$slug), true) ? 'wordpress.org' : 'external';
};
$updates = get_site_transient('update_plugins');
foreach (get_plugins() as $file => $headers) {
  $update = $updates->response[$file] ?? null; $slug = $pluginSlug($file);
  $data['removalDependencies'] = array_merge($data['removalDependencies'], $declaredDependencies($headers));
  $dependencies = $update->requires_plugins ?? ($headers['RequiresPlugins'] ?? '');
  if (is_string($dependencies)) { $dependencies = array_values(array_filter(array_map('trim', explode(',', $dependencies)))); }
  $current = (string)$headers['Version']; $next = $update->new_version ?? $current;
  if (!preg_match('/^\\d+(?:\\.\\d+){0,7}$/D', $current) || !preg_match('/^\\d+(?:\\.\\d+){0,7}$/D', $next)) { $next = $current; $data['warnings'][] = $slug . ' : version absente ou non standard, extension conservée.'; }
  $source = $origin($headers['UpdateURI'] ?? '', $slug, 'plugin'); $manual = '';
  $official = $officialOffer('plugin', $slug, $update);
  if ($slug === 'wp-rocket') {
    $missing = function_exists('get_rocket_option') && !get_rocket_option('consumer_key') && !get_rocket_option('consumer_email')
      && !defined('WP_ROCKET_KEY') && !defined('WP_ROCKET_EMAIL');
    $status = ($official['source'] ?? '') === 'vendor' ? 'active' : ($missing ? 'disconnected' : 'unknown');
    $data['licenses'][] = array('component' => 'wp-rocket', 'status' => $status);
    if ($status === 'disconnected') { $manual = 'WP Rocket ne dispose pas des identifiants de licence attendus et ne fournit pas de paquet officiel.'; }
  }
  if ($next !== $current && (!$official || ($source === 'external' && $official['source'] !== 'vendor'))) { $manual = 'Aucun paquet officiel vérifié pour la mise à jour proposée.'; }
  elseif ($next !== $current && $official['source'] === 'wordpress.org' && preg_match('/^[a-z0-9_-]{1,150}$/iD', $slug)) {
    // A skipped verification (e.g. no published checksums) is not proof of integrity.
    $check = WP_CLI::runcommand('plugin verify-checksums '.escapeshellarg($slug).' --version='.escapeshellarg($current).' --strict --format=json', array('return' => 'all', 'exit_error' => false));
    if ($check->return_code !== 0 || trim($check->stderr) !== '' || trim($check->stdout) !== 'Success: Verified 1 of 1 plugins.') { $manual = 'Fichiers personnalisés ou intégrité non vérifiable : faire vérifier les différences avant mise à jour.'; }
  }
  if ($manual !== '') { $next = $current; }
  $entry = array('slug' => $slug, 'current' => $current, 'target' => $next, 'requiresPhp' => $update->requires_php ?? ($headers['RequiresPHP'] ?? ''), 'requiresWordPress' => $update->requires ?? ($headers['RequiresWP'] ?? ''), 'requiresPlugins' => $dependencies, 'updateOrigin' => $source, 'manualReason' => $manual);
  if ($next !== $current) { $entry['officialOffer'] = $official; }
  $data['plugins'][] = $entry;
}
$themeUpdates = get_site_transient('update_themes');
foreach (wp_get_themes() as $slug => $theme) {
  $update = (array)($themeUpdates->response[$slug] ?? null);
  $current = (string)$theme->get('Version'); $target = $update['new_version'] ?? $current;
  $source = $origin($theme->get('UpdateURI'), $slug, 'theme');
  $official = $officialOffer('theme', $slug, $update);
  if ($slug === 'Divi') {
    $account = get_site_option('et_account_status');
    $settings = (array)get_site_option('et_automatic_updates_options', get_option('et_automatic_updates_options', array()));
    $status = $account === 'expired' ? 'expired' : (($official['source'] ?? '') === 'vendor' ? 'active'
      : (empty($settings['username']) && empty($settings['api_key']) ? 'disconnected' : 'unknown'));
    $data['licenses'][] = array('component' => 'Divi', 'status' => $status);
  }
  $entry = array('slug' => $slug, 'current' => $current, 'target' => $current, 'requiresPhp' => $update['requires_php'] ?? '', 'requiresWordPress' => $update['requires'] ?? '', 'requiresPlugins' => array(), 'updateOrigin' => $source, 'template' => (string)$theme->get('Template'));
  if ($target !== $current && $official && ($source !== 'external' || $official['source'] === 'vendor') && preg_match('/^\\d+(?:\\.\\d+){0,7}$/D', $current) && preg_match('/^\\d+(?:\\.\\d+){0,7}$/D', $target) && version_compare($target, $current, '>')) {
    $entry['target'] = $target;
    $entry['officialOffer'] = $official;
  } elseif ($slug === 'Divi' && $status === 'expired') {
    $entry['manualReason'] = 'Elegant Themes signale un abonnement expiré et ne fournit pas le paquet Divi. Renouvelez ou reconnectez un abonnement actif.';
  }
  $data['themes'][] = $entry;
}
$data['removalDependencies'] = array_values(array_unique($data['removalDependencies']));
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
