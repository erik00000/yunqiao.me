/** Native Codex history projection repair, informed by CodexPlusPlus (AGPL-3.0-only).
 * Upstream source: 75d25e0b, session_index_scan.rs / session_index_repair.rs.
 * Raw rollout files are evidence only and are never modified by this module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  acquireHistoryLock, assertClientsStopped, checkedFile, discoverHistoryDbs, fileHash, historyLocation, normalizeHistoryContext, sameHistoryFile,
  historyContext, openHistoryDb, repairRoot, saveJournal, sqlIdentifier, tableColumns, valueHash,
  type HistoryContext, type SqlDb,
} from './historyRepairIO.js';

type Row = Record<string, any>;
type Scope = 'active' | 'archived' | 'all';
interface Options { scope?: Scope; ids?: string[]; revision?: string; backupId?: string }
interface Source { file: string; hash: string; size: number; mtime: number; threadId: string }
interface Boundary { start: number; end: number; started: number; completed: number; status: string; error: string | null; duration: number | null }
interface Candidate {
  threadId: string; turnId: string; itemId: string; ordinal: number; responseOrdinal: number;
  text: string; created: number; originalFirst: boolean; nativeIdentity: boolean; goal: boolean;
  boundary?: Boundary; following?: { id: string; ordinal: number }; start?: number; source: string;
}
interface Detail { threadId: string; turnId?: string; itemId?: string; action: string; reason: string; file?: string }
interface Mutation { table: 'thread_items' | 'thread_turns'; key: Row; before: Row | null; after: Row; fields?: string[] }
interface Plan { db: string; sources: Source[]; mutations: Mutation[]; items: Detail[]; warnings: string[]; scanFiles: number; candidates: number; existing: number; skipped: number; revision: string; options: Options }
interface Journal { version: 1; id: string; home: string; sqliteHome: string; db: string; createdAt: string; status: string; mutations: Mutation[]; snapshot?: string; error?: string; restoredAt?: string }
const terminal = new Set(['completed', 'interrupted', 'failed']);
const itemFields = ['thread_id', 'turn_id', 'item_id', 'rollout_ordinal', 'created_at_ms', 'item_json', 'item_type', 'updated_at_ordinal'];
const turnFields = ['thread_id', 'turn_id', 'status', 'first_user_item_id'];
const boundaryFields = ['rollout_ordinal', 'error_json', 'started_at', 'completed_at', 'duration_ms', 'rollout_end_ordinal'];
const validOrdinal = (n: any): n is number => Number.isSafeInteger(n) && n >= 0;
const plain = (value: any): string | null => Array.isArray(value) && value.length && value.every(p => ['text', 'input_text', 'Text'].includes(p?.type) && typeof p.text === 'string') ? value.map(p => p.text).join('') || null : null;
const ordinary = (text: string) => !!text.trim() && !/^(?:<codex_internal_context|<environment_context|<permissions instructions>|# AGENTS\.md instructions|<INSTRUCTIONS>)/.test(text.trimStart());
const messageText = (row: Row): string | null => { try { return plain(JSON.parse(row.item_json).content); } catch { return null; } };
const getKey = (table: string, row: Row) => table === 'thread_items' ? { thread_id: row.thread_id, turn_id: row.turn_id, item_id: row.item_id } : { thread_id: row.thread_id, turn_id: row.turn_id };
const stamp = (file: string) => { const s = fs.statSync(file); return { size: s.size, mtime: s.mtimeMs }; };

function walk(dir: string, home: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('不扫描链接目录中的历史记录');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(file, home, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(checkedFile(home, file));
    if (out.length > 100_000) throw new Error('会话文件超过十万项，请缩小扫描目录');
  }
}

/** Never derive a native item ID from text alone. Repeated sends consume distinct evidence. */
function scan(raw: string, file: string): { threadId: string; candidates: Candidate[]; issues: Detail[] } {
  const lines = raw.replace(/^\uFEFF/, '').split('\n');
  const records: Row[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { records.push(JSON.parse(lines[i])); }
    catch { throw new Error(i === lines.length - 1 ? '会话尾行尚未写完整' : `第 ${i + 1} 行 JSON 损坏`); }
  }
  const first = records[0];
  if (first?.type !== 'session_meta' || typeof first.payload?.id !== 'string' || !first.payload.id) throw new Error('首条记录缺少 session_meta 会话身份');
  const threadId = first.payload.id;
  if (first.payload.subagent_history_start_ordinal != null || first.payload.parent_thread_id || typeof first.payload.source === 'object' && first.payload.source?.subagent) throw new Error('子任务继承日志需要单独的分片归属核验，本次跳过');
  type Turn = { responses: Row[]; completions: Row[]; events: Row[]; start?: Row; end?: Row; invalid: boolean; following?: { id: string; ordinal: number } };
  const turns = new Map<string, Turn>();
  const get = (id: string): Turn => { if (!turns.has(id)) turns.set(id, { responses: [], completions: [], events: [], invalid: false }); return turns.get(id)!; };
  let current = '', previous = '';
  let goal: { text: string; key: string; created: number; turn?: string } | undefined;
  const goals: Candidate[] = [], seenGoals = new Set<string>();
  const issues: Detail[] = [];
  let lastOrdinal = -1;
  for (let position = 0; position < records.length; position++) {
    const row = records[position], p = row.payload || {};
    if (row.ordinal != null) {
      if (!validOrdinal(row.ordinal) || row.ordinal <= lastOrdinal) throw new Error('原始记录序号重复、倒序或无法精确表示');
      lastOrdinal = row.ordinal;
    }
    if (row.type === 'session_meta') { if (p.id !== threadId) throw new Error('文件混入其他会话元数据'); continue; }
    if ((p.thread_id && p.thread_id !== threadId) || (p.threadId && p.threadId !== threadId)) throw new Error('文件混入其他会话事件');
    row.position = position;
    if (row.type === 'event_msg') {
      const id = typeof p.turn_id === 'string' ? p.turn_id : current;
      if (p.type === 'task_started') {
        if (!id) continue;
        const turn = get(id);
        if (turn.start || turn.end) turn.invalid = true;
        if (current && current !== id && !get(current).end) get(current).invalid = true;
        turn.start = row;
        if (previous && previous !== id && validOrdinal(row.ordinal)) get(previous).following = { id, ordinal: row.ordinal };
        current = id; previous = id;
        if (goal && !goal.turn) goal.turn = id;
      } else if (['task_complete', 'task_failed', 'turn_aborted'].includes(p.type)) {
        if (!id) continue;
        const turn = get(id); if (turn.end) turn.invalid = true; turn.end = row; current = '';
      } else if (p.type === 'thread_goal_updated' && p.threadId === threadId && typeof p.goal?.objective === 'string' && Number.isSafeInteger(p.goal?.createdAt)) {
        const key = p.goal.id ? `id:${p.goal.id}:created:${p.goal.createdAt}` : `created:${p.goal.createdAt}`;
        if (!seenGoals.has(key)) goal = { text: p.goal.objective, key, created: p.goal.createdAt * 1000 };
      } else if (p.type === 'user_message' && id && typeof p.message === 'string' && ordinary(p.message)) {
        const turn = get(id); if (!turn.end) turn.events.push(row);
      } else if (p.type === 'item_completed' && ['UserMessage', 'userMessage'].includes(p.item?.type) && id) {
        const turn = get(id);
        if (turn.end) { turn.invalid = true; continue; }
        if (p.thread_id !== threadId || p.turn_id !== id || !validOrdinal(row.ordinal) || typeof p.item?.id !== 'string' || !p.item.id) turn.invalid = true;
        turn.completions.push(row);
      }
    }
    if (row.type === 'response_item' && p.role === 'user') {
      const meta = p.internal_chat_message_metadata_passthrough || {}, id = meta.turn_id || current;
      if (!id) continue;
      const turn = get(id), text = plain(p.content);
      const visible = Array.isArray(p.content) ? p.content.map((x: any) => x.text || '').join('') : '';
      const attachment = Array.isArray(p.content) && p.content.some((x: any) => !['text', 'input_text', 'Text'].includes(x.type));
      if (turn.end) turn.invalid = true;
      if (goal && goal.turn === id && text?.startsWith('<codex_internal_context') && (text.includes(`<objective>\n${goal.text}\n</objective>`) || text.includes(`<objective>\r\n${goal.text}\r\n</objective>`)) && validOrdinal(row.ordinal)) {
        goals.push({ threadId, turnId: id, itemId: `recovered-goal-${valueHash([threadId, goal.key, goal.text])}`, ordinal: row.ordinal, responseOrdinal: row.ordinal, text: goal.text, created: goal.created, originalFirst: false, nativeIdentity: false, goal: true, source: file });
        seenGoals.add(goal.key); goal = undefined;
      }
      if (ordinary(visible) || attachment) {
        if (meta.turn_id !== id || !validOrdinal(row.ordinal)) turn.invalid = true;
        turn.responses.push(row);
      }
    }
  }
  const candidates: Candidate[] = [];
  for (const [turnId, turn] of turns) {
    const skip = (reason: string) => issues.push({ threadId, turnId, action: 'skip', reason, file });
    if (turn.invalid) { skip('轮次身份、原始顺序或完成事件存在冲突'); continue; }
    const responses = turn.responses, firstResponse = responses[0], firstCompletion = turn.completions[0];
    let boundary: Boundary | undefined;
    if (turn.start && turn.end && validOrdinal(turn.start.ordinal) && validOrdinal(turn.end.ordinal) && turn.start.ordinal < turn.end.ordinal) {
      const started = turn.start.payload.started_at ?? Date.parse(turn.start.timestamp) / 1000;
      const completed = turn.end.payload.completed_at ?? Date.parse(turn.end.timestamp) / 1000;
      if (Number.isFinite(started) && started >= 0 && Number.isFinite(completed) && completed >= started && (turn.end.payload.started_at == null || turn.end.payload.started_at === started)) {
        const end = turn.end.payload;
        boundary = { start: turn.start.ordinal, end: turn.end.ordinal, started, completed, status: end.type === 'turn_aborted' ? 'interrupted' : end.type === 'task_failed' || end.error != null ? 'failed' : 'completed', error: end.error == null ? null : JSON.stringify(end.error), duration: validOrdinal(end.duration_ms) ? end.duration_ms : null };
      }
    }
    const usedEvents = new Set<number>(), usedCompletions = new Set<number>();
    for (let index = 0; index < responses.length; index++) {
      const row = responses[index], p = row.payload, text = plain(p.content), meta = p.internal_chat_message_metadata_passthrough || {};
      if (!text || !ordinary(text) || !validOrdinal(row.ordinal)) { skip('附件或缺失原生序号的消息不自动补写'); continue; }
      const next = responses.slice(index + 1).find(r => plain(r.payload.content) === text), prev = responses.slice(0, index).reverse().find(r => plain(r.payload.content) === text);
      const complete = turn.completions.filter(r => !usedCompletions.has(r.position) && plain(r.payload.item.content) === text && r.ordinal > row.ordinal && (!next || r.ordinal < next.ordinal) && (!turn.end || r.position < turn.end.position));
      if (complete.length > 1) { skip('一条用户输入对应多个完成事件，无法确认原生消息身份'); continue; }
      const eventCount = turn.events.filter(r => r.payload.message === text).length, responseCount = responses.filter(r => plain(r.payload.content) === text).length;
      const event = eventCount === responseCount ? turn.events.find(r => !usedEvents.has(r.position) && r.payload.message === text && (!prev || r.position > prev.position) && (!next || r.position < next.position)) : undefined;
      if (!complete.length && !event) { skip('缺少独立用户事件或唯一原生完成事件'); continue; }
      if (event) usedEvents.add(event.position);
      const projection = complete[0]; if (projection) usedCompletions.add(projection.position);
      const created = Number.isFinite(meta.create_time) && meta.create_time > 0 ? Math.trunc(meta.create_time * 1000) : Date.parse(row.timestamp);
      if (!Number.isSafeInteger(created) || created < 0) { skip('原始消息创建时间不可确认'); continue; }
      const originalFirst = row === firstResponse && (!firstCompletion || projection === firstCompletion) && (!turn.start || turn.start.ordinal < row.ordinal);
      candidates.push({ threadId, turnId, text, created, source: file, responseOrdinal: row.ordinal, ordinal: projection?.ordinal ?? row.ordinal, itemId: projection?.payload.item.id || `recovered-user-${turnId}-${row.ordinal}`, nativeIdentity: !!projection, goal: false, originalFirst, boundary, following: turn.following, start: turn.start?.ordinal });
    }
    for (const candidate of goals.filter(c => c.turnId === turnId)) {
      candidate.originalFirst = !!turn.start && turn.start.ordinal < candidate.ordinal && (!firstResponse || candidate.ordinal < firstResponse.ordinal) && (!firstCompletion || candidate.ordinal < firstCompletion.ordinal);
      candidates.push({ ...candidate, boundary, following: turn.following, start: turn.start?.ordinal });
    }
  }
  return { threadId, candidates, issues };
}

function validateSchema(db: SqlDb): boolean {
  for (const [table, required] of [['thread_items', itemFields], ['thread_turns', turnFields]] as const) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!required.every(name => info.some(row => row.name === name))) throw new Error(`原生 ${table} 数据库格式未知，未进行补写`);
    const known = new Set(table === 'thread_turns' ? [...turnFields, ...boundaryFields] : itemFields);
    if (info.some(row => !known.has(row.name) && row.notnull && row.dflt_value == null)) throw new Error(`原生 ${table} 存在未知必填字段，未进行补写`);
  }
  return boundaryFields.every(name => tableColumns(db, 'thread_turns').has(name));
}

function readRows(db: SqlDb, table: string, key: Row): Row[] {
  return db.prepare(`SELECT * FROM ${sqlIdentifier(table)} WHERE ${Object.keys(key).map(k => `${sqlIdentifier(k)} IS ?`).join(' AND ')}`).all(...Object.values(key));
}
function rowProjection(row: Row | undefined, fields?: string[]): Row | null {
  if (!row) return null;
  return Object.fromEntries((fields || Object.keys(row)).sort().map(key => [key, row[key]]));
}
const same = (a: Row | null | undefined, b: Row | null | undefined, fields?: string[]) => valueHash(rowProjection(a || undefined, fields)) === valueHash(rowProjection(b || undefined, fields));
const keyMatches = (row: Row, key: Row) => Object.entries(key).every(([k, v]) => row[k] === v);

async function plan(ctx: HistoryContext, options: Options, connection?: SqlDb): Promise<Plan> {
  const scope = options.scope || 'all';
  if (!['active', 'archived', 'all'].includes(scope)) throw new Error('不支持的历史范围');
  if (options.ids && (!Array.isArray(options.ids) || options.ids.some(id => typeof id !== 'string'))) throw new Error('会话列表格式无效');
  const files: string[] = [], sources: Source[] = [], issues: Detail[] = [], warnings: string[] = [];
  if (scope !== 'archived') walk(path.join(ctx.home, 'sessions'), ctx.home, files);
  if (scope !== 'active') walk(path.join(ctx.home, 'archived_sessions'), ctx.home, files);
  let candidates: Candidate[] = [];
  for (const file of files.sort()) {
    try {
      const before = stamp(file);
      if (before.size > 128 * 1024 * 1024) throw new Error('单个日志超过 128 MiB，需分开检查');
      const bytes = fs.readFileSync(file), hash = await fileHash(file), after = stamp(file);
      if (before.size !== after.size || before.mtime !== after.mtime || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('扫描期间来源文件发生变化');
      const result = scan(bytes.toString('utf8'), file);
      if (options.ids?.length && !options.ids.includes(result.threadId)) continue;
      sources.push({ file, hash, ...after, threadId: result.threadId }); candidates.push(...result.candidates); issues.push(...result.issues);
    } catch (error) { issues.push({ threadId: '', action: 'skip', reason: (error as Error).message, file }); }
  }
  const databases = discoverHistoryDbs(ctx).filter(file => path.basename(file) === 'thread_history_1.sqlite');
  if (databases.length !== 1) throw new Error(databases.length ? '发现多个 thread_history_1.sqlite，请确认 CODEX_SQLITE_HOME' : '未发现原生 thread_history_1.sqlite；本次没有创建数据库');
  const file = databases[0], db = connection || openHistoryDb(file, true), own = !connection;
  try {
    const canCreateTurns = validateSchema(db);
    const schemas = db.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') AND tbl_name IN ('thread_items','thread_turns') ORDER BY name").all();
    const snapshots: Row[] = [], mutations: Mutation[] = [];
    const owners = new Set<string>();
    for (const stateFile of discoverHistoryDbs(ctx).filter(p => /^state_\d+\.sqlite$/.test(path.basename(p)))) {
      const state = openHistoryDb(stateFile, true);
      try {
        if (!['id', 'rollout_path'].every(c => tableColumns(state, 'threads').has(c))) continue;
        for (const row of state.prepare('SELECT id,rollout_path FROM threads WHERE rollout_path IS NOT NULL').all()) {
          if (typeof row.rollout_path === 'string' && sources.some(s => s.threadId === row.id && sameHistoryFile(ctx.home, path.resolve(ctx.home, row.rollout_path), s.file))) owners.add(row.id);
        }
      } finally { state.close(); }
    }
    // Any contradictory identity is skipped as a group, even across archived fragments.
    const groups = new Map<string, Candidate[]>();
    for (const c of candidates) { const key = `${c.threadId}\0${c.turnId}\0${c.itemId}`; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(c); }
    candidates = [];
    for (const group of groups.values()) {
      const c = group[0];
      if (group.some(other => other.text !== c.text || other.ordinal !== c.ordinal || other.responseOrdinal !== c.responseOrdinal || other.originalFirst !== c.originalFirst || other.start !== c.start || valueHash(other.following) !== valueHash(c.following) || valueHash(other.boundary) !== valueHash(c.boundary))) issues.push({ threadId: c.threadId, turnId: c.turnId, itemId: c.itemId, action: 'skip', reason: '多个日志分片的身份或首条证据互相冲突' });
      else candidates.push(c);
    }
    const conflicts = new Set<Candidate>();
    const positions = new Map<string, Candidate[]>();
    for (const c of candidates) {
      for (const key of [`projection:${c.threadId}\0${c.ordinal}`, `response:${c.threadId}\0${c.turnId}\0${c.responseOrdinal}`]) {
        if (!positions.has(key)) positions.set(key, []); positions.get(key)!.push(c);
      }
    }
    for (const group of positions.values()) if (group.length > 1) for (const c of group) conflicts.add(c);
    const threadRows = new Map<string, { turns: Row[]; items: Row[] }>();
    for (const id of [...new Set(candidates.map(c => c.threadId))].sort()) {
      const rows = { turns: readRows(db, 'thread_turns', { thread_id: id }), items: readRows(db, 'thread_items', { thread_id: id }) };
      snapshots.push({ id, turns: rows.turns.map(r => ({ ...r })), items: rows.items.map(r => ({ ...r })) }); threadRows.set(id, rows);
    }
    let existing = 0;
    const details: Detail[] = [...issues];
    for (const c of candidates.sort((a, b) => a.threadId.localeCompare(b.threadId) || a.ordinal - b.ordinal)) {
      const detail = (action: string, reason: string) => details.push({ threadId: c.threadId, turnId: c.turnId, itemId: c.itemId, action, reason });
      if (conflicts.has(c)) { detail('skip', '同一任务原生序号被不同消息占用'); continue; }
      const rows = threadRows.get(c.threadId)!;
      let turn = rows.turns.find(r => r.turn_id === c.turnId);
      const position = rows.items.find(r => r.rollout_ordinal === c.ordinal);
      const existingItem = rows.items.find(r => r.turn_id === c.turnId && r.item_id === c.itemId);
      if (position && position !== existingItem || existingItem && (existingItem.item_type !== 'userMessage' || messageText(existingItem) !== c.text || existingItem.rollout_ordinal !== c.ordinal)) { detail('skip', '原生消息身份、内容或顺序存在冲突'); continue; }
      if (!turn) {
        const b = c.boundary;
        if (!canCreateTurns || !owners.has(c.threadId) || !c.originalFirst || (!c.goal && !c.nativeIdentity) || !b || !(b.start < c.responseOrdinal && c.responseOrdinal <= c.ordinal && c.ordinal < b.end) || db.prepare('SELECT 1 FROM thread_turns WHERE turn_id=? LIMIT 1').get(c.turnId) || rows.turns.some(t => t.rollout_ordinal === b.start) || rows.items.some(r => r.turn_id === c.turnId)) { detail('skip', '原生轮次缺失，完整边界、任务归属或首条身份不足'); continue; }
        turn = { thread_id: c.threadId, turn_id: c.turnId, first_user_item_id: null, status: b.status, rollout_ordinal: b.start, error_json: b.error, started_at: b.started, completed_at: b.completed, duration_ms: b.duration, rollout_end_ordinal: b.end };
        mutations.push({ table: 'thread_turns', key: getKey('thread_turns', turn), before: null, after: { ...turn } }); rows.turns.push(turn);
      }
      const first = rows.items.find(r => r.turn_id === c.turnId && r.item_id === turn!.first_user_item_id && r.item_type === 'userMessage');
      const userRows = rows.items.filter(r => r.turn_id === c.turnId && r.item_type === 'userMessage');
      let finished = terminal.has(turn.status);
      if (!finished && turn.status === 'inProgress' && c.following && c.start != null && turn.rollout_ordinal === c.start && c.following.ordinal > c.ordinal) finished = rows.turns.some(t => t.turn_id === c.following!.id && t.rollout_ordinal === c.following!.ordinal);
      if (existingItem && (turn.first_user_item_id === c.itemId || first && first.rollout_ordinal < c.ordinal)) { existing++; detail('present', '原生消息已存在'); continue; }
      if (!finished) { detail('skip', '原生轮次仍在运行或状态未知'); continue; }
      let link = false;
      if (existingItem) {
        if (turn.first_user_item_id == null && c.originalFirst && userRows.every(r => r.rollout_ordinal >= c.ordinal)) link = true;
        else { detail('skip', '已有用户消息的首条指针不一致'); continue; }
      } else if (c.originalFirst && userRows.every(r => r.rollout_ordinal > c.ordinal)) {
        if (turn.first_user_item_id == null || turn.first_user_item_id === c.itemId || c.goal && first && first.rollout_ordinal > c.ordinal) link = true;
        else { detail('skip', '悬空首条指针与原始消息 ID 不一致'); continue; }
      } else if (!first || first.rollout_ordinal >= c.ordinal || !c.nativeIdentity || c.goal) { detail('skip', '无法证明该消息与首条消息的相对顺序'); continue; }
      if (!existingItem) {
        const item = { thread_id: c.threadId, turn_id: c.turnId, item_id: c.itemId, rollout_ordinal: c.ordinal, created_at_ms: c.created, item_json: JSON.stringify({ type: 'userMessage', id: c.itemId, content: [{ type: 'text', text: c.text, text_elements: [] }] }), item_type: 'userMessage', updated_at_ordinal: c.ordinal };
        mutations.push({ table: 'thread_items', key: getKey('thread_items', item), before: null, after: item }); rows.items.push(item);
      }
      if (link) {
        const inserted = mutations.find(m => m.table === 'thread_turns' && !m.before && keyMatches(turn!, m.key));
        if (inserted) inserted.after.first_user_item_id = c.itemId;
        else mutations.push({ table: 'thread_turns', key: getKey('thread_turns', turn), before: { ...getKey('thread_turns', turn), first_user_item_id: turn.first_user_item_id }, after: { ...getKey('thread_turns', turn), first_user_item_id: c.itemId }, fields: ['thread_id', 'turn_id', 'first_user_item_id'] });
        turn.first_user_item_id = c.itemId;
      }
      detail(existingItem ? 'relink' : 'insert', existingItem ? '重新连接已核验的原生首条消息' : '补回原生用户消息投影');
    }
    const normalized = { scope, ids: options.ids ? [...options.ids].sort() : undefined };
    return { db: file, sources, mutations, items: details, warnings, scanFiles: files.length, candidates: candidates.length, existing, skipped: details.filter(x => x.action === 'skip').length, revision: valueHash({ sources, schemas, snapshots, mutations, owners: [...owners].sort(), options: normalized }), options: normalized };
  } finally { if (own) db.close(); }
}

function summary(plan: Plan) {
  const grouped = new Map<string, Detail[]>();
  for (const detail of plan.items) {
    const key = detail.threadId || `unreadable:${valueHash(detail.file)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(detail);
  }
  for (const source of plan.sources) if (!grouped.has(source.threadId)) grouped.set(source.threadId, []);
  const items = [...grouped].map(([id, details]) => {
    const source = plan.sources.find(s => s.threadId === id), insertions = details.filter(x => x.action === 'insert').length, links = details.filter(x => x.action === 'relink').length, skipped = details.filter(x => x.action === 'skip');
    return { id, title: source ? id : '待核查的会话文件', path: source?.file || details[0]?.file, archived: (source?.file || '').split(path.sep).includes('archived_sessions'), changes: [...(insertions ? [`补回 ${insertions} 条原生消息`] : []), ...(links ? [`重连 ${links} 个首条指针`] : [])], status: insertions || links ? 'ready' : skipped.length ? 'blocked' : 'unchanged', reason: [...new Set(skipped.map(x => x.reason))].join('；') || undefined };
  });
  return { ok: true, revision: plan.revision, options: plan.options, dbPath: plan.db, summary: { scanned: plan.scanFiles, selected: items.length, repairable: items.filter(x => x.status === 'ready').length, indexChanges: plan.mutations.length, blocked: items.filter(x => x.status === 'blocked').length, unchanged: items.filter(x => x.status === 'unchanged').length }, scanFiles: plan.scanFiles, candidates: plan.candidates, changes: plan.items.filter(x => ['insert', 'relink'].includes(x.action)).length, existing: plan.existing, skipped: plan.skipped, items, details: plan.items.slice(0, 200), truncatedItems: Math.max(0, plan.items.length - 200), warnings: plan.warnings, insertedMessages: plan.mutations.filter(m => m.table === 'thread_items').length, relinkedTurns: plan.mutations.filter(m => m.table === 'thread_turns' && m.before).length, createdTurns: plan.mutations.filter(m => m.table === 'thread_turns' && !m.before).length };
}
async function recheck(ctx: HistoryContext, sources: Source[]): Promise<void> {
  for (const source of sources) {
    checkedFile(ctx.home, source.file);
    const current = stamp(source.file);
    if (current.size !== source.size || current.mtime !== source.mtime || await fileHash(source.file) !== source.hash) throw new Error('来源会话在修复期间发生变化，已取消本次写入');
  }
}
function applyMutation(db: SqlDb, mutation: Mutation): void {
  const rows = readRows(db, mutation.table, mutation.key);
  if (rows.length > 1 || !same(rows[0], mutation.before, mutation.fields)) throw new Error('原生记录在修复期间发生变化');
  if (!mutation.before) {
    const fields = Object.keys(mutation.after);
    db.prepare(`INSERT INTO ${sqlIdentifier(mutation.table)} (${fields.map(sqlIdentifier).join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...fields.map(k => mutation.after[k]));
  } else {
    const fields = Object.keys(mutation.after).filter(k => !(k in mutation.key));
    const result = db.prepare(`UPDATE ${sqlIdentifier(mutation.table)} SET ${fields.map(k => `${sqlIdentifier(k)}=?`).join(',')} WHERE ${Object.keys(mutation.key).map(k => `${sqlIdentifier(k)} IS ?`).join(' AND ')}`).run(...fields.map(k => mutation.after[k]), ...Object.values(mutation.key));
    if (Number(result.changes) !== 1) throw new Error('原生首条指针更新数量异常');
  }
}
const backupRoot = (ctx: HistoryContext) => path.join(repairRoot(ctx), 'index-backups');
function journalPath(ctx: HistoryContext, id: string): string {
  if (!/^[0-9A-Za-z-]{1,100}$/.test(id)) throw new Error('备份标识无效');
  return path.join(backupRoot(ctx), id, 'journal.json');
}
function loadJournal(ctx: HistoryContext, id: string): Journal {
  const file = journalPath(ctx, id); checkedFile(backupRoot(ctx), file);
  const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
  if (journal.version !== 1 || journal.id !== id || historyLocation(journal.home) !== ctx.home || historyLocation(journal.sqliteHome) !== ctx.sqliteHome || !Array.isArray(journal.mutations) || path.basename(journal.db) !== 'thread_history_1.sqlite') throw new Error('备份不属于当前会话目录');
  checkedFile(ctx.sqliteHome, journal.db);
  return journal;
}
function backups(ctx: HistoryContext): Row[] {
  const root = backupRoot(ctx); if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).flatMap(e => {
    try { const j = loadJournal(ctx, e.name); return [{ id: j.id, backupId: j.id, createdAt: j.createdAt, status: j.status, changes: j.mutations.length, sessions: new Set(j.mutations.map(m => m.key.thread_id)).size, path: path.dirname(journalPath(ctx, j.id)), restoredAt: j.restoredAt }]; } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function inspectRestore(ctx: HistoryContext, journal: Journal, db: SqlDb) {
  validateSchema(db);
  const conflicts: string[] = [], observations: Row[] = [];
  for (const m of journal.mutations) {
    if (!['thread_items', 'thread_turns'].includes(m.table) || !m.key || !m.after || Object.keys(m.key).sort().join() !== Object.keys(getKey(m.table, m.key)).sort().join()) throw new Error('恢复日志字段不受支持');
    const rows = readRows(db, m.table, m.key); observations.push({ table: m.table, key: m.key, rows });
    // A prepared journal may represent a crash before or after COMMIT; match before/after explicitly.
    if (rows.length > 1 || !same(rows[0], m.after, m.fields) && !same(rows[0], m.before, m.fields)) conflicts.push(`${m.key.thread_id}/${m.key.turn_id}/${m.key.item_id || '首条指针'} 已被后续操作修改`);
    if (m.table === 'thread_turns' && !m.before && rows.length) {
      const owned = journal.mutations.filter(x => x.table === 'thread_items' && x.key.thread_id === m.key.thread_id && x.key.turn_id === m.key.turn_id);
      const items = readRows(db, 'thread_items', m.key); observations.push({ ownedTurnItems: items });
      if (items.some(item => !owned.some(x => keyMatches(item, x.key)))) conflicts.push(`${m.key.turn_id} 已产生其他原生消息，不能删除补建轮次`);
    }
  }
  return { ok: true, backupId: journal.id, revision: valueHash({ journal, observations }), canRestore: !conflicts.length, conflicts, changes: journal.mutations.length, summary: { sessions: new Set(journal.mutations.map(m => m.key.thread_id)).size, rows: journal.mutations.length, files: 0 }, status: journal.status, message: conflicts.length ? '存在后续修改，保留现状并停止恢复' : '仅撤回此批次插入的消息与首条指针，不整库覆盖' };
}

export function createSessionIndexRepairService(ctx: HistoryContext = historyContext()) {
  ctx = normalizeHistoryContext(ctx);
  return {
    async preview(options: Options = {}) { return summary(await plan(ctx, options)); },
    backups() { return { ok: true, backups: backups(ctx) }; },
    async apply(options: Options = {}) {
      if (!options.revision) throw new Error('请先预览索引修复，再提交对应版本');
      await assertClientsStopped(ctx); const release = acquireHistoryLock(ctx);
      let journal: Journal | undefined, journalFile = '', committed = false;
      try {
        if (backups(ctx).some(x => ['prepared', 'restoring'].includes(x.status))) throw new Error('发现中断的索引修复，请先检查并恢复该备份');
        const preview = await plan(ctx, options);
        if (preview.revision !== options.revision) throw new Error('预览后会话或数据库已变化，请重新预览');
        if (!preview.mutations.length) return { ...summary(preview), applied: false, message: '没有满足证据要求的待修复项目' };
        await recheck(ctx, preview.sources);
        const db = openHistoryDb(preview.db, false);
        try {
          const id = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
          journalFile = journalPath(ctx, id); fs.mkdirSync(path.dirname(journalFile), { recursive: true, mode: 0o700 });
          const snapshot = path.join(path.dirname(journalFile), 'thread_history.sqlite');
          db.prepare('VACUUM INTO ?').run(snapshot);
          db.prepare('BEGIN IMMEDIATE').run();
          db.prepare('PRAGMA defer_foreign_keys = ON').run();
          try {
            await assertClientsStopped(ctx); await recheck(ctx, preview.sources);
            const locked = await plan(ctx, options, db);
            if (locked.revision !== options.revision) throw new Error('取得写锁后来源或原生索引发生变化');
            journal = { version: 1, id, home: ctx.home, sqliteHome: ctx.sqliteHome, db: preview.db, createdAt: new Date().toISOString(), status: 'prepared', mutations: locked.mutations, snapshot };
            saveJournal(journalFile, journal);
            // Parent turns first, then messages, then existing first-pointer updates.
            const ordered = [...locked.mutations].sort((a, b) => (a.table === 'thread_turns' && !a.before ? 0 : a.table === 'thread_items' ? 1 : 2) - (b.table === 'thread_turns' && !b.before ? 0 : b.table === 'thread_items' ? 1 : 2));
            for (const mutation of ordered) applyMutation(db, mutation);
            // Capture actual inserted rows, including schema defaults, for conflict-safe restore.
            for (const mutation of journal.mutations) if (!mutation.before) mutation.after = { ...readRows(db, mutation.table, mutation.key)[0] };
            saveJournal(journalFile, journal); await recheck(ctx, locked.sources);
            db.prepare('COMMIT').run(); committed = true;
            journal.status = 'applied'; saveJournal(journalFile, journal);
            return { ...summary(locked), applied: true, backupId: id, backupPath: path.dirname(journalFile), backup: { id, path: path.dirname(journalFile) }, message: `已补回 ${locked.mutations.filter(m => m.table === 'thread_items').length} 条原生消息，修复前备份已保留` };
          } catch (error) { if (!committed) { try { db.prepare('ROLLBACK').run(); } catch {} } throw error; }
        } finally { db.close(); }
      } catch (error) {
        if (journal && !committed) { journal.status = 'failed'; journal.error = (error as Error).message; saveJournal(journalFile, journal); }
        if (committed && journal) return { ok: true, applied: true, backupId: journal.id, warning: `原生修复已提交，备份状态保存失败：${(error as Error).message}` };
        throw error;
      } finally { release(); }
    },
    restorePreview(options: Options) {
      if (!options.backupId) throw new Error('缺少备份标识');
      const journal = loadJournal(ctx, options.backupId), db = openHistoryDb(journal.db, true);
      try { return inspectRestore(ctx, journal, db); } finally { db.close(); }
    },
    async restore(options: Options) {
      if (!options.backupId || !options.revision) throw new Error('请先预览备份恢复');
      await assertClientsStopped(ctx); const release = acquireHistoryLock(ctx);
      try {
        const journal = loadJournal(ctx, options.backupId), db = openHistoryDb(journal.db, false);
        let committed = false;
        try {
          db.prepare('BEGIN IMMEDIATE').run();
          db.prepare('PRAGMA defer_foreign_keys = ON').run();
          const preview = inspectRestore(ctx, journal, db);
          if (preview.revision !== options.revision) throw new Error('恢复预览已过期，请重新预览');
          if (!preview.canRestore) throw new Error(`备份存在冲突：${preview.conflicts.join('；')}`);
          await assertClientsStopped(ctx);
          journal.status = 'restoring'; saveJournal(journalPath(ctx, journal.id), journal);
          // Clear/revert pointers before removing their message rows; delete newly created turns last.
          const ordered = [...journal.mutations].sort((a, b) => (a.before ? 0 : a.table === 'thread_items' ? 1 : 2) - (b.before ? 0 : b.table === 'thread_items' ? 1 : 2));
          for (const mutation of ordered) {
            const current = readRows(db, mutation.table, mutation.key)[0];
            if (same(current, mutation.before, mutation.fields)) continue;
            if (mutation.before) applyMutation(db, { ...mutation, before: mutation.after, after: mutation.before });
            else db.prepare(`DELETE FROM ${sqlIdentifier(mutation.table)} WHERE ${Object.keys(mutation.key).map(k => `${sqlIdentifier(k)} IS ?`).join(' AND ')}`).run(...Object.values(mutation.key));
          }
          db.prepare('COMMIT').run(); committed = true;
          journal.status = 'restored'; journal.restoredAt = new Date().toISOString(); saveJournal(journalPath(ctx, journal.id), journal);
          return { ok: true, restored: true, backupId: journal.id, changes: journal.mutations.length, message: '已恢复本批次的原生消息索引修改' };
        } catch (error) {
          if (!committed) { try { db.prepare('ROLLBACK').run(); } catch {} }
          else return { ok: true, restored: true, backupId: journal.id, warning: `原生恢复已提交，备份状态保存失败：${(error as Error).message}` };
          throw error;
        }
        finally { db.close(); }
      } finally { release(); }
    },
  };
}

export async function runSessionIndexRepairAction(action: string, payload: Options = {}): Promise<any | null> {
  if (!action.startsWith('codex.indexRepair.')) return null;
  const service = createSessionIndexRepairService();
  switch (action) {
    case 'codex.indexRepair.preview': return service.preview(payload);
    case 'codex.indexRepair.apply': return service.apply(payload);
    case 'codex.indexRepair.backups': return service.backups();
    case 'codex.indexRepair.restorePreview': return service.restorePreview(payload);
    case 'codex.indexRepair.restore': return service.restore(payload);
    default: throw new Error('未知索引修复操作');
  }
}
