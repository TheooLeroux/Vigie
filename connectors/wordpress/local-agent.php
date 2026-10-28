<?php
/** Vigie local maintenance agent. CLI only; no HTTP endpoint or arbitrary command input. */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
umask(0077);

function va_json(string $path): array {
    if (is_link($path) || !is_file($path) || filesize($path) > 524288) { throw new RuntimeException('invalid_file'); }
    $value = json_decode((string)file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($value)) { throw new RuntimeException('invalid_json'); }
    return $value;
}
function va_save(string $path, array $value): void {
    $temp = $path.'.tmp.'.bin2hex(random_bytes(8));
    if (is_link($path) || file_put_contents($temp, json_encode($value, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), LOCK_EX) === false) { throw new RuntimeException('write_failed'); }
    chmod($temp, 0600);
    if (!rename($temp, $path)) { unlink($temp); throw new RuntimeException('write_failed'); }
}
function va_envelope(array $value, string $key): array {
    $payload = base64_encode(json_encode($value, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    return ['payload' => $payload, 'signature' => hash_hmac('sha256', "vigie-agent-v1\n".$payload, hex2bin($key))];
}
function va_open(array $envelope, string $key): array {
    if (array_keys($envelope) !== ['payload', 'signature'] || !is_string($envelope['payload']) || !is_string($envelope['signature']) || strlen($envelope['payload']) > 400000 || !hash_equals(hash_hmac('sha256', "vigie-agent-v1\n".$envelope['payload'], hex2bin($key)), $envelope['signature'])) { throw new RuntimeException('invalid_signature'); }
    $decoded = base64_decode($envelope['payload'], true);
    if ($decoded === false) { throw new RuntimeException('invalid_payload'); }
    return json_decode($decoded, true, 32, JSON_THROW_ON_ERROR);
}
function va_uuid($value): bool { return is_string($value) && (bool)preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/D', $value); }
function va_version($value): bool { return is_string($value) && strlen($value) <= 80 && (bool)preg_match('/^\d+(?:\.\d+){0,7}$/D', $value); }
function va_run(array $args, int $timeout = 180, bool $captureOutput = true): string {
    $pipes = [];
    $process = proc_open($args, [['pipe','r'], $captureOutput ? ['pipe','w'] : ['file','/dev/null','w'], ['pipe','w']], $pipes, null, null, ['bypass_shell' => true]);
    if (!is_resource($process)) { throw new RuntimeException('process_unavailable'); }
    fclose($pipes[0]); if ($captureOutput) { stream_set_blocking($pipes[1], false); } stream_set_blocking($pipes[2], false);
    $output = ''; $start = time(); $exit = -1;
    try {
        do {
            if ($captureOutput) { $output .= stream_get_contents($pipes[1]); }
            stream_get_contents($pipes[2]); // Never expose raw logs, which may contain site secrets.
            if (strlen($output) > 524288 || time() - $start > $timeout) { proc_terminate($process, 9); throw new RuntimeException('process_limit'); }
            $status = proc_get_status($process);
            if (!$status['running']) { $exit = $status['exitcode']; break; }
            usleep(50000);
        } while (true);
        if ($captureOutput) { $output .= stream_get_contents($pipes[1]); }
    } finally { if ($captureOutput) { fclose($pipes[1]); } fclose($pipes[2]); $closed = proc_close($process); }
    if ($exit !== 0 && $closed !== 0) { throw new RuntimeException('command_failed'); }
    return trim($output);
}
function va_wp(array $config, array $args, int $timeout = 180): string {
    return va_run(array_merge([$config['phpBinary'], $config['wpBinary'], '--path='.$config['root'], '--no-color'], $args), $timeout);
}
function va_plan(array $config): array {
    if (hash_file('sha256', __DIR__.'/plan.php') !== $config['planSha256']) { throw new RuntimeException('plan_source_changed'); }
    $output = va_wp($config, ['eval-file', __DIR__.'/plan.php']);
    if (!preg_match('/^VIGIE_PLAN=(.+)$/m', $output, $matches)) { throw new RuntimeException('plan_unavailable'); }
    $decoded = base64_decode($matches[1], true);
    if ($decoded === false) { throw new RuntimeException('invalid_plan_encoding'); }
    return json_decode($decoded, true, 32, JSON_THROW_ON_ERROR);
}
function va_eligibility(array $config): array {
    $data = va_wp($config, ['eval', 'echo json_encode(array("multisite"=>is_multisite(),"fileModsDisabled"=>defined("DISALLOW_FILE_MODS") && DISALLOW_FILE_MODS,"home"=>home_url()));']);
    $value = json_decode($data, true, 8, JSON_THROW_ON_ERROR);
    if ($value['multisite'] || $value['fileModsDisabled']) { throw new RuntimeException('wordpress_policy'); }
    return $value;
}
function va_validate_plan(array $plan): void {
    if (!isset($plan['wordpress'], $plan['php'], $plan['plugins'], $plan['themes']) || !va_version($plan['wordpress']['current'] ?? null) || !va_version($plan['wordpress']['target'] ?? null) || !va_version($plan['php']) || count($plan['plugins']) > 1000 || count($plan['themes']) > 300) { throw new RuntimeException('invalid_plan'); }
    if (version_compare($plan['wordpress']['target'], $plan['wordpress']['current'], '<')) { throw new RuntimeException('downgrade_refused'); }
    foreach (['plugins', 'themes'] as $kind) {
        $seen = [];
        foreach ($plan[$kind] as $item) {
            if (!is_array($item) || !is_string($item['slug'] ?? null) || !preg_match('/^[a-z0-9_-]{1,150}$/iD', $item['slug']) || isset($seen[$item['slug']]) || !is_string($item['current'] ?? null) || !is_string($item['target'] ?? null) || strlen($item['current']) > 80 || strlen($item['target']) > 80 || preg_match('/[\x00-\x1f]/', $item['current'].$item['target'])) { throw new RuntimeException('invalid_component'); }
            if ($kind === 'themes' && $item['target'] !== $item['current']) { throw new RuntimeException('theme_update_refused'); }
            if ($item['target'] !== $item['current'] && (!va_version($item['current']) || !va_version($item['target']) || version_compare($item['target'], $item['current'], '<'))) { throw new RuntimeException('invalid_component'); }
            $seen[$item['slug']] = true;
        }
    }
}
function va_same_versions(array $actual, array $expected, bool $updated): void {
    $field = $updated ? 'target' : 'current';
    if ($actual['wordpress']['current'] !== $expected['wordpress'][$field] || $actual['php'] !== $expected['php']) { throw new RuntimeException('versions_changed'); }
    foreach (['plugins', 'themes'] as $kind) {
        if (count($actual[$kind]) !== count($expected[$kind])) { throw new RuntimeException('components_changed'); }
        foreach ($expected[$kind] as $item) {
            $match = array_values(array_filter($actual[$kind], static fn($v) => $v['slug'] === $item['slug']));
            if (count($match) !== 1 || $match[0]['current'] !== $item[$field]) { throw new RuntimeException('versions_changed'); }
        }
    }
}
function va_tree(string $root): int {
    $bytes = 0;
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST) as $item) {
        if ($item->isLink() || (!$item->isFile() && !$item->isDir())) { throw new RuntimeException('symlinks_or_special_files'); }
        if ($item->isFile()) { $bytes += $item->getSize(); }
    }
    return $bytes;
}
function va_backup(array $config, string $run): array {
    $folder = __DIR__.'/backups/'.$run;
    if (file_exists($folder) || is_link($folder) || file_exists($config['root'].'/.maintenance')) { throw new RuntimeException('backup_or_maintenance_exists'); }
    $bytes = va_tree($config['root']);
    if (disk_free_space(__DIR__) < $bytes * 3 + 104857600) { throw new RuntimeException('disk_space'); }
    mkdir($folder, 0700);
    // Maintenance limits web writes, but does not fence external integrations.
    va_wp($config, ['maintenance-mode', 'activate']);
    try {
        va_wp($config, ['db', 'check']);
        va_wp($config, ['db', 'export', $folder.'/database.sql', '--single-transaction', '--quick', '--add-drop-table'], 300);
        va_run(['/bin/tar', '-czf', $folder.'/files.tar.gz', '--exclude=./.maintenance', '-C', $config['root'], '.'], 300);
        // Validate every archive entry and the exit status without buffering a potentially huge file list.
        va_run(['/bin/tar', '-tzf', $folder.'/files.tar.gz'], 120, false);
        if (!is_file($folder.'/database.sql') || filesize($folder.'/database.sql') === 0) { throw new RuntimeException('empty_database_backup'); }
        $manifest = ['root' => $config['root'], 'runId' => $run, 'createdAt' => time(), 'files' => hash_file('sha256', $folder.'/files.tar.gz'), 'database' => hash_file('sha256', $folder.'/database.sql')];
        va_save($folder.'/manifest.json', va_envelope($manifest, $config['secret']));
        return ['backup' => $folder, 'manifest' => $manifest];
    } finally { va_wp($config, ['maintenance-mode', 'deactivate']); }
}
function va_verify_backup(array $config, string $run): array {
    $folder = __DIR__.'/backups/'.$run;
    if (is_link($folder) || realpath($folder) !== $folder) { throw new RuntimeException('invalid_backup'); }
    $manifest = va_open(va_json($folder.'/manifest.json'), $config['secret']);
    if ($manifest['root'] !== $config['root'] || $manifest['runId'] !== $run || !hash_equals($manifest['files'], hash_file('sha256', $folder.'/files.tar.gz')) || !hash_equals($manifest['database'], hash_file('sha256', $folder.'/database.sql'))) { throw new RuntimeException('backup_changed'); }
    return $manifest;
}
function va_update(array $config, array $job): array {
    if (file_exists($config['root'].'/.maintenance')) { throw new RuntimeException('maintenance_exists'); }
    $plan = $job['plan'] ?? [];
    va_validate_plan($plan);
    if ($plan['php'] !== PHP_VERSION || ($job['webPhp'] ?? null) !== PHP_VERSION) { throw new RuntimeException('php_mismatch'); }
    va_same_versions(va_plan($config), $plan, false);
    va_verify_backup($config, $job['runId']);
    va_wp($config, ['maintenance-mode', 'activate']);
    try {
        if ($plan['wordpress']['current'] !== $plan['wordpress']['target']) { va_wp($config, ['core','update','--version='.$plan['wordpress']['target']], 300); }
        va_wp($config, ['core','update-db']);
        foreach ($plan['plugins'] as $item) {
            if ($item['current'] !== $item['target']) { va_wp($config, ['plugin','update',$item['slug'],'--version='.$item['target']], 300); }
        }
        va_wp($config, ['core','verify-checksums']);
        va_wp($config, ['cache','flush']);
    } finally {
        // This removal does not need WordPress to boot after a fatal plugin error.
        if (is_file($config['root'].'/.maintenance') && !is_link($config['root'].'/.maintenance')) { unlink($config['root'].'/.maintenance'); }
    }
    $installed = va_plan($config); va_same_versions($installed, $plan, true);
    return ['plan' => $installed, 'backup' => __DIR__.'/backups/'.$job['runId']];
}
function va_restore(array $config, array $job): array {
    // Full data restoration is explicitly requested, never an automatic failure handler.
    if (($job['confirmDataLoss'] ?? false) !== true || ($config['environment'] ?? null) !== 'staging') { throw new RuntimeException('restore_requires_staging_confirmation'); }
    va_verify_backup($config, $job['runId']);
    $folder = __DIR__.'/backups/'.$job['runId']; $restore = __DIR__.'/restore-'.$job['id']; $quarantine = __DIR__.'/quarantine-'.$job['id'];
    if (file_exists($restore) || file_exists($quarantine)) { throw new RuntimeException('restore_exists'); }
    mkdir($restore, 0700);
    va_run(['/bin/tar','-xzf',$folder.'/files.tar.gz','--no-same-owner','-C',$restore], 300);
    va_tree($restore);
    // Swapping directories also removes files introduced by the failed update.
    if (!rename($config['root'], $quarantine)) { throw new RuntimeException('quarantine_failed'); }
    if (!rename($restore, $config['root'])) { rename($quarantine, $config['root']); throw new RuntimeException('restore_failed'); }
    file_put_contents($config['root'].'/.maintenance', '<?php $upgrading = '.time().';');
    va_wp($config, ['db','import',$folder.'/database.sql'], 300);
    unlink($config['root'].'/.maintenance');
    return ['restored' => true, 'quarantine' => $quarantine, 'backup' => $folder];
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') !== __FILE__) { return; }
$lock = null;
try {
    if (($argv[1] ?? '') !== __DIR__.'/config.json') { throw new RuntimeException('config_path'); }
    $config = va_json(__DIR__.'/config.json');
    if (($config['protocol'] ?? '') !== 'vigie-local-v1' || !preg_match('/^[a-f0-9]{64}$/D', $config['secret'] ?? '') || !preg_match('#^/home/[a-zA-Z0-9_-]+/.+#D', $config['root'] ?? '') || realpath($config['root']) !== $config['root'] || str_starts_with(__DIR__.'/', $config['root'].'/') || (fileperms(__DIR__) & 0077) !== 0 || !in_array($config['environment'] ?? '', ['staging','production'], true)) { throw new RuntimeException('invalid_config'); }
    if (hash_file('sha256', __FILE__) !== $config['workerSha256'] || realpath($config['phpBinary']) !== realpath(PHP_BINARY) || !is_file($config['wpBinary']) || !is_executable($config['phpBinary'])) { throw new RuntimeException('runtime_changed'); }
    $lock = fopen(__DIR__.'/agent.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { exit(0); }
    va_save(__DIR__.'/heartbeat.json', va_envelope(['protocol'=>'vigie-local-v1','root'=>$config['root'],'php'=>PHP_VERSION,'time'=>time()], $config['secret']));
    foreach (glob(__DIR__.'/jobs/*.json') ?: [] as $file) {
        $id = basename($file, '.json'); if (!va_uuid($id)) { continue; }
        $statusFile = __DIR__.'/results/'.$id.'.json';
        if (file_exists($statusFile)) { continue; } // Includes interrupted/failed requests: no implicit retry.
        try {
            $job = va_open(va_json($file), $config['secret']);
            if (($job['id'] ?? null) !== $id || !va_uuid($job['runId'] ?? null) || ($job['root'] ?? null) !== $config['root'] || !is_int($job['issuedAt'] ?? null) || abs(time()-$job['issuedAt']) > 900 || !in_array($job['operation'] ?? '', ['inspect','backup','update','restore'], true)) { throw new RuntimeException('invalid_job'); }
        } catch (Throwable $error) { continue; } // Partial/unauthenticated uploads cannot consume an operation ID.
        $status = ['id'=>$id,'runId'=>$job['runId'],'operation'=>$job['operation'],'root'=>$config['root'],'stage'=>'running','startedAt'=>time()];
        va_save($statusFile, va_envelope($status, $config['secret']));
        try {
            if ($job['operation'] !== 'restore') { va_wp($config, ['core','is-installed']); va_eligibility($config); }
            if ($job['operation'] === 'inspect') {
                $plan = va_plan($config); va_validate_plan($plan);
                $result = ['plan'=>$plan,'eligibility'=>va_eligibility($config),'php'=>PHP_VERSION];
            } elseif ($job['operation'] === 'backup') {
                if (($job['webPhp'] ?? null) !== PHP_VERSION) { throw new RuntimeException('php_mismatch'); }
                $result = va_backup($config, $job['runId']);
            } elseif ($job['operation'] === 'update') { $result = va_update($config, $job); }
            else { $result = va_restore($config, $job); }
            $status['stage']='completed'; $status['result']=$result;
        } catch (Throwable $error) {
            $status['stage']='failed';
            // Only our bounded error codes leave the account; PHP/CLI logs never do.
            $code=$error->getMessage(); $status['error']=preg_match('/^[a-z_]{1,80}$/D',$code)?$code:'agent_failed';
        }
        $status['finishedAt']=time(); va_save($statusFile, va_envelope($status,$config['secret']));
        break; // One job per tick; bounded account load.
    }
} catch (Throwable $error) { fwrite(STDERR, "Vigie local agent unavailable\n"); exit(1); }
finally { if (is_resource($lock)) { flock($lock, LOCK_UN); fclose($lock); } }
