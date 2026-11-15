<?php
/** Offline integration tests. PHP 8.1+, pdo_sqlite, openssl; no real accounts or credits. */
declare(strict_types=1);
require __DIR__ . '/../server/member_service.php';

function fixture(string $directory, string $mode = ''): MemberService
{
    $config = ['enabled' => true, 'origin' => 'https://members.example.test', 'adminKey' => 'test-administrator-key-only',
        'secret' => str_repeat('fixture-secret-', 4), 'dataDir' => $directory . '/ledger'];
    $upstream = new PDO('sqlite:' . $directory . '/upstream.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $upstream->exec('PRAGMA busy_timeout=10000');
    $upstream->exec('PRAGMA journal_mode=WAL');
    $upstream->exec('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, user_id INTEGER NOT NULL, cents INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, group_id INTEGER NOT NULL);');
    $transport = static function (string $method, string $path, array $headers, ?array $body) use ($upstream, $mode): array {
        $okay = static fn(array $data): array => ['status' => 200, 'body' => ['code' => 0, 'data' => $data]];
        $userId = 0;
        foreach ($headers as $header) if (preg_match('/^Authorization: Bearer user-([0-9]+)$/', $header, $m)) $userId = (int)$m[1];
        if ($path === '/auth/login') {
            if (($body['password'] ?? '') === '2fa') return $okay(['requires_2fa' => true, 'temp_token' => 'temporary-proof', 'user_email_masked' => 'u***@example.test']);
            if (($body['password'] ?? '') !== 'correct') return ['status' => 401, 'body' => []];
            return $okay(['access_token' => 'user-1', 'expires_in' => 3600]);
        }
        if ($path === '/auth/login/2fa') return ($body['totp_code'] ?? '') === '123456' ? $okay(['access_token' => 'user-1']) : ['status' => 401, 'body' => []];
        if ($path === '/auth/me') {
            if (!$userId) return ['status' => 401, 'body' => []];
            $q = $upstream->prepare('SELECT COALESCE(SUM(cents),0) FROM codes WHERE user_id=?'); $q->execute([$userId]);
            return $okay(['id' => $mode === 'different-user' ? $userId + 1 : $userId, 'email' => 'user' . $userId . '@example.test',
                'username' => '测试用户', 'balance' => (int)$q->fetchColumn() / 100, 'status' => $mode === 'inactive' ? 'inactive' : 'active']);
        }
        if ($path === '/groups/available') return $okay([['id' => 7, 'name' => 'OpenAI', 'platform' => 'openai', 'status' => 'active', 'rate_multiplier' => 1], ['id' => 8, 'name' => 'Claude', 'platform' => 'anthropic', 'status' => 'active']]);
        if (str_starts_with($path, '/keys?')) {
            if (!$userId) throw new RuntimeException('Keys must use user auth');
            $q = $upstream->prepare('SELECT * FROM keys WHERE user_id=?'); $q->execute([$userId]);
            return $okay(['items' => array_map(static fn(array $row): array => ['id' => 1, 'key' => $row['key'], 'group_id' => (int)$row['group_id'], 'user_id' => (int)$row['user_id'], 'status' => 'active'], $q->fetchAll(PDO::FETCH_ASSOC))]);
        }
        if ($path === '/keys') {
            if (!$userId || array_filter($headers, static fn(string $h): bool => str_starts_with($h, 'x-api-key:'))) throw new RuntimeException('Wrong key authorization');
            if ($body['name'] !== 'yunqiao.me 客户端') throw new RuntimeException('Wrong key name');
            $q = $upstream->prepare('INSERT OR IGNORE INTO keys(key,user_id,group_id) VALUES(?,?,?)'); $q->execute([$body['custom_key'], $userId, $body['group_id']]);
            return $okay(['id' => 1, 'key' => $body['custom_key'], 'user_id' => $userId, 'group_id' => $body['group_id'], 'status' => 'active']);
        }
        if (!in_array('x-api-key: test-administrator-key-only', $headers, true)) throw new RuntimeException('Admin header missing');
        $receipt = static fn(array $row): array => ['id' => 10, 'code' => $row['code'], 'type' => 'balance', 'value' => (int)$row['cents'] / 100, 'used_by' => (int)$row['user_id'], 'status' => 'used'];
        if (str_starts_with($path, '/admin/redeem-codes?')) {
            parse_str((string)parse_url($path, PHP_URL_QUERY), $query);
            $q = $upstream->prepare('SELECT * FROM codes WHERE code=?'); $q->execute([$query['search']]);
            $row = $q->fetch(PDO::FETCH_ASSOC);
            return $okay(['items' => $row ? [$receipt($row)] : [], 'total' => $row ? 1 : 0]);
        }
        if ($path !== '/admin/redeem-codes/create-and-redeem') throw new RuntimeException('Unexpected endpoint');
        if ($body['value'] !== 10 || $body['type'] !== 'balance' || !in_array('Idempotency-Key: ' . $body['code'], $headers, true)) throw new RuntimeException('Unsafe grant request');
        $upstream->exec('BEGIN IMMEDIATE');
        try {
            $upstream->exec("INSERT INTO counters(key,value) VALUES('fulfill',1) ON CONFLICT(key) DO UPDATE SET value=value+1");
            $q = $upstream->prepare('INSERT OR IGNORE INTO codes(code,user_id,cents) VALUES(?,?,1000)'); $q->execute([$body['code'], $body['user_id']]);
            $q = $upstream->prepare('SELECT * FROM codes WHERE code=?'); $q->execute([$body['code']]);
            $row = $q->fetch(PDO::FETCH_ASSOC);
            $upstream->exec('COMMIT');
        } catch (Throwable $e) { $upstream->exec('ROLLBACK'); throw $e; }
        if ($mode === 'timeout-after-credit') throw new MemberError('UPSTREAM_UNAVAILABLE', 'simulated lost response', 503);
        $result = $receipt($row);
        if ($mode === 'wrong-receipt') $result['value'] = 20;
        return $okay(['redeem_code' => $result]);
    };
    return new MemberService($config, $transport);
}

function identity(int $id): array
{
    return ['installationId' => 'installation-test-' . $id, 'installationProof' => hash('sha256', 'proof-' . $id)];
}
function signedIn(MemberService $service, int $userId, int $installId): array
{
    $credentials = identity($installId);
    $login = $service->handle('bind', ['accessToken' => 'user-' . $userId], $credentials, 'ip-' . $userId . '-' . $installId);
    return $credentials + ['sessionToken' => $login['sessionToken']];
}
function check(bool $condition, string $label): void
{
    if (!$condition) throw new RuntimeException('FAILED: ' . $label);
}
function expectCode(callable $run, string $code): void
{
    try { $run(); } catch (MemberError $e) { check($e->errorCode === $code, 'expected ' . $code . ', got ' . $e->errorCode); return; }
    throw new RuntimeException('Expected error: ' . $code);
}
function db(string $directory): PDO { return new PDO('sqlite:' . $directory . '/ledger/members.sqlite'); }
function upstreamDb(string $directory): PDO { return new PDO('sqlite:' . $directory . '/upstream.sqlite'); }

if (($argv[1] ?? '') === '--worker') {
    $directory = $argv[2];
    $credentials = json_decode((string)file_get_contents($argv[3]), true, 32, JSON_THROW_ON_ERROR);
    try { echo json_encode(fixture($directory)->handle('claim', [], $credentials), JSON_THROW_ON_ERROR); }
    catch (Throwable $e) { fwrite(STDERR, get_class($e) . ': ' . $e->getMessage()); exit(1); }
    exit;
}
if (($argv[1] ?? '') === '--init-worker') {
    try { echo json_encode(signedIn(fixture($argv[2]), (int)$argv[3], (int)$argv[3]), JSON_THROW_ON_ERROR); }
    catch (Throwable $e) { fwrite(STDERR, get_class($e) . ': ' . $e->getMessage()); exit(1); }
    exit;
}

$root = sys_get_temp_dir() . '/aurora-members-test-' . bin2hex(random_bytes(6));
mkdir($root, 0700, true);
$tests = 0;
$test = static function (string $name, callable $run) use (&$tests, $root): void {
    $directory = $root . '/' . (++$tests); mkdir($directory, 0700, true); $run($directory); echo 'PASS ' . $name . PHP_EOL;
};

$test('fixed ten-dollar grant, repeated claim and private response', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    $first = $service->handle('claim', [], $credentials); $second = $service->handle('claim', [], $credentials);
    check($first['gift']['status'] === 'claimed' && $first['gift']['amountUsd'] === 10 && $first['member']['balance'] === 10.0, 'credit confirmed');
    check($first['gift']['code'] === $second['gift']['code'], 'stable code');
    check((int)upstreamDb($dir)->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 1000, 'exact credit');
    $output = json_encode([$first, $service->publicConfig(), $service->adminOverview()]);
    check(!str_contains($output, 'test-administrator-key') && !str_contains($output, 'user-1'), 'secrets not exposed');
});
$test('same account on another installation cannot receive twice', static function ($dir): void {
    $service = fixture($dir); $service->handle('claim', [], signedIn($service, 1, 1));
    $result = $service->handle('claim', [], signedIn($service, 1, 2));
    check($result['gift']['status'] === 'claimed' && (int)upstreamDb($dir)->query('SELECT COUNT(*) FROM codes')->fetchColumn() === 1, 'account unique');
});
$test('another account on same installation is ineligible', static function ($dir): void {
    $service = fixture($dir); $service->handle('claim', [], signedIn($service, 1, 1));
    $other = signedIn($service, 2, 1);
    check($service->handle('status', [], $other)['gift']['status'] === 'ineligible', 'installation status');
    expectCode(fn() => $service->handle('claim', [], $other), 'INSTALLATION_ALREADY_CLAIMED');
});
$test('self-reported identity and amount rejected', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    foreach (['userId' => 2, 'user_id' => 2, 'amount' => 100, 'value' => 20, 'code' => 'forged'] as $key => $value) expectCode(fn() => $service->handle('claim', [$key => $value], $credentials), 'INVALID_FIELDS');
    check((int)db($dir)->query('SELECT COUNT(*) FROM welcome_grants')->fetchColumn() === 0, 'no reservation');
});
$test('installation and bearer authentication enforced', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    $bad = $credentials; $bad['installationProof'] = str_repeat('0', 64);
    expectCode(fn() => $service->handle('claim', [], $bad), 'INSTALLATION_MISMATCH');
    $other = signedIn($service, 2, 2); $other['sessionToken'] = $credentials['sessionToken'];
    expectCode(fn() => $service->handle('claim', [], $other), 'SESSION_EXPIRED');
    expectCode(fn() => $service->handle('bind', ['accessToken' => 'forged'], identity(3)), 'AUTH_REJECTED');
});
$test('timeout after upstream credit recovers by code lookup', static function ($dir): void {
    $service = fixture($dir, 'timeout-after-credit'); $credentials = signedIn($service, 1, 1);
    expectCode(fn() => $service->handle('claim', [], $credentials), 'UPSTREAM_UNAVAILABLE');
    check(db($dir)->query('SELECT status FROM welcome_grants')->fetchColumn() === 'pending', 'pending durable');
    $result = fixture($dir)->handle('claim', [], $credentials);
    check($result['gift']['status'] === 'claimed' && (int)upstreamDb($dir)->query("SELECT value FROM counters WHERE key='fulfill'")->fetchColumn() === 1, 'read-only reconciliation');
});
$test('mismatched receipt requires review, admin read-only reconcile', static function ($dir): void {
    $service = fixture($dir, 'wrong-receipt'); $credentials = signedIn($service, 1, 1);
    expectCode(fn() => $service->handle('claim', [], $credentials), 'GRANT_REVIEW_REQUIRED');
    check(db($dir)->query('SELECT status FROM welcome_grants')->fetchColumn() === 'review', 'fail closed');
    expectCode(fn() => fixture($dir)->handle('claim', [], $credentials), 'GRANT_REVIEW_REQUIRED');
    check(fixture($dir)->adminReconcile(1, false)['gift']['status'] === 'claimed', 'admin confirms actual upstream receipt');
});
$test('upstream identity and active status revalidated before credit', static function ($dir): void {
    $credentials = signedIn(fixture($dir), 1, 1);
    expectCode(fn() => fixture($dir, 'different-user')->handle('claim', [], $credentials), 'AUTH_REJECTED');
    expectCode(fn() => fixture($dir, 'inactive')->handle('claim', [], $credentials), 'ACCOUNT_INACTIVE');
});
$test('session token is hashed, upstream JWT encrypted, logout revokes', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    $session = db($dir)->query('SELECT * FROM member_sessions')->fetch(PDO::FETCH_ASSOC);
    check($session['token_hash'] !== $credentials['sessionToken'] && !str_contains($session['upstream_token'], 'user-1'), 'encrypted at rest');
    $service->handle('logout', [], $credentials);
    expectCode(fn() => $service->handle('claim', [], $credentials), 'SESSION_EXPIRED');
});
$test('login and two-factor flow', static function ($dir): void {
    $service = fixture($dir);
    expectCode(fn() => $service->handle('login', ['email' => 'u@example.test', 'password' => 'bad'], identity(1)), 'AUTH_REJECTED');
    $challenge = $service->handle('login', ['email' => 'u@example.test', 'password' => '2fa'], identity(1));
    check($challenge['requires2fa'] && $challenge['tempToken'] === 'temporary-proof', 'challenge');
    $login = $service->handle('login2fa', ['tempToken' => $challenge['tempToken'], 'totpCode' => '123456'], identity(1));
    check($login['member']['id'] === 1, '2fa verified');
});
$test('disabled service and per-IP login throttling', static function ($dir): void {
    $disabled = new MemberService(['enabled' => false]);
    check(!$disabled->publicConfig()['enabled'], 'disabled config');
    expectCode(fn() => $disabled->handle('claim', [], []), 'MEMBERS_DISABLED');
    $service = fixture($dir);
    for ($i = 0; $i < 12; $i++) expectCode(fn() => $service->handle('bind', ['accessToken' => 'bad'], identity(1), 'same-ip'), 'AUTH_REJECTED');
    expectCode(fn() => $service->handle('bind', ['accessToken' => 'bad'], identity(1), 'same-ip'), 'RATE_LIMITED');
});
$test('user-scoped API key, allowed group and stable retries', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    expectCode(fn() => $service->handle('create-client-key', ['groupId' => 999], $credentials), 'GROUP_REQUIRED');
    $first = $service->handle('create-client-key', ['groupId' => 7], $credentials);
    $again = $service->handle('create-client-key', ['groupId' => 7], $credentials);
    check($first['apiKey'] === $again['apiKey'] && $first['format'] === 'openai-responses', 'stable key');
    check((int)upstreamDb($dir)->query('SELECT COUNT(*) FROM keys')->fetchColumn() === 1, 'one user key');
    check(!str_contains(json_encode($service->handle('status', [], $credentials)), 'sk-yunqiao-'), 'status does not reveal key');
});
$test('concurrent PHP processes credit exactly once', static function ($dir): void {
    $credentials = signedIn(fixture($dir), 1, 1);
    $credentialsPath = $dir . '/worker.json'; file_put_contents($credentialsPath, json_encode($credentials));
    $workers = [];
    for ($i = 0; $i < 8; $i++) {
        $command = [PHP_BINARY];
        // The portable Windows test runtime has no php.ini; Linux CI inherits
        // its configured extensions (OpenSSL may be compiled into PHP itself).
        if (PHP_OS_FAMILY === 'Windows') array_push($command, '-d', 'extension_dir=' . ini_get('extension_dir'), '-d', 'extension=pdo_sqlite', '-d', 'extension=openssl');
        array_push($command, __FILE__, '--worker', $dir, $credentialsPath);
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        check(is_resource($process), 'worker launch'); fclose($pipes[0]); $workers[] = [$process, $pipes];
    }
    foreach ($workers as [$process, $pipes]) {
        $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
        check(proc_close($process) === 0, 'worker success ' . $err);
        check((json_decode($out, true)['gift']['status'] ?? '') === 'claimed', 'worker result');
    }
    check((int)upstreamDb($dir)->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 1000, 'one upstream grant');
    check((int)db($dir)->query('SELECT COUNT(*) FROM welcome_grants')->fetchColumn() === 1, 'one local grant');
});
$test('corrupt monetary ledger is not silently reset', static function ($dir): void {
    mkdir($dir . '/ledger'); file_put_contents($dir . '/ledger/members.sqlite', 'not a sqlite database');
    $failed = false; try { signedIn(fixture($dir), 1, 1); } catch (PDOException $e) { $failed = true; }
    check($failed && file_get_contents($dir . '/ledger/members.sqlite') === 'not a sqlite database', 'corruption preserved');
});

$test('initialized empty or incomplete ledgers never rebuild grant history', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    $service->handle('claim', [], $credentials); unset($service);
    $database = db($dir); $database->exec('PRAGMA wal_checkpoint(TRUNCATE)'); unset($database);
    file_put_contents($dir . '/ledger/members.sqlite', '');
    expectCode(fn() => signedIn(fixture($dir), 1, 2), 'STORAGE_UNAVAILABLE');
    check(filesize($dir . '/ledger/members.sqlite') === 0, 'empty ledger preserved');
    unlink($dir . '/ledger/members.sqlite');
    $database = db($dir); $database->exec('CREATE TABLE unrelated (id INTEGER)'); unset($database);
    $original = hash_file('sha256', $dir . '/ledger/members.sqlite');
    expectCode(fn() => signedIn(fixture($dir), 1, 2), 'STORAGE_UNAVAILABLE');
    check(hash_file('sha256', $dir . '/ledger/members.sqlite') === $original, 'incomplete ledger preserved');
    check((int)upstreamDb($dir)->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 1000, 'no extra credit after ledger loss');
});

$test('failed origin verification never leaves a usable cached database', static function ($dir): void {
    signedIn(fixture($dir), 1, 1);
    $service = new MemberService(['enabled' => true, 'origin' => 'https://changed.example.test',
        'adminKey' => 'test-administrator-key-only', 'secret' => str_repeat('fixture-secret-', 4), 'dataDir' => $dir . '/ledger']);
    expectCode(fn() => $service->adminOverview(), 'UPSTREAM_CHANGED');
    expectCode(fn() => $service->adminOverview(), 'UPSTREAM_CHANGED');
});

$test('simultaneous first requests initialize one complete ledger', static function ($dir): void {
    // Prepare only the mock upstream. The member ledger does not exist when workers start.
    fixture($dir);
    $workers = [];
    for ($i = 1; $i <= 8; $i++) {
        $command = [PHP_BINARY];
        if (PHP_OS_FAMILY === 'Windows') array_push($command, '-d', 'extension_dir=' . ini_get('extension_dir'), '-d', 'extension=pdo_sqlite', '-d', 'extension=openssl');
        array_push($command, __FILE__, '--init-worker', $dir, (string)$i);
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        check(is_resource($process), 'initialization worker launch'); fclose($pipes[0]); $workers[] = [$process, $pipes];
    }
    foreach ($workers as [$process, $pipes]) {
        $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
        check(proc_close($process) === 0, 'initialization worker success ' . $err);
        check(isset(json_decode($out, true)['sessionToken']), 'initialization worker session');
    }
    check((int)db($dir)->query('SELECT COUNT(*) FROM installations')->fetchColumn() === 8, 'all independent installations retained');
    check(is_file($dir . '/ledger/members.initialized'), 'initialized marker persisted');
});

$test('missing origin and failed initialization marker remain closed on retries', static function ($dir): void {
    $service = fixture($dir); signedIn($service, 1, 1); unset($service);
    $database = db($dir); $database->exec("DELETE FROM member_meta WHERE key='upstream_origin'"); unset($database);
    $service = fixture($dir);
    expectCode(fn() => $service->adminOverview(), 'STORAGE_UNAVAILABLE');
    expectCode(fn() => $service->adminOverview(), 'STORAGE_UNAVAILABLE');
    check((int)db($dir)->query('SELECT COUNT(*) FROM member_meta')->fetchColumn() === 0, 'missing origin never inferred from new configuration');
    $database = db($dir); $database->exec("INSERT INTO member_meta VALUES('upstream_origin','https://members.example.test')"); unset($database);
    unlink($dir . '/ledger/members.initialized'); mkdir($dir . '/ledger/members.initialized');
    $service = fixture($dir);
    expectCode(fn() => $service->adminOverview(), 'STORAGE_UNAVAILABLE');
    expectCode(fn() => $service->adminOverview(), 'STORAGE_UNAVAILABLE');
});

echo 'All ' . $tests . ' membership integration tests passed. Fixtures: ' . $root . PHP_EOL;
