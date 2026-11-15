import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { scanSessions } from '../sessions.js';
import { checkedFile, discoverHistoryDbs, historyContext, openHistoryDb, tableColumns } from '../historyRepairIO.js';

interface SessionInfo { id: string; title: string; cwd: string; model: string; createdAt: number | null; updatedAt: number | null; archived: boolean; preview: string; gitBranch: string }
interface SessionRecord { session: SessionInfo; rollout?: string }
interface SessionEvent { type: string; seq: number; time: string; data: Record<string, any> }
const METHODS = new Set(['listSessions', 'filterSessions', 'readSession', 'readTitle', 'listEvents', 'filterEvents', 'readEvent', 'readEventsSince', 'searchSessions', 'searchEvents']);
const INJECTED = ['<environment_context>', '<user_instructions>', '<permissions instructions>', '<turn_aborted>', '# AGENTS.md instructions'];
const CACHE_BYTES = 32 * 1024 * 1024;
const eventCache = new Map<string, { stamp: string; events: SessionEvent[]; bytes: number }>();
let cacheBytes = 0;
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const integer = (value: unknown, fallback: number): number => Number.isSafeInteger(Number(value)) && Number(value) >= 0 && value !== null && value !== '' ? Number(value) : fallback;
const truncate = (text: string, length: number): string => { const chars = Array.from(text); return chars.length > length ? chars.slice(0, length).join('') + '…' : text; };
const timestamp = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  return Number.isFinite(n) ? Math.floor(n > 1e11 ? n / 1000 : n) : null;
};

/** Prefer the native index so renamed titles, archived state and absent rollout files stay visible. */
function sessions(): SessionRecord[] {
  const context = historyContext(), records = new Map<string, SessionRecord>();
  let indexed = false;
  for (const file of discoverHistoryDbs(context)) {
    const db = openHistoryDb(file, true);
    try {
      const columns = tableColumns(db, 'threads');
      if (!columns.has('id') || !columns.has('rollout_path')) continue;
      indexed = true;
      const fields = ['id', 'title', 'cwd', 'model', 'created_at', 'updated_at', 'archived', 'first_user_message', 'rollout_path', 'git_branch'];
      const rows = db.prepare(`SELECT ${fields.map(field => columns.has(field) ? `"${field}"` : `NULL AS "${field}"`).join(',')} FROM threads LIMIT 50001`).all();
      if (rows.length > 50000) throw new Error('原生会话索引过大，无法完成扩展查询');
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id) continue;
        if (records.has(row.id)) throw new Error('多个原生会话索引包含相同 ID，无法唯一识别会话');
        records.set(row.id, { session: { id: row.id, title: string(row.title), cwd: string(row.cwd), model: string(row.model), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), archived: !!row.archived, preview: truncate(string(row.first_user_message), 200), gitBranch: string(row.git_branch) }, rollout: string(row.rollout_path) || undefined });
      }
    } finally { db.close(); }
  }
  if (!indexed) for (const item of scanSessions().filter(item => item.agent === 'Codex')) {
    if (records.has(item.id)) throw new Error('多个本地会话文件包含相同 ID，无法唯一识别会话');
    records.set(item.id, { session: { id: item.id, title: item.title, cwd: item.cwd || '', model: item.model || '', createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), archived: !!item.archived, preview: truncate(item.title, 200), gitBranch: '' }, rollout: item.path });
  }
  return [...records.values()].sort((a, b) => (b.session.updatedAt || 0) - (a.session.updatedAt || 0) || a.session.id.localeCompare(b.session.id));
}

function contentText(value: unknown): string {
  return (Array.isArray(value) ? value : []).flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'input_image') return ['[图片]'];
    if (!['input_text', 'output_text', 'text'].includes(block.type) || typeof block.text !== 'string') return [];
    const text = block.text.trimStart();
    return !text || INJECTED.some(prefix => text.startsWith(prefix)) ? [] : [block.text];
  }).join('\n\n');
}
function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return contentText(value);
  if (value && typeof value === 'object' && typeof (value as any).content === 'string') return (value as any).content;
  return value == null ? '' : JSON.stringify(value);
}

async function events(record: SessionRecord): Promise<SessionEvent[]> {
  if (!record.rollout) throw new Error('此会话没有 rollout 文件');
  const file = checkedFile(historyContext().home, path.resolve(historyContext().home, record.rollout));
  if (!file.endsWith('.jsonl')) throw new Error('会话日志格式无效');
  const stat = fs.statSync(file), stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`, key = `${file}\0${record.session.id}`;
  const cached = eventCache.get(key);
  if (cached?.stamp === stamp) return cached.events;
  if (stat.size > 256 * 1024 * 1024) throw new Error('此会话日志超过 256 MB，扩展查询无法完整加载');
  const result: SessionEvent[] = [];
  let turn = '', bytes = 0;
  const push = (type: string, time: string, data: Record<string, any>) => {
    const event = { type, seq: result.length, time, data };
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (result.length >= 200000 || bytes > 64 * 1024 * 1024) throw new Error('此会话事件过多，扩展查询无法完整加载');
    result.push(event);
  };
  const stream = fs.createReadStream(file, { encoding: 'utf8', end: Math.max(0, stat.size - 1) });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 8 * 1024 * 1024) throw new Error('会话日志单条记录过大，扩展查询无法完整加载');
      let event: any; try { event = JSON.parse(line); } catch { continue; }
      const p = event?.payload, time = string(event?.timestamp);
      if (!p || typeof p !== 'object') continue;
      if (event.type === 'session_meta' && typeof p.id === 'string' && p.id !== record.session.id) throw new Error('会话日志 ID 与原生索引不一致');
      if (event.type === 'turn_context' || event.type === 'event_msg' && p.type === 'task_started') {
        if (typeof p.turn_id === 'string' && p.turn_id !== turn) { turn = p.turn_id; push('turn/start', time, { turn }); }
      } else if (event.type === 'response_item') {
        if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
          const text = contentText(p.content);
          if (text.trim()) push(`${p.role}/message`, time, { turn, id: string(p.id), text: truncate(text, 20000), ...(p.role === 'assistant' ? { phase: p.phase ?? null } : {}) });
        } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
          const input = p.type === 'function_call' ? p.arguments : p.input;
          push('tool/call', time, { turn, name: string(p.name), callId: string(p.call_id), input: truncate(typeof input === 'string' ? input : JSON.stringify(input ?? null), 20000) });
        } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
          push('tool/result', time, { turn, callId: string(p.call_id), output: truncate(outputText(p.output), 20000) });
        } else if (p.type === 'reasoning') {
          const text = (Array.isArray(p.summary) ? p.summary : []).map((part: any) => string(part?.text)).filter(Boolean).join('\n\n');
          if (text.trim()) push('assistant/reasoning', time, { turn, text: truncate(text, 20000) });
        }
      } else if (event.type === 'event_msg') {
        if (p.type === 'task_complete') push('turn/complete', time, { turn: p.turn_id ?? turn, durationMs: p.duration_ms ?? null, lastMessage: truncate(string(p.last_agent_message), 20000) });
        else if (p.type === 'turn_aborted') push('turn/aborted', time, { turn: p.turn_id ?? turn, reason: p.reason ?? null });
        else if (p.type === 'token_count' && p.info) push('token/usage', time, { turn, total: p.info.total_token_usage ?? null, last: p.info.last_token_usage ?? null, contextWindow: p.info.model_context_window ?? null });
        else if (p.type === 'context_compacted') push('session/compacted', time, { turn });
      } else if (event.type === 'compacted') push('session/compacted', time, { turn });
    }
  } finally { lines.close(); stream.destroy(); }
  if (cached) { cacheBytes -= cached.bytes; eventCache.delete(key); }
  if (bytes <= CACHE_BYTES) {
    while (eventCache.size && (eventCache.size >= 32 || cacheBytes + bytes > CACHE_BYTES)) {
      const oldest = eventCache.keys().next().value!; cacheBytes -= eventCache.get(oldest)!.bytes; eventCache.delete(oldest);
    }
    eventCache.set(key, { stamp, events: result, bytes }); cacheBytes += bytes;
  }
  return result;
}

const lightweight = (event: SessionEvent): SessionEvent => ({ ...event, data: Object.fromEntries(Object.entries(event.data).map(([key, value]) => [key, ['text', 'input', 'output'].includes(key) && typeof value === 'string' ? truncate(value, 200) : value])) });
const textMatches = (haystack: string, query: string): boolean => haystack.toLowerCase().includes(query.toLowerCase());
const eventText = (event: SessionEvent): string => ['text', 'input', 'output', 'name'].map(key => string(event.data[key])).join('\n');
const matchesTypes = (event: SessionEvent, types: any): boolean => typeof types === 'string' ? event.type === types : Array.isArray(types) ? types.includes(event.type) : true;
function page(options: any, fallback: number): { offset: number; limit: number } { return { offset: integer(options.cursor ?? options.offset, 0), limit: Math.max(1, Math.min(500, integer(options.limit, fallback))) }; }

export async function queryExtensionHistory(method: string, params: any): Promise<any> {
  if (!METHODS.has(method)) throw new Error(`尚未适配会话查询方法：${method}`);
  params ??= {};
  const options = params.options ?? params;
  const all = sessions(), id = typeof params === 'string' ? params : params.id ?? params.sessionId;
  const find = (value: unknown): SessionRecord => {
    if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new Error('会话 ID 无效');
    const item = all.find(item => item.session.id === value.replace(/^local:/, ''));
    if (!item) throw new Error('未找到此本地会话');
    return item;
  };
  const filtered = (exact = false) => all.filter(({ session }) => (exact && options.id !== undefined && options.archived === undefined || session.archived === !!options.archived)
    && (!exact || options.id === undefined || session.id === options.id)
    && (!exact || options.cwd === undefined || session.cwd.startsWith(string(options.cwd)))
    && (!exact || options.createdAfter === undefined || session.createdAt !== null && session.createdAt >= Number(options.createdAfter))
    && (!exact || options.createdBefore === undefined || session.createdAt !== null && session.createdAt < Number(options.createdBefore)));
  if (method === 'listSessions' || method === 'filterSessions' || method === 'searchSessions') {
    const { offset, limit } = page(options, method === 'filterSessions' ? 500 : method === 'searchSessions' ? 20 : 50);
    const query = string(method === 'searchSessions' ? options.query : options.search).trim();
    const matches = filtered(method === 'filterSessions').filter(({ session }) => !query || [session.title, session.cwd, session.preview].some(text => textMatches(text, query)));
    const items = matches.slice(offset, offset + limit).map(item => item.session);
    return method === 'searchSessions' ? { items, nextCursor: offset + limit < matches.length ? String(offset + limit) : null } : items;
  }
  if (method === 'searchEvents') {
    const query = string(options.query); if (!query) throw new Error('缺少 query');
    const { offset, limit } = page(options, 20), matches: Array<{ sessionId: string; event: SessionEvent }> = [];
    for (const item of options.sessionId !== undefined ? [find(options.sessionId)] : filtered()) {
      // Missing log files cannot supply events. A direct per-session query surfaces the error.
      let log: SessionEvent[]; try { log = await events(item); } catch (error) { if (options.sessionId !== undefined) throw error; continue; }
      for (const event of log) if (matchesTypes(event, options.types) && textMatches(eventText(event), query)) {
        matches.push({ sessionId: item.session.id, event: lightweight(event) }); if (matches.length > offset + limit) break;
      }
      if (matches.length > offset + limit) break;
    }
    return { items: matches.slice(offset, offset + limit), nextCursor: matches.length > offset + limit ? String(offset + limit) : null };
  }
  const item = find(id);
  if (method === 'readTitle') return item.session.title;
  const log = await events(item);
  if (method === 'readSession') return { session: item.session, events: log };
  if (method === 'readEventsSince') return log.slice(integer(options.seq, 0), integer(options.seq, 0) + Math.min(500, integer(options.limit, 500)));
  if (method === 'readEvent') {
    const seq = integer(options.seq, -1); if (seq < 0 || seq >= log.length) throw new Error('会话中没有指定的 seq');
    return log.slice(Math.max(0, seq - Math.min(50, integer(options.before, 0))), seq + Math.min(50, integer(options.after, 0)) + 1);
  }
  const matches = log.filter(event => matchesTypes(event, options.types) && (method !== 'filterEvents' || !options.text || textMatches(eventText(event), string(options.text))));
  const { offset, limit } = page(options, method === 'filterEvents' ? 500 : 100);
  if (method === 'filterEvents') return matches.slice(offset, offset + limit);
  const end = Math.max(0, matches.length - offset), start = options.fromEnd ? Math.max(0, end - limit) : offset;
  return matches.slice(start, options.fromEnd ? end : start + limit).map(lightweight);
}
