import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const isolated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-member-client-')));
const require = createRequire(import.meta.url);
const bundle = path.join(isolated, 'member-client.cjs');
const originalFetch = globalThis.fetch;
let passed = 0;
await build({
  stdin: { contents: `export * from './src/main/member.ts'; export { AuroraStore } from './src/core/store/index.ts';`, resolveDir: workspace, loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'isolated-electron', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'member-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'member-test' }, () => ({ contents: 'export const app = globalThis.__memberElectron.app; export const safeStorage = globalThis.__memberElectron.safeStorage;', loader: 'js' }));
  } }],
});

function freshApi() { delete require.cache[require.resolve(bundle)]; return require(bundle); }
function fixture(label) {
  const directory = path.join(isolated, label); fs.mkdirSync(directory, { recursive: true });
  const encryptionKey = randomBytes(32);
  const control = { secure: true, activeUser: 1, expired: '', expiredHtml: false, offlineConfig: false, ambiguousClaim: false, disabled: false, offlineLogout: false, alterKey: null, requests: [] };
  const safeStorage = {
    isEncryptionAvailable: () => control.secure, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const bytes = Buffer.from(value); const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'); },
  };
  globalThis.__memberElectron = { app: { getPath: name => { assert.equal(name, 'userData'); return directory; } }, safeStorage };
  const groups = [
    { id: 7, name: 'OpenAI', platform: 'openai', supported: true },
    { id: 8, name: 'Claude', platform: 'anthropic', supported: true },
    { id: 9, name: 'Gemini', platform: 'gemini', supported: true },
    { id: 10, name: 'DeepSeek', platform: 'deepseek', supported: true },
    { id: 11, name: 'Grok', platform: 'grok', supported: true },
    { id: 12, name: 'Unknown', platform: 'future', supported: false },
  ];
  const formats = { openai: 'openai-responses', anthropic: 'anthropic', gemini: 'gemini', deepseek: 'openai-chat', grok: 'openai-chat' };
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://ai.haowucm.cn'); assert.equal(parsed.pathname, '/member.php'); assert.equal(options.redirect, 'error');
    const action = parsed.searchParams.get('a'); const body = options.body ? JSON.parse(options.body) : null;
    control.requests.push({ action, body, headers: { ...options.headers }, method: options.method });
    const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (control.expired === action) return control.expiredHtml ? new Response('<html>Unauthorized</html>', { status: 401 }) : respond({ ok: false, code: 'SESSION_EXPIRED', error: '登录已过期' }, 401);
    if (action === 'config') { if (control.offlineConfig) throw new Error('configuration unavailable'); return respond({ ok: true, enabled: !control.disabled, giftUsd: 10 }); }
    assert.match(options.headers['X-Aurora-Installation'], /^[a-f\d-]{36}$/); assert.match(options.headers['X-Aurora-Installation-Proof'], /^[a-f\d]{64}$/);
    if (['login', 'login2fa', 'bind'].includes(action)) {
      if (body.password === 'two-factor') return respond({ ok: true, requires2fa: true, tempToken: 'challenge-token', emailMasked: 'u***@test.invalid' });
      return respond({ ok: true, sessionToken: String(control.activeUser).repeat(64), accessToken: 'upstream-access-must-stay-private', refreshToken: 'upstream-refresh-must-stay-private', expiresAt: new Date(Date.now() + 3600000).toISOString(), member: { id: control.activeUser, email: 'u@test.invalid', balance: 0 }, gift: { status: 'eligible', amountUsd: 10 } });
    }
    assert.equal(options.headers.authorization, 'Bearer ' + String(control.activeUser).repeat(64));
    if (action === 'status') return respond({ ok: true, member: { id: control.activeUser, balance: 10 }, gift: { status: 'claimed', amountUsd: 10 } });
    if (action === 'groups') return respond({ ok: true, groups });
    if (action === 'claim') { if (control.ambiguousClaim) throw new Error('response lost after request'); return respond({ ok: true, member: { id: control.activeUser, balance: 10 }, gift: { status: 'claimed', amountUsd: 10, code: 'consumed-receipt' } }); }
    if (action === 'logout') { if (control.offlineLogout) throw new Error('simulated network failure'); return respond({ ok: true }); }
    if (action === 'create-client-key') {
      const group = groups.find(g => g.id === body.groupId); assert(group);
      let value = { ok: true, memberId: control.activeUser, id: 123, apiKey: `sk-user-${control.activeUser}-group-${group.id}-private`, group, name: '云桥会员', format: formats[group.platform], baseUrl: 'https://api.yunqiao.me' + (group.platform === 'gemini' ? '' : '/v1') };
      if (control.alterKey) value = control.alterKey(value);
      return respond(value);
    }
    throw new Error('Unexpected member action: ' + action);
  };
  const api = freshApi(); const store = new api.AuroraStore(path.join(directory, 'data'));
  return { api, store, control, directory, safeStorage, groups };
}
async function test(label, run) { await run(); passed++; console.log(`PASS ${label}`); }
const login = async f => f.api.memberAction(f.store, 'member.login', { email: ' user@test.invalid ', password: 'login-password-private' });

try {
  await test('installation and session encrypted, credentials never reach renderer or backup', async () => {
    const f = fixture('encrypted'); const result = await login(f);
    assert(!('sessionToken' in result)); assert(!('accessToken' in result)); assert(!('refreshToken' in result));
    const req = f.control.requests.find(r => r.action === 'login'); assert.equal(req.body.email, 'user@test.invalid');
    const installation = fs.readFileSync(path.join(f.directory, 'member-installation.enc'));
    const persisted = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    for (const secret of [req.headers['X-Aurora-Installation-Proof'], req.headers['X-Aurora-Installation'], '1'.repeat(64), 'login-password-private']) {
      assert(!installation.includes(Buffer.from(secret))); assert(!persisted.includes(Buffer.from(secret))); assert(!JSON.stringify(f.store.exportAll()).includes(secret)); assert(!JSON.stringify(result).includes(secret));
    }
    assert(!fs.existsSync(path.join(f.directory, 'member-installation.json')));
    assert.equal(f.safeStorage.decryptString(persisted), '1'.repeat(64));
  });
  await test('restart preserves both installation proof and encrypted member session', async () => {
    const f = fixture('restart'); await login(f); const previous = f.control.requests.at(-1).headers;
    const fresh = freshApi(); const result = await fresh.memberAction(f.store, 'member.status', {});
    assert.equal(result.loggedIn, true); const current = f.control.requests.at(-1).headers;
    assert.equal(current['X-Aurora-Installation'], previous['X-Aurora-Installation']); assert.equal(current['X-Aurora-Installation-Proof'], previous['X-Aurora-Installation-Proof']);
  });
  await test('legacy plaintext installation migrates without changing identity', async () => {
    const f = fixture('legacy'); const old = { id: '12345678-1234-4321-abcd-123456789abc', proof: 'a'.repeat(64) };
    fs.writeFileSync(path.join(f.directory, 'member-installation.json'), JSON.stringify(old)); await login(f);
    assert.equal(f.control.requests.at(-1).headers['X-Aurora-Installation'], old.id); assert.equal(f.control.requests.at(-1).headers['X-Aurora-Installation-Proof'], old.proof);
    assert(!fs.existsSync(path.join(f.directory, 'member-installation.json')));
  });
  await test('missing secure storage allows public status but prevents credential persistence', async () => {
    const f = fixture('unavailable'); f.control.secure = false;
    assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, false);
    await assert.rejects(() => login(f), /安全存储/); assert.equal(f.control.requests.length, 1);
    assert(!fs.existsSync(path.join(f.directory, 'member-installation.enc')));
  });
  await test('claim authority fields are discarded before fixed server request', async () => {
    const f = fixture('claim'); await login(f);
    const result = await f.api.memberAction(f.store, 'member.claim', { userId: 999, value: 999, code: 'forged', origin: 'https://attacker.invalid' });
    assert.deepEqual(f.control.requests.at(-1).body, {}); assert.equal(result.gift.amountUsd, 10);
  });
  await test('each supported group becomes the correct protocol and no key returns to renderer', async () => {
    const f = fixture('protocols'); await login(f);
    const expected = { 7: 'openai-responses', 8: 'anthropic', 9: 'gemini', 10: 'openai-chat', 11: 'openai-chat' };
    for (const [id, format] of Object.entries(expected)) {
      const r = await f.api.memberAction(f.store, 'member.addProvider', { groupId: Number(id) });
      const provider = f.store.listProviders().find(p => p.id === r.providerId); assert.equal(provider.format, format); assert(!JSON.stringify(r).includes('sk-user-'));
    }
    await assert.rejects(() => f.api.memberAction(f.store, 'member.addProvider', { groupId: 12 }), /协议无效/);
    assert.equal(f.store.listProviders().length, 5);
  });
  await test('repeated add deduplicates keys and explicitly re-enables the chosen key', async () => {
    const f = fixture('deduplicate'); await login(f);
    const r = await f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 });
    const provider = f.store.listProviders()[0]; provider.apiKeys[0].enabled = false; f.store.saveProvider(provider);
    const again = await f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 });
    assert.equal(again.providerId, r.providerId); assert.equal(f.store.listProviders().length, 1); assert.equal(f.store.listProviders()[0].apiKeys.length, 1); assert(f.store.listProviders()[0].apiKeys[0].enabled);
  });
  await test('switching member accounts never combines their provider key pools', async () => {
    const f = fixture('switch'); await login(f); await f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 });
    await f.api.memberAction(f.store, 'member.logout', {}); assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    f.control.activeUser = 2; await login(f); await f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 });
    const providers = f.store.listProviders(); assert.equal(providers.length, 2);
    assert(providers.every(p => p.apiKeys.length === 1)); assert.notEqual(providers[0].presetId, providers[1].presetId);
  });
  await test('expired status and claim clear saved session and permit a fresh login', async () => {
    const f = fixture('expired'); await login(f); f.control.expired = 'status';
    assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, false); assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    f.control.expired = ''; await login(f); f.control.expired = 'claim';
    const expired = await f.api.memberAction(f.store, 'member.claim', {});
    assert.equal(expired.ok, false); assert.equal(expired.loggedIn, false); assert.equal(expired.authExpired, true); assert.match(expired.message, /登录已过期/);
    assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, false);
    f.control.expired = ''; await login(f); assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, true);
  });
  await test('non-JSON authentication failure clears encrypted session and exposes logged-out state independently of config availability', async () => {
    const f = fixture('expired-html'); await login(f); f.control.expired = 'claim'; f.control.expiredHtml = true;
    const result = await f.api.memberAction(f.store, 'member.claim', {});
    assert.equal(result.ok, false); assert.equal(result.loggedIn, false); assert.equal(result.authExpired, true);
    assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    f.control.offlineConfig = true;
    await assert.rejects(() => f.api.memberAction(f.store, 'member.status', {}), /configuration unavailable/);
    assert.equal(f.control.requests.filter(r => r.action === 'claim').length, 1);
  });
  await test('group authentication failure is explicit and an ambiguous claim never retries or reconciles automatically', async () => {
    const f = fixture('ambiguous'); await login(f); f.control.expired = 'groups';
    const expired = await f.api.memberAction(f.store, 'member.groups', {});
    assert.equal(expired.authExpired, true); assert.equal(expired.loggedIn, false);
    f.control.expired = ''; await login(f); f.control.ambiguousClaim = true;
    const before = f.control.requests.length;
    await assert.rejects(() => f.api.memberAction(f.store, 'member.claim', {}), /response lost/);
    assert.deepEqual(f.control.requests.slice(before).map(r => r.action), ['claim']);
    assert(fs.existsSync(path.join(f.directory, 'member-session.enc')));
  });
  await test('late status responses cannot clear a newer login or expose the prior account', async () => {
    for (const responseKind of ['html-401', 'json-auth', 'success', 'same-token-success', 'body-auth']) {
      const f = fixture('late-' + responseKind); await login(f);
      const mockFetch = globalThis.fetch;
      let release, entered;
      const started = new Promise(resolve => { entered = resolve; });
      let first = true;
      globalThis.fetch = async (url, options) => {
        if (new URL(url).searchParams.get('a') !== 'status' || !first) return mockFetch(url, options);
        first = false;
        assert.equal(options.headers.authorization, 'Bearer ' + '1'.repeat(64));
        const waiting = new Promise(resolve => { release = resolve; });
        const body = responseKind === 'body-auth'
          ? { status: 200, ok: true, text: async () => { entered(); await waiting; return JSON.stringify({ ok: false, code: 'AUTH_REJECTED', error: 'old session' }); } }
          : null;
        if (body) return body;
        entered(); await waiting;
        if (responseKind === 'html-401') return new Response('<html>expired old session</html>', { status: 401 });
        if (responseKind === 'json-auth') return new Response(JSON.stringify({ ok: false, code: 'AUTH_REJECTED', error: 'old session' }));
        return new Response(JSON.stringify({ ok: true, member: { id: 1, balance: 111 }, gift: { status: 'claimed' } }));
      };
      const oldStatus = f.api.memberAction(f.store, 'member.status', {});
      const rejected = assert.rejects(oldStatus, /登录状态已变化/);
      await started;
      f.control.activeUser = responseKind === 'same-token-success' ? 1 : 2;
      await login(f);
      const encryptedBefore = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
      release(); await rejected;
      assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), encryptedBefore);
      const latest = await f.api.memberAction(f.store, 'member.status', {});
      assert.equal(latest.loggedIn, true); assert.equal(latest.member.id, f.control.activeUser);
      assert.notEqual(latest.member.balance, 111);
    }
  });
  await test('offline logout still clears local credentials and reports remote limitation', async () => {
    const f = fixture('logout'); await login(f); f.control.offlineLogout = true;
    const result = await f.api.memberAction(f.store, 'member.logout', {}); assert(result.ok); assert.match(result.message, /远端会话/);
    assert(!fs.existsSync(path.join(f.directory, 'member-session.enc'))); assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, false);
  });
  await test('mismatched supplier URL, protocol and group cannot save a provider', async () => {
    const f = fixture('invalid'); await login(f);
    for (const alter of [v => ({ ...v, baseUrl: 'https://attacker.invalid/v1' }), v => ({ ...v, format: 'anthropic' }), v => ({ ...v, group: { ...v.group, id: 8 } }), v => ({ ...v, memberId: undefined })]) {
      f.control.alterKey = alter; await assert.rejects(() => f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 }), /协议无效/);
    }
    assert.equal(f.store.listProviders().length, 0);
  });
  await test('two-factor challenge and completion use the agreed contract', async () => {
    const f = fixture('two-factor'); const challenge = await f.api.memberAction(f.store, 'member.login', { email: 'u@test.invalid', password: 'two-factor' });
    assert(challenge.requires2fa); assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    await f.api.memberAction(f.store, 'member.login2fa', { tempToken: challenge.tempToken, code: '123456' });
    assert.deepEqual(f.control.requests.at(-1).body, { tempToken: 'challenge-token', totpCode: '123456' });
  });
  console.log(`All ${passed} desktop membership integration tests passed.`);
} finally {
  globalThis.fetch = originalFetch; delete globalThis.__memberElectron;
  assert.equal(path.dirname(isolated), fs.realpathSync(os.tmpdir()));
  assert(path.basename(isolated).startsWith('aurora-member-client-'));
  fs.rmSync(isolated, { recursive: true, force: true });
}
