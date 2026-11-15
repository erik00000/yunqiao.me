<?php
declare(strict_types=1);
/** Real multi-process regression for public ping versus release/password updates. */
if (($argv[1] ?? '') === '--worker') {
    require $argv[2] . '/lib.php';
    $role = $argv[3];
    $iterations = (int)$argv[4];
    for ($i = 0; $i < $iterations; $i++) {
        if ($role === 'analytics') {
            store_update('analytics.json', static function (array $data): array {
                usleep(1200);
                $data['pings'] = (int)($data['pings'] ?? 0) + 1;
                return $data;
            });
            continue;
        }
        config_update(static function (array $cfg) use ($role, $i): array {
            // Widen the competing read/write window; this must be inside the stable lock.
            usleep(1200);
            if ($role === 'ping') {
                $cfg['stats']['pings'] = (int)($cfg['stats']['pings'] ?? 0) + 1;
            } elseif ($role === 'release') {
                $cfg['update'] = normalize_update(['version' => '9.' . $i . '.0', 'notes' => 'release-' . $i,
                    'files' => ['win-x64' => 'https://example.test/release-' . $i . '.exe'],
                    'sha256' => ['win-x64' => str_repeat('a', 64)]], (array)($cfg['update'] ?? []));
            } elseif ($role === 'settings') {
                $cfg['passwordHash'] = 'test-password-hash-' . $i;
                $cfg['siteName'] = 'test-site-' . $i;
            } else throw new RuntimeException('Unknown test worker');
            return $cfg;
        });
    }
    exit;
}

$root = sys_get_temp_dir() . '/aurora-config-concurrency-' . bin2hex(random_bytes(6));
mkdir($root, 0700, true);
$source = (string)file_get_contents(__DIR__ . '/../server/lib.php');
$source = str_replace("const AURORA_DATA_DIR = '/www/aurora-data';", 'const AURORA_DATA_DIR = ' . var_export($root, true) . ';', $source, $replaced);
if ($replaced !== 1) throw new RuntimeException('Test isolation failed');
file_put_contents($root . '/lib.php', $source);
require $root . '/lib.php';
$initial = ['passwordHash' => 'test-original-hash', 'siteName' => 'initial', 'stats' => ['pings' => 0, 'installs' => 17], 'update' => ['version' => '0.6.0'], 'unrelated' => ['preserve' => true]];
file_put_contents($root . '/config.json', json_encode($initial));
$iterations = 40;
$workers = [];
foreach (['ping', 'ping', 'ping', 'ping', 'release', 'settings', 'analytics', 'analytics', 'analytics'] as $role) {
    $process = proc_open([PHP_BINARY, __FILE__, '--worker', $root, $role, (string)$iterations], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($process)) throw new RuntimeException('Cannot launch regression worker');
    fclose($pipes[0]); $workers[] = [$process, $pipes];
}
foreach ($workers as [$process, $pipes]) {
    $output = stream_get_contents($pipes[1]); $errors = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
    if (proc_close($process) !== 0) throw new RuntimeException('Worker failed: ' . $errors . $output);
}
$final = config();
if ($final['stats']['pings'] !== 4 * $iterations || $final['stats']['installs'] !== 17) throw new RuntimeException('Concurrent pings were lost');
echo "PASS six PHP processes preserve all 160 ping increments\n";
if ($final['update']['version'] !== '9.39.0' || $final['update']['notes'] !== 'release-39' || $final['update']['sha256']['win-x64'] !== str_repeat('a', 64)) throw new RuntimeException('Ping overwrote the newest release');
echo "PASS public pings cannot overwrite the latest release URL or checksum\n";
if ($final['passwordHash'] !== 'test-password-hash-39' || $final['siteName'] !== 'test-site-39' || $final['unrelated'] !== ['preserve' => true]) throw new RuntimeException('Concurrent updates overwrote administrator settings');
echo "PASS public pings and release updates cannot overwrite the newest password or site settings\n";
$before = (string)file_get_contents($root . '/config.json');
try { config_update(static function (array $cfg): array { $cfg['passwordHash'] = 'must-not-save'; throw new RuntimeException('Expected rollback'); }); }
catch (RuntimeException $expected) { }
if ((string)file_get_contents($root . '/config.json') !== $before || config() !== $final) throw new RuntimeException('Failed callback changed configuration or retained the lock');
echo "PASS failed update preserves original configuration and releases the lock\n";
if ((store_read('analytics.json')['pings'] ?? 0) !== 3 * $iterations) throw new RuntimeException('Atomic analytics replacement lost concurrent increments');
echo "PASS atomic analytics replacement preserves all 120 concurrent increments\nAll 5 configuration concurrency checks passed.\n";
