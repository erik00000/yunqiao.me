import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-history-repair-test-'));
let count = 0;
function check(label, fn) { fn(); count++; console.log(`PASS ${label}`); }
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => fs.readFileSync(file, 'utf8');
const uid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (id, provider = 'old', extra = {}) => [
  JSON.stringify({ timestamp: '2026-11-15T01:00:00Z', type: 'session_meta', payload: { id, model_provider: provider, cwd: 'D:/existing-project', source: 'cli', ...extra } }),
  ' { "type": "event_msg", "payload": {"type":"user_message", "message":"正文 不应改变"} } ',
  JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'opaque-ciphertext-preserve-exactly' } }),
].join('\r\n') + '\r\n';
try {
  const bundle = path.join(root, 'api.cjs');
  await build({ entryPoints: [path.join(workspace, 'src/core/historyRepair.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { createHistoryRepairService } = createRequire(import.meta.url)(bundle);
  function fixture(name) {
    const home = path.join(root, name, '.codex'); fs.mkdirSync(home, { recursive: true });
    write(path.join(home, 'config.toml'), 'model_provider = "aurora"\n[model_providers.aurora]\nname = "Aurora"\nbase_url = "http://127.0.0.1:3425/v1"\n');
    const dbPath = path.join(home, 'state_5.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT, cwd TEXT, title TEXT, archived INTEGER, untouched TEXT); CREATE TABLE local_thread_catalog_hosts(host_id TEXT PRIMARY KEY, host_kind TEXT); INSERT INTO local_thread_catalog_hosts VALUES('local-machine','local'),('remote-machine','remote'); CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,model_provider TEXT,display_title TEXT,archived INTEGER,PRIMARY KEY(host_id,thread_id));");
    function add(n, options = {}) {
      const id = uid(n), archived = !!options.archived;
      const file = path.join(home, archived ? 'archived_sessions' : 'sessions', '2026', `rollout-${id}.jsonl`);
      const source = options.content ?? text(id, options.provider || 'old', options.meta || {});
      if (!options.missing) write(file, source);
      if (!options.orphan) db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id, options.provider || 'old', options.stalePath ? path.join(home, 'moved', path.basename(file)) : file, 'D:/existing-project', `Session ${n}`, archived ? 1 : 0, 'keep-me');
      if (options.catalog) { db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?,?,?)').run('local-machine', id, 'old', `Local ${n}`, 0); db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?,?,?)').run('remote-machine', id, 'remote-provider', `Remote ${n}`, 0); }
      return { id, file, source };
    }
    const ctx = { home, sqliteHome: home, blockingProcesses: async () => [] };
    return { home, db, dbPath, add, service: createHistoryRepairService(ctx), ctx };
  }
  const f = fixture('normal');
  const first = f.add(1, { catalog: true }), second = f.add(2, { archived: true, stalePath: true });
  f.add(3, { missing: true }); f.add(4, { meta: { source: { subagent: { parent_thread_id: first.id } } } }); f.add(5, { content: text(uid(5)) + '{partial' }); f.add(6, { orphan: true });
  const initial = await f.service.preview({ scope: 'all', fixPaths: true });
  check('Preview reports repairable and blocked cases without writing', () => { assert(initial.ok, initial.message); assert.equal(initial.summary.repairable, 2); assert.equal(initial.summary.blocked, 4); assert.equal(initial.summary.pathChanges, 1); assert(initial.summary.encrypted >= 2); assert.equal(read(first.file), first.source); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'old'); });
  const active = await f.service.preview({ scope: 'active', ids: [first.id] });
  check('Explicit IDs and active/archive scopes are honored', () => { assert.equal(active.items.length, 1); assert.equal(active.items[0].id, first.id); });
  const invalidTarget = await f.service.preview({ targetProvider: 'unconfigured' });
  check('Unconfigured provider IDs are rejected before planning', () => assert(!invalidTarget.ok));
  const applied = await f.service.apply({ ...initial.options, revision: initial.revision });
  check('Batch repair changes metadata, canonical index, local catalog and verified stale paths', () => { assert(applied.ok, applied.message); assert.equal(applied.updated, 2); assert.equal(JSON.parse(read(first.file).split('\r\n')[0]).payload.model_provider, 'aurora'); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'aurora'); assert.equal(f.db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(second.id).rollout_path, second.file); assert.equal(f.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('local-machine', first.id).model_provider, 'aurora'); });
  check('Chat body, encrypted content, unrelated fields and remote host catalog remain intact', () => { assert.equal(read(first.file).split('\r\n').slice(1).join('\r\n'), first.source.split('\r\n').slice(1).join('\r\n')); assert.equal(f.db.prepare('SELECT untouched FROM threads WHERE id=?').get(first.id).untouched, 'keep-me'); assert.equal(f.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('remote-machine', first.id).model_provider, 'remote-provider'); });
  check('Each modified source has a full original backup and SQLite has a readable consistent snapshot', () => { const manifest = JSON.parse(read(path.join(applied.backup, 'manifest.json'))); assert.equal(manifest.files.length, 2); assert.equal(read(manifest.files[0].original), first.source); const snapshot = new DatabaseSync(manifest.databases[0].backup, { readOnly: true }); assert.equal(snapshot.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'old'); snapshot.close(); });
  const unchanged = await f.service.preview({ ids: [first.id, second.id] });
  check('Repeated repair is idempotent', () => { assert.equal(unchanged.summary.repairable, 0); assert.equal(unchanged.summary.unchanged, 2); });
  const newSession = f.add(7, { provider: 'new-after-repair' });
  const restorePreview = await f.service.restorePreview({ backupId: applied.backupId });
  const restored = await f.service.restore({ backupId: applied.backupId, revision: restorePreview.revision });
  check('Restore puts back exact original files and only changed row fields, preserving new sessions', () => { assert(restored.ok, restored.message); assert.equal(read(first.file), first.source); assert.equal(read(second.file), second.source); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'old'); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(newSession.id).model_provider, 'new-after-repair'); assert(f.service.backups().backups[0].restoredAt); });
  const stale = await f.service.preview({ ids: [first.id] });
  write(first.file, first.source + '\n');
  const staleResult = await f.service.apply({ ...stale.options, revision: stale.revision });
  check('Source changes after preview invalidate the batch revision', () => { assert(!staleResult.ok); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'old'); });
  write(first.file, first.source);
  const rowPreview = await f.service.preview({ ids: [first.id] });
  f.db.prepare('UPDATE threads SET model_provider=? WHERE id=?').run('external-change', first.id);
  const rowResult = await f.service.apply({ ...rowPreview.options, revision: rowPreview.revision });
  check('Index changes after preview invalidate the batch revision', () => assert(!rowResult.ok));
  f.db.prepare('UPDATE threads SET model_provider=? WHERE id=?').run('old', first.id);
  const selected = await f.service.preview({ ids: [first.id] });
  const selectedApplied = await f.service.apply({ ...selected.options, revision: selected.revision });
  assert(selectedApplied.ok, selectedApplied.message);
  write(first.file, read(first.file) + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'new work' } }) + '\n');
  const conflict = await f.service.restorePreview({ backupId: selectedApplied.backupId });
  check('Restore refuses to overwrite a continued conversation', () => { assert(!conflict.ok); assert(conflict.conflicts.some(x => x.includes('新增或修改'))); assert(read(first.file).includes('new work')); });
  const processService = createHistoryRepairService({ ...f.ctx, blockingProcesses: async () => ['ChatGPT.exe'] });
  const blocked = await processService.apply({ ...selected.options, revision: selected.revision });
  check('Running desktop or CLI blocks writes', () => assert(!blocked.ok && blocked.message.includes('ChatGPT.exe')));
  f.db.close();
  const alternate = fixture('alternate-db');
  const migrated = alternate.add(10);
  alternate.db.close();
  fs.mkdirSync(path.join(alternate.home, 'sqlite'));
  fs.renameSync(alternate.dbPath, path.join(alternate.home, 'sqlite', 'codex-vnext.db'));
  const alternatePlan = await alternate.service.preview({});
  const alternateResult = await alternate.service.apply({ ...alternatePlan.options, revision: alternatePlan.revision });
  check('New sqlite directory layouts are discovered by schema', () => { assert(alternatePlan.ok, alternatePlan.message); assert(alternatePlan.dbPath.endsWith('codex-vnext.db')); assert(alternateResult.ok, alternateResult.message); assert.equal(JSON.parse(read(migrated.file).split('\r\n')[0]).payload.model_provider, 'aurora'); });
  const selectedArchive = await alternate.service.preview({ scope: 'archived' });
  check('Empty scopes are reported honestly without creating backups', () => assert.equal(selectedArchive.summary.selected, 0));
  console.log(`\n${count} batch history repair integration checks passed.`);
} finally {
  const resolved = path.resolve(root);
  if (resolved.startsWith(path.join(os.tmpdir(), 'aurora-history-repair-test-'))) fs.rmSync(resolved, { recursive: true, force: true });
}
