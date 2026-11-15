<?php
/** Multi-process admin throttling, all fake passwords and isolated local data. */
declare(strict_types=1);
if (($argv[1] ?? '') === '--worker') {
    require $argv[2] . '/lib.php';
    echo json_encode(admin_login_attempt('incorrect', (string)file_get_contents($argv[2] . '/hash'), 'fixture-ip'));
    exit;
}
$root = sys_get_temp_dir() . '/aurora-admin-auth-' . bin2hex(random_bytes(6)); mkdir($root, 0700, true);
$source = (string)file_get_contents(__DIR__ . '/../server/lib.php');
$source = str_replace("const AURORA_DATA_DIR = '/www/aurora-data';", 'const AURORA_DATA_DIR = ' . var_export($root, true) . ';', $source, $replaced);
if ($replaced !== 1) throw new RuntimeException('Admin authentication isolation failed');
file_put_contents($root . '/lib.php', $source); require $root . '/lib.php';
$password = 'isolated-administrator-fixture'; $hash = password_hash($password, PASSWORD_DEFAULT); file_put_contents($root . '/hash', $hash);
$workers = [];
for ($i = 0; $i < 8; $i++) {
    $process = proc_open([PHP_BINARY, __FILE__, '--worker', $root], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($process)) throw new RuntimeException('Cannot launch authentication worker');
    fclose($pipes[0]); $workers[] = [$process, $pipes];
}
$limited = 0;
foreach ($workers as [$process, $pipes]) {
    $out = stream_get_contents($pipes[1]); $errors = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
    if (proc_close($process) !== 0) throw new RuntimeException('Authentication worker failed: ' . $errors);
    $result = json_decode($out, true, 16, JSON_THROW_ON_ERROR);
    if ($result['accepted']) throw new RuntimeException('Incorrect password accepted');
    if ($result['retryAfter'] > 0) $limited++;
}
if ($limited !== 3) throw new RuntimeException('Concurrent failed attempts were lost');
echo "PASS eight concurrent sessions enforce the five-attempt limit\n";
$blocked = admin_login_attempt($password, $hash, 'fixture-ip');
if ($blocked['accepted'] || $blocked['retryAfter'] <= 0) throw new RuntimeException('Active lockout was bypassed');
echo "PASS an active lockout cannot be cleared by another session\n";
store_write('fail_' . md5('fixture-ip') . '.json', ['n' => 0, 'until' => time() - 1]);
if (!admin_login_attempt($password, $hash, 'fixture-ip')['accepted']) throw new RuntimeException('Expired lockout rejected correct password');
echo "PASS correct password succeeds after lockout expiry\n";
$file = 'fail_' . md5('fixture-write-failure') . '.json'; mkdir(data_path($file . '.tmp' . getmypid()));
$failed = false;
try { admin_login_attempt($password, $hash, 'fixture-write-failure'); } catch (RuntimeException $error) { $failed = true; }
if (!$failed) throw new RuntimeException('Authentication succeeded without persisting state');
echo "PASS storage failure cannot silently bypass authentication accounting\nAll 4 administrator authentication checks passed.\n";
