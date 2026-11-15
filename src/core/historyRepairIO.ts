import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite } from './agents/configFiles.js';
import { runningCodingClients } from './clientProcesses.js';
import { getAdapter } from './agents/adapters.js';

export const runFile = promisify(execFile);
export interface HistoryContext { home: string; sqliteHome: string; blockingProcesses?: () => Promise<string[]> }
export function historyContext(): HistoryContext {
  const home = process.env.AURORA_CLIENT_HOME ? path.join(process.env.AURORA_CLIENT_HOME, '.codex') : process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return { home: path.resolve(home), sqliteHome: path.resolve(process.env.AURORA_CLIENT_HOME ? home : process.env.CODEX_SQLITE_HOME || home) };
}
export function inside(root: string, file: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(file)); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
export function checkedFile(root: string, file: string): string {
  if (!inside(root, file)) throw new Error('文件路径不属于本次修复目录');
  const realRoot = fs.realpathSync(root), realFile = fs.realpathSync(file);
  if (!inside(realRoot, realFile) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('修复不接受外部链接或非普通文件');
  return realFile;
}
export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function valueHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex'); }
export const repairRoot = (ctx: HistoryContext) => path.join(ctx.home, '.aurora-history-repair');
export function saveJournal(file: string, value: unknown): void { atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
export async function assertClientsStopped(ctx: HistoryContext): Promise<void> {
  const processes = ctx.blockingProcesses ? await ctx.blockingProcesses() : await runningClients();
  if (processes.length) throw new Error(`请先完全退出 ChatGPT 桌面版 / Codex 及 CLI，再执行修复或恢复。检测到：${processes.join('、')}`);
}
export async function runningClients(): Promise<string[]> {
  const configured = getAdapter('chatgpt-desktop')?.detect().command;
  return runningCodingClients(configured ? [configured] : []);
}

/** Shared across provider repair and native index repair; stale owners are recovered only after PID verification. */
export function acquireHistoryLock(ctx: HistoryContext): () => void {
  const root = repairRoot(ctx); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'repair.lock'), owner = { pid: process.pid, nonce: randomBytes(12).toString('hex'), at: new Date().toISOString() };
  const create = () => fs.writeFileSync(file, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { create(); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    let old: any;
    try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('修复锁无法读取，请检查是否有中断的修复任务'); }
    if (!Number.isInteger(old.pid) || old.pid <= 0) throw new Error('修复锁格式异常，请手动检查');
    let alive = true;
    try { process.kill(old.pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('已有历史修复或恢复正在执行，请等待完成');
    if (fs.readFileSync(file, 'utf8') !== JSON.stringify(old)) throw new Error('修复锁已变化，请重新操作');
    fs.unlinkSync(file); create();
  }
  return () => { try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.nonce === owner.nonce) fs.unlinkSync(file); } catch { /* best effort */ } };
}

export interface SqlDb { prepare(sql: string): { all(...values: any[]): any[]; get(...values: any[]): any; run(...values: any[]): { changes: number | bigint } }; close(): void; }
export function openHistoryDb(file: string, readOnly: boolean): SqlDb {
  try { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(file, { readOnly }); db.prepare('PRAGMA busy_timeout = 2000').run(); return db; }
  catch (error) { throw new Error(`无法读取历史 SQLite 数据库：${String((error as Error).message)}`); }
}
export const sqlIdentifier = (value: string): string => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('不受支持的数据库字段'); return `"${value}"`; };
export function tableColumns(db: SqlDb, table: string): Set<string> { return new Set(db.prepare(`PRAGMA table_info(${sqlIdentifier(table)})`).all().map(row => row.name)); }
export function discoverHistoryDbs(ctx: HistoryContext): string[] {
  const out: string[] = [];
  for (const dir of [ctx.sqliteHome, path.join(ctx.sqliteHome, 'sqlite')]) {
    if (!fs.existsSync(dir)) continue;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isFile() || !/\.(?:sqlite|sqlite3|db)$/i.test(item.name)) continue;
      if (dir === ctx.sqliteHome && !/^(?:state_\d+|thread_history_\d+)\.sqlite$/.test(item.name)) continue;
      const file = path.join(dir, item.name); checkedFile(ctx.sqliteHome, file); out.push(file);
    }
  }
  if (out.length > 40) throw new Error('当前目录数据库过多，请检查 CODEX_SQLITE_HOME 配置');
  return out.sort();
}

/** Read-only native provider regions for history filtering; duplicate canonical identities stay ambiguous. */
export function nativeSessionRegions(ctx: HistoryContext = historyContext()): Map<string, { modelProvider?: string; archived?: boolean }> {
  const regions = new Map<string, { modelProvider?: string; archived?: boolean }>(), seen = new Set<string>();
  for (const file of discoverHistoryDbs(ctx)) {
    const db = openHistoryDb(file, true);
    try {
      const columns = tableColumns(db, 'threads');
      if (!columns.has('id') || !columns.has('model_provider')) continue;
      const rows = db.prepare(`SELECT id,model_provider${columns.has('archived') ? ',archived' : ''} FROM threads LIMIT 50001`).all();
      if (rows.length > 50000) throw new Error('原生会话索引过大，未加载区域筛选');
      for (const row of rows) {
        if (typeof row.id !== 'string') continue;
        if (seen.has(row.id)) { regions.set(row.id, {}); continue; }
        seen.add(row.id);
        regions.set(row.id, { modelProvider: typeof row.model_provider === 'string' && row.model_provider ? row.model_provider : undefined, archived: columns.has('archived') ? !!row.archived : undefined });
      }
    } finally { db.close(); }
  }
  return regions;
}
