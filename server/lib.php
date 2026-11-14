<?php
/**
 * 云桥AI 工具箱 · 云端目录后台
 * 公共库：存储、鉴权、响应、CORS
 *
 * 这个目录要放在网站根目录之外，或者配合 nginx 的 deny 规则。
 */
declare(strict_types=1);

const AURORA_DATA_DIR = '/www/aurora-data';
const AURORA_VERSION = '1.0.0';

function data_path(string $name): string
{
    if (!is_dir(AURORA_DATA_DIR)) {
        @mkdir(AURORA_DATA_DIR, 0700, true);
    }
    return AURORA_DATA_DIR . '/' . $name;
}

/** 读 JSON 文件，失败返回默认值 */
function store_read(string $name, array $default = []): array
{
    $f = data_path($name);
    if (!is_file($f)) {
        return $default;
    }
    $raw = @file_get_contents($f);
    if ($raw === false || $raw === '') {
        return $default;
    }
    $j = json_decode($raw, true);
    return is_array($j) ? $j : $default;
}

/** 原子写：先写临时文件再 rename，带 flock */
function store_write(string $name, array $data): bool
{
    $f = data_path($name);
    $tmp = $f . '.tmp' . getmypid();
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) {
        return false;
    }
    if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
        return false;
    }
    if (!@rename($tmp, $f)) {
        @unlink($tmp);
        return false;
    }
    @chmod($f, 0600);
    return true;
}

function config(): array
{
    $cfg = store_read('config.json', []);
    if (!isset($cfg['passwordHash'])) {
        // Existing installs keep their password. Fresh installs have no shared default credential.
        $initialPassword = getenv('AURORA_ADMIN_PASSWORD');
        if (!$initialPassword || strlen($initialPassword) < 12) {
            $initialPassword = bin2hex(random_bytes(18));
            $initialFile = data_path('initial-admin-password.txt');
            if (@file_put_contents($initialFile, $initialPassword . PHP_EOL, LOCK_EX) === false) {
                throw new RuntimeException('Cannot initialize administration credentials');
            }
            @chmod($initialFile, 0600);
        }
        $cfg['passwordHash'] = password_hash($initialPassword, PASSWORD_DEFAULT);
        $cfg['siteName'] = '云桥AI 工具箱 云端目录';
        $cfg['update'] = [
            'version' => '0.1.0',
            'notes' => '首个版本',
            'mandatory' => false,
            'files' => new stdClass(),
        ];
        $cfg['stats'] = ['pings' => 0, 'installs' => 0, 'lastPing' => null];
        $cfg['createdAt'] = date('c');
        store_write('config.json', $cfg);
    }
    return $cfg;
}

function save_config(array $cfg): void
{
    store_write('config.json', $cfg);
}

function catalog(): array
{
    $c = store_read('catalog.json', [
        'version' => 0,
        'updatedAt' => date('c'),
        'providers' => [],
    ]);
    if (!isset($c['providers']) || !is_array($c['providers'])) {
        $c['providers'] = [];
    }
    return $c;
}

function save_catalog(array $c): void
{
    $c['version'] = (int)($c['version'] ?? 0) + 1;
    $c['updatedAt'] = date('c');
    store_write('catalog.json', $c);
}

/* ------------------------------ 会话与鉴权 ------------------------------ */

function boot_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => !empty($_SERVER['HTTPS']),
    ]);
    session_name('aurora_sid');
    @session_start();
}

function is_logged_in(): bool
{
    boot_session();
    return !empty($_SESSION['aurora_admin']) && (int)($_SESSION['loginAt'] ?? 0) > time() - 43200;
}

function require_login(): void
{
    if (!is_logged_in()) {
        json_out(['error' => '未登录', 'needLogin' => true], 401);
    }
}

function csrf_token(): string
{
    boot_session();
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(16));
    }
    return $_SESSION['csrf'];
}

function check_csrf(): void
{
    boot_session();
    $sent = $_SERVER['HTTP_X_CSRF'] ?? ($_POST['_csrf'] ?? '');
    if (empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], (string)$sent)) {
        json_out(['error' => 'CSRF 校验失败，请刷新页面'], 419);
    }
}

/* ------------------------------ 输出 ------------------------------ */

function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function cors(): void
{
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Headers: Content-Type, X-CSRF, Authorization');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Max-Age: 86400');
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function body_json(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $j = json_decode($raw, true);
    return is_array($j) ? $j : [];
}

function now(): string
{
    return date('c');
}

/** 校验并规整一条供应商记录 */
function normalize_provider(array $p): array
{
    $formats = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];
    $regions = ['cn', 'global', 'local', 'relay', 'subscription'];
    $baseUrl = trim((string)($p['baseUrl'] ?? ''));
    $parts = parse_url($baseUrl);
    if (!$parts || !in_array($parts['scheme'] ?? '', ['http', 'https'], true) || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
        throw new InvalidArgumentException('供应商地址必须为不含账号密码的 HTTP(S) 地址');
    }
    if (!empty($p['format']) && !in_array($p['format'], $formats, true)) {
        throw new InvalidArgumentException('不支持的供应商协议');
    }
    $docs = trim((string)($p['docs'] ?? ''));
    if ($docs !== '') {
        $docUrl = parse_url($docs);
        if (!$docUrl || !in_array($docUrl['scheme'] ?? '', ['http', 'https'], true) || empty($docUrl['host']) || isset($docUrl['user']) || isset($docUrl['pass'])) {
            throw new InvalidArgumentException('文档地址必须为 HTTP(S) 地址');
        }
    }
    $models = [];
    foreach (($p['models'] ?? []) as $m) {
        if (!is_array($m)) {
            continue;
        }
        $id = trim((string)($m['id'] ?? ''));
        if ($id === '') {
            continue;
        }
        $models[] = [
            'id' => $id,
            'displayName' => (string)($m['displayName'] ?? ''),
            'contextWindow' => isset($m['contextWindow']) ? (int)$m['contextWindow'] : 128000,
            'inputPrice' => isset($m['inputPrice']) ? (float)$m['inputPrice'] : 0,
            'outputPrice' => isset($m['outputPrice']) ? (float)$m['outputPrice'] : 0,
            'capabilities' => [
                'tools' => (bool)($m['capabilities']['tools'] ?? true),
                'vision' => (bool)($m['capabilities']['vision'] ?? false),
                'thinking' => (bool)($m['capabilities']['thinking'] ?? false),
            ],
        ];
    }
    return [
        'key' => (string)($p['key'] ?? ('p_' . substr(md5((string)($p['name'] ?? '') . microtime()), 0, 10))),
        'name' => trim((string)($p['name'] ?? '未命名')),
        'vendor' => (string)($p['vendor'] ?? ''),
        'format' => in_array($p['format'] ?? '', $formats, true) ? $p['format'] : 'openai-chat',
        'baseUrl' => $baseUrl,
        'region' => in_array($p['region'] ?? '', $regions, true) ? $p['region'] : 'relay',
        'color' => (string)($p['color'] ?? '#6d8cff'),
        'icon' => (string)($p['icon'] ?? '◆'),
        'docs' => $docs,
        'note' => (string)($p['note'] ?? ''),
        'tags' => array_values(array_filter(array_map('strval', (array)($p['tags'] ?? [])))),
        'enabled' => (bool)($p['enabled'] ?? true),
        'official' => (bool)($p['official'] ?? false),
        'sort' => (int)($p['sort'] ?? 100),
        'models' => $models,
        'updatedAt' => now(),
    ];
}



/** 带文件锁的读-改-写：并发埋点不丢数据 */
function store_update(string $name, callable $fn, array $default = []): array
{
    $f = data_path($name);
    $fp = @fopen($f, 'c+');
    if (!$fp) {
        return $default;
    }
    flock($fp, LOCK_EX);
    $raw = stream_get_contents($fp);
    $data = $raw ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        $data = $default;
    }
    $data = $fn($data);
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json !== false) {
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, $json);
        fflush($fp);
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    @chmod($f, 0600);
    return $data;
}

/* ------------------------------ 访问统计 ------------------------------ */

const ANALYTICS_RETENTION_DAYS = 90;
const ANALYTICS_MAX_IPS = 2000;

function client_ip(): string
{
    $fwd = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if ($fwd) {
        $first = trim(explode(',', $fwd)[0]);
        if ($first !== '') {
            return $first;
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

function short_ua(): string
{
    $ua = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');
    $ua = preg_replace('/\s+/', ' ', trim($ua));
    return mb_substr($ua === '' ? 'unknown' : $ua, 0, 120);
}

/**
 * 记录一次公开接口访问。
 * $kind: catalog | update | ping
 * $extra: ['version' => '0.2.3', 'platform' => 'win', 'arch' => 'x64']
 */
function track(string $kind, array $extra = []): void
{
    $today = date('Y-m-d');
    $ip = client_ip();
    $ua = short_ua();

    store_update('analytics.json', function (array $a) use ($kind, $extra, $today, $ip, $ua) {
        $a['days'] = $a['days'] ?? [];
        $d = $a['days'][$today] ?? ['catalog' => 0, 'update' => 0, 'ping' => 0, 'ips' => [], 'versions' => [], 'platforms' => []];
        $d[$kind] = (int)($d[$kind] ?? 0) + 1;
        $d['ips'] = $d['ips'] ?? [];
        $d['ips'][$ip] = (int)($d['ips'][$ip] ?? 0) + 1;
        if (isset($extra['version']) && $extra['version'] !== '') {
            $v = (string)$extra['version'];
            $d['versions'] = $d['versions'] ?? [];
            $d['versions'][$v] = (int)($d['versions'][$v] ?? 0) + 1;
        }
        if (isset($extra['platform'])) {
            $p = (string)$extra['platform'];
            $d['platforms'] = $d['platforms'] ?? [];
            $d['platforms'][$p] = (int)($d['platforms'][$p] ?? 0) + 1;
        }
        $a['days'][$today] = $d;

        // 客户端档案
        $a['clients'] = $a['clients'] ?? [];
        $c = $a['clients'][$ip] ?? ['first' => date('c'), 'last' => date('c'), 'count' => 0, 'ua' => $ua, 'version' => ''];
        $c['last'] = date('c');
        $c['count'] = (int)($c['count'] ?? 0) + 1;
        $c['ua'] = $ua ?: ($c['ua'] ?? '');
        if (!empty($extra['version'])) {
            $c['version'] = (string)$extra['version'];
        }
        if (!empty($extra['platform'])) {
            $c['platform'] = (string)$extra['platform'];
        }
        $a['clients'][$ip] = $c;

        // 控制体量：IP 表按最后活跃时间保留前 N 个
        if (count($a['clients']) > ANALYTICS_MAX_IPS) {
            uasort($a['clients'], fn($x, $y) => strcmp((string)($y['last'] ?? ''), (string)($x['last'] ?? '')));
            $a['clients'] = array_slice($a['clients'], 0, ANALYTICS_MAX_IPS, true);
        }
        // 只保留最近 N 天的日聚合
        $cut = date('Y-m-d', strtotime('-' . ANALYTICS_RETENTION_DAYS . ' days'));
        foreach (array_keys($a['days']) as $day) {
            if (strcmp((string)$day, $cut) < 0) {
                unset($a['days'][$day]);
            }
        }
        return $a;
    }, ['days' => [], 'clients' => []]);
}

/** 把按天的原始数据压成前端要的形状 */
function analytics_summary(array $a): array
{
    $days = $a['days'] ?? [];
    ksort($days);
    $series = [];
    $totals = ['catalog' => 0, 'update' => 0, 'ping' => 0];
    $versions = [];
    $platforms = [];
    $ipsToday = [];

    foreach ($days as $day => $d) {
        $series[] = [
            'day' => (string)$day,
            'catalog' => (int)($d['catalog'] ?? 0),
            'update' => (int)($d['update'] ?? 0),
            'ping' => (int)($d['ping'] ?? 0),
            'ips' => count((array)($d['ips'] ?? [])),
        ];
        foreach ($totals as $k => $_) {
            $totals[$k] += (int)($d[$k] ?? 0);
        }
        foreach ((array)($d['versions'] ?? []) as $v => $n) {
            $versions[$v] = ($versions[$v] ?? 0) + (int)$n;
        }
        foreach ((array)($d['platforms'] ?? []) as $p => $n) {
            $platforms[$p] = ($platforms[$p] ?? 0) + (int)$n;
        }
    }
    $todayKey = date('Y-m-d');
    $ipsToday = array_keys((array)($days[$todayKey]['ips'] ?? []));

    $clients = [];
    foreach ((array)($a['clients'] ?? []) as $ip => $c) {
        $clients[] = [
            'ip' => (string)$ip,
            'count' => (int)($c['count'] ?? 0),
            'first' => $c['first'] ?? '',
            'last' => $c['last'] ?? '',
            'ua' => $c['ua'] ?? '',
            'version' => $c['version'] ?? '',
            'platform' => $c['platform'] ?? '',
        ];
    }
    usort($clients, fn($x, $y) => strcmp((string)$y['last'], (string)$x['last']));

    arsort($versions);
    arsort($platforms);

    return [
        'totals' => $totals,
        'today' => [
            'catalog' => (int)($days[$todayKey]['catalog'] ?? 0),
            'update' => (int)($days[$todayKey]['update'] ?? 0),
            'ips' => count($ipsToday),
        ],
        'series' => array_slice($series, -30),
        'versions' => $versions,
        'platforms' => $platforms,
        'clients' => array_slice($clients, 0, 500),
        'ipTotal' => count((array)($a['clients'] ?? [])),
        'retentionDays' => ANALYTICS_RETENTION_DAYS,
    ];
}
