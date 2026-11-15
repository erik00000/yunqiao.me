import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-local-clients-')));
const require = createRequire(import.meta.url);
const bundle = path.join(temporaryRoot, 'local-clients.cjs');
await build({ stdin: { contents: `export * from './src/core/localClients.ts'; export { AuroraStore } from './src/core/store/index.ts';`, resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const api = require(bundle);
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text)); };
let passed = 0;
function fixture(name) { const home = path.join(temporaryRoot, name); fs.mkdirSync(home); return { home, store: new api.AuroraStore(path.join(home, 'store')), options: { home, platform: 'win32' } }; }
function scan(f, options = {}) { return api.syncLocalClients(f.store, { ...f.options, force: true, ...options }); }
function codex(f, config, auth) { write(path.join(f.home, '.codex', 'config.toml'), config); if (auth) write(path.join(f.home, '.codex', 'auth.json'), auth); }
function test(label, run) { run(); passed++; console.log(`PASS ${label}`); }
const relayConfig = (key, name = 'Relay') => `model_provider = "relay"\nmodel = "gpt-current"\n[model_providers.relay]\nname = ${JSON.stringify(name)}\nbase_url = "https://relay.test/v1"\nwire_api = "responses"\nexperimental_bearer_token = ${JSON.stringify(key)}\n`;

try {
  test('official OAuth and independent third-party providers coexist without auth writes', () => {
    const f = fixture('oauth-coexist');
    codex(f, relayConfig('sk-relay-current-key'), { auth_mode: 'chatgpt', tokens: { access_token: 'official-oauth-access-private', refresh_token: 'official-refresh-private' } });
    write(path.join(f.home, '.claude', '.credentials.json'), { claudeAiOauth: { accessToken: 'claude-oauth-private', refreshToken: 'claude-refresh-private', expiresAt: Date.now() - 1000, subscriptionType: 'max' } });
    const authBefore = fs.readFileSync(path.join(f.home, '.codex', 'auth.json'));
    const configBefore = fs.readFileSync(path.join(f.home, '.codex', 'config.toml'));
    const result = scan(f); assert.equal(result.added, 1); assert.equal(result.accounts.length, 2);
    assert(result.accounts.every(a => a.authKind === 'oauth' && a.importable === false)); assert(result.accounts.some(a => a.kind === 'claude' && a.credentialStatus === 'expired'));
    assert.deepEqual(fs.readFileSync(path.join(f.home, '.codex', 'auth.json')), authBefore); assert.deepEqual(fs.readFileSync(path.join(f.home, '.codex', 'config.toml')), configBefore);
    assert.equal(f.store.listProviders()[0].apiKeys[0].key, 'sk-relay-current-key'); assert.equal(f.store.listProviders()[0].official, false);
    const snapshot = JSON.stringify(result) + fs.readFileSync(path.join(f.store.dir, 'local-client-imports.json'), 'utf8');
    for (const secret of ['sk-relay-current-key', 'official-oauth-access-private', 'official-refresh-private', 'claude-oauth-private']) assert(!snapshot.includes(secret));
  });
  test('current profile maps auth.json API key to the actual custom URL', () => {
    const f = fixture('profile-auth');
    codex(f, `profile = "work profile"\nmodel_provider = "openai"\n[profiles."work profile"]\nmodel_provider = "private endpoint"\nmodel = "custom-model"\n[model_providers."private endpoint"]\nname="Private endpoint"\nbase_url="https://private.test/custom/v1"\nwire_api="responses"\nrequires_openai_auth=true\n[mcp_servers.example]\nargs=["--flag", "some=value"]\n`, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-custom-auth-configuration' });
    const result = scan(f); assert.equal(result.added, 1); const provider = f.store.listProviders()[0];
    assert.equal(provider.baseUrl, 'https://private.test/custom/v1'); assert.equal(provider.apiKeys[0].key, 'sk-custom-auth-configuration'); assert.deepEqual(provider.models.map(m => m.id), ['custom-model']); assert(!result.accounts.length);
    assert(!f.store.listProviders().some(p => p.baseUrl.includes('api.openai.com')));
  });
  test('standalone API auth defaults to official only when no custom provider is selected', () => {
    const official = fixture('official-key'); write(path.join(official.home, '.codex', 'auth.json'), { OPENAI_API_KEY: 'sk-official-api-stored' });
    assert.equal(scan(official).added, 1); assert.equal(official.store.listProviders()[0].baseUrl, 'https://api.openai.com/v1');
    const unknown = fixture('unknown-provider'); codex(unknown, 'model_provider="missing-provider"\n', { OPENAI_API_KEY: 'sk-must-not-reach-openai' });
    assert.equal(scan(unknown).added, 0); assert.equal(unknown.store.listProviders().length, 0);
  });
  test('built-in openai base URL and selected-profile provider overrides retain real destination', () => {
    const f = fixture('openai-override'); codex(f, 'model_provider="openai"\nopenai_base_url="https://custom-openai.test/v1"\n', { OPENAI_API_KEY: 'sk-custom-builtin-key' });
    assert.equal(scan(f).added, 1); assert.equal(f.store.listProviders()[0].baseUrl, 'https://custom-openai.test/v1');
    const scoped = fixture('profile-provider-override'); codex(scoped, 'profile="work"\nmodel_provider="relay"\n[model_providers.relay]\nbase_url="https://old-endpoint.test/v1"\nrequires_openai_auth=true\n[profiles.work.model_providers.relay]\nbase_url="https://actual-endpoint.test/v1"\n', { OPENAI_API_KEY: 'sk-profile-override-key' });
    assert.equal(scan(scoped).added, 1); assert.equal(scoped.store.listProviders()[0].baseUrl, 'https://actual-endpoint.test/v1');
    const gateway = fixture('builtin-gateway'); codex(gateway, `model_provider="openai"\nopenai_base_url="http://127.0.0.1:${gateway.store.getSettings().gatewayPort}/codex/coexist"\n`, { OPENAI_API_KEY: 'sk-ignored-builtin-gateway' });
    assert.equal(scan(gateway).added, 0); assert.equal(gateway.store.listProviders().length, 0);
  });
  test('env_key uses only explicitly available environment and never falls back to another credential', () => {
    const f = fixture('environment');
    codex(f, 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://relay.test/v1"\nenv_key="CLIENT_TEST_KEY"\nrequires_openai_auth=true\n', { OPENAI_API_KEY: 'sk-unrelated-auth-key' });
    const previous = process.env.CLIENT_TEST_KEY; process.env.CLIENT_TEST_KEY = 'sk-real-environment-must-not-read';
    try {
      assert.equal(scan(f).added, 0); assert.equal(f.store.listProviders().length, 0);
      assert.equal(scan(f, { environment: { CLIENT_TEST_KEY: 'sk-explicit-client-env-key' } }).added, 1);
      assert.equal(f.store.listProviders()[0].apiKeys[0].key, 'sk-explicit-client-env-key');
    } finally { if (previous === undefined) delete process.env.CLIENT_TEST_KEY; else process.env.CLIENT_TEST_KEY = previous; }
  });
  test('refresh is idempotent and imports new providers added while the app runs', () => {
    const f = fixture('refresh'); codex(f, relayConfig('sk-initial-relay-key'));
    const first = scan(f); const id = f.store.listProviders()[0].id; const timestamp = f.store.listProviders()[0].updatedAt;
    const again = scan(f); assert.equal(again.added, 0); assert.equal(again.updated, 0); assert.equal(f.store.listProviders()[0].updatedAt, timestamp); assert.equal(f.store.listProviders()[0].id, id);
    fs.appendFileSync(path.join(f.home, '.codex', 'config.toml'), '\n[model_providers.another]\nbase_url="https://another.test/v1"\nexperimental_bearer_token="sk-another-live-config"\n');
    assert.equal(scan(f).added, 1); assert.equal(f.store.listProviders().length, 2); assert(first.sources[0].id);
  });
  test('runtime key activity does not block a legitimate source key rotation', () => {
    const f = fixture('rotation'); codex(f, relayConfig('sk-old-relay-config')); scan(f);
    const initial = f.store.listProviders()[0]; initial.apiKeys[0].lastUsedAt = '2026-11-15T00:00:00Z'; f.store.saveProvider(initial);
    codex(f, relayConfig('sk-rotated-relay-config'));
    const result = scan(f); assert.equal(result.updated, 1); assert.equal(f.store.listProviders()[0].id, initial.id); assert.equal(f.store.listProviders()[0].apiKeys[0].key, 'sk-rotated-relay-config');
  });
  test('manual supplier edits protect all user values from later automatic refresh', () => {
    const f = fixture('manual-edits'); codex(f, relayConfig('sk-original-manual-key')); scan(f);
    const provider = f.store.listProviders()[0]; f.store.saveProvider({ ...provider, name: '我自己的名称', priority: 33, models: [{ id: 'my-model', inputPrice: 3 }], apiKeys: [{ ...provider.apiKeys[0], key: 'sk-user-edited-key' }] });
    const before = f.store.listProviders(); codex(f, relayConfig('sk-new-source-key'));
    const result = scan(f, { force: true }); assert.equal(result.updated, 0); assert(result.sources.some(s => s.status === 'modified')); assert.deepEqual(f.store.listProviders(), before);
  });
  test('deletion tombstones survive restarts, source rotation and forced scans until explicit restore', () => {
    const f = fixture('deletion'); codex(f, relayConfig('sk-before-delete-key'));
    const initial = scan(f); const sourceId = initial.sources[0].id; f.store.deleteProvider(f.store.listProviders()[0].id);
    codex(f, relayConfig('sk-after-delete-key')); const restarted = new api.AuroraStore(f.store.dir);
    const ignored = api.syncLocalClients(restarted, { ...f.options, force: true }); assert.equal(restarted.listProviders().length, 0); assert(ignored.sources.some(s => s.id === sourceId && s.status === 'ignored' && s.canRestore));
    assert.equal(api.restoreIgnoredLocalSource(restarted, sourceId, f.options).added, 1); assert.equal(restarted.listProviders()[0].apiKeys[0].key, 'sk-after-delete-key');
    assert.throws(() => api.restoreIgnoredLocalSource(restarted, sourceId, f.options), /没有可恢复/);
  });
  test('exact existing suppliers are linked without duplicates or overwritten custom metadata', () => {
    const f = fixture('existing'); const existing = f.store.saveProvider({ name: '我已配置的服务', baseUrl: 'https://relay.test/v1/', format: 'openai-responses', models: [{ id: 'manually-picked', maxOutput: 1234 }], apiKeys: [{ id: 'known-key', label: '现有', key: 'sk-existing-provider-key', enabled: false, weight: 2 }], enabled: false });
    codex(f, relayConfig('sk-existing-provider-key')); const result = scan(f);
    assert.equal(result.added, 0); assert(result.sources.some(s => s.providerId === existing.id && s.status === 'linked')); assert.deepEqual(f.store.getProvider(existing.id), existing);
    codex(f, relayConfig('sk-changed-external-source')); scan(f); assert.deepEqual(f.store.getProvider(existing.id), existing);
  });
  test('own gateway token, loopback aliases and managed provider never form a routing loop', () => {
    const f = fixture('gateway'); const settings = f.store.getSettings();
    codex(f, relayConfig(settings.gatewayToken) + '\n[model_providers.aurora]\nbase_url="https://foreign.test/v1"\nexperimental_bearer_token="sk-owned-managed-profile"\n');
    write(path.join(f.home, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: `http://localhost:${settings.gatewayPort}/v1`, ANTHROPIC_API_KEY: 'sk-different-loopback-key' } });
    const result = scan(f); assert.equal(result.added, 0); assert.equal(f.store.listProviders().length, 0); assert(result.sources.every(s => !s.canRestore));
  });
  test('malformed TOML, commands, OAuth-shaped keys and dynamic placeholders are not imported', () => {
    const invalid = fixture('invalid-toml'); codex(invalid, '[model_providers.broken\nexperimental_bearer_token="sk-parser-must-not-leak"', { OPENAI_API_KEY: 'sk-auth-must-not-misroute' });
    const invalidResult = scan(invalid); assert.equal(invalidResult.added, 0); assert(!JSON.stringify(invalidResult).includes('sk-parser-must-not-leak'));
    const helper = fixture('helpers'); write(path.join(helper.home, '.claude', 'settings.json'), { apiKeyHelper: 'echo secret && touch SHOULD_NOT_EXIST', env: { ANTHROPIC_API_KEY: 'sk-helper-not-executed' } });
    codex(helper, relayConfig('${UNEXPANDED_KEY}') + '\n[model_providers.oauth]\nbase_url="https://oauth.test"\nexperimental_bearer_token="eyJabc.eyJdef.signature"\n');
    write(path.join(helper.home, '.gemini', '.env'), 'GEMINI_API_KEY=$(cat sensitive-file)\n');
    const result = scan(helper); assert.equal(result.added, 0); assert(!fs.existsSync(path.join(helper.home, 'SHOULD_NOT_EXIST')));
    write(path.join(helper.home, '.claude', 'settings.json'), { env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-official-oauth-token' } }); assert.equal(scan(helper).added, 0);
  });
  test('Claude Desktop, Claude Code, Gemini, Qwen and explicit OpenCode schemas import safely', () => {
    const f = fixture('other-clients');
    write(path.join(f.home, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://claude.test', ANTHROPIC_API_KEY: 'sk-claude-code-stored', ANTHROPIC_MODEL: 'claude-custom' } });
    write(path.join(f.home, 'AppData', 'Local', 'Claude-3p', 'configLibrary', 'third-party.json'), { inferenceProvider: 'gateway', inferenceGatewayAuthScheme: 'bearer', inferenceGatewayBaseUrl: 'https://desktop.test', inferenceGatewayApiKey: 'sk-desktop-profile-stored', inferenceModels: [{ name: 'claude-desktop-model' }] });
    write(path.join(f.home, '.gemini', '.env'), 'GEMINI_API_KEY="gemini-stored-key"\nGOOGLE_GEMINI_BASE_URL="https://gemini.test"\nGEMINI_MODEL="gemini-custom"\n');
    write(path.join(f.home, '.qwen', '.env'), 'OPENAI_API_KEY=qwen-stored-key\nOPENAI_BASE_URL=https://qwen.test/v1\nOPENAI_MODEL=qwen-custom\n');
    write(path.join(f.home, '.config', 'opencode', 'opencode.json'), { provider: { custom: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://opencode.test/v1', apiKey: 'sk-opencode-key-stored' }, models: { 'open-model': {} } } } });
    const result = scan(f); assert.equal(result.added, 5); assert.deepEqual(new Set(f.store.listProviders().map(p => p.format)), new Set(['anthropic', 'gemini', 'openai-chat']));
    assert(result.sources.every(s => !!s.path && !!s.providerId)); assert(f.store.listProviders().every(p => p.notes.includes('配置文件：')));
  });
  test('missing source does not erase the imported supplier and a corrupt ledger fails closed', () => {
    const f = fixture('missing'); codex(f, relayConfig('sk-source-file-removed')); scan(f); const before = f.store.listProviders();
    fs.unlinkSync(path.join(f.home, '.codex', 'config.toml')); assert(scan(f).sources.some(s => s.status === 'missing-file')); assert.deepEqual(f.store.listProviders(), before);
    write(path.join(f.store.dir, 'local-client-imports.json'), '{invalid'); assert.throws(() => scan(f), /来源记录损坏/); assert.deepEqual(f.store.listProviders(), before); assert.equal(api.getLocalClientsSnapshot(f.store).ok, false);
  });
  test('isolated home ignores real CODEX_HOME and auth environment defaults', () => {
    const f = fixture('isolation'); const external = path.join(temporaryRoot, 'outside-config'); write(path.join(external, 'auth.json'), { OPENAI_API_KEY: 'sk-outside-must-not-import' });
    const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = external;
    try { assert.equal(scan(f).added, 0); assert.equal(f.store.listProviders().length, 0); }
    finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
  });
  test('snapshot reads are detached and never rescan or expose credentials', () => {
    const f = fixture('snapshot'); codex(f, relayConfig('sk-never-return-from-snapshot')); scan(f);
    const snapshot = api.getLocalClientsSnapshot(f.store); assert(!JSON.stringify(snapshot).includes('sk-never-return-from-snapshot')); snapshot.sources.length = 0;
    assert(api.getLocalClientsSnapshot(f.store).sources.length > 0); assert.equal(f.store.listProviders().length, 1);
  });
  test('structurally damaged tombstone ledger cannot resurrect a deleted import', () => {
    const f = fixture('broken-ledger'); codex(f, relayConfig('sk-ledger-test-key')); const result = scan(f); f.store.deleteProvider(f.store.listProviders()[0].id);
    const file = path.join(f.store.dir, 'local-client-imports.json'); const ledger = JSON.parse(fs.readFileSync(file, 'utf8')); ledger.sources[result.sources[0].id] = 'broken-record'; write(file, ledger);
    assert.throws(() => scan(f), /来源记录损坏/); assert.equal(f.store.listProviders().length, 0);
  });
  test('an official login marker without access credentials stays a record-only account', () => {
    const f = fixture('record-only'); write(path.join(f.home, '.codex', 'auth.json'), { auth_mode: 'chatgpt', tokens: { account_id: 'account-record-only' } });
    const result = scan(f); assert.equal(result.accounts.length, 1); assert.equal(result.accounts[0].credentialStatus, 'record-only'); assert.equal(result.added, 0); assert.equal(f.store.listProviders().length, 0);
  });
  test('switching Codex to the gateway cannot erase imported models and new explicit IDs merge', () => {
    const f = fixture('switch-model-preservation'); codex(f, relayConfig('sk-model-retention-key')); scan(f);
    const original = f.store.listProviders()[0];
    codex(f, relayConfig('sk-model-retention-key').replace('model_provider = "relay"', 'model_provider = "aurora"') + '\n[model_providers.aurora]\nbase_url="http://127.0.0.1:3425/v1"\nexperimental_bearer_token="sk-our-gateway-ignored"\n');
    scan(f); assert.deepEqual(f.store.getProvider(original.id).models, original.models);
    codex(f, relayConfig('sk-model-retention-key').replace('"gpt-current"', '"gpt-new-explicit"')); scan(f);
    assert.deepEqual(f.store.getProvider(original.id).models.map(m => m.id), ['gpt-current', 'gpt-new-explicit']);
  });
  test('non-forced scans throttle for five seconds while force remains immediate', () => {
    const f = fixture('throttle'); codex(f, relayConfig('sk-throttle-initial-key'));
    const first = api.syncLocalClients(f.store, f.options); assert.equal(first.added, 1);
    codex(f, relayConfig('sk-throttle-next-key'));
    const cached = api.syncLocalClients(f.store, f.options); assert.equal(cached.checkedAt, first.checkedAt); assert.equal(cached.added, 0); assert.equal(cached.updated, 0); assert.equal(f.store.listProviders()[0].apiKeys[0].key, 'sk-throttle-initial-key');
    assert.equal(api.syncLocalClients(f.store, { ...f.options, force: true }).updated, 1);
    codex(f, relayConfig('sk-throttle-after-five-seconds'));
    const actualNow = Date.now; Date.now = () => actualNow() + 5001;
    try { assert.equal(api.syncLocalClients(f.store, f.options).updated, 1); }
    finally { Date.now = actualNow; }
  });
  console.log(`All ${passed} local client discovery checks passed.`);
} finally {
  assert(path.basename(temporaryRoot).startsWith('aurora-local-clients-'));
  assert.equal(fs.realpathSync(path.dirname(temporaryRoot)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
