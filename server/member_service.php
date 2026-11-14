<?php
/** Installation-bound member sessions and one-time sub2api welcome credit. */
declare(strict_types=1);

final class MemberError extends RuntimeException
{
    public int $httpStatus;
    public string $errorCode;
    public function __construct(string $errorCode, string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->httpStatus = $status;
        $this->errorCode = $errorCode;
    }
}

final class MemberService
{
    public const GIFT_USD = 10;
    private const CAMPAIGN = 'aurora-first-member-v1';
    private array $config;
    private ?PDO $db = null;
    private $transport;

    public static function environment(): array
    {
        $file = '/www/aurora-data/member-secrets.json';
        $stored = [];
        if (is_file($file)) {
            if (is_link($file) || (fileperms($file) & 0077) !== 0) throw new RuntimeException('Member secrets permissions must be 0600');
            $stored = json_decode((string)file_get_contents($file), true, 16, JSON_THROW_ON_ERROR);
            if (!is_array($stored)) throw new RuntimeException('Invalid member secrets');
        }
        $setting = static function (string $environment, string $field, $fallback) use ($stored) {
            $value = getenv($environment);
            return $value !== false ? $value : ($stored[$field] ?? $fallback);
        };
        return [
            'enabled' => in_array($setting('AURORA_MEMBERS_ENABLED', 'enabled', false), [true, '1'], true),
            'origin' => rtrim((string)$setting('AURORA_SUB2API_URL', 'origin', 'https://api.yunqiao.me'), '/'),
            'adminKey' => (string)$setting('AURORA_SUB2API_ADMIN_KEY', 'adminKey', ''),
            'secret' => (string)$setting('AURORA_MEMBER_SECRET', 'secret', ''),
            'dataDir' => (string)$setting('AURORA_MEMBER_DATA_DIR', 'dataDir', '/www/aurora-data/members'),
        ];
    }

    /** A transport can only be injected by trusted PHP code, never an HTTP parameter. */
    public function __construct(array $config, ?callable $transport = null)
    {
        $this->config = $config;
        $this->transport = $transport;
    }

    public function publicConfig(): array
    {
        return ['ok' => true, 'enabled' => $this->configured(), 'giftUsd' => self::GIFT_USD,
            'currency' => 'USD', 'accountUrl' => $this->validOrigin() ? $this->config['origin'] : 'https://api.yunqiao.me',
            'campaign' => self::CAMPAIGN];
    }

    private function validOrigin(): bool
    {
        $url = parse_url((string)($this->config['origin'] ?? ''));
        return is_array($url) && ($url['scheme'] ?? '') === 'https' && !empty($url['host'])
            && !isset($url['user']) && !isset($url['pass'])
            && !isset($url['query']) && !isset($url['fragment']) && empty($url['path'])
            && (!isset($url['port']) || $url['port'] === 443);
    }

    private function configured(): bool
    {
        return ($this->config['enabled'] ?? false) === true && $this->validOrigin()
            && strlen((string)($this->config['adminKey'] ?? '')) >= 12
            && strlen((string)($this->config['secret'] ?? '')) >= 32;
    }

    private function database(): PDO
    {
        if ($this->db) return $this->db;
        umask(0077);
        $dir = (string)($this->config['dataDir'] ?? '');
        if ($dir === '' || (!is_dir($dir) && !@mkdir($dir, 0700, true))) {
            throw new MemberError('STORAGE_UNAVAILABLE', '会员存储暂不可用', 503);
        }
        // A missing/corrupt existing database is never silently replaced with an empty ledger.
        $path = $dir . '/members.sqlite';
        $marker = $dir . '/members.initialized';
        if (is_file($marker) && !is_file($path)) throw new MemberError('STORAGE_UNAVAILABLE', '会员账本缺失，请联系管理员恢复备份', 503);
        if (is_link($path)) throw new MemberError('STORAGE_UNAVAILABLE', '会员存储暂不可用', 503);
        $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $db->exec('PRAGMA busy_timeout=10000');
        $db->exec('PRAGMA journal_mode=WAL');
        $db->exec('PRAGMA synchronous=FULL');
        $db->exec('PRAGMA foreign_keys=ON');
        $db->exec('CREATE TABLE IF NOT EXISTS member_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS installations (id_hash TEXT PRIMARY KEY, proof_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS member_sessions (token_hash TEXT PRIMARY KEY, installation_hash TEXT NOT NULL REFERENCES installations(id_hash), user_id INTEGER NOT NULL, profile TEXT NOT NULL, upstream_token TEXT NOT NULL, expires_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS member_sessions_expiry ON member_sessions(expires_at);
            CREATE TABLE IF NOT EXISTS welcome_grants (user_id INTEGER PRIMARY KEY, installation_hash TEXT NOT NULL UNIQUE REFERENCES installations(id_hash), code TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN (\'pending\',\'claimed\',\'review\')), amount_cents INTEGER NOT NULL CHECK(amount_cents=1000), created_at INTEGER NOT NULL, claimed_at INTEGER, upstream_id INTEGER, last_error TEXT);
            CREATE TABLE IF NOT EXISTS member_rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);');
        @chmod($path, 0600);
        $this->db = $db;
        $this->transaction(function () use ($db): void {
            $origin = $db->query("SELECT value FROM member_meta WHERE key='upstream_origin'")->fetchColumn();
            if ($origin === false) {
                $this->execute("INSERT INTO member_meta(key,value) VALUES('upstream_origin',?)", [$this->config['origin']]);
            } elseif (!hash_equals((string)$origin, $this->config['origin'])) {
                throw new MemberError('UPSTREAM_CHANGED', '会员站点变更需要管理员迁移账本', 503);
            }
        });
        if (!is_file($marker) && @file_put_contents($marker, "aurora-members-v1\n", LOCK_EX) === false) {
            throw new MemberError('STORAGE_UNAVAILABLE', '无法确认会员账本状态', 503);
        }
        return $db;
    }

    private function execute(string $sql, array $parameters = []): PDOStatement
    {
        $q = $this->database()->prepare($sql);
        $q->execute($parameters);
        return $q;
    }

    private function transaction(callable $run)
    {
        $db = $this->database();
        $db->exec('BEGIN IMMEDIATE');
        try {
            $result = $run();
            $db->exec('COMMIT');
            return $result;
        } catch (Throwable $error) {
            $db->exec('ROLLBACK');
            throw $error;
        }
    }

    private function rateLimit(string $kind, string $identity, int $limit, int $window): void
    {
        $key = hash_hmac('sha256', $kind . ':' . $identity, $this->config['secret']);
        $this->transaction(function () use ($key, $limit, $window): void {
            $row = $this->execute('SELECT * FROM member_rate_limits WHERE key=?', [$key])->fetch(PDO::FETCH_ASSOC);
            $now = time();
            if ($row && $row['window_start'] > $now - $window && $row['attempts'] >= $limit) {
                throw new MemberError('RATE_LIMITED', '请求过于频繁，请稍后再试', 429);
            }
            $fresh = !$row || $row['window_start'] <= $now - $window;
            $this->execute('INSERT OR REPLACE INTO member_rate_limits(key,window_start,attempts) VALUES(?,?,?)',
                [$key, $fresh ? $now : $row['window_start'], $fresh ? 1 : $row['attempts'] + 1]);
            $this->execute('DELETE FROM member_rate_limits WHERE window_start<?', [$now - 86400]);
        });
    }

    private function installation(array $credentials, bool $create): string
    {
        $id = (string)($credentials['installationId'] ?? '');
        $proof = (string)($credentials['installationProof'] ?? '');
        if (!preg_match('/^[a-zA-Z0-9_-]{16,80}$/D', $id) || !preg_match('/^[a-f0-9]{64}$/D', $proof)) {
            throw new MemberError('INSTALLATION_REQUIRED', '客户端安装凭据无效', 401);
        }
        $idHash = hash('sha256', $id);
        $proofHash = hash('sha256', $proof);
        $this->transaction(function () use ($idHash, $proofHash, $create): void {
            $row = $this->execute('SELECT proof_hash FROM installations WHERE id_hash=?', [$idHash])->fetch(PDO::FETCH_ASSOC);
            if (!$row && $create) {
                $this->execute('INSERT INTO installations(id_hash,proof_hash,created_at) VALUES(?,?,?)', [$idHash, $proofHash, time()]);
            } elseif (!$row || !hash_equals($row['proof_hash'], $proofHash)) {
                throw new MemberError('INSTALLATION_MISMATCH', '客户端安装凭据不匹配', 401);
            }
        });
        return $idHash;
    }

    private function seal(string $token): string
    {
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt($token, 'aes-256-gcm', hash('sha256', $this->config['secret'], true), OPENSSL_RAW_DATA, $iv, $tag, self::CAMPAIGN);
        if ($cipher === false) throw new RuntimeException('Token encryption failed');
        return base64_encode($iv . $tag . $cipher);
    }

    private function unseal(string $value): string
    {
        $bytes = base64_decode($value, true);
        $token = $bytes !== false && strlen($bytes) > 28
            ? openssl_decrypt(substr($bytes, 28), 'aes-256-gcm', hash('sha256', $this->config['secret'], true), OPENSSL_RAW_DATA, substr($bytes, 0, 12), substr($bytes, 12, 16), self::CAMPAIGN) : false;
        if ($token === false) throw new MemberError('SESSION_EXPIRED', '会员登录已失效，请重新登录', 401);
        return $token;
    }

    private function request(string $method, string $path, array $headers, ?array $body = null): array
    {
        if ($this->transport) {
            $response = ($this->transport)($method, $path, $headers, $body);
        } else {
            if (!function_exists('curl_init')) throw new MemberError('UPSTREAM_UNAVAILABLE', '会员服务暂不可用', 503);
            $curl = curl_init($this->config['origin'] . '/api/v1' . $path);
            $buffer = '';
            curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_HTTPHEADER => array_merge(['Accept: application/json', 'Content-Type: application/json'], $headers),
                CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 25, CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_RETURNTRANSFER => false,
                CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$buffer): int {
                    if (strlen($buffer) + strlen($chunk) > 1048576) return 0;
                    $buffer .= $chunk;
                    return strlen($chunk);
                }]);
            if ($body !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($body, JSON_THROW_ON_ERROR));
            $success = curl_exec($curl);
            $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            curl_close($curl);
            if ($success === false) throw new MemberError('UPSTREAM_UNAVAILABLE', '会员服务连接中断，可稍后安全重试', 503);
            $response = ['status' => $status, 'body' => json_decode($buffer, true)];
        }
        $status = (int)($response['status'] ?? 0);
        $payload = $response['body'] ?? null;
        if ($status < 200 || $status >= 300 || !is_array($payload) || ($payload['code'] ?? null) !== 0 || !is_array($payload['data'] ?? null)) {
            if (in_array($status, [401, 403], true) && !str_starts_with($path, '/admin/')) {
                throw new MemberError('AUTH_REJECTED', '会员身份验证失败，请检查登录信息或重新登录', 401);
            }
            if ($status === 429) throw new MemberError('UPSTREAM_RATE_LIMITED', '会员站点请求频繁，请稍后再试', 429);
            if ($path === '/auth/login' || $path === '/auth/login/2fa') {
                throw new MemberError('LOGIN_REJECTED', '登录失败；如站点要求验证码，请在会员网站完成登录后绑定访问令牌', 400);
            }
            throw new MemberError('UPSTREAM_UNAVAILABLE', '会员服务暂未确认结果，请稍后重试', 503);
        }
        return $payload['data'];
    }

    private function profile(string $accessToken): array
    {
        if ($accessToken === '' || strlen($accessToken) > 16384 || preg_match('/[\r\n]/', $accessToken)) {
            throw new MemberError('AUTH_REJECTED', '会员访问令牌无效', 401);
        }
        $user = $this->request('GET', '/auth/me', ['Authorization: Bearer ' . $accessToken]);
        if (!is_int($user['id'] ?? null) || $user['id'] <= 0 || ($user['status'] ?? '') !== 'active') {
            throw new MemberError('ACCOUNT_INACTIVE', '会员账户不可用', 403);
        }
        return ['id' => $user['id'], 'email' => (string)($user['email'] ?? ''),
            'username' => (string)($user['username'] ?? ''), 'balance' => (float)($user['balance'] ?? 0)];
    }

    private function createSession(string $accessToken, array $credentials, int $expiresIn = 3600): array
    {
        // The upstream authenticated identity is the only source of user_id.
        $profile = $this->profile($accessToken);
        $installation = $this->installation($credentials, true);
        $token = bin2hex(random_bytes(32));
        $expiresAt = time() + max(60, min(3600, $expiresIn));
        $this->transaction(function () use ($token, $installation, $profile, $accessToken, $expiresAt): void {
            $this->execute('DELETE FROM member_sessions WHERE expires_at<? OR installation_hash=?', [time(), $installation]);
            $this->execute('INSERT INTO member_sessions(token_hash,installation_hash,user_id,profile,upstream_token,expires_at) VALUES(?,?,?,?,?,?)',
                [hash('sha256', $token), $installation, $profile['id'], json_encode($profile, JSON_THROW_ON_ERROR), $this->seal($accessToken), $expiresAt]);
        });
        return ['ok' => true, 'sessionToken' => $token, 'expiresAt' => gmdate('c', $expiresAt),
            'member' => $profile, 'gift' => $this->gift($profile['id'], $installation)];
    }

    private function session(array $credentials): array
    {
        $installation = $this->installation($credentials, false);
        $token = (string)($credentials['sessionToken'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/D', $token)) throw new MemberError('SESSION_REQUIRED', '请先登录会员账户', 401);
        $row = $this->execute('SELECT * FROM member_sessions WHERE token_hash=?', [hash('sha256', $token)])->fetch(PDO::FETCH_ASSOC);
        if (!$row || $row['expires_at'] <= time() || !hash_equals($row['installation_hash'], $installation)) {
            throw new MemberError('SESSION_EXPIRED', '会员登录已失效，请重新登录', 401);
        }
        return $row;
    }

    private function gift(int $userId, string $installation): array
    {
        $grant = $this->execute('SELECT * FROM welcome_grants WHERE user_id=?', [$userId])->fetch(PDO::FETCH_ASSOC);
        if ($grant) {
            $result = ['status' => $grant['status'], 'amountUsd' => self::GIFT_USD, 'currency' => 'USD', 'campaign' => self::CAMPAIGN];
            if ($grant['status'] === 'claimed') {
                $result['code'] = $grant['code'];
                $result['claimedAt'] = gmdate('c', (int)$grant['claimed_at']);
            }
            if ($grant['status'] === 'review') $result['message'] = '赠金凭据需要管理员核对，请勿重复兑换';
            return $result;
        }
        $used = $this->execute('SELECT 1 FROM welcome_grants WHERE installation_hash=?', [$installation])->fetchColumn();
        return ['status' => $used ? 'ineligible' : 'eligible', 'amountUsd' => self::GIFT_USD,
            'currency' => 'USD', 'campaign' => self::CAMPAIGN,
            'message' => $used ? '此安装已为其他会员领取过首次使用赠金' : '首次绑定会员可领取 $10 体验额度'];
    }

    private function validateReceipt(array $grant, array $receipt): void
    {
        if (($receipt['code'] ?? '') !== $grant['code'] || ($receipt['type'] ?? '') !== 'balance'
            || !is_numeric($receipt['value'] ?? null) || (float)$receipt['value'] !== (float)self::GIFT_USD
            || ($receipt['used_by'] ?? null) !== (int)$grant['user_id'] || ($receipt['status'] ?? '') !== 'used'
            || !is_int($receipt['id'] ?? null) || $receipt['id'] <= 0) {
            $this->execute("UPDATE welcome_grants SET status='review',last_error='RECEIPT_MISMATCH' WHERE user_id=? AND status='pending'", [$grant['user_id']]);
            throw new MemberError('GRANT_REVIEW_REQUIRED', '赠金凭据与账户不匹配，需要管理员核对', 409);
        }
    }

    private function fulfill(array $grant, bool $readOnly = false): void
    {
        if ($grant['status'] === 'claimed') return;
        if ($grant['status'] === 'review' && !$readOnly) throw new MemberError('GRANT_REVIEW_REQUIRED', '赠金凭据需要管理员核对', 409);
        $headers = ['x-api-key: ' . $this->config['adminKey']];
        // Recover a consumed code even after the upstream idempotency cache has expired.
        $found = $this->request('GET', '/admin/redeem-codes?search=' . rawurlencode($grant['code']) . '&page_size=100', $headers);
        if (!is_array($found['items'] ?? null)) throw new MemberError('UPSTREAM_UNAVAILABLE', '无法核对赠金凭据', 503);
        $receipt = null;
        foreach ($found['items'] as $item) {
            if (is_array($item) && ($item['code'] ?? '') === $grant['code']) { $receipt = $item; break; }
        }
        if ($receipt !== null && (($receipt['type'] ?? '') !== 'balance' || (float)($receipt['value'] ?? 0) !== (float)self::GIFT_USD)) {
            $this->validateReceipt($grant, $receipt);
        }
        if ($receipt === null || ($receipt['status'] ?? '') !== 'used') {
            if ($readOnly) throw new MemberError('GRANT_PENDING', '上游尚无已核销凭据，额度未被确认到账', 409);
            $result = $this->request('POST', '/admin/redeem-codes/create-and-redeem',
                array_merge($headers, ['Idempotency-Key: ' . $grant['code']]),
                ['code' => $grant['code'], 'type' => 'balance', 'value' => self::GIFT_USD, 'user_id' => (int)$grant['user_id'], 'notes' => self::CAMPAIGN]);
            $receipt = is_array($result['redeem_code'] ?? null) ? $result['redeem_code'] : [];
        }
        $this->validateReceipt($grant, $receipt);
        $this->execute("UPDATE welcome_grants SET status='claimed',claimed_at=?,upstream_id=?,last_error=NULL WHERE user_id=? AND status IN ('pending','review')", [time(), $receipt['id'], $grant['user_id']]);
    }

    /** Only call behind the existing web administrator session and CSRF protection. */
    public function adminOverview(): array
    {
        $configuration = $this->publicConfig();
        if (!$this->configured()) return array_merge($configuration, ['grants' => [], 'totals' => ['claimed' => 0, 'pending' => 0, 'review' => 0, 'amountUsd' => 0]]);
        $totals = ['claimed' => 0, 'pending' => 0, 'review' => 0, 'amountUsd' => 0];
        foreach ($this->database()->query('SELECT status,COUNT(*) AS count FROM welcome_grants GROUP BY status')->fetchAll(PDO::FETCH_ASSOC) as $row) $totals[$row['status']] = (int)$row['count'];
        $totals['amountUsd'] = $totals['claimed'] * self::GIFT_USD;
        $grants = $this->database()->query('SELECT user_id AS userId,status,created_at AS createdAt,claimed_at AS claimedAt,last_error AS lastError,upstream_id AS upstreamId FROM welcome_grants ORDER BY created_at DESC LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
        return array_merge($configuration, ['totals' => $totals, 'grants' => $grants]);
    }

    public function adminReconcile(int $userId, bool $retry): array
    {
        if (!$this->configured()) throw new MemberError('MEMBERS_DISABLED', '会员服务尚未启用', 503);
        $grant = $this->execute('SELECT * FROM welcome_grants WHERE user_id=?', [$userId])->fetch(PDO::FETCH_ASSOC);
        if (!$grant) throw new MemberError('GRANT_NOT_FOUND', '该账户没有客户端赠金申请', 404);
        $this->fulfill($grant, !$retry);
        return ['ok' => true, 'gift' => $this->gift($userId, $grant['installation_hash'])];
    }

    private function availableGroups(string $accessToken): array
    {
        $groups = $this->request('GET', '/groups/available', ['Authorization: Bearer ' . $accessToken]);
        $result = [];
        foreach ($groups as $group) {
            if (!is_array($group) || !is_int($group['id'] ?? null) || !is_string($group['platform'] ?? null) || ($group['status'] ?? '') !== 'active') continue;
            $result[] = ['id' => $group['id'], 'name' => (string)($group['name'] ?? ''), 'platform' => $group['platform'],
                'supported' => in_array($group['platform'], ['anthropic', 'openai', 'gemini', 'deepseek', 'grok'], true),
                'rateMultiplier' => (float)($group['rate_multiplier'] ?? 1)];
        }
        return $result;
    }

    private function createClientKey(array $session, array $body): array
    {
        $this->rateLimit('client-key', (string)$session['user_id'], 6, 60);
        $accessToken = $this->unseal($session['upstream_token']);
        $profile = $this->profile($accessToken);
        if ($profile['id'] !== (int)$session['user_id']) throw new MemberError('AUTH_REJECTED', '会员身份不匹配', 401);
        $groups = $this->availableGroups($accessToken);
        $groupId = $body['groupId'] ?? (count($groups) === 1 ? $groups[0]['id'] : null);
        $selected = null;
        foreach ($groups as $group) if ($group['id'] === $groupId) $selected = $group;
        if (!$selected) throw new MemberError('GROUP_REQUIRED', '请选择当前会员可使用的模型分组');
        if (!$selected['supported']) throw new MemberError('PLATFORM_UNSUPPORTED', '该分组协议暂未支持一键接入，请到平台网站查看配置说明');
        // A stable custom key also prevents duplication after the upstream idempotency TTL expires.
        $key = 'sk-yunqiao-' . hash_hmac('sha256', 'client-key-v1:' . $session['user_id'] . ':' . $session['installation_hash'] . ':' . $groupId, $this->config['secret']);
        $headers = ['Authorization: Bearer ' . $accessToken];
        $keys = $this->request('GET', '/keys?search=' . rawurlencode('yunqiao.me 客户端') . '&page_size=100', $headers);
        if (!is_array($keys['items'] ?? null)) throw new MemberError('UPSTREAM_UNAVAILABLE', '无法核对客户端密钥', 503);
        $entry = null;
        foreach ($keys['items'] as $candidate) if (is_array($candidate) && ($candidate['key'] ?? '') === $key) { $entry = $candidate; break; }
        if (!$entry) {
            if (($keys['total'] ?? count($keys['items'])) > 100) throw new MemberError('KEY_REVIEW_REQUIRED', '客户端密钥过多，请到会员站点管理后重试', 409);
            $entry = $this->request('POST', '/keys', array_merge($headers, ['Idempotency-Key: YQ-CLIENT-' . hash('sha256', $key)]),
                ['name' => 'yunqiao.me 客户端', 'group_id' => $groupId, 'custom_key' => $key]);
        }
        if (($entry['key'] ?? '') !== $key || ($entry['user_id'] ?? null) !== $profile['id'] || ($entry['group_id'] ?? null) !== $groupId || ($entry['status'] ?? '') !== 'active') {
            throw new MemberError('KEY_REVIEW_REQUIRED', '客户端密钥状态不符，请到会员站点核对', 409);
        }
        $format = ['openai' => 'openai-responses', 'anthropic' => 'anthropic', 'gemini' => 'gemini', 'deepseek' => 'openai-chat', 'grok' => 'openai-chat'][$selected['platform']];
        return ['ok' => true, 'apiKey' => $key, 'id' => $entry['id'], 'memberId' => $profile['id'], 'name' => '云桥会员', 'group' => $selected,
            'baseUrl' => $this->config['origin'] . ($format === 'gemini' ? '' : '/v1'), 'format' => $format];
    }

    public function handle(string $action, array $body, array $credentials, string $remoteAddress = 'unknown'): array
    {
        if ($action === 'config') return $this->publicConfig();
        if (!$this->configured()) throw new MemberError('MEMBERS_DISABLED', '会员服务尚未启用', 503);
        // Reject authoritative fields outright instead of accidentally accepting a future UI field.
        foreach (['userId', 'user_id', 'amount', 'amountUsd', 'value', 'code', 'adminKey', 'origin'] as $forbidden) {
            if (array_key_exists($forbidden, $body)) throw new MemberError('INVALID_FIELDS', '请求包含不允许的会员字段');
        }
        if (in_array($action, ['login', 'login2fa', 'bind'], true)) {
            $this->rateLimit('login', $remoteAddress, 12, 300);
            if ($action === 'bind') return $this->createSession((string)($body['accessToken'] ?? ''), $credentials);
            if ($action === 'login') {
                $email = (string)($body['email'] ?? '');
                $password = (string)($body['password'] ?? '');
                if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 1 || strlen($password) > 1024) {
                    throw new MemberError('INVALID_LOGIN', '请输入有效邮箱和密码');
                }
                $payload = ['email' => $email, 'password' => $password];
                foreach (['turnstile_token', 'tencent_captcha_ticket', 'tencent_captcha_randstr'] as $field) {
                    if (isset($body[$field]) && is_string($body[$field]) && strlen($body[$field]) <= 8192) $payload[$field] = $body[$field];
                }
                $auth = $this->request('POST', '/auth/login', [], $payload);
                if (($auth['requires_2fa'] ?? false) === true) {
                    return ['ok' => true, 'requires2fa' => true, 'tempToken' => (string)($auth['temp_token'] ?? ''),
                        'emailMasked' => (string)($auth['user_email_masked'] ?? '')];
                }
            } else {
                if (!preg_match('/^[0-9]{6}$/D', (string)($body['totpCode'] ?? '')) || strlen((string)($body['tempToken'] ?? '')) > 16384) {
                    throw new MemberError('INVALID_2FA', '请输入六位动态验证码');
                }
                $auth = $this->request('POST', '/auth/login/2fa', [], ['temp_token' => (string)($body['tempToken'] ?? ''), 'totp_code' => $body['totpCode']]);
            }
            return $this->createSession((string)($auth['access_token'] ?? ''), $credentials, (int)($auth['expires_in'] ?? 3600));
        }
        $session = $this->session($credentials);
        $userId = (int)$session['user_id'];
        $installation = $session['installation_hash'];
        if ($action === 'logout') {
            $this->execute('DELETE FROM member_sessions WHERE token_hash=?', [$session['token_hash']]);
            return ['ok' => true];
        }
        if ($action === 'status') {
            $profile = $this->profile($this->unseal($session['upstream_token']));
            if ($profile['id'] !== $userId) throw new MemberError('AUTH_REJECTED', '会员身份不匹配', 401);
            $this->execute('UPDATE member_sessions SET profile=? WHERE token_hash=?', [json_encode($profile, JSON_THROW_ON_ERROR), $session['token_hash']]);
            return ['ok' => true, 'expiresAt' => gmdate('c', (int)$session['expires_at']),
                'member' => $profile, 'gift' => $this->gift($userId, $installation)];
        }
        if ($action === 'groups') return ['ok' => true, 'groups' => $this->availableGroups($this->unseal($session['upstream_token']))];
        if ($action === 'create-client-key') return $this->createClientKey($session, $body);
        if ($action !== 'claim') throw new MemberError('UNKNOWN_ACTION', '会员操作不存在', 404);
        $this->rateLimit('claim', (string)$userId, 20, 60);
        $profile = $this->profile($this->unseal($session['upstream_token']));
        if ($profile['id'] !== $userId) throw new MemberError('AUTH_REJECTED', '会员身份不匹配', 401);
        $grant = $this->transaction(function () use ($userId, $installation): array {
            $existing = $this->execute('SELECT * FROM welcome_grants WHERE user_id=?', [$userId])->fetch(PDO::FETCH_ASSOC);
            if ($existing) return $existing;
            if ($this->execute('SELECT 1 FROM welcome_grants WHERE installation_hash=?', [$installation])->fetchColumn()) {
                throw new MemberError('INSTALLATION_ALREADY_CLAIMED', '此安装已领取过首次使用赠金', 409);
            }
            // Stable across every retry and process crash; committed before any external side effect.
            $code = 'YQ-WELCOME-' . strtoupper(hash_hmac('sha256', self::CAMPAIGN . ':' . $this->config['origin'] . ':' . $userId, $this->config['secret']));
            $this->execute('INSERT INTO welcome_grants(user_id,installation_hash,code,status,amount_cents,created_at) VALUES(?,?,?,\'pending\',1000,?)', [$userId, $installation, $code, time()]);
            return $this->execute('SELECT * FROM welcome_grants WHERE user_id=?', [$userId])->fetch(PDO::FETCH_ASSOC);
        });
        if ($grant['status'] !== 'claimed') {
            try {
                $this->fulfill($grant);
            } catch (MemberError $error) {
                $this->execute("UPDATE welcome_grants SET last_error=? WHERE user_id=? AND status='pending'", [$error->errorCode, $userId]);
                throw $error;
            }
        }
        // A receipt is authoritative; balance is refreshed separately and never inferred by adding 10.
        try { $profile = $this->profile($this->unseal($session['upstream_token'])); } catch (MemberError $ignored) { }
        $this->execute('UPDATE member_sessions SET profile=? WHERE token_hash=?', [json_encode($profile, JSON_THROW_ON_ERROR), $session['token_hash']]);
        return ['ok' => true, 'member' => $profile, 'gift' => $this->gift($userId, $installation)];
    }
}
