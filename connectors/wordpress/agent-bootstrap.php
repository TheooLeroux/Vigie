<?php
/** Private CLI launcher; keep WordPress web PHP configuration untouched. */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
// WP-CLI is a Phar. CloudLinux can omit this module from the selected CLI PHP.
// Only child CLI processes inherit the extra scan directory; retain existing ini files.
if (!extension_loaded('phar')) {
    $scan = getenv('PHP_INI_SCAN_DIR');
    putenv('PHP_INI_SCAN_DIR=' . ($scan === false ? '' : $scan) . PATH_SEPARATOR . __DIR__ . '/php.d');
}
// Installation qualifies the runtime, independently of component update plans.
// Import helpers without entering the worker; updates retain their full validation.
require __DIR__ . '/agent.php';
try {
    $config = va_json(__DIR__ . '/config.json');
    if (($argv[1] ?? '') !== __DIR__ . '/config.json' || ($config['protocol'] ?? '') !== 'vigie-local-v1' || !preg_match('/^[a-f0-9]{64}$/D', $config['secret'] ?? '') || !preg_match('#^/home/[a-zA-Z0-9_-]+/.+#D', $config['root'] ?? '') || realpath($config['root']) !== $config['root'] || str_starts_with(__DIR__ . '/', $config['root'] . '/') || (fileperms(__DIR__) & 0077) !== 0 || hash_file('sha256', __DIR__ . '/agent.php') !== $config['workerSha256'] || realpath($config['phpBinary']) !== realpath(PHP_BINARY)) { throw new RuntimeException('invalid_config'); }
    $lock = fopen(__DIR__ . '/agent.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { exit(0); }
    try {
        $path = __DIR__ . '/readiness.json';
        if (!is_file($path) || filemtime($path) < filemtime(__DIR__ . '/config.json')) {
            $result = ['protocol' => 'vigie-local-v1', 'root' => $config['root'], 'php' => PHP_VERSION, 'ready' => false];
            try {
                va_wp($config, ['core', 'is-installed']);
                $result['eligibility'] = va_eligibility($config);
                $result['ready'] = true;
            } catch (Throwable $error) {
                $code = $error->getMessage();
                $result['error'] = preg_match('/^[a-z_]{1,80}$/D', $code) ? $code : 'wordpress_probe_failed';
            }
            $result['time'] = time();
            va_save($path, va_envelope($result, $config['secret']));
        }
    } finally { flock($lock, LOCK_UN); fclose($lock); }
} catch (Throwable $error) { fwrite(STDERR, "Vigie launcher unavailable\n"); exit(1); }
// Execute the worker as the main script, preserving its direct-entry guard.
$process = proc_open([PHP_BINARY, __DIR__ . '/agent.php', $argv[1] ?? ''], [STDIN, STDOUT, STDERR], $pipes, null, null, ['bypass_shell' => true]);
if (!is_resource($process)) { exit(1); }
exit(proc_close($process));
