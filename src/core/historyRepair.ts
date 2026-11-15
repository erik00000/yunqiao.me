import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { atomicWrite } from './agents/configFiles.js';
import { acquireHistoryLock, assertClientsStopped, checkedFile, discoverHistoryDbs, fileHash, historyContext, inside, openHistoryDb, repairRoot, saveJournal, sqlIdentifier, tableColumns, valueHash, type HistoryContext, type SqlDb } from './historyRepairIO.js';

type Cell = string | number | null;
interface RowState { dbPath: string; table: 'threads' | 'local_thread_catalog'; keys: Record<string, Cell>; before: Record<string, Cell>; after: Record<string, Cell>; sessionId: string }
interface SourceFile { path: string; id: string; hash: string; afterHash: string; size: number; mtimeMs: number; mode: number; providers: string[]; cwd?: string; archived: boolean; metadataChanges: number; encrypted: boolean; subagent: boolean; invalid?: string }
export interface HistoryRepairOptions { targetProvider?: string; scope?: 'active' | 'archived' | 'all'; ids?: string[]; sourceProvider?: string; fixPaths?: boolean }
interface Options { targetProvider: string; scope: 'active' | 'archived' | 'all'; ids?: string[]; sourceProvider?: string; fixPaths: boolean }
export interface HistoryRepairItem { id: string; title: string; path: string; paths: string[]; archived: boolean; beforeProvider: string; metadataProvider: string; targetProvider: string; changes: string[]; status: 'ready' | 'unchanged' | 'blocked'; reason?: string; encrypted: boolean }
interface Summary { scanned: number; selected: number; repairable: number; metadataChanges: number; indexChanges: number; pathChanges: number; blocked: number; unchanged: number; encrypted: number }
interface InternalPlan { ok: true; revision: string; options: Options; summary: Summary; items: HistoryRepairItem[]; warnings: string[]; dbPath: string; dbPaths: string[]; currentProvider: string; files: SourceFile[]; rows: RowState[]; schemas: Record<string, string>; configHash: string }
interface FileBackup { path: string; original: string; staged: string; beforeHash: string; afterHash: string; mtimeMs: number; mode: number; sessionId: string }
interface DatabaseBackup { path: string; backup: string; hash: string; schema: string }
interface Journal { format: 'aurora-history-provider-v1'; id: string; createdAt: string; targetProvider: string; sessions: number; status: 'prepared' | 'applying' | 'complete' | 'restoring' | 'restored' | 'interrupted'; restoredAt?: string; home: string; sqliteHome: string; options: Options; files: FileBackup[]; databases: DatabaseBackup[]; rows: RowState[]; error?: string }
const UUID = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
const MAX_FILES = 10000;
const MAX_LINE = 32 * 1024 * 1024;
const serialize = (value: any): Cell => typeof value === 'bigint' ? Number(value) : value === undefined ? null : value;
function schemaHash(db: SqlDb): string { return valueHash(db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type,name").all()); }
const providerIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const recordObject = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function readProvider(ctx: HistoryContext): { current: string; available: Set<string>; targets: Array<{ id: string; name: string; current: boolean }>; hash: string } {
  const file = path.join(ctx.home, 'config.toml');
  if (!fs.existsSync(file)) throw new Error('未找到当前客户端 config.toml，不能确认迁移目标');
  checkedFile(ctx.home, file);
  if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('客户端 config.toml 过大，未读取迁移目标');
  const text = fs.readFileSync(file, 'utf8');
  let config: any;
  try { config = parseToml(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('客户端 config.toml 不是有效的 TOML，请先在原客户端检查配置'); }
  let profile: Record<string, any> = {};
  if (config.profile !== undefined) {
    if (typeof config.profile !== 'string' || !recordObject(config.profiles?.[config.profile])) throw new Error('当前客户端选择的 profile 无效，不能确认迁移目标');
    profile = config.profiles[config.profile];
  }
  if ([config.model_providers, profile.model_providers].some(value => value !== undefined && !recordObject(value))) throw new Error('客户端 model_providers 不是有效的供应商表');
  const current = profile.model_provider ?? config.model_provider ?? 'openai';
  if (!providerIdentity(current)) throw new Error('当前客户端 model_provider 标识无效');
  const providers: Record<string, any> = { ...(config.model_providers || {}), ...(profile.model_providers || {}) };
  const targets = [{ id: 'openai', name: typeof providers.openai?.name === 'string' ? providers.openai.name : 'OpenAI / ChatGPT', current: current === 'openai' }];
  for (const [id, provider] of Object.entries(providers)) {
    if (id !== 'openai' && id !== 'codex_plus_managed' && providerIdentity(id) && recordObject(provider)) targets.push({ id, name: typeof provider.name === 'string' ? provider.name : id, current: id === current });
  }
  targets.sort((a, b) => Number(b.current) - Number(a.current) || a.id.localeCompare(b.id));
  return { current, available: new Set(targets.map(target => target.id)), targets, hash: valueHash(text) };
}
function normalizeOptions(ctx: HistoryContext, input: HistoryRepairOptions = {}): { options: Options; config: ReturnType<typeof readProvider> } {
  if (input.targetProvider !== undefined && typeof input.targetProvider !== 'string') throw new Error('目标供应商标识无效');
  const config = readProvider(ctx), target = input.targetProvider?.trim() || config.current;
  if (!providerIdentity(target) || !config.available.has(target)) throw new Error('目标供应商必须是在当前客户端 config.toml 中配置的 provider 标识');
  const scope = input.scope || 'all'; if (!['active', 'archived', 'all'].includes(scope)) throw new Error('会话范围无效');
  if (input.ids && (!Array.isArray(input.ids) || input.ids.length > MAX_FILES || input.ids.some(id => typeof id !== 'string' || !UUID.test(id)))) throw new Error('所选会话 ID 无效');
  if (input.sourceProvider !== undefined && !providerIdentity(input.sourceProvider)) throw new Error('来源供应商筛选无效');
  return { config, options: { targetProvider: target, scope, ids: input.ids ? [...new Set(input.ids)].sort() : undefined, sourceProvider: input.sourceProvider, fixPaths: input.fixPaths !== false } };
}
function walkFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (!fs.existsSync(dir)) return out;
  if (depth > 10) throw new Error('会话目录层级超过支持范围');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(file, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) { out.push(file); if (out.length > MAX_FILES) throw new Error('会话超过 10000 个文件，请先缩小会话目录范围后重试'); }
  }
  return out;
}
async function* rawLines(file: string): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) {
    const data = Buffer.concat([pending, chunk as Buffer]); let start = 0;
    for (let index = data.indexOf(10); index >= 0; index = data.indexOf(10, start)) {
      if (index + 1 - start > MAX_LINE) throw new Error('单行记录超过 32 MB，未自动改写');
      yield data.subarray(start, index + 1); start = index + 1;
    }
    pending = data.subarray(start);
    if (pending.length > MAX_LINE) throw new Error('单行记录超过 32 MB，未自动改写');
  }
  if (pending.length) yield pending;
}
function parseLine(line: Buffer): { record: any; ending: string; bom: string } | null {
  let text = line.toString('utf8'); const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''; text = text.slice(bom.length);
  const ending = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : '';
  if (ending) text = text.slice(0, -ending.length);
  if (!text.trim()) return null;
  if (text.includes('\uFFFD')) throw new Error('会话记录包含无效 UTF-8 文本');
  try { return { record: JSON.parse(text), ending, bom }; }
  catch { throw new Error('会话记录不是完整有效的 JSON，未自动改写'); }
}
function rewritten(line: Buffer, parsed: ReturnType<typeof parseLine>, target: string): Buffer {
  if (!parsed || parsed.record?.type !== 'session_meta' || parsed.record.payload?.model_provider === target) return line;
  return Buffer.from(parsed.bom + JSON.stringify({ ...parsed.record, payload: { ...parsed.record.payload, model_provider: target } }) + parsed.ending, 'utf8');
}
async function inspectFile(file: string, target: string, archived: boolean): Promise<SourceFile> {
  const stat = fs.statSync(file), before = createHash('sha256'), after = createHash('sha256');
  const result: SourceFile = { path: file, id: '', hash: '', afterHash: '', size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode, providers: [], archived, metadataChanges: 0, encrypted: false, subagent: false };
  const ids = new Set<string>(); let metadata = 0;
  try {
    for await (const line of rawLines(file)) {
      before.update(line); const parsed = parseLine(line); const record = parsed?.record;
      after.update(rewritten(line, parsed, target));
      if (line.includes(Buffer.from('encrypted_content'))) result.encrypted = true;
      if (record?.type !== 'session_meta') continue;
      metadata++;
      const payload = record.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !UUID.test(payload.id || '')) throw new Error('session_meta 缺少有效原生会话 ID');
      ids.add(payload.id);
      const provider = typeof payload.model_provider === 'string' ? payload.model_provider : '(missing)';
      result.providers.push(provider); if (provider !== target) result.metadataChanges++;
      if (typeof payload.cwd === 'string') result.cwd ||= payload.cwd;
      result.subagent ||= /subagent|sub_agent|spawn/i.test(typeof payload.source === 'string' ? payload.source : JSON.stringify(payload.source || {}));
    }
    if (!metadata) throw new Error('找不到 session_meta，不能确认归属');
    if (ids.size !== 1) throw new Error('一个文件包含多个会话 ID，不能确认归属');
    result.id = [...ids][0];
    result.hash = before.digest('hex'); result.afterHash = after.digest('hex');
    const next = fs.statSync(file);
    if (next.size !== stat.size || next.mtimeMs !== stat.mtimeMs || next.ino !== stat.ino) throw new Error('扫描时会话文件发生变化，请退出客户端后重新预览');
  } catch (error) { result.id = [...ids][0] || path.basename(file).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0] || `invalid-${valueHash(file).slice(0, 12)}`; result.invalid = String((error as Error).message); }
  return result;
}
interface IndexRow { dbPath: string; table: RowState['table']; keys: Record<string, Cell>; values: Record<string, Cell>; title: string; archived: boolean; source?: string }
function readIndexes(ctx: HistoryContext): { indexes: Map<string, IndexRow[]>; schemas: Record<string, string>; warnings: string[] } {
  const indexes = new Map<string, IndexRow[]>(), schemas: Record<string, string> = {}, warnings: string[] = [];
  for (const dbPath of discoverHistoryDbs(ctx)) {
    const db = openHistoryDb(dbPath, true);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
      if (!tables.includes('threads') && !tables.includes('local_thread_catalog')) continue;
      schemas[dbPath] = schemaHash(db);
      for (const table of ['threads', 'local_thread_catalog'] as const) {
        if (!tables.includes(table)) continue;
        const columns = tableColumns(db, table), idColumn = table === 'threads' ? 'id' : 'thread_id';
        if (!columns.has(idColumn) || !columns.has('model_provider')) { warnings.push(`${path.basename(dbPath)} 的 ${table} 结构未知，未自动修改`); continue; }
        const fields = [idColumn, 'model_provider', 'rollout_path', 'cwd', 'archived', 'title', 'display_title', 'host_id', 'source', 'source_kind', 'thread_source'].filter(field => columns.has(field));
        let where = '', params: Cell[] = [];
        if (table === 'local_thread_catalog' && columns.has('host_id')) {
          const hosts = tableColumns(db, 'local_thread_catalog_hosts');
          let localIds = ['local'];
          if (hosts.has('host_id')) localIds = db.prepare(hosts.has('host_kind') ? "SELECT host_id FROM local_thread_catalog_hosts WHERE lower(host_kind)='local'" : "SELECT host_id FROM local_thread_catalog_hosts WHERE host_id='local'").all().map(row => row.host_id);
          if (!localIds.length) { warnings.push(`${path.basename(dbPath)} 无法确认本地主机目录，跳过该目录投影`); continue; }
          where = ` WHERE host_id IN (${localIds.map(() => '?').join(',')})`; params = localIds;
        }
        const rows = db.prepare(`SELECT ${fields.map(sqlIdentifier).join(',')} FROM ${sqlIdentifier(table)}${where}`).all(...params);
        if (rows.length > 50000) throw new Error('会话索引超过 50000 条，请使用客户端原生工具分批维护');
        for (const row of rows) {
          const id = row[idColumn]; if (typeof id !== 'string' || !UUID.test(id)) continue;
          const keys: Record<string, Cell> = { [idColumn]: id }; if (table === 'local_thread_catalog' && columns.has('host_id')) keys.host_id = row.host_id;
          const values = Object.fromEntries(['model_provider', 'rollout_path', 'cwd'].filter(k => columns.has(k)).map(k => [k, serialize(row[k])]));
          const indexed: IndexRow = { dbPath, table, keys, values, title: row.title || row.display_title || id, archived: !!row.archived, source: row.source || row.source_kind || row.thread_source || '' };
          indexes.set(id, [...(indexes.get(id) || []), indexed]);
        }
      }
    } finally { db.close(); }
  }
  return { indexes, schemas, warnings };
}

/** Only native threads determine the visible provider region; rollout metadata is supporting evidence. */
async function providerInventory(ctx: HistoryContext) {
  const config = readProvider(ctx), { indexes, warnings } = readIndexes(ctx);
  const sources = new Map<string, { id: string; count: number; active: number; archived: number }>();
  let ambiguous = 0, missingProvider = 0, metadataMismatch = 0, unindexed = 0;
  const canonical = new Map<string, IndexRow>();
  for (const [id, rows] of indexes) {
    const native = rows.filter(row => row.table === 'threads');
    if (native.length !== 1) { if (native.length > 1) ambiguous++; continue; }
    const row = native[0], provider = row.values.model_provider;
    if (!providerIdentity(provider)) { missingProvider++; continue; }
    canonical.set(id, row);
    const source = sources.get(provider) || { id: provider, count: 0, active: 0, archived: 0 };
    source.count++; source[row.archived ? 'archived' : 'active']++;
    sources.set(provider, source);
  }
  const paths = [...walkFiles(path.join(ctx.home, 'sessions')), ...walkFiles(path.join(ctx.home, 'archived_sessions'))];
  if (paths.length > MAX_FILES) throw new Error('会话超过 10000 个文件，未完成区域扫描');
  const mismatched = new Set<string>(), orphaned = new Set<string>();
  for (const file of paths) {
    checkedFile(ctx.home, file);
    const source = await inspectFile(file, config.current, false), row = canonical.get(source.id);
    if (!row) orphaned.add(source.id);
    else if (source.providers.some(provider => provider !== row.values.model_provider)) mismatched.add(source.id);
  }
  metadataMismatch = mismatched.size; unindexed = orphaned.size;
  if (ambiguous) warnings.push(`${ambiguous} 个会话在多个原生 threads 索引中重复，未计入可选区域，迁移时需要先处理冲突。`);
  if (missingProvider) warnings.push(`${missingProvider} 个原生会话缺少有效供应商标识，可使用全部来源修复检查。`);
  if (metadataMismatch) warnings.push(`${metadataMismatch} 个会话的日志元数据与原生索引归属不同；区域计数和来源筛选以原生 threads 索引为准。`);
  if (unindexed) warnings.push(`${unindexed} 个日志会话没有唯一有效的原生 threads 归属，未计入区域；预览会说明不能迁移的原因。`);
  return { ok: true, currentProvider: config.current, targets: config.targets, sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)), warnings };
}
function itemSummary(items: HistoryRepairItem[], files: SourceFile[], rows: RowState[], scanned: number): Summary {
  const ready = new Set(items.filter(i => i.status === 'ready').map(i => i.id));
  return { scanned, selected: items.length, repairable: ready.size, metadataChanges: files.filter(f => ready.has(f.id)).reduce((n, f) => n + f.metadataChanges, 0), indexChanges: rows.filter(r => r.before.model_provider !== r.after.model_provider).length,
    pathChanges: rows.filter(r => r.before.rollout_path !== r.after.rollout_path || r.before.cwd !== r.after.cwd).length, blocked: items.filter(i => i.status === 'blocked').length, unchanged: items.filter(i => i.status === 'unchanged').length, encrypted: items.filter(i => i.encrypted).length };
}
async function buildPlan(ctx: HistoryContext, input: HistoryRepairOptions): Promise<InternalPlan> {
  const { options, config } = normalizeOptions(ctx, input), selected = options.ids ? new Set(options.ids) : undefined;
  const { indexes, schemas, warnings } = readIndexes(ctx);
  const paths = [...walkFiles(path.join(ctx.home, 'sessions')).map(file => ({ file, archived: false })), ...walkFiles(path.join(ctx.home, 'archived_sessions')).map(file => ({ file, archived: true }))];
  if (paths.length > MAX_FILES) throw new Error('会话超过 10000 个文件，未开始修复');
  const byId = new Map<string, SourceFile[]>();
  for (const { file, archived } of paths) {
    checkedFile(ctx.home, file);
    const source = await inspectFile(file, options.targetProvider, archived);
    byId.set(source.id, [...(byId.get(source.id) || []), source]);
  }
  const ids = [...new Set([...byId.keys(), ...indexes.keys(), ...(selected || [])])].sort();
  const items: HistoryRepairItem[] = [], files: SourceFile[] = [], rows: RowState[] = [];
  for (const id of ids) {
    if (selected && !selected.has(id)) continue;
    const sources = byId.get(id) || [], indexRows = indexes.get(id) || [], canonical = indexRows.filter(row => row.table === 'threads');
    const archived = canonical[0]?.archived ?? sources[0]?.archived ?? indexRows[0]?.archived ?? false;
    if (options.scope !== 'all' && (options.scope === 'archived') !== archived) continue;
    if (options.sourceProvider !== undefined && !canonical.some(row => row.values.model_provider === options.sourceProvider)) continue;
    const item: HistoryRepairItem = { id, title: canonical[0]?.title || indexRows[0]?.title || id, path: sources[0]?.path || String(indexRows[0]?.values.rollout_path || ''), paths: sources.map(s => s.path), archived, beforeProvider: [...new Set(canonical.map(r => String(r.values.model_provider ?? '(missing)')))].join(', '), metadataProvider: [...new Set(sources.flatMap(s => s.providers))].join(', '), targetProvider: options.targetProvider, changes: [], status: 'unchanged', encrypted: sources.some(s => s.encrypted) };
    if (!sources.length) { item.status = 'blocked'; item.reason = '没有找到包含同一原生 ID 的会话原文件；未猜测补建索引或内容'; }
    else if (sources.some(s => s.invalid)) { item.status = 'blocked'; item.reason = sources.find(s => s.invalid)?.invalid; }
    else if (sources.some(s => s.subagent) || indexRows.some(r => /subagent|sub_agent/i.test(r.source || ''))) { item.status = 'blocked'; item.reason = '子智能体会话保留原归属，避免改变父子任务关系'; }
    else if (sources.some(s => s.archived !== sources[0].archived)) { item.status = 'blocked'; item.reason = '相同会话 ID 同时存在活动与归档目录，需要手动核查'; }
    else if (!indexRows.some(r => r.table === 'threads')) { item.status = 'blocked'; item.reason = '缺少原生 threads 行；仅有日志不足以安全重建所有必填索引字段'; }
    else if (canonical.length !== 1) { item.status = 'blocked'; item.reason = '同一会话存在多个原生 threads 行，无法确认唯一归属'; }
    else if (options.sourceProvider !== undefined && indexRows.some(row => row.table === 'local_thread_catalog' && row.values.model_provider !== options.sourceProvider && row.values.model_provider !== options.targetProvider)) { item.status = 'blocked'; item.reason = '本机目录归属既不属于原供应商也不属于目标供应商，需要先核查索引冲突'; }
    const rowChanges: RowState[] = [];
    if (item.status !== 'blocked') {
      for (const row of indexRows) {
        const after: Record<string, Cell> = { ...row.values, model_provider: options.targetProvider };
        if (options.fixPaths && Object.hasOwn(after, 'rollout_path')) {
          const existing = typeof after.rollout_path === 'string' ? path.resolve(ctx.home, after.rollout_path) : '';
          const matched = sources.find(s => path.resolve(s.path) === existing);
          if (!matched && sources.length === 1 && (!existing || !fs.existsSync(existing))) { after.rollout_path = sources[0].path; item.changes.push('修复会话文件路径'); }
          else if (!matched) { item.status = 'blocked'; item.reason = '索引路径指向其他现存文件或有多个候选原文件，不能自动选择'; break; }
        }
        if (valueHash(after) !== valueHash(row.values)) rowChanges.push({ dbPath: row.dbPath, table: row.table, keys: row.keys, before: row.values, after, sessionId: id });
      }
      if (item.status !== 'blocked') {
        if (sources.some(s => s.metadataChanges)) item.changes.push('同步会话原文件的供应商元数据');
        if (rowChanges.some(r => r.before.model_provider !== r.after.model_provider)) item.changes.push('同步原生索引与本机目录的供应商归属');
        if (item.changes.length || rowChanges.length) { item.status = 'ready'; files.push(...sources); rows.push(...rowChanges); }
      }
    }
    item.changes = [...new Set(item.changes)]; items.push(item);
  }
  if (items.some(i => i.encrypted)) warnings.push('部分会话包含 encrypted_content。修复保留这些内容原样，跨账号或供应商能否续聊仍取决于原客户端和原始身份。');
  if (options.sourceProvider !== undefined) warnings.push('来源筛选以原生 threads 索引为准。迁移同步日志与本机目录归属，不移动会话文件，也不更改当前客户端的模型或供应商配置。');
  warnings.push('本操作同步供应商归属与可确认的文件路径，不修改聊天正文、账号凭据、任务执行状态，也不自动恢复被删除的任务。');
  const dbPaths = Object.keys(schemas);
  const summary = itemSummary(items, files, rows, ids.length);
  const revision = valueHash({ options, schemas, config: config.hash, items, files: files.map(f => [f.path, f.hash, f.afterHash]), rows });
  return { ok: true, revision, options, summary, items, warnings, dbPath: dbPaths[0] || '', dbPaths, currentProvider: config.current, files, rows, schemas, configHash: config.hash };
}
const publicPlan = ({ files: _files, rows: _rows, schemas: _schemas, configHash: _config, ...plan }: InternalPlan) => plan;
function backupDir(ctx: HistoryContext): string { return path.join(repairRoot(ctx), 'provider-backups'); }
function journalFile(ctx: HistoryContext, id: string): string { if (!/^provider-\d+-[a-f0-9]{12}$/.test(id)) throw new Error('备份批次 ID 无效'); return path.join(backupDir(ctx), id, 'manifest.json'); }
function loadJournal(ctx: HistoryContext, id: string): Journal {
  const file = journalFile(ctx, id); checkedFile(repairRoot(ctx), file);
  if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('备份清单过大');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
  if (value.format !== 'aurora-history-provider-v1' || value.id !== id || path.resolve(value.home) !== path.resolve(ctx.home) || path.resolve(value.sqliteHome) !== path.resolve(ctx.sqliteHome)) throw new Error('备份不属于当前客户端配置目录');
  const root = path.dirname(file);
  for (const f of value.files) { checkedFile(ctx.home, f.path); checkedFile(root, f.original); if (!inside(root, f.staged)) throw new Error('备份中暂存路径无效'); }
  for (const db of value.databases) { checkedFile(ctx.sqliteHome, db.path); checkedFile(root, db.backup); }
  for (const row of value.rows) {
    if (!value.databases.some(db => db.path === row.dbPath) || !['threads', 'local_thread_catalog'].includes(row.table) || Object.keys(row.keys).some(k => !['id', 'thread_id', 'host_id'].includes(k)) || Object.keys(row.before).some(k => !['model_provider', 'rollout_path', 'cwd'].includes(k)) || Object.keys(row.after).sort().join() !== Object.keys(row.before).sort().join()) throw new Error('备份中的数据库变更超出允许范围');
  }
  return value;
}
function currentRow(db: SqlDb, row: RowState): Record<string, Cell> | undefined {
  const keys = Object.keys(row.keys), fields = Object.keys(row.before);
  const rows = db.prepare(`SELECT ${fields.map(sqlIdentifier).join(',')} FROM ${sqlIdentifier(row.table)} WHERE ${keys.map(k => `${sqlIdentifier(k)} IS ?`).join(' AND ')}`).all(...keys.map(k => row.keys[k]));
  if (rows.length !== 1) return undefined;
  return Object.fromEntries(fields.map(k => [k, serialize(rows[0][k])]));
}
function writeRow(db: SqlDb, row: RowState, values: Record<string, Cell>): void {
  const fields = Object.keys(values), keys = Object.keys(row.keys);
  const expected = valueHash(values) === valueHash(row.after) ? row.before : row.after;
  if (valueHash(currentRow(db, row)) === valueHash(values)) return;
  const result = db.prepare(`UPDATE ${sqlIdentifier(row.table)} SET ${fields.map(k => `${sqlIdentifier(k)} = ?`).join(',')} WHERE ${[...keys, ...fields].map(k => `${sqlIdentifier(k)} IS ?`).join(' AND ')}`).run(...fields.map(k => values[k]), ...keys.map(k => row.keys[k]), ...fields.map(k => expected[k]));
  if (Number(result.changes) !== 1) throw new Error('会话索引行数量发生变化，已停止写入');
}
async function stageSource(source: SourceFile, original: string, staged: string, target: string): Promise<void> {
  await fs.promises.copyFile(source.path, original, fs.constants.COPYFILE_EXCL);
  if (await fileHash(original) !== source.hash) throw new Error('创建备份时会话原文件已变化，请重新预览');
  fs.chmodSync(original, 0o600);
  const handle = await fs.promises.open(staged, 'wx', 0o600);
  try { for await (const line of rawLines(original)) await handle.write(rewritten(line, parseLine(line), target)); await handle.sync(); }
  finally { await handle.close(); }
  if (await fileHash(staged) !== source.afterHash) throw new Error('暂存的修复内容与预览不一致');
}
async function replaceFile(source: string, target: string, mode: number, mtimeMs: number): Promise<void> {
  const temporary = `${target}.aurora-repair-${randomBytes(6).toString('hex')}.tmp`;
  try { await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL); fs.chmodSync(temporary, mode); await fs.promises.rename(temporary, target); fs.utimesSync(target, new Date(), new Date(mtimeMs)); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function openJournalDbs(journal: Journal): Map<string, SqlDb> {
  const dbs = new Map<string, SqlDb>();
  try { for (const entry of journal.databases) { const db = openHistoryDb(entry.path, false); dbs.set(entry.path, db); db.prepare('BEGIN IMMEDIATE').run(); if (schemaHash(db) !== entry.schema) throw new Error('数据库结构在预览或备份后变化，不能自动恢复'); } return dbs; }
  catch (error) { for (const db of dbs.values()) { try { db.prepare('ROLLBACK').run(); } catch {} db.close(); } throw error; }
}
async function restoreInspection(ctx: HistoryContext, journal: Journal): Promise<{ ok: boolean; revision: string; summary: { sessions: number; files: number; rows: number }; conflicts: string[]; message: string }> {
  const conflicts: string[] = [], state: unknown[] = [];
  if (journal.status === 'restored') conflicts.push('该备份批次已经恢复');
  for (const file of journal.files) {
    try {
      const current = await fileHash(file.path), original = await fileHash(file.original); state.push([file.path, current, original]);
      if (original !== file.beforeHash) conflicts.push(`原始文件备份校验失败：${file.path}`);
      if (![file.beforeHash, file.afterHash].includes(current)) conflicts.push(`文件在修复后有新增或修改，保留现状：${file.path}`);
    } catch { conflicts.push(`无法读取会话或原始备份：${file.path}`); }
  }
  for (const entry of journal.databases) {
    let db: SqlDb | undefined;
    try {
      if (await fileHash(entry.backup) !== entry.hash) conflicts.push(`数据库快照校验失败：${entry.path}`);
      db = openHistoryDb(entry.path, true); const schema = schemaHash(db); state.push([entry.path, schema]);
      if (schema !== entry.schema) conflicts.push(`数据库结构已变化：${entry.path}`);
      for (const row of journal.rows.filter(row => row.dbPath === entry.path)) {
        const current = currentRow(db, row); state.push([row.table, row.keys, current]);
        if (valueHash(current) !== valueHash(row.before) && valueHash(current) !== valueHash(row.after)) conflicts.push(`会话索引 ${row.sessionId} 在修复后有修改或已删除`);
      }
    } catch (error) { conflicts.push(String((error as Error).message)); }
    finally { db?.close(); }
  }
  return { ok: conflicts.length === 0, revision: valueHash({ id: journal.id, status: journal.status, state }), summary: { sessions: journal.sessions, files: journal.files.length, rows: journal.rows.length }, conflicts, message: conflicts.length ? '检测到恢复冲突，未覆盖现有历史' : '将仅恢复本批次修改的元数据和索引字段，保留其余新增会话' };
}
async function restoreJournal(ctx: HistoryContext, journal: Journal, revision?: string): Promise<any> {
  const inspection = await restoreInspection(ctx, journal);
  if (!inspection.ok) return { ...inspection, backupId: journal.id };
  if (revision && revision !== inspection.revision) throw new Error('恢复预览后历史又有变化，请重新预览');
  const dbs = openJournalDbs(journal), file = journalFile(ctx, journal.id);
  try {
    const current = await restoreInspection(ctx, journal);
    if (!current.ok || current.revision !== inspection.revision) throw new Error('取得写锁后检测到历史变化，未执行恢复');
    journal.status = 'restoring'; saveJournal(file, journal);
    for (const source of journal.files) if (await fileHash(source.path) !== source.beforeHash) await replaceFile(source.original, source.path, source.mode, source.mtimeMs);
    for (const row of journal.rows) writeRow(dbs.get(row.dbPath)!, row, row.before);
    for (const db of dbs.values()) db.prepare('COMMIT').run();
    journal.status = 'restored'; journal.restoredAt = new Date().toISOString(); saveJournal(file, journal);
    return { ok: true, backupId: journal.id, updated: journal.sessions, message: `已恢复 ${journal.sessions} 个会话在本批修复前的元数据与索引。备份继续保留。` };
  } catch (error) {
    for (const db of dbs.values()) { try { db.prepare('ROLLBACK').run(); } catch {} }
    journal.status = 'interrupted'; journal.error = String((error as Error).message); saveJournal(file, journal);
    return { ok: false, backupId: journal.id, message: `恢复未全部完成，原始备份完整保留，请重新预览恢复：${journal.error}` };
  } finally { for (const db of dbs.values()) db.close(); }
}

export function createHistoryRepairService(ctx: HistoryContext = historyContext()) {
  function backups() {
    const root = backupDir(ctx); if (!fs.existsSync(root)) return { ok: true, backups: [] };
    const list: any[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^provider-\d+-[a-f0-9]{12}$/.test(entry.name)) continue;
      try { const j = loadJournal(ctx, entry.name); list.push({ id: j.id, createdAt: j.createdAt, targetProvider: j.targetProvider, sessions: j.sessions, restoredAt: j.restoredAt, path: path.join(root, entry.name), status: j.status === 'complete' || j.status === 'restored' ? j.status : 'interrupted' }); }
      catch { list.push({ id: entry.name, createdAt: '', targetProvider: '', sessions: 0, path: path.join(root, entry.name), status: 'interrupted', error: '备份清单需要手动检查' }); }
    }
    return { ok: true, backups: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }
  return {
    async providers() { try { return await providerInventory(ctx); } catch (error) { return { ok: false, message: String((error as Error).message), currentProvider: '', targets: [], sources: [], warnings: [] }; } },
    async preview(input: HistoryRepairOptions = {}) { try { return publicPlan(await buildPlan(ctx, input)); } catch (error) { return { ok: false, message: String((error as Error).message), items: [], warnings: [] }; } },
    backups,
    async apply(input: HistoryRepairOptions & { revision: string }) {
      let unlock: (() => void) | undefined, journal: Journal | undefined;
      const dbs = new Map<string, SqlDb>();
      try {
        if (!input.revision) throw new Error('请先预览本次修复范围');
        await assertClientsStopped(ctx); unlock = acquireHistoryLock(ctx);
        if (backups().backups.some(b => b.status === 'interrupted')) throw new Error('存在未完成或无法读取的修复备份，请先检查并恢复该批次');
        const plan = await buildPlan(ctx, input);
        if (plan.revision !== input.revision) throw new Error('预览后会话、索引或供应商配置发生变化，请重新预览');
        if (!plan.summary.repairable) return { ok: true, updated: 0, message: '所选范围没有可安全执行的修复项' };
        const id = `provider-${Date.now()}-${randomBytes(6).toString('hex')}`, root = path.join(backupDir(ctx), id);
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        journal = { format: 'aurora-history-provider-v1', id, createdAt: new Date().toISOString(), targetProvider: plan.options.targetProvider, sessions: plan.summary.repairable, status: 'prepared', home: ctx.home, sqliteHome: ctx.sqliteHome, options: plan.options, files: [], databases: [], rows: [] };
        saveJournal(journalFile(ctx, id), journal);
        for (const source of plan.files.filter(f => f.metadataChanges)) {
          const i = journal.files.length, original = path.join(root, `${i}.original.jsonl`), staged = path.join(root, `${i}.repaired.jsonl`);
          await stageSource(source, original, staged, plan.options.targetProvider);
          journal.files.push({ path: source.path, original, staged, beforeHash: source.hash, afterHash: source.afterHash, mtimeMs: source.mtimeMs, mode: source.mode, sessionId: source.id });
          saveJournal(journalFile(ctx, id), journal);
        }
        for (const dbPath of [...new Set(plan.rows.map(r => r.dbPath))]) {
          const backup = path.join(root, `database-${journal.databases.length}.sqlite`), db = openHistoryDb(dbPath, false);
          try { db.prepare('VACUUM INTO ?').run(backup); } finally { db.close(); }
          fs.chmodSync(backup, 0o600); journal.databases.push({ path: dbPath, backup, hash: await fileHash(backup), schema: plan.schemas[dbPath] });
          saveJournal(journalFile(ctx, id), journal);
        }
        journal.rows = plan.rows;
        saveJournal(journalFile(ctx, id), journal);
        await assertClientsStopped(ctx);
        for (const [file, db] of openJournalDbs(journal)) dbs.set(file, db);
        if (readProvider(ctx).hash !== plan.configHash) throw new Error('备份过程中客户端配置变化，请重新预览');
        for (const source of plan.files) if (await fileHash(source.path) !== source.hash) throw new Error('备份过程中会话原文件发生变化');
        for (const row of plan.rows) if (valueHash(currentRow(dbs.get(row.dbPath)!, row)) !== valueHash(row.before)) throw new Error('备份过程中会话索引发生变化');
        journal.status = 'applying'; saveJournal(journalFile(ctx, id), journal);
        for (const source of journal.files) { if (await fileHash(source.path) !== source.beforeHash) throw new Error('会话文件正在被其他程序修改'); await replaceFile(source.staged, source.path, source.mode, source.mtimeMs); }
        for (const row of journal.rows) writeRow(dbs.get(row.dbPath)!, row, row.after);
        for (const source of journal.files) if (await fileHash(source.path) !== source.afterHash) throw new Error('提交前检测到会话文件被外部修改');
        for (const db of dbs.values()) db.prepare('COMMIT').run();
        journal.status = 'complete'; saveJournal(journalFile(ctx, id), journal);
        return { ok: true, updated: journal.sessions, backupId: id, backup: root, target: journal.targetProvider, summary: plan.summary, message: `已批量修复 ${journal.sessions} 个会话的归属与可确认的路径。完整备份已保存，聊天正文和加密内容保持原样。` };
      } catch (error) {
        for (const db of dbs.values()) { try { db.prepare('ROLLBACK').run(); } catch {} db.close(); } dbs.clear();
        if (journal && fs.existsSync(journalFile(ctx, journal.id))) {
          journal.status = 'interrupted'; journal.error = String((error as Error).message); saveJournal(journalFile(ctx, journal.id), journal);
          const rollback = await restoreJournal(ctx, journal).catch(e => ({ ok: false, message: String(e.message || e) }));
          return { ok: false, backupId: journal.id, backup: path.dirname(journalFile(ctx, journal.id)), rolledBack: rollback.ok, message: `批量修复未完成：${String((error as Error).message)}。${rollback.ok ? '已恢复本次写入。' : '部分状态需要恢复，完整备份已保留。'}` };
        }
        return { ok: false, message: String((error as Error).message) };
      } finally { for (const db of dbs.values()) db.close(); unlock?.(); }
    },
    async restorePreview(input: { backupId: string }) { try { return await restoreInspection(ctx, loadJournal(ctx, input.backupId)); } catch (error) { return { ok: false, message: String((error as Error).message), conflicts: [String((error as Error).message)] }; } },
    async restore(input: { backupId: string; revision: string }) {
      let unlock: (() => void) | undefined;
      try { if (!input.revision) throw new Error('请先预览恢复内容'); await assertClientsStopped(ctx); unlock = acquireHistoryLock(ctx); return await restoreJournal(ctx, loadJournal(ctx, input.backupId), input.revision); }
      catch (error) { return { ok: false, message: String((error as Error).message) }; } finally { unlock?.(); }
    },
  };
}
export async function runHistoryRepairAction(action: string, payload: any): Promise<any | null> {
  const service = createHistoryRepairService();
  switch (action) {
    case 'codex.repair.providers': return service.providers();
    case 'codex.repair.preview': return service.preview(payload);
    case 'codex.repair.apply': return service.apply(payload);
    case 'codex.repair.backups': return service.backups();
    case 'codex.repair.restorePreview': return service.restorePreview(payload);
    case 'codex.repair.restore': return service.restore(payload);
    default: return null;
  }
}
