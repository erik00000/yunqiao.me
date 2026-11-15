import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-native-index-')));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const meta = { type: 'session_meta', ordinal: 0, payload: { id: 'thread' } };
const event = (type, ordinal, fields = {}) => ({ type: 'event_msg', ordinal, timestamp: '2026-11-15T01:00:00Z', payload: { type, thread_id: 'thread', ...fields } });
const start = (id = 'turn', ordinal = 1) => event('task_started', ordinal, { turn_id: id, started_at: 100 });
const response = (text = '原始请求', id = 'turn', ordinal = 3) => ({ type: 'response_item', ordinal, timestamp: '2026-11-15T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: id, create_time: 100 } } });
const user = (text = '原始请求', id = 'turn', ordinal = 2) => event('user_message', ordinal, { turn_id: id, message: text });
const complete = (text = '原始请求', item = 'native-first', id = 'turn', ordinal = 4) => event('item_completed', ordinal, { turn_id: id, item: { type: 'UserMessage', id: item, content: [{ type: 'text', text }] } });
const end = (id = 'turn', ordinal = 5) => event('task_complete', ordinal, { turn_id: id, started_at: 100, completed_at: 102, duration_ms: 2000 });
const defaultRecords = () => [meta, start(), user(), response(), complete(), end()];
let api, cases = 0, seq = 0;
async function fixture({ records = defaultRecords(), turns = [{ id: 'turn', status: 'completed', ordinal: 1 }], archive = false, schema = true } = {}) {
  const home = path.join(temporary, `case-${++seq}`);
  const rollout = path.join(home, archive ? 'archived_sessions' : 'sessions', '2026', 'rollout.jsonl');
  write(rollout, records.map(x => JSON.stringify(x)).join('\n') + '\n');
  const dbFile = path.join(home, 'thread_history_1.sqlite'), db = new DatabaseSync(dbFile);
  if (schema) {
    db.exec(`CREATE TABLE thread_turns(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,status TEXT NOT NULL,first_user_item_id TEXT,rollout_ordinal INTEGER,error_json TEXT,started_at INTEGER,completed_at INTEGER,duration_ms INTEGER,rollout_end_ordinal INTEGER,PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE thread_items(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,item_id TEXT NOT NULL,rollout_ordinal INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,item_json TEXT NOT NULL,item_type TEXT NOT NULL,updated_at_ordinal INTEGER NOT NULL,PRIMARY KEY(thread_id,turn_id,item_id));
      CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id,rollout_ordinal);`);
    for (const turn of turns) db.prepare('INSERT INTO thread_turns(thread_id,turn_id,status,first_user_item_id,rollout_ordinal) VALUES(?,?,?,?,?)').run('thread', turn.id, turn.status, turn.first ?? null, turn.ordinal);
  } else db.exec('CREATE TABLE thread_turns (thread_id TEXT, renamed_turn TEXT);');
  const context = { home, sqliteHome: home, blockingProcesses: async () => [] };
  return { home, rollout, dbFile, db, service: api.createSessionIndexRepairService(context), context, read: () => db.prepare('SELECT * FROM thread_items ORDER BY rollout_ordinal').all() };
}
async function check(name, fn) { await fn(); cases++; console.log(`PASS ${name}`); }
try {
  const bundle = path.join(temporary, 'index.cjs');
  await build({ entryPoints: [path.join(root, 'src/core/sessionIndexRepair.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  api = createRequire(import.meta.url)(bundle);
  await check('真实原生投影写入、可重复执行、保留rollout、按行恢复保留其他消息', async () => {
    const f = await fixture(), original = fs.readFileSync(f.rollout, 'utf8');
    try {
      const preview = await f.service.preview(); assert.equal(preview.changes, 1); assert.equal(f.read().length, 0);
      const result = await f.service.apply({ revision: preview.revision }); assert(result.applied); assert.equal(result.insertedMessages, 1);
      assert.equal(f.read()[0].item_id, 'native-first'); assert.equal(f.read()[0].rollout_ordinal, 4); assert.equal(JSON.parse(f.read()[0].item_json).content[0].text, '原始请求');
      assert.equal(f.db.prepare('SELECT first_user_item_id FROM thread_turns').get().first_user_item_id, 'native-first');
      assert.equal((await f.service.preview()).changes, 0); assert.equal(fs.readFileSync(f.rollout, 'utf8'), original);
      f.db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run('other', 'other', 'keep', 10, 1, '{}', 'agentMessage', 10);
      const restore = f.service.restorePreview({ backupId: result.backupId }); assert(restore.canRestore);
      await f.service.restore({ backupId: result.backupId, revision: restore.revision });
      assert.equal(f.read().length, 1); assert.equal(f.read()[0].item_id, 'keep'); assert.equal(f.db.prepare('SELECT first_user_item_id FROM thread_turns').get().first_user_item_id, null);
    } finally { f.db.close(); }
  });
  await check('后续编辑原生内容会阻止恢复，不覆盖新数据', async () => {
    const f = await fixture(); try {
      const result = await f.service.apply({ revision: (await f.service.preview()).revision });
      f.db.prepare('UPDATE thread_items SET item_json=?').run('{"type":"userMessage","content":[{"type":"text","text":"later edit"}]}');
      const restore = f.service.restorePreview({ backupId: result.backupId }); assert(!restore.canRestore);
      await assert.rejects(f.service.restore({ backupId: result.backupId, revision: restore.revision }), /冲突/); assert(f.read()[0].item_json.includes('later edit'));
    } finally { f.db.close(); }
  });
  await check('同文多次发送保持各自完成事件ID、位置及首条指针', async () => {
    const f = await fixture({ records: [meta, start(), user('重复'), response('重复'), complete('重复'), user('重复','turn',5), response('重复','turn',6), complete('重复','native-second','turn',7), end('turn',8)] });
    try { const p = await f.service.preview(); assert.equal(p.changes, 2); await f.service.apply({ revision: p.revision }); assert.deepEqual(f.read().map(x => x.item_id), ['native-first','native-second']); assert.equal(f.db.prepare('SELECT first_user_item_id FROM thread_turns').get().first_user_item_id, 'native-first'); } finally { f.db.close(); }
  });
  await check('附件首条不能被后续纯文字冒充首条', async () => {
    const attachment = response(); attachment.payload.content = [{ type: 'input_image', image_url: 'local' }];
    const completedAttachment = complete(); completedAttachment.payload.item.content = [{ type: 'image', image_url: 'local' }];
    const f = await fixture({ records: [meta, start(), attachment, completedAttachment, user('后续','turn',5), response('后续','turn',6), complete('后续','second','turn',7), end('turn',8)] });
    try { const p = await f.service.preview(); assert.equal(p.changes, 0); assert(p.skipped > 0); } finally { f.db.close(); }
  });
  await check('独立事件不足、多完成身份、终态后完成事件均不会猜测恢复', async () => {
    for (const records of [[meta,start(),response(),end()], [...defaultRecords().slice(0,-1),complete('原始请求','another','turn',5),end('turn',6)], [meta,start(),user(),response(),end(),complete()]]) {
      const f = await fixture({ records }); try { assert.equal((await f.service.preview()).changes, 0); } finally { f.db.close(); }
    }
  });
  await check('相同长度与mtime的来源变更仍使预览过期', async () => {
    const f = await fixture(); try {
      const p = await f.service.preview(), stat = fs.statSync(f.rollout); fs.writeFileSync(f.rollout, fs.readFileSync(f.rollout,'utf8').replaceAll('原始请求','变更请求')); fs.utimesSync(f.rollout,stat.atime,stat.mtime);
      await assert.rejects(f.service.apply({ revision: p.revision }), /变化/); assert.equal(f.read().length,0);
    } finally { f.db.close(); }
  });
  await check('未知schema明确拒绝，不创建空索引或误报成功', async () => {
    const f = await fixture({ schema: false }); try { await assert.rejects(f.service.preview(), /格式未知/); assert(!f.db.prepare("SELECT name FROM sqlite_master WHERE name='thread_items'").get()); } finally { f.db.close(); }
  });
  await check('active范围不碰归档；all扫描归档并修复', async () => {
    const f = await fixture({ archive: true }); try { assert.equal((await f.service.preview({ scope:'active' })).changes,0); const p=await f.service.preview({scope:'all'}); assert.equal(p.changes,1); await f.service.apply({scope:'all',revision:p.revision}); } finally { f.db.close(); }
  });
  await check('正在生成的原生轮次及运行中的客户端阻止写入', async () => {
    const f = await fixture({ turns: [{id:'turn',status:'inProgress',ordinal:1}] }); try { assert.equal((await f.service.preview()).changes,0); const running=api.createSessionIndexRepairService({...f.context,blockingProcesses:async()=>['Codex.exe']}); await assert.rejects(running.apply({revision:'anything'}),/请先完全退出/); } finally { f.db.close(); }
  });
  await check('完整原始边界与canonical归属共同证明缺失轮次才补建', async () => {
    const f = await fixture({turns:[]}); try {
      assert.equal((await f.service.preview()).changes,0);
      const state=new DatabaseSync(path.join(f.home,'state_5.sqlite')); state.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)'); state.prepare('INSERT INTO threads VALUES(?,?)').run('thread',f.rollout); state.close();
      const p=await f.service.preview(); assert.equal(p.createdTurns,1); const applied=await f.service.apply({revision:p.revision});
      const turn=f.db.prepare('SELECT * FROM thread_turns').get(); assert.equal(turn.status,'completed'); assert.equal(turn.started_at,100); assert.equal(turn.completed_at,102); assert.equal(turn.first_user_item_id,'native-first');
      const r=f.service.restorePreview({backupId:applied.backupId}); await f.service.restore({backupId:applied.backupId,revision:r.revision}); assert.equal(f.db.prepare('SELECT count(*) AS n FROM thread_turns').get().n,0);
    } finally { f.db.close(); }
  });
  await check('目标事件和内部objective双重证据生成稳定目标投影', async () => {
    const goal=event('thread_goal_updated',1,{threadId:'thread',goal:{id:'goal-1',createdAt:99,objective:'完成目标'}}), context=response('<codex_internal_context>\n<objective>\n完成目标\n</objective>\n</codex_internal_context>','turn',3);
    const f=await fixture({records:[meta,goal,start('turn',2),context,end('turn',4)],turns:[{id:'turn',status:'completed',ordinal:2}]});
    try { const p=await f.service.preview(); assert.equal(p.changes,1); await f.service.apply({revision:p.revision}); assert(f.read()[0].item_id.startsWith('recovered-goal-')); assert.equal(JSON.parse(f.read()[0].item_json).content[0].text,'完成目标'); assert.equal((await f.service.preview()).changes,0); } finally { f.db.close(); }
  });
  await check('SQLite写入失败整批回滚并保留失败日志', async () => {
    const f=await fixture(); try {
      f.db.exec("CREATE TRIGGER reject_link BEFORE UPDATE ON thread_turns BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
      const p=await f.service.preview(); await assert.rejects(f.service.apply({revision:p.revision}),/simulated failure/); assert.equal(f.read().length,0); assert.equal(f.service.backups().backups[0].status,'failed');
    } finally { f.db.close(); }
  });
  await check('截断尾行及跨会话污染跳过整份源文件', async () => {
    const f=await fixture(); try { fs.appendFileSync(f.rollout,'{"type":'); const p=await f.service.preview(); assert.equal(p.changes,0); assert(p.items.some(i=>i.reason.includes('尾行'))); } finally { f.db.close(); }
    const other=await fixture({records:[...defaultRecords(),event('user_message',6,{thread_id:'other',turn_id:'turn',message:'污染'})]}); try { const p=await other.service.preview(); assert.equal(p.changes,0); assert(p.items.some(i=>i.reason.includes('混入'))); } finally { other.db.close(); }
  });
  await check('悬空指针只能恢复相同原生ID，不能借用任意消息', async () => {
    const f=await fixture({turns:[{id:'turn',status:'completed',ordinal:1,first:'different-id'}]});
    try { assert.equal((await f.service.preview()).changes,0); assert.equal(f.db.prepare('SELECT first_user_item_id FROM thread_turns').get().first_user_item_id,'different-id'); } finally { f.db.close(); }
  });
  await check('已有孤立原生消息只重新连接指针且恢复保留后来状态', async () => {
    const f=await fixture(); try {
      f.db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run('thread','turn','native-first',4,100000,JSON.stringify({type:'userMessage',id:'native-first',content:[{type:'text',text:'原始请求'}]}),'userMessage',4);
      const p=await f.service.preview(); assert.equal(p.insertedMessages,0); assert.equal(p.relinkedTurns,1);
      const r=await f.service.apply({revision:p.revision}); f.db.prepare("UPDATE thread_turns SET status='interrupted'").run();
      const restore=f.service.restorePreview({backupId:r.backupId}); assert(restore.canRestore); await f.service.restore({backupId:r.backupId,revision:restore.revision});
      const turn=f.db.prepare('SELECT * FROM thread_turns').get(); assert.equal(turn.status,'interrupted'); assert.equal(turn.first_user_item_id,null); assert.equal(f.read().length,1);
    } finally { f.db.close(); }
  });
  await check('旧inProgress仅在日志与原生后继边界都吻合时可补写', async () => {
    const f=await fixture({records:[...defaultRecords(),start('next',6),end('next',7)],turns:[{id:'turn',status:'inProgress',ordinal:1},{id:'next',status:'completed',ordinal:6}]});
    try { const p=await f.service.preview(); assert.equal(p.changes,1); await f.service.apply({revision:p.revision}); assert.equal(f.db.prepare("SELECT status FROM thread_turns WHERE turn_id='turn'").get().status,'inProgress'); } finally { f.db.close(); }
  });
  await check('分片原始位置相同但完成事件ID不同拒绝选择胜者', async () => {
    const f=await fixture(); try {
      const fragment=defaultRecords(); fragment[4]=complete('原始请求','conflicting-id','turn',5); fragment[5]=end('turn',6);
      write(path.join(f.home,'archived_sessions','fragment.jsonl'),fragment.map(x=>JSON.stringify(x)).join('\n')+'\n');
      const p=await f.service.preview(); assert.equal(p.changes,0); assert(p.skipped>0);
    } finally { f.db.close(); }
  });
  await check('取得锁后来源变化时取消写入，原生消息保持原样', async () => {
    const f=await fixture(); try {
      let checks=0;
      const service=api.createSessionIndexRepairService({...f.context,blockingProcesses:async()=>{ if(++checks===2) fs.appendFileSync(f.rollout,JSON.stringify(event('token_count',6))+'\n'); return []; }});
      const p=await service.preview(); await assert.rejects(service.apply({revision:p.revision}),/变化/); assert.equal(f.read().length,0);
    } finally { f.db.close(); }
  });
  console.log(`Native session index checks passed: ${cases}`);
} finally {
  // All fixtures are generated beneath this explicitly resolved temporary directory.
  const resolved=path.resolve(temporary); if (path.dirname(resolved)!==fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('aurora-native-index-')) throw new Error('Unexpected test cleanup directory');
  fs.rmSync(resolved,{recursive:true,force:true});
}
