<?php
/** Real loopback HTTP requests against isolated PHP files; no production data or credentials. */
declare(strict_types=1);
$root = sys_get_temp_dir() . '/aurora-server-api-' . bin2hex(random_bytes(6));
mkdir($root . '/web', 0700, true); mkdir($root . '/data', 0700); mkdir($root . '/sessions', 0700);
$library = (string)file_get_contents(__DIR__ . '/../server/lib.php');
$library = str_replace("const AURORA_DATA_DIR = '/www/aurora-data';", 'const AURORA_DATA_DIR = ' . var_export($root . '/data', true) . ';', $library, $replaced);
if ($replaced !== 1) throw new RuntimeException('API test isolation failed');
file_put_contents($root . '/web/lib.php', $library);
foreach (['api.php', 'pub.php'] as $file) copy(__DIR__ . '/../server/' . $file, $root . '/web/' . $file);
$password = 'isolated-administrator-fixture';
$configuration = ['passwordHash' => password_hash($password, PASSWORD_DEFAULT), 'siteName' => 'Fixture', 'stats' => [],
    'update' => ['version' => '9.0.0', 'files' => ['win' => 'https://example.test/setup.exe'], 'sha256' => ['win' => str_repeat('a', 64)]]];
file_put_contents($root . '/data/config.json', json_encode($configuration));
$catalog = ['version' => 3, 'providers' => [['key' => 'original', 'name' => 'Original', 'enabled' => true,
    'format' => 'openai-chat', 'baseUrl' => 'https://example.test/v1', 'models' => [['id' => 'fixture-model']]]]];
$original = json_encode($catalog); file_put_contents($root . '/data/catalog.json', $original);
$socket = stream_socket_server('tcp://127.0.0.1:0', $errorCode, $errorMessage);
if (!$socket) throw new RuntimeException('Cannot reserve loopback address');
$address = stream_socket_get_name($socket, false); fclose($socket);
$command = [PHP_BINARY];
if (PHP_OS_FAMILY === 'Windows') array_push($command, '-d', 'extension_dir=' . ini_get('extension_dir'), '-d', 'extension=mbstring');
array_push($command, '-d', 'session.save_path=' . $root . '/sessions', '-d', 'display_errors=0', '-S', $address, '-t', $root . '/web');
$process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['file', $root . '/server.log', 'a'], 2 => ['file', $root . '/server.log', 'a']], $pipes);
if (!is_resource($process)) throw new RuntimeException('Cannot start isolated PHP server');
fclose($pipes[0]);
$cookie = ''; $csrf = ''; $checks = 0;
$request = static function (string $path, string $method = 'GET', ?string $body = null, array $extraHeaders = []) use ($address, &$cookie, &$csrf): array {
    $headers = array_merge(['Content-Type: application/json', 'Connection: close'], $extraHeaders);
    if ($cookie !== '') $headers[] = 'Cookie: ' . $cookie;
    if ($csrf !== '') $headers[] = 'X-CSRF: ' . $csrf;
    $options = ['method' => $method, 'header' => implode("\r\n", $headers), 'ignore_errors' => true, 'timeout' => 10];
    if ($body !== null) $options['content'] = $body;
    $response = @file_get_contents('http://' . $address . '/' . $path, false, stream_context_create(['http' => $options]));
    if ($response === false || !isset($http_response_header[0])) throw new RuntimeException('Loopback request failed');
    preg_match('~^HTTP/\S+ (\d+)~', $http_response_header[0], $match);
    foreach ($http_response_header as $header) if (preg_match('/^Set-Cookie: (aurora_sid=[^;]+)/i', $header, $found)) $cookie = $found[1];
    return [(int)$match[1], json_decode($response, true, 64, JSON_THROW_ON_ERROR), $http_response_header];
};
$check = static function (bool $okay, string $message) use (&$checks): void {
    if (!$okay) throw new RuntimeException($message);
    $checks++; echo 'PASS ' . $message . PHP_EOL;
};
try {
    $deadline = microtime(true) + 10;
    do {
        $connection = @stream_socket_client('tcp://' . $address, $errorCode, $errorMessage, 0.1);
        if ($connection) { fclose($connection); break; }
        usleep(50000);
    } while (microtime(true) < $deadline);
    [$status, $login] = $request('api.php?a=login', 'POST', json_encode(['password' => $password]));
    $check($status === 200 && isset($login['csrf']), 'isolated administrator login succeeds'); $csrf = $login['csrf'];
    [$status, $whoami, $headers] = $request('api.php?a=whoami');
    $check($status === 200 && in_array('Cache-Control: no-store, private', $headers, true), 'administrator JSON and CSRF responses are not cacheable');
    foreach (['{broken', '[]', 'null', '"text"', '{}', '{"unexpected":true}', '{"providers":{}}', '{"providers":[null]}'] as $bad) {
        [$status] = $request('api.php?a=catalog.import', 'POST', $bad);
        $check($status === 400 && file_get_contents($root . '/data/catalog.json') === $original, 'invalid import preserves complete catalog: ' . $bad);
    }
    [$status] = $request('api.php?a=catalog.import', 'POST', json_encode(['providers' => [$catalog['providers'][0], $catalog['providers'][0]]]));
    $check($status === 400 && file_get_contents($root . '/data/catalog.json') === $original, 'duplicate provider identities cannot replace a valid catalog');
    [$status] = $request('api.php?a=catalog.import', 'POST', '{"providers":[],"padding":"' . str_repeat('a', 4194304) . '"}');
    $check($status === 413 && file_get_contents($root . '/data/catalog.json') === $original, 'oversized request cannot consume an unlimited body or replace catalog');
    [$status] = $request('api.php?a=catalog.import', 'GET');
    $check($status === 405 && file_get_contents($root . '/data/catalog.json') === $original, 'GET cannot replace catalog');
    $savedCsrf = $csrf; $csrf = 'wrong-fixture-token';
    [$status] = $request('api.php?a=catalog.import', 'POST', '{"providers":[]}'); $csrf = $savedCsrf;
    $check($status === 419 && file_get_contents($root . '/data/catalog.json') === $original, 'CSRF failure cannot clear catalog');
    [$status, $updated] = $request('api.php?a=catalog.import', 'POST', json_encode(['providers' => $catalog['providers']]));
    $check($status === 200 && $updated['count'] === 1 && $updated['version'] === 4, 'valid import persists exactly once');
    [$status, $release] = $request('pub.php?action=update&platform=win&arch=x64&current=0.6.0');
    $check($status === 200 && $release['url'] === $configuration['update']['files']['win'] && $release['sha256'] === str_repeat('a', 64), 'fallback release URL uses its matching checksum');
    $analyticsBefore = file_get_contents($root . '/data/analytics.json');
    mkdir($root . '/data/analytics.json.tmp' . proc_get_status($process)['pid']);
    [$status] = $request('pub.php?action=catalog');
    $check($status === 200 && file_get_contents($root . '/data/analytics.json') === $analyticsBefore, 'analytics write failure preserves statistics and public catalog availability');
    [$status] = $request('api.php?a=analytics.reset', 'POST', '{}');
    $check($status === 500 && file_get_contents($root . '/data/analytics.json') === $analyticsBefore, 'failed analytics reset returns an error without losing stored statistics');
    echo 'All ' . $checks . ' isolated server HTTP checks passed.' . PHP_EOL;
} finally {
    proc_terminate($process); proc_close($process);
}
