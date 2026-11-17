import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-connection-history-')));
const databases = [];
const originalClientHome = process.env.AURORA_CLIENT_HOME;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => fs.readFileSync(file, 'utf8');
const id = number => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const plannedConfiguration = 'model_provider = "yunqiao"\nmodel = "gpt-current"\n[model_providers.yunqiao]\nname = "云桥 AI"\nbase_url = "https://example.invalid/v1"\n';
const automatic = { configurationText: plannedConfiguration, backupAll: true, includeSubagents: true, requireAll: true, preserveMissingSourceIndexes: true };
let checks = 0;
async function check(name, run) { await run(); checks++; console.log('PASS', name); }
try {
  const bundle = path.join(root, 'history.cjs');
  await build({ stdin: { contents: "export * from './src/core/historyRepair.ts'; export { acquireHistoryLock } from './src/core/historyRepairIO.ts';", resolveDir: workspace, loader: 'ts' }, outfile: bundle, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' });
  const { createHistoryRepairService, runHistoryRepairAction, acquireHistoryLock } = createRequire(import.meta.url)(bundle);
  function fixture(name, options = {}) {
    const home = path.join(root, name, '.codex'); fs.mkdirSync(home, { recursive: true });
    const configPath = path.join(home, 'config.toml');
    if (!options.noConfiguration) write(configPath, 'model_provider = "previous"\n[model_providers.previous]\nname = "Previous"\n');
    const databasePath = path.join(home, 'state_5.sqlite'), db = new DatabaseSync(databasePath); databases.push(db);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,rollout_path TEXT,cwd TEXT,title TEXT,archived INTEGER,source TEXT,parent_thread_id TEXT,model TEXT,reasoning_effort TEXT); CREATE TABLE local_thread_catalog_hosts(host_id TEXT PRIMARY KEY,host_kind TEXT); INSERT INTO local_thread_catalog_hosts VALUES(\'desktop\',\'local\'),(\'remote\',\'remote\'); CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,model_provider TEXT,PRIMARY KEY(host_id,thread_id));');
    function add(number, values = {}) {
      const threadId = id(number), provider = values.provider || 'previous', archived = !!values.archived;
      const file = path.join(home, archived ? 'archived_sessions' : 'sessions', '2026', `rollout-${threadId}.jsonl`);
      const source = values.parent ? { subagent: { thread_spawn: { parent_thread_id: values.parent, depth: 1 } } } : 'cli';
      const content = '\ufeff' + JSON.stringify({ type: 'session_meta', payload: { id: threadId, model_provider: provider, source, cwd: 'D:/fixture', model: 'gpt-history', reasoning_effort: 'high' } }) + '\r\n'
        + ' { "type": "event_msg", "payload": { "message": "正文 保留原字节" } } \r\n'
        + '{"type":"response_item","payload":{"encrypted_content":"private-fixture-ciphertext"}}\r\n';
      write(file, content);
      db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(threadId, provider, file, 'D:/fixture', `Thread ${number}`, archived ? 1 : 0, values.parent ? 'subagent' : 'cli', values.parent || null, 'gpt-history', 'high');
      db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run('desktop', threadId, provider);
      db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run('remote', threadId, 'remote-original');
      return { id: threadId, file, content, provider, parent: values.parent, archived };
    }
    const ctx = { home, sqliteHome: home, blockingProcesses: async () => [] };
    const service = trusted => createHistoryRepairService(ctx, trusted ?? automatic);
    const provider = threadId => db.prepare('SELECT model_provider FROM threads WHERE id=?').get(threadId).model_provider;
    return { home, configPath, db, databasePath, ctx, add, service, provider };
  }
  async function apply(service, input = {}) {
    const preview = await service.preview({ scope: 'all', ...input }); assert(preview.ok, preview.message);
    const result = await service.apply({ ...preview.options, revision: preview.revision });
    return { preview, result };
  }
  async function restore(service, result) {
    const preview = await service.restorePreview({ backupId: result.backupId }); assert(preview.ok, preview.message);
    const restored = await service.restore({ backupId: result.backupId, revision: preview.revision }); assert(restored.ok, restored.message);
  }
  await check('Planned configuration migrates all provider regions, archived histories and parent/child sessions while preserving content and settings', async () => {
    const f = fixture('whole-tree'), parent = f.add(1), child = f.add(2, { parent: parent.id, provider: 'old-secondary' }), archived = f.add(3, { archived: true, provider: 'other' }), aligned = f.add(4, { provider: 'yunqiao' });
    const unrelatedPath = path.join(f.home, 'sqlite', 'auxiliary.db'); fs.mkdirSync(path.dirname(unrelatedPath), { recursive: true });
    const unrelated = new DatabaseSync(unrelatedPath); databases.push(unrelated); unrelated.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep auxiliary data');");
    const configBefore = read(f.configPath), alignedMtime = fs.statSync(aligned.file).mtimeMs;
    let prepared;
    const service = f.service({ ...automatic, onPrepared(info) {
      prepared = info;
      const journal = JSON.parse(read(path.join(info.backup, 'manifest.json')));
      assert.equal(journal.status, 'prepared'); assert.equal(journal.files.length, 0); assert.equal(journal.databases.length, 0);
      assert.equal(read(parent.file), parent.content); assert.equal(f.provider(parent.id), 'previous');
    } });
    const { preview, result } = await apply(service);
    assert.equal(preview.summary.blocked, 0); assert.equal(preview.summary.repairable, 3);
    assert(result.ok, result.message); assert.equal(result.updated, 3); assert.equal(result.backupId, prepared.backupId);
    const journal = JSON.parse(read(path.join(result.backup, 'manifest.json')));
    assert.equal(journal.files.length, 4); assert.equal(journal.databases.length, 2);
    for (const thread of [parent, child, archived, aligned]) {
      assert.equal(f.provider(thread.id), 'yunqiao');
      const before = thread.content.split('\r\n'), after = read(thread.file).split('\r\n');
      assert.deepEqual(after.slice(1), before.slice(1));
      const oldMeta = JSON.parse(before[0].replace(/^\ufeff/, '')), newMeta = JSON.parse(after[0].replace(/^\ufeff/, ''));
      assert.deepEqual(newMeta, { ...oldMeta, payload: { ...oldMeta.payload, model_provider: 'yunqiao' } });
      assert.equal(read(journal.files.find(entry => entry.path === thread.file).original), thread.content);
      const row = f.db.prepare('SELECT * FROM threads WHERE id=?').get(thread.id);
      assert.equal(row.model, 'gpt-history'); assert.equal(row.reasoning_effort, 'high'); assert.equal(row.archived, thread.archived ? 1 : 0); assert.equal(row.parent_thread_id, thread.parent || null);
      assert.equal(f.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('remote', thread.id).model_provider, 'remote-original');
    }
    assert.equal(fs.statSync(aligned.file).mtimeMs, alignedMtime); assert.equal(read(f.configPath), configBefore);
    const snapshot = new DatabaseSync(journal.databases.find(entry => entry.path === unrelatedPath).backup, { readOnly: true });
    try { assert.equal(snapshot.prepare('SELECT value FROM unrelated').get().value, 'keep auxiliary data'); } finally { snapshot.close(); }
    await restore(service, result);
    for (const thread of [parent, child, archived, aligned]) { assert.equal(read(thread.file), thread.content); assert.equal(f.provider(thread.id), thread.provider); }
  });
  await check('An absent config can be planned and migrated without creating config.toml', async () => {
    const f = fixture('missing-config', { noConfiguration: true }), thread = f.add(10);
    const { result } = await apply(f.service()); assert(result.ok, result.message);
    assert.equal(f.provider(thread.id), 'yunqiao'); assert.equal(fs.existsSync(f.configPath), false);
    await restore(f.service(), result); assert.equal(read(thread.file), thread.content);
    assert.equal((await createHistoryRepairService(f.ctx).preview()).ok, false);
  });
  await check('Full backups are produced even when every history provider already matches', async () => {
    const f = fixture('already-aligned'), thread = f.add(20, { provider: 'yunqiao' });
    const beforeStat = fs.statSync(thread.file), { result } = await apply(f.service());
    assert(result.ok, result.message); assert.equal(result.updated, 0); assert.equal(result.summary.repairable, 0); assert(result.backupId);
    const journal = JSON.parse(read(path.join(result.backup, 'manifest.json')));
    assert.equal(journal.files.length, 1); assert.equal(journal.databases.length, 1); assert.equal(journal.rows.length, 0);
    assert.equal(journal.files[0].beforeHash, journal.files[0].afterHash); assert.equal(read(journal.files[0].original), thread.content);
    assert.equal(read(thread.file), thread.content); assert.equal(fs.statSync(thread.file).mtimeMs, beforeStat.mtimeMs);
    await restore(f.service(), result);
  });
  await check('requireAll refuses a blocked batch before any backup is created or valid history changes', async () => {
    const f = fixture('blocked'), valid = f.add(30), invalid = f.add(31); write(invalid.file, invalid.content + '{partial');
    const { preview, result } = await apply(f.service());
    assert.equal(preview.summary.blocked, 1); assert.equal(result.ok, false); assert.equal(result.rolledBack, true); assert.equal(result.backupId, undefined);
    assert.equal(f.service().backups().backups.length, 0); assert.equal(read(valid.file), valid.content); assert.equal(f.provider(valid.id), 'previous');
  });
  await check('Unknown relevant SQLite schemas prevent automatic preparation, but unrelated databases are allowed', async () => {
    const f = fixture('unknown-index'); f.add(40); f.db.exec('ALTER TABLE threads RENAME COLUMN model_provider TO incompatible_provider;');
    const preview = await f.service().preview(); assert.equal(preview.ok, false); assert.match(preview.message, /结构未知/);
    const result = await f.service().apply({ revision: 'not-a-valid-preview' }); assert.equal(result.ok, false); assert.equal(result.backupId, undefined);
    assert.equal(f.service().backups().backups.length, 0);
  });
  await check('Automatic subagent inclusion is confined to whole-history scope and is never enabled by RPC fields', async () => {
    const f = fixture('subagent-scope'), parent = f.add(50), child = f.add(51, { parent: parent.id });
    for (const input of [{ ids: [child.id] }, { scope: 'active' }, { sourceProvider: 'previous' }]) {
      const plan = await f.service().preview(input); assert(plan.ok); assert(plan.items.find(item => item.id === child.id)?.status === 'blocked');
    }
    const manual = await createHistoryRepairService(f.ctx).preview({ includeSubagents: true, backupAll: true, requireAll: true });
    assert(manual.ok); assert.equal(manual.items.find(item => item.id === child.id).status, 'blocked');
    process.env.AURORA_CLIENT_HOME = path.dirname(f.home);
    const rpc = await runHistoryRepairAction('codex.repair.preview', { targetProvider: 'yunqiao', configurationText: plannedConfiguration, includeSubagents: true });
    assert.equal(rpc.ok, false); assert.match(rpc.message, /目标供应商/);
  });
  await check('Disk existence/content and planned config changes invalidate a previous preview', async () => {
    const f = fixture('config-race', { noConfiguration: true }), thread = f.add(60), service = f.service();
    const absent = await service.preview(); assert(absent.ok);
    write(f.configPath, 'model_provider="openai"\n');
    const created = await service.apply({ ...absent.options, revision: absent.revision }); assert.equal(created.ok, false); assert.equal(created.backupId, undefined);
    const beforeEdit = await service.preview(); write(f.configPath, 'model_provider="openai"\n# external change\n');
    assert.equal((await service.apply({ ...beforeEdit.options, revision: beforeEdit.revision })).ok, false);
    const planned = await service.preview();
    const changedPlan = f.service({ ...automatic, configurationText: plannedConfiguration + '# changed target plan\n' });
    assert.equal((await changedPlan.apply({ ...planned.options, revision: planned.revision })).ok, false);
    assert.equal(read(thread.file), thread.content); assert.equal(f.provider(thread.id), 'previous');
  });
  await check('A failed journal callback rolls back the registered empty batch and allows a later attempt', async () => {
    const f = fixture('failed-journal'), thread = f.add(70); let bound;
    const service = f.service({ ...automatic, onPrepared: async info => { bound = info; throw new Error('private coordinator failure'); } });
    const { result } = await apply(service); assert.equal(result.ok, false); assert.equal(result.rolledBack, true); assert.equal(result.backupId, bound.backupId);
    assert.equal(JSON.parse(read(path.join(bound.backup, 'manifest.json'))).status, 'restored');
    assert.equal(read(thread.file), thread.content); assert.equal(f.provider(thread.id), 'previous');
    const retry = await apply(f.service()); assert(retry.result.ok, retry.result.message);
  });
  await check('The trusted outer lock remains held across apply/restore and both process checks still run', async () => {
    const f = fixture('outer-lock'); f.add(80); let processChecks = 0;
    const ctx = { ...f.ctx, blockingProcesses: async () => { processChecks++; return []; } };
    const unlock = acquireHistoryLock(ctx), service = createHistoryRepairService(ctx, { ...automatic, lockHeld: true });
    try {
      const { result } = await apply(service); assert(result.ok, result.message); assert.equal(processChecks, 2);
      assert.throws(() => acquireHistoryLock(ctx), /已有历史/);
      await restore(service, result); assert.equal(processChecks, 3); assert.throws(() => acquireHistoryLock(ctx), /已有历史/);
    } finally { unlock(); }
    const reacquire = acquireHistoryLock(ctx); reacquire();
  });
  await check('A newly running client between backup and apply prevents history writes and leaves a recoverable batch', async () => {
    const f = fixture('client-race'), thread = f.add(90); let calls = 0;
    const service = createHistoryRepairService({ ...f.ctx, blockingProcesses: async () => ++calls > 1 ? ['private-fixture-client'] : [] }, automatic);
    const { result } = await apply(service); assert.equal(result.ok, false); assert.equal(result.rolledBack, true);
    assert.equal(read(thread.file), thread.content); assert.equal(f.provider(thread.id), 'previous');
  });
  await check('Partial backup failure is linked, safely restored and does not block the next migration', async () => {
    const f = fixture('partial-backup'), first = f.add(100), second = f.add(101), originalCopy = fs.promises.copyFile;
    let result;
    fs.promises.copyFile = async (from, to, flags) => {
      if (from === second.file && String(to).endsWith('.original.jsonl')) throw new Error('private copy failure');
      return originalCopy(from, to, flags);
    };
    try { ({ result } = await apply(f.service())); } finally { fs.promises.copyFile = originalCopy; }
    assert.equal(result.ok, false); assert.equal(result.rolledBack, true); assert(result.backupId);
    assert.equal(read(first.file), first.content); assert.equal(read(second.file), second.content);
    assert.equal((await apply(f.service())).result.ok, true);
  });
  await check('SQLite failure after full snapshots and source replacement restores exact bytes and providers', async () => {
    const f = fixture('database-failure'), thread = f.add(110);
    f.db.exec("CREATE TRIGGER reject_switch BEFORE UPDATE OF model_provider ON local_thread_catalog WHEN NEW.model_provider='yunqiao' BEGIN SELECT RAISE(FAIL,'private database failure'); END;");
    const { result } = await apply(f.service()); assert.equal(result.ok, false); assert.equal(result.rolledBack, true);
    assert.equal(read(thread.file), thread.content); assert.equal(f.provider(thread.id), 'previous');
    assert.equal(f.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('desktop', thread.id).model_provider, 'previous');
  });
  await check('Concurrent changes to an already-aligned backed-up log are preserved and reported as incomplete rollback', async () => {
    const f = fixture('preserve-append'), first = f.add(120), aligned = f.add(121, { provider: 'yunqiao' });
    const originalRename = fs.promises.rename; let appended;
    fs.promises.rename = async (from, to) => { const value = await originalRename(from, to); if (to === first.file) { appended = read(aligned.file) + '{"type":"event_msg","payload":{"message":"new work"}}\n'; write(aligned.file, appended); } return value; };
    let result;
    try { ({ result } = await apply(f.service())); } finally { fs.promises.rename = originalRename; }
    assert.equal(result.ok, false); assert.equal(result.rolledBack, false); assert.equal(read(aligned.file), appended);
    assert.equal(JSON.parse(read(path.join(result.backup, 'manifest.json'))).status, 'interrupted');
    assert.equal(f.provider(first.id), 'previous');
  });
  await check('Restoring a trusted legacy managed current provider is allowed only with its actual provider table', async () => {
    const f = fixture('restore-legacy-managed'), thread = f.add(130, { provider: 'yunqiao' });
    const legacy = 'model_provider="codex_plus_managed"\n[model_providers.codex_plus_managed]\nname="Legacy"\nbase_url="http://127.0.0.1:3425/v1"\n';
    const service = f.service({ ...automatic, configurationText: legacy });
    const { preview, result } = await apply(service); assert.equal(preview.currentProvider, 'codex_plus_managed'); assert(result.ok, result.message);
    assert.equal(f.provider(thread.id), 'codex_plus_managed'); await restore(service, result); assert.equal(read(thread.file), thread.content);
    const missing = f.service({ ...automatic, configurationText: 'model_provider="codex_plus_managed"\n' });
    assert.equal((await missing.preview()).ok, false);
    const nonCurrent = f.service({ ...automatic, configurationText: legacy.replace('model_provider="codex_plus_managed"', 'model_provider="openai"') });
    assert.equal((await nonCurrent.preview({ targetProvider: 'codex_plus_managed' })).ok, false);
    write(f.configPath, legacy);
    assert.equal((await createHistoryRepairService(f.ctx).preview({ targetProvider: 'codex_plus_managed' })).ok, false);
  });
  await check('Fresh empty desktop catalogs need no invented local host, while populated unknown ownership remains blocked', async () => {
    const f = fixture('empty-catalog'); f.db.exec('DELETE FROM local_thread_catalog_hosts;');
    const { result } = await apply(f.service()); assert(result.ok, result.message); assert.equal(result.updated, 0); assert(result.backupId);
    f.db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run('unknown', id(140), 'previous');
    const blocked = await f.service().preview(); assert.equal(blocked.ok, false); assert.match(blocked.message, /本地主机/);
  });
  await check('A real unindexed log still blocks the entire automatic batch while missing-source indexes are explicitly preserved', async () => {
    const f = fixture('missing-index'), orphan = f.add(150), missing = f.add(151);
    f.db.prepare('DELETE FROM threads WHERE id=?').run(orphan.id);
    fs.unlinkSync(missing.file);
    const { preview, result } = await apply(f.service());
    assert.equal(preview.summary.blocked, 1); assert.equal(preview.summary.preserved, 1); assert.match(preview.items.find(item => item.id === orphan.id).reason, /缺少原生/);
    assert.match(preview.items.find(item => item.id === missing.id).reason, /原文件/);
    assert.equal(result.ok, false); assert.equal(result.backupId, undefined); assert.equal(read(orphan.file), orphan.content);
  });
  await check('One real log and 107 missing-source sessions back up one file plus the complete database and preserve every orphan index cell', async () => {
    const f = fixture('one-log-107-indexes'), valid = f.add(300);
    const missing = Array.from({ length: 107 }, (_, i) => f.add(301 + i, { archived: i % 2 === 0, parent: i % 3 === 0 ? valid.id : undefined, provider: `old-region-${i % 4}` }));
    for (const item of missing) fs.unlinkSync(item.file);
    const before = { threads: f.db.prepare('SELECT * FROM threads ORDER BY id').all(), catalog: f.db.prepare('SELECT * FROM local_thread_catalog ORDER BY host_id,thread_id').all() };
    const { preview, result } = await apply(f.service());
    assert.equal(preview.summary.scanned, 108); assert.equal(preview.summary.repairable, 1); assert.equal(preview.summary.preserved, 107); assert.equal(preview.summary.blocked, 0);
    assert.equal(preview.summary.filesToBackUp, 1); assert.equal(preview.summary.indexDatabasesToBackUp, 1);
    assert(preview.items.filter(item => item.status === 'preserved').every(item => item.paths.length === 0 && item.changes.length === 0 && /原样保留/.test(item.reason)));
    assert(result.ok, result.message); assert.equal(result.updated, 1); assert.equal(result.backedUp, 1); assert.equal(result.indexBackedUp, 1); assert.equal(result.preserved, 107); assert.match(result.message, /107 条.*原样保留/);
    const journal = JSON.parse(read(path.join(result.backup, 'manifest.json')));
    assert.equal(journal.files.length, 1); assert.equal(journal.databases.length, 1); assert(journal.rows.every(row => row.sessionId === valid.id));
    const backup = new DatabaseSync(journal.databases[0].backup, { readOnly: true });
    try { assert.deepEqual(backup.prepare('SELECT * FROM threads ORDER BY id').all(), before.threads); assert.deepEqual(backup.prepare('SELECT * FROM local_thread_catalog ORDER BY host_id,thread_id').all(), before.catalog); }
    finally { backup.close(); }
    assert.deepEqual(f.db.prepare('SELECT * FROM threads ORDER BY id').all().filter(row => row.id !== valid.id), before.threads.filter(row => row.id !== valid.id));
    assert.deepEqual(f.db.prepare('SELECT * FROM local_thread_catalog ORDER BY host_id,thread_id').all().filter(row => row.thread_id !== valid.id), before.catalog.filter(row => row.thread_id !== valid.id));
    for (const item of missing) assert.equal(fs.existsSync(item.file), false);
    await restore(f.service(), result);
    assert.equal(read(valid.file), valid.content); assert.deepEqual(f.db.prepare('SELECT * FROM threads ORDER BY id').all(), before.threads); assert.deepEqual(f.db.prepare('SELECT * FROM local_thread_catalog ORDER BY host_id,thread_id').all(), before.catalog);
  });
  await check('An entirely index-only history still requires full database backup and restore never rewrites preserved rows', async () => {
    const f = fixture('all-indexes'), first = f.add(420), second = f.add(421, { archived: true });
    fs.unlinkSync(first.file); fs.unlinkSync(second.file);
    const before = f.db.prepare('SELECT * FROM threads ORDER BY id').all();
    const { preview, result } = await apply(f.service()); assert(result.ok, result.message);
    assert.equal(preview.summary.repairable, 0); assert.equal(preview.summary.preserved, 2); assert.equal(result.backedUp, 0); assert.equal(result.indexBackedUp, 1); assert(result.backupId);
    const journal = JSON.parse(read(path.join(result.backup, 'manifest.json'))); assert.equal(journal.files.length, 0); assert.equal(journal.rows.length, 0); assert.equal(journal.databases.length, 1);
    assert.deepEqual(f.db.prepare('SELECT * FROM threads ORDER BY id').all(), before);
    f.db.prepare('UPDATE threads SET title=? WHERE id=?').run('later external title', first.id);
    const after = f.db.prepare('SELECT * FROM threads ORDER BY id').all(); await restore(f.service(), result);
    assert.deepEqual(f.db.prepare('SELECT * FROM threads ORDER BY id').all(), after); assert(!fs.existsSync(first.file)); assert(!fs.existsSync(second.file));
  });
  await check('Catalog-only missing sources can be preserved but duplicate native rows, duplicate catalog keys and conflicting provider ownership still block', async () => {
    const catalogOnly = fixture('catalog-only-missing'), item = catalogOnly.add(430); fs.unlinkSync(item.file); catalogOnly.db.prepare('DELETE FROM threads WHERE id=?').run(item.id);
    const only = await apply(catalogOnly.service()); assert(only.result.ok, only.result.message); assert.equal(only.result.preserved, 1); assert.equal(only.result.indexBackedUp, 1);
    for (const kind of ['duplicate-native', 'duplicate-catalog', 'provider-conflict', 'existing-wrong-id']) {
      const f = fixture(kind), item = f.add(431); fs.unlinkSync(item.file);
      if (kind === 'duplicate-native') f.db.exec('CREATE TABLE copied_threads AS SELECT * FROM threads; INSERT INTO copied_threads SELECT * FROM threads; DROP TABLE threads; ALTER TABLE copied_threads RENAME TO threads;');
      else if (kind === 'duplicate-catalog') f.db.exec('CREATE TABLE copied_catalog AS SELECT * FROM local_thread_catalog; INSERT INTO copied_catalog SELECT * FROM local_thread_catalog; DROP TABLE local_thread_catalog; ALTER TABLE copied_catalog RENAME TO local_thread_catalog;');
      else if (kind === 'provider-conflict') f.db.prepare("UPDATE local_thread_catalog SET model_provider='conflicting-region' WHERE host_id='desktop'").run();
      else { const other = f.add(432); f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(other.file, item.id); }
      const { preview, result } = await apply(f.service()); assert.equal(preview.summary.blocked, 1, kind); assert.equal(preview.summary.preserved, 0, kind);
      assert.equal(result.ok, false, kind); assert.equal(result.backupId, undefined); assert.equal(f.provider(item.id), 'previous');
    }
  });
  await check('Preserving source-less indexes requires trusted planned full strict scope and cannot be enabled in manual or RPC payloads', async () => {
    const f = fixture('preserve-scope'), item = f.add(440); fs.unlinkSync(item.file);
    for (const trusted of [{ ...automatic, backupAll: false }, { ...automatic, requireAll: false }, { ...automatic, configurationText: undefined }, { ...automatic, preserveMissingSourceIndexes: false }]) {
      const plan = await f.service(trusted).preview(); assert(plan.ok); assert.equal(plan.summary.preserved, 0); assert.equal(plan.summary.blocked, 1);
    }
    for (const input of [{ ids: [item.id] }, { scope: 'active' }, { sourceProvider: 'previous' }]) {
      const plan = await f.service().preview(input); assert(plan.ok); assert.equal(plan.summary.preserved, 0); assert.equal(plan.summary.blocked, 1);
    }
    const payload = { preserveMissingSourceIndexes: true, backupAll: true, requireAll: true, configurationText: plannedConfiguration };
    const manual = await createHistoryRepairService(f.ctx).preview(payload); assert(manual.ok); assert.equal(manual.summary.preserved, 0); assert.equal(manual.summary.blocked, 1);
    process.env.AURORA_CLIENT_HOME = path.dirname(f.home);
    const rpc = await runHistoryRepairAction('codex.repair.preview', payload); assert(rpc.ok, rpc.message); assert.equal(rpc.summary.preserved, 0); assert.equal(rpc.summary.blocked, 1);
    const applied = await createHistoryRepairService(f.ctx).apply({ ...payload, revision: manual.revision }); assert(applied.ok, applied.message); assert.equal(applied.updated, 0); assert.equal(applied.backupId, undefined);
    assert.equal(f.provider(item.id), 'previous'); assert.equal(fs.existsSync(item.file), false);
  });
  await check('A missing-source index edit invalidates its reviewed plan without creating backups or changing the other valid log', async () => {
    const f = fixture('preserved-revision'), valid = f.add(450), missing = f.add(451); fs.unlinkSync(missing.file); const preview = await f.service().preview();
    f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(path.join(f.home, 'different-absent.jsonl'), missing.id);
    const result = await f.service().apply({ revision: preview.revision }); assert.equal(result.ok, false); assert.equal(result.backupId, undefined); assert.equal(read(valid.file), valid.content);
  });
  await check('Out-of-scope and foreign-platform catalog paths are preserved without filesystem probes while inaccessible in-scope paths still fail closed', async () => {
    const f = fixture('external-paths'), outside = path.join(root, 'outside-scan.jsonl'); write(outside, 'untouched external file');
    const externalPaths = [outside, '\\\\fixture-unreachable-host\\share\\rollout.jsonl', 'Z:\\foreign-computer\\rollout.jsonl', '/foreign-machine/rollout.jsonl'];
    for (const [i, external] of externalPaths.entries()) { const item = f.add(470 + i); fs.unlinkSync(item.file); f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(external, item.id); }
    const lstat = fs.lstatSync, forbidden = new Set(externalPaths.flatMap(file => [file, path.resolve(f.home, file)]));
    fs.lstatSync = function(file, ...args) { assert(!forbidden.has(String(file)), `Probed external catalog path: ${file}`); return lstat.call(this, file, ...args); };
    let result;
    try { ({ result } = await apply(f.service())); } finally { fs.lstatSync = lstat; }
    assert(result.ok, result.message); assert.equal(result.preserved, 4); assert.equal(result.backedUp, 0); assert.equal(read(outside), 'untouched external file');
    const inaccessible = f.add(474); fs.unlinkSync(inaccessible.file);
    fs.lstatSync = function(file, ...args) { if (String(file) === inaccessible.file) throw Object.assign(new Error('fixture source access denied'), { code: 'EACCES' }); return lstat.call(this, file, ...args); };
    try { const preview = await f.service().preview(); assert.equal(preview.ok, false); assert.match(preview.message, /access denied/); }
    finally { fs.lstatSync = lstat; }
  });
  await check('Database backup failure in an index-only batch prevents success and leaves all original rows unchanged', async () => {
    const f = fixture('index-backup-failed'), item = f.add(460); fs.unlinkSync(item.file);
    const before = f.db.prepare('SELECT * FROM threads').all(), prepare = DatabaseSync.prototype.prepare; let reached = false, result;
    DatabaseSync.prototype.prepare = function (sql) { if (sql === 'VACUUM INTO ?') { reached = true; throw new Error('fixture database snapshot unavailable'); } return prepare.call(this, sql); };
    try { ({ result } = await apply(f.service())); } finally { DatabaseSync.prototype.prepare = prepare; }
    assert(reached); assert.equal(result.ok, false); assert.equal(result.rolledBack, true); assert.deepEqual(f.db.prepare('SELECT * FROM threads').all(), before); assert(!fs.existsSync(item.file));
    assert((await apply(f.service())).result.ok);
  });
  await check('Complete backups reject session links instead of silently excluding them', async () => {
    const f = fixture('linked-session'); f.add(160);
    const external = path.join(root, 'outside-linked-session'); fs.mkdirSync(external);
    const link = path.join(f.home, 'sessions', 'linked'); fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    try { const preview = await f.service().preview(); assert.equal(preview.ok, false); assert.match(preview.message, /链接/); }
    finally { fs.unlinkSync(link); }
  });
  await check('A commit failure after another database committed compensates both databases and source files', async () => {
    const f = fixture('split-commit'), thread = f.add(170);
    f.db.exec('DROP TABLE local_thread_catalog; DROP TABLE local_thread_catalog_hosts;');
    const catalogPath = path.join(f.home, 'sqlite', 'desktop-catalog.db'); fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    const catalog = new DatabaseSync(catalogPath); databases.push(catalog);
    catalog.exec("PRAGMA journal_mode=WAL; CREATE TABLE local_thread_catalog_hosts(host_id TEXT PRIMARY KEY,host_kind TEXT); INSERT INTO local_thread_catalog_hosts VALUES('desktop','local'); CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,model_provider TEXT,PRIMARY KEY(host_id,thread_id));");
    catalog.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run('desktop', thread.id, 'previous');
    const prepare = DatabaseSync.prototype.prepare; let commits = 0, failed = false, result;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (sql !== 'COMMIT') return statement;
      return { run(...args) { commits++; if (!failed && commits === 2) { failed = true; throw new Error('private second database commit failure'); } return statement.run(...args); } };
    };
    try { ({ result } = await apply(f.service())); } finally { DatabaseSync.prototype.prepare = prepare; }
    assert(failed); assert.equal(result.ok, false); assert.equal(result.rolledBack, true); assert.equal(read(thread.file), thread.content);
    assert.equal(f.provider(thread.id), 'previous'); assert.equal(catalog.prepare('SELECT model_provider FROM local_thread_catalog WHERE thread_id=?').get(thread.id).model_provider, 'previous');
  });
  await check('An interrupted batch with mixed before/after files and committed rows restores idempotently from its saved journal', async () => {
    const f = fixture('crash-mixed-state'), first = f.add(180), second = f.add(181), service = f.service();
    const { result } = await apply(service); assert(result.ok, result.message);
    // Emulate a terminated writer after one file/row reached its after-state.
    // This is private fixture state; recovery must accept only before/after.
    write(first.file, first.content);
    f.db.prepare('UPDATE threads SET model_provider=? WHERE id=?').run('previous', first.id);
    f.db.prepare('UPDATE local_thread_catalog SET model_provider=? WHERE host_id=? AND thread_id=?').run('previous', 'desktop', first.id);
    const manifestPath = path.join(result.backup, 'manifest.json'), journal = JSON.parse(read(manifestPath)); journal.status = 'applying'; write(manifestPath, JSON.stringify(journal));
    await restore(service, result);
    for (const thread of [first, second]) { assert.equal(read(thread.file), thread.content); assert.equal(f.provider(thread.id), 'previous'); }
    assert.equal(JSON.parse(read(manifestPath)).status, 'restored');
  });
  await check('Caller-reserved backup IDs are exact, exclusive and never let a new transaction replace an existing batch', async () => {
    const f = fixture('reserved-batch'), thread = f.add(190), backupId = 'provider-1730000000000-012345abcdef';
    let observed;
    const service = f.service({ ...automatic, backupId, onPrepared: info => { observed = info; } });
    const { result } = await apply(service); assert(result.ok, result.message); assert.equal(result.backupId, backupId); assert.equal(observed.backupId, backupId);
    const manifestPath = path.join(result.backup, 'manifest.json'), saved = read(manifestPath), current = read(thread.file);
    const duplicate = await apply(f.service({ ...automatic, backupId }));
    assert.equal(duplicate.result.ok, false); assert.equal(duplicate.result.backupId, undefined);
    assert.equal(read(manifestPath), saved); assert.equal(read(thread.file), current);
    await restore(service, result); assert.equal(read(thread.file), thread.content);
    const invalid = await apply(f.service({ ...automatic, backupId: '../../outside' }));
    assert.equal(invalid.result.ok, false); assert.match(invalid.result.message, /批次 ID/);
  });
  await check('A trusted incomplete original provider can be restored only when no logs or databases exist', async () => {
    const home = path.join(root, 'empty-legacy-config', '.codex'); fs.mkdirSync(home, { recursive: true });
    const configPath = path.join(home, 'config.toml'); write(configPath, plannedConfiguration);
    const ctx = { home, sqliteHome: home, blockingProcesses: async () => [] };
    const missingProvider = 'model_provider="legacy-unconfigured"\n# original bytes preserved by the caller\n';
    const service = createHistoryRepairService(ctx, { ...automatic, configurationText: missingProvider });
    const { result } = await apply(service); assert(result.ok, result.message); assert.equal(result.updated, 0); assert.equal(result.backupId, undefined);
    assert.equal(read(configPath), plannedConfiguration);
    assert.equal((await service.preview({ targetProvider: 'another-unconfigured' })).ok, false);
    write(configPath, missingProvider); assert.equal((await createHistoryRepairService(ctx).preview()).ok, false);
    const databasePath = path.join(home, 'state_5.sqlite'), db = new DatabaseSync(databasePath); databases.push(db); db.exec('CREATE TABLE unrelated(value TEXT);');
    const withDatabase = await service.preview(); assert.equal(withDatabase.ok, false); assert.match(withDatabase.message, /目标供应商/);
    db.close(); fs.unlinkSync(databasePath);
    write(path.join(home, 'sessions', 'unindexed.jsonl'), '{"type":"session_meta","payload":{"id":"' + id(200) + '","model_provider":"old"}}\n');
    const withFile = await service.preview(); assert.equal(withFile.ok, false); assert.match(withFile.message, /目标供应商/);
  });
  console.log(`History connection backups: ${checks} isolated checks passed`);
} finally {
  for (const db of databases) { try { db.close(); } catch {} }
  if (originalClientHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = originalClientHome;
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('yunqiao-connection-history-'));
  fs.rmSync(root, { recursive: true, force: true });
}
