<?php
// Isolated WordPress API fixture for executing the real observer's response code.
$wp_version = '6.7.2';
define('WP_CONTENT_DIR', ABSPATH.'wp-content');
$wpdb = new class { public function db_version() { return '10.6.1'; } };
function add_action($name, $callback, $priority) { if ($name === 'wp_loaded') { $GLOBALS['fixture_theme_root'] = true; } $callback(); }
function wp_strip_all_tags($value) { return strip_tags($value); }
function get_site_option($name, $default = false) { return $default; }
function update_site_option($name, $value) { return true; }
function wp_version_check() {}
function wp_update_plugins() {}
function wp_update_themes() {}
function get_site_transient($name) { return false; }
function get_plugins() { return array('private/plugin.php' => array('Name' => 'Private', 'Version' => '1.0', 'RequiresPHP' => '7.4', 'RequiresWP' => '6.0')); }
function get_mu_plugins() { return array(); }
function is_plugin_active($file) { return true; }
function is_plugin_active_for_network($file) { return false; }
function register_theme_directory($path) { $GLOBALS['fixture_theme_root'] = true; }
function get_stylesheet() { return 'fixture-theme'; }
function get_template() { return 'fixture-theme'; }
function wp_get_themes() { if (empty($GLOBALS['fixture_theme_root'])) { return array(); } return array('fixture-theme'=>new class { public function get($field) { $data=array('Name'=>'Fixture theme','Version'=>'1.0');return isset($data[$field])?$data[$field]:''; } }); }
function get_option($name, $default = false) { $values=array('blogname'=>'Fixture site','blog_public'=>'1');return isset($values[$name])?$values[$name]:$default; }
function wp_normalize_path($path) { return str_replace('\\', '/', $path); }
function esc_url_raw($url) { return $url; }
function site_url() { return 'https://site.example.org/'; }
function home_url() { return 'https://site.example.org/'; }
function get_locale() { return 'fr_FR'; }
function wp_timezone_string() { return 'Europe/Paris'; }
function is_multisite() { return false; }
function is_ssl() { return true; }
function wp_using_ext_object_cache() { return null; }
function nocache_headers() {}
function wp_send_json($value) { header('Content-Type: application/json'); echo json_encode($value); exit; }
