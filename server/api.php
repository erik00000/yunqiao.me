<?php
/**
 * 管理 API。所有写操作要求登录 + CSRF。
 * 调用方式：POST /api.php?a=动作名   （body 为 JSON）
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

// The administration API is same-origin only. Public catalog CORS lives in pub.php.
if (!empty($_SERVER['HTTP_ORIGIN'])) {
    $originHost = parse_url((string)$_SERVER['HTTP_ORIGIN'], PHP_URL_HOST);
    $requestHost = parse_url('http://' . ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST);
    if (!$originHost || strcasecmp($originHost, (string)$requestHost) !== 0) {
        json_out(['error' => '不允许的来源地址'], 403);
    }
}
boot_session();

$action = $_GET['a'] ?? ($_GET['action'] ?? '');
$body = body_json();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$readActions = ['whoami', 'catalog.get', 'analytics.get'];
if (!in_array($action, $readActions, true) && $method !== 'POST') {
    header('Allow: POST');
    json_out(['error' => '写操作必须使用 POST'], 405);
}
set_exception_handler(function (Throwable $error): void {
    json_out(['error' => $error instanceof InvalidArgumentException ? $error->getMessage() : '操作失败，请检查服务器日志'], $error instanceof InvalidArgumentException ? 400 : 500);
});

/* ------------------------------ 登录 ------------------------------ */

if ($action === 'login') {
    $pass = (string)($body['password'] ?? '');
    $cfg = config();
    // 简单防爆破：同 IP 连续失败锁定
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0';
    $failFile = 'fail_' . md5($ip) . '.json';
    $fail = store_read($failFile, ['n' => 0, 'until' => 0]);
    if (($fail['until'] ?? 0) > time()) {
        json_out(['error' => '尝试太频繁，请 ' . (($fail['until'] - time())) . ' 秒后再试'], 429);
    }
    if (!password_verify($pass, $cfg['passwordHash'])) {
        $fail['n'] = ($fail['n'] ?? 0) + 1;
        if ($fail['n'] >= 5) {
            $fail = ['n' => 0, 'until' => time() + 300];
        }
        store_write($failFile, $fail);
        json_out(['error' => '密码不正确'], 401);
    }
    store_write($failFile, ['n' => 0, 'until' => 0]);
    session_regenerate_id(true);
    $_SESSION['aurora_admin'] = true;
    $_SESSION['loginAt'] = time();
    json_out(['ok' => true, 'csrf' => csrf_token()]);
}

if ($action === 'logout') {
    require_login();
    check_csrf();
    $_SESSION = [];
    session_destroy();
    json_out(['ok' => true]);
}

if ($action === 'whoami') {
    json_out(['ok' => true, 'loggedIn' => is_logged_in(), 'csrf' => csrf_token()]);
}

/* ------------------------------ 以下都需要登录 ------------------------------ */

require_login();
if ($method !== 'GET') {
    check_csrf();
}

switch ($action) {
    /* ---------- 目录 ---------- */
    case 'catalog.get': {
        $c = catalog();
        $cfg = config();
        json_out([
            'ok' => true,
            'catalog' => $c,
            'update' => $cfg['update'],
            'stats' => $cfg['stats'] ?? [],
            'siteName' => $cfg['siteName'] ?? '云桥AI 工具箱 云端目录',
            'publicUrl' => (isset($_SERVER['HTTPS']) ? 'https://' : 'http://') . ($_SERVER['HTTP_HOST'] ?? ''),
        ]);
    }

    case 'provider.save': {
        $p = normalize_provider($body);
        $c = catalog();
        $found = false;
        foreach ($c['providers'] as $i => $old) {
            if (($old['key'] ?? '') === $p['key']) {
                $c['providers'][$i] = $p;
                $found = true;
                break;
            }
        }
        if (!$found) {
            $p['createdAt'] = now();
            array_unshift($c['providers'], $p);
        }
        // 按 sort 排，同序按名字
        usort($c['providers'], function ($a, $b) {
            $s = ((int)($a['sort'] ?? 100)) <=> ((int)($b['sort'] ?? 100));
            return $s !== 0 ? $s : strcmp((string)($a['name'] ?? ''), (string)($b['name'] ?? ''));
        });
        save_catalog($c);
        json_out(['ok' => true, 'provider' => $p, 'version' => $c['version']]);
    }

    case 'provider.delete': {
        $keys = (array)($body['keys'] ?? [$body['key'] ?? '']);
        $keys = array_values(array_filter(array_map('strval', $keys)));
        $c = catalog();
        $before = count($c['providers']);
        $c['providers'] = array_values(array_filter($c['providers'], function ($p) use ($keys) {
            return !in_array((string)($p['key'] ?? ''), $keys, true);
        }));
        save_catalog($c);
        json_out(['ok' => true, 'deleted' => $before - count($c['providers']), 'version' => $c['version']]);
    }

    case 'provider.toggle': {
        $keys = array_values(array_filter(array_map('strval', (array)($body['keys'] ?? [$body['key'] ?? '']))));
        $enabled = (bool)($body['enabled'] ?? true);
        $c = catalog();
        foreach ($c['providers'] as $i => $p) {
            if (in_array((string)($p['key'] ?? ''), $keys, true)) {
                $c['providers'][$i]['enabled'] = $enabled;
            }
        }
        save_catalog($c);
        json_out(['ok' => true, 'version' => $c['version']]);
    }

    case 'provider.bulkAdd': {
        $list = $body['providers'] ?? [];
        if (!is_array($list)) {
            json_out(['error' => 'providers 必须是数组'], 400);
        }
        $c = catalog();
        $byKey = [];
        foreach ($c['providers'] as $i => $p) {
            $byKey[(string)($p['key'] ?? '')] = $i;
        }
        $added = 0;
        $updated = 0;
        foreach ($list as $raw) {
            if (!is_array($raw)) {
                continue;
            }
            $p = normalize_provider($raw);
            if (isset($byKey[$p['key']])) {
                $c['providers'][$byKey[$p['key']]] = $p;
                $updated++;
            } else {
                $p['createdAt'] = now();
                $c['providers'][] = $p;
                $byKey[$p['key']] = count($c['providers']) - 1;
                $added++;
            }
        }
        save_catalog($c);
        json_out(['ok' => true, 'added' => $added, 'updated' => $updated, 'version' => $c['version']]);
    }

    case 'catalog.import': {
        // 整体替换（导入备份）
        $incoming = $body['catalog']['providers'] ?? $body['providers'] ?? [];
        if (!is_array($incoming)) {
            json_out(['error' => '格式不正确'], 400);
        }
        $list = [];
        foreach ($incoming as $raw) {
            if (is_array($raw)) {
                $list[] = normalize_provider($raw);
            }
        }
        $c = ['version' => (int)(catalog()['version'] ?? 0), 'updatedAt' => now(), 'providers' => $list];
        save_catalog($c);
        json_out(['ok' => true, 'count' => count($list), 'version' => $c['version']]);
    }

    case 'analytics.get': {
        $a = store_read('analytics.json', ['days' => [], 'clients' => []]);
        json_out(['ok' => true, 'analytics' => analytics_summary($a)]);
    }

    case 'analytics.reset': {
        store_write('analytics.json', ['days' => [], 'clients' => []]);
        json_out(['ok' => true]);
    }

    /* ---------- 更新 ---------- */
    case 'update.save': {
        $cfg = config();
        $cfg['update'] = [
            'version' => (string)($body['version'] ?? $cfg['update']['version'] ?? '0.1.0'),
            'notes' => (string)($body['notes'] ?? ''),
            'mandatory' => (bool)($body['mandatory'] ?? false),
            'files' => (object)($body['files'] ?? []),
            'publishedAt' => now(),
        ];
        save_config($cfg);
        json_out(['ok' => true, 'update' => $cfg['update']]);
    }

    case 'settings.save': {
        $cfg = config();
        if (!empty($body['siteName'])) {
            $cfg['siteName'] = (string)$body['siteName'];
        }
        if (!empty($body['password'])) {
            $pwd = (string)$body['password'];
            if (strlen($pwd) < 8) {
                json_out(['error' => '密码至少 8 位'], 400);
            }
            $cfg['passwordHash'] = password_hash($pwd, PASSWORD_DEFAULT);
        }
        save_config($cfg);
        json_out(['ok' => true]);
    }

    case 'stats.reset': {
        $cfg = config();
        $cfg['stats'] = ['pings' => 0, 'installs' => 0, 'lastPing' => null];
        save_config($cfg);
        json_out(['ok' => true]);
    }

    default:
        json_out(['error' => '未知操作: ' . $action], 404);
}


