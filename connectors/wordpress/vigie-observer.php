<?php
/**
 * Plugin Name: Vigie — Inventaire
 * Description: Inventaire privé en lecture seule pour le plateau interne Vigie.
 * Version: 1.0.3
 * Requires PHP: 7.4
 */
if (!defined('ABSPATH')) { exit; }
// Ordinary requests do not register hooks, query options or contact Vigie.
if (!isset($_GET['vigie_observer']) || $_GET['vigie_observer'] !== 'v1') { return; }

$vigie_observer_key = '__VIGIE_SECRET_HEX__';
$vigie_observer_time = isset($_SERVER['HTTP_X_VIGIE_TIME']) ? $_SERVER['HTTP_X_VIGIE_TIME'] : '';
$vigie_observer_nonce = isset($_SERVER['HTTP_X_VIGIE_NONCE']) ? $_SERVER['HTTP_X_VIGIE_NONCE'] : '';
$vigie_observer_signature = isset($_SERVER['HTTP_X_VIGIE_SIGNATURE']) ? $_SERVER['HTTP_X_VIGIE_SIGNATURE'] : '';
$vigie_observer_body = file_get_contents('php://input', false, null, 0, 4097);
if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !preg_match('/^[0-9]{10}$/D', $vigie_observer_time)
    || abs(time() - (int)$vigie_observer_time) > 120 || !preg_match('/^[a-f0-9]{32}$/D', $vigie_observer_nonce)
    || strlen($vigie_observer_body) > 4096 || !preg_match('/^[a-f0-9]{64}$/D', $vigie_observer_key)
    || !hash_equals(hash_hmac('sha256', "v1\n".$vigie_observer_time."\n".$vigie_observer_nonce."\n".$vigie_observer_body, hex2bin($vigie_observer_key)), $vigie_observer_signature)) {
    http_response_code(404); header('Cache-Control: no-store'); exit;
}
$vigie_observer_request = json_decode($vigie_observer_body, true);
if (!is_array($vigie_observer_request) || !isset($vigie_observer_request['refresh']) || !is_bool($vigie_observer_request['refresh'])
    || array_diff(array_keys($vigie_observer_request), array('refresh', 'mode'))
    || (isset($vigie_observer_request['mode']) && $vigie_observer_request['mode'] !== 'early')) {
    http_response_code(400); header('Cache-Control: no-store'); exit;
}
// Drop the key from request scope before loading the site's other extensions.
unset($vigie_observer_key, $vigie_observer_signature, $vigie_observer_body);
$vigie_observer_early = isset($vigie_observer_request['mode']) && $vigie_observer_request['mode'] === 'early';
add_action($vigie_observer_early ? 'muplugins_loaded' : 'wp_loaded', static function () use ($vigie_observer_nonce, $vigie_observer_request, $vigie_observer_early) {
    global $wp_version, $wpdb;
    require_once ABSPATH.'wp-admin/includes/plugin.php';
    require_once ABSPATH.'wp-admin/includes/update.php';
    require_once ABSPATH.'wp-includes/update.php';
    // WordPress normally registers the theme root after muplugins_loaded.
    if ($vigie_observer_early) { register_theme_directory(WP_CONTENT_DIR.'/themes'); }
    // These functions check update feeds and cache results; they never install updates.
    if (!$vigie_observer_early && $vigie_observer_request['refresh'] && time() - (int)get_site_option('_vigie_observer_last_refresh', 0) > 900) {
        update_site_option('_vigie_observer_last_refresh', time());
        wp_version_check(); wp_update_plugins(); wp_update_themes();
    }
    $plugin_updates = get_site_transient('update_plugins');
    $theme_updates = get_site_transient('update_themes');
    $core_updates = get_site_transient('update_core');
    $clean = static function ($value) { return is_scalar($value) ? substr(wp_strip_all_tags((string)$value), 0, 500) : ''; };
    $update = static function ($cache, $id, $version) use ($clean) {
        $cache = (array)$cache;
        $available = isset($cache['response'][$id]) ? (array)$cache['response'][$id] : array();
        $current = isset($cache['no_update'][$id]) ? (array)$cache['no_update'][$id] : array();
        $latest = isset($available['new_version']) ? $available['new_version'] : (isset($current['new_version']) ? $current['new_version'] : '');
        $checked = isset($cache['checked'][$id]) && (string)$cache['checked'][$id] === (string)$version && !empty($cache['last_checked']);
        return array('latestVersion' => $clean($latest) ?: null, 'updateCheckedAt' => $checked ? gmdate('c', (int)$cache['last_checked']) : null, 'updateSource' => 'wordpress', 'updateState' => $checked && $latest ? (version_compare($latest, $version, '>') ? 'available' : (version_compare($latest, $version, '=') ? 'current' : 'ahead')) : 'unknown');
    };
    $plugins = array(); $automatic_plugins = (array)get_site_option('auto_update_plugins', array());
    foreach (get_plugins() as $file => $meta) {
        $plugins[] = array_merge(array('file' => $clean($file), 'slug' => $clean(dirname($file) === '.' ? basename($file, '.php') : dirname($file)), 'name' => $clean($meta['Name']), 'version' => $clean($meta['Version']) ?: null, 'active' => is_plugin_active($file) || is_plugin_active_for_network($file), 'mustUse' => false, 'autoUpdate' => in_array($file, $automatic_plugins, true), 'requiresPhp' => $clean(isset($meta['RequiresPHP']) ? $meta['RequiresPHP'] : '') ?: null, 'requiresWordPress' => $clean(isset($meta['RequiresWP']) ? $meta['RequiresWP'] : '') ?: null, 'template' => null), $update($plugin_updates, $file, $meta['Version']));
    }
    foreach (get_mu_plugins() as $file => $meta) {
        $plugins[] = array('file' => $clean($file), 'slug' => $clean(basename($file, '.php')), 'name' => $clean($meta['Name']), 'version' => $clean($meta['Version']) ?: null, 'active' => true, 'mustUse' => true, 'autoUpdate' => null, 'requiresPhp' => $clean(isset($meta['RequiresPHP']) ? $meta['RequiresPHP'] : '') ?: null, 'requiresWordPress' => null, 'template' => null, 'latestVersion' => null, 'updateCheckedAt' => null, 'updateSource' => 'wordpress', 'updateState' => 'unknown');
    }
    $themes = array(); $automatic_themes = (array)get_site_option('auto_update_themes', array());
    foreach (wp_get_themes() as $slug => $theme) {
        $themes[] = array_merge(array('file' => $clean($slug).'/style.css', 'slug' => $clean($slug), 'name' => $clean($theme->get('Name')), 'version' => $clean($theme->get('Version')) ?: null, 'active' => $slug === get_stylesheet() || $slug === get_template(), 'mustUse' => false, 'autoUpdate' => in_array($slug, $automatic_themes, true), 'requiresPhp' => $clean($theme->get('RequiresPHP')) ?: null, 'requiresWordPress' => $clean($theme->get('RequiresWP')) ?: null, 'template' => $clean($theme->get('Template')) ?: null), $update($theme_updates, $slug, $theme->get('Version')));
    }
    $latest_core = null; $core_state = 'unknown';
    if (is_object($core_updates) && isset($core_updates->version_checked) && $core_updates->version_checked === $wp_version && !empty($core_updates->last_checked)) {
        foreach ((array)(isset($core_updates->updates) ? $core_updates->updates : array()) as $offer) {
            if (is_object($offer) && isset($offer->current, $offer->response) && in_array($offer->response, array('upgrade', 'latest'), true)) {
                if ($latest_core === null || version_compare($offer->current, $latest_core, '>')) { $latest_core = $clean($offer->current); }
            }
        }
        if ($latest_core) { $core_state = version_compare($latest_core, $wp_version, '>') ? 'available' : (version_compare($latest_core, $wp_version, '=') ? 'current' : 'ahead'); }
    }
    $limits = array(); foreach (array('memory_limit', 'max_execution_time', 'max_input_vars', 'upload_max_filesize', 'post_max_size', 'display_errors') as $name) { $limits[$name] = $clean(ini_get($name)); }
    $payload = array('format' => 'vigie.wordpress.v1', 'collectionMode' => $vigie_observer_early ? 'early' : 'normal', 'nonce' => $vigie_observer_nonce, 'collectedAt' => gmdate('c'), 'documentRoot' => rtrim(wp_normalize_path(ABSPATH), '/'),
        'wordpress' => array('version' => $clean($wp_version), 'latestVersion' => $latest_core, 'updateState' => $core_state, 'updateCheckedAt' => is_object($core_updates) && !empty($core_updates->last_checked) ? gmdate('c', (int)$core_updates->last_checked) : null, 'updateSource' => 'wordpress'),
        'php' => array('version' => PHP_VERSION, 'scope' => 'web', 'sapi' => PHP_SAPI, 'limits' => $limits, 'extensions' => array_values(get_loaded_extensions())),
        'site' => array('name' => $clean(get_option('blogname')), 'url' => esc_url_raw(site_url()), 'home' => esc_url_raw(home_url()), 'locale' => $clean(get_locale()), 'timezone' => $clean(wp_timezone_string()), 'multisite' => is_multisite(), 'searchEnginesVisible' => (bool)get_option('blog_public'), 'https' => is_ssl()),
        'configuration' => array('debug' => defined('WP_DEBUG') && (bool)WP_DEBUG, 'debugDisplay' => defined('WP_DEBUG_DISPLAY') && (bool)WP_DEBUG_DISPLAY, 'cronDisabled' => defined('DISABLE_WP_CRON') && (bool)DISABLE_WP_CRON, 'fileEditDisabled' => defined('DISALLOW_FILE_EDIT') && (bool)DISALLOW_FILE_EDIT, 'fileModsDisabled' => defined('DISALLOW_FILE_MODS') && (bool)DISALLOW_FILE_MODS, 'pageCache' => defined('WP_CACHE') && (bool)WP_CACHE, 'objectCache' => (bool)wp_using_ext_object_cache()),
        'database' => array('version' => $clean($wpdb->db_version())), 'plugins' => $plugins, 'themes' => $themes);
    nocache_headers(); header('Cache-Control: private, no-store, max-age=0'); header('X-Robots-Tag: noindex, nofollow');
    wp_send_json($payload);
}, -9999);
