import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Trusted host/test context only. Renderer requests must never supply these options. */
export interface ClaudeDesktopSessionOptions {
  platform?: NodeJS.Platform;
  home?: string;
  environment?: Record<string, string | undefined>;
  isolated?: boolean;
  maxDirectories?: number;
  maxFiles?: number;
  maxRecordBytes?: number;
}

export interface ClaudeDesktopSessionRecord {
  id: string;
  title: string;
  cwd: string;
  createdAtMs?: number;
  updatedAtMs: number;
  modifiedAtMs: number;
  isArchived: boolean;
  cliSessionId?: string;
  unarchivedCliSessionId?: string;
  priorCliSessionIds: string[];
  cliIds: string[];
  sourceLabel: string;
  /** Data directory, account and organization form the scope; session IDs alone are not globally unique. */
  sourceScope: string;
  sourceDirectory: string;
  accountId: string;
  organizationId: string;
  path: string;
  size: number;
}

interface Source { anchor: string; directory: string; sessions: string; label: string }
interface Limits { directories: number; files: number; entries: number; maxDirectories: number; maxFiles: number; maxEntries: number; maxRecordBytes: number }
const recordName = /^local_[A-Za-z0-9][A-Za-z0-9_-]{0,200}\.json$/;
const sessionId = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/.test(value.trim()) ? value.trim() : undefined;
const safeComponent = (value: string) => value.length <= 200 && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(value);
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
const limit = (value: number | undefined, fallback: number, ceiling: number) => Number.isInteger(value) && value! > 0 ? Math.min(value!, ceiling) : fallback;

function limits(options: ClaudeDesktopSessionOptions): Limits {
  return { directories: 0, files: 0, entries: 0,
    maxDirectories: limit(options.maxDirectories, 2048, 10000), maxFiles: limit(options.maxFiles, 5000, 10000),
    maxEntries: 50000, maxRecordBytes: limit(options.maxRecordBytes, 1024 * 1024, 10 * 1024 * 1024) };
}

/** Reject every linked descendant, including Windows junctions and reparse paths that resolve elsewhere. */
function safeDirectory(anchor: string, directory: string): string {
  if (!inside(anchor, directory)) throw new Error('Claude 桌面会话目录超出允许范围');
  const anchorStat = fs.lstatSync(anchor);
  if (!anchorStat.isDirectory() || anchorStat.isSymbolicLink()) throw new Error('Claude 桌面会话根目录不是普通目录');
  const realAnchor = fs.realpathSync.native(anchor);
  let current = anchor, expected = realAnchor;
  for (const part of path.relative(anchor, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); expected = path.join(expected, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || key(fs.realpathSync.native(current)) !== key(expected)) throw new Error('Claude 桌面会话目录包含链接或重定向');
  }
  return fs.realpathSync.native(directory);
}

function entries(source: Pick<Source, 'anchor'>, directory: string, budget: Limits): fs.Dirent[] {
  if (budget.directories >= budget.maxDirectories || budget.entries >= budget.maxEntries) return [];
  budget.directories++;
  const found: fs.Dirent[] = [];
  let handle: fs.Dir | undefined;
  try {
    safeDirectory(source.anchor, directory);
    handle = fs.opendirSync(directory);
    for (let entry = handle.readSync(); entry && budget.entries < budget.maxEntries; entry = handle.readSync()) {
      budget.entries++;
      if (!entry.isSymbolicLink() && safeComponent(entry.name)) found.push(entry);
    }
  } catch { /* An inaccessible or replaced source does not hide other sources. */ }
  finally { handle?.closeSync(); }
  return found.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function sources(options: ClaudeDesktopSessionOptions, budget: Limits): Source[] {
  const isolatedHome = process.env.AURORA_CLIENT_HOME;
  const isolated = !!isolatedHome || (options.isolated ?? options.home !== undefined);
  const home = options.home ?? isolatedHome ?? os.homedir();
  if (!path.isAbsolute(home) || /[\u0000-\u001f\u007f]/.test(home)) throw new Error('Claude 桌面会话主目录无效');
  const userHome = path.resolve(home), platform = options.platform ?? process.platform;
  const environment = isolated ? {} : options.environment ?? process.env;
  const env = (name: string) => environment[name] ?? (platform === 'win32' ? environment[Object.keys(environment).find(k => k.toUpperCase() === name) || ''] : undefined);
  const bases: Array<{ directory: string; anchor: string }> = [];
  const addBase = (directory: string) => {
    if (!path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory)) return;
    directory = path.resolve(directory);
    const anchor = isolated || inside(userHome, directory) ? userHome : directory;
    try { safeDirectory(anchor, directory); } catch { return; }
    if (!bases.some(base => key(base.directory) === key(directory))) bases.push({ directory, anchor });
  };
  if (platform === 'win32') {
    const local = env('LOCALAPPDATA') || path.join(userHome, 'AppData', 'Local');
    addBase(local); addBase(env('APPDATA') || path.join(userHome, 'AppData', 'Roaming'));
    if (path.isAbsolute(local)) {
      const anchor = isolated || inside(userHome, path.resolve(local)) ? userHome : path.resolve(local), packages = path.join(local, 'Packages');
      let matchedPackages = 0;
      for (const entry of entries({ anchor }, packages, budget)) {
        if (!entry.isDirectory() || !/^(?:Claude|AnthropicPBC\.Claude)_[a-z0-9]{13}$/i.test(entry.name)) continue;
        if (++matchedPackages > 64) break;
        for (const name of ['Local', 'Roaming']) {
          const directory = path.join(packages, entry.name, 'LocalCache', name);
          try {
            safeDirectory(anchor, directory);
            if (!bases.some(base => key(base.directory) === key(directory))) bases.push({ anchor, directory });
          } catch { /* Ignore invalid package data roots. */ }
        }
      }
    }
  } else if (platform === 'darwin') addBase(path.join(userHome, 'Library', 'Application Support'));
  else addBase(env('XDG_CONFIG_HOME') || path.join(userHome, '.config'));
  const result: Source[] = [];
  for (const base of bases) for (const name of ['Claude-3p', 'Claude']) {
    const directory = path.join(base.directory, name), sessions = path.join(directory, 'claude-code-sessions');
    try {
      safeDirectory(base.anchor, sessions);
      result.push({ anchor: base.anchor, directory, sessions, label: name === 'Claude-3p' ? 'Claude-3p · 第三方网关' : 'Claude · 默认目录' });
    } catch { /* Missing stores are normal. */ }
  }
  return result;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) { const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined; }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const ms = value < 100000000000 ? value * 1000 : value;
  return Number.isSafeInteger(Math.trunc(ms)) && ms <= 8640000000000000 ? Math.trunc(ms) : undefined;
}
function text(value: unknown, length: number): string { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length) : ''; }
function workingDirectory(value: unknown): string { return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) ? value : ''; }

function readRecord(source: Source, file: string, budget: Limits): ClaudeDesktopSessionRecord {
  const relative = path.relative(source.sessions, file).split(path.sep);
  if (relative.length !== 3 || !relative.every(safeComponent) || !recordName.test(relative[2])) throw new Error('Claude 桌面会话文件不符合账号和组织目录布局');
  const [accountId, organizationId, filename] = relative;
  const parent = path.dirname(file), realParent = safeDirectory(source.anchor, parent);
  // A deletion marker suppresses only this account/organization's record, even if its contents are malformed.
  const marker = 'deleted_' + filename.slice('local_'.length, -'.json'.length);
  try { fs.lstatSync(path.join(parent, marker)); throw new Error('Claude 桌面会话已删除'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const initial = fs.lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink() || key(fs.realpathSync.native(file)) !== key(path.join(realParent, filename))) throw new Error('Claude 桌面会话文件不是普通文件或包含链接');
  if (initial.size > budget.maxRecordBytes) throw new Error('Claude 桌面会话元数据过大');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let raw: string;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size || opened.mtimeMs !== initial.mtimeMs) throw new Error('Claude 桌面会话文件在读取前发生变化');
    safeDirectory(source.anchor, parent);
    if (key(fs.realpathSync.native(file)) !== key(path.join(realParent, filename))) throw new Error('Claude 桌面会话文件路径发生变化');
    const buffer = Buffer.alloc(initial.size + 1);
    let size = 0;
    while (size < buffer.length) { const count = fs.readSync(descriptor, buffer, size, buffer.length - size, size); if (!count) break; size += count; }
    const after = fs.fstatSync(descriptor);
    if (size !== initial.size || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) throw new Error('Claude 桌面会话文件在读取时发生变化');
    raw = buffer.subarray(0, size).toString('utf8');
  } finally { fs.closeSync(descriptor); }
  let metadata: Record<string, unknown>;
  try { metadata = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new Error('Claude 桌面会话元数据不是有效 JSON'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Claude 桌面会话元数据结构无效');
  const cliSessionId = sessionId(metadata.cliSessionId), unarchivedCliSessionId = sessionId(metadata.unarchivedCliSessionId);
  const priorCliSessionIds = [...new Set((Array.isArray(metadata.priorCliSessionIds) ? metadata.priorCliSessionIds.slice(0, 128) : []).map(sessionId).filter((id): id is string => !!id))];
  const cliIds = [...new Set([cliSessionId, unarchivedCliSessionId, ...priorCliSessionIds].filter((id): id is string => !!id))];
  const sourceDirectory = safeDirectory(source.anchor, source.directory), createdAtMs = timestamp(metadata.createdAt);
  return { id: filename.slice(0, -5), title: text(metadata.title, 512).replace(/\s+/g, ' '), cwd: workingDirectory(metadata.cwd),
    ...(createdAtMs !== undefined ? { createdAtMs } : {}), updatedAtMs: timestamp(metadata.lastActivityAt) ?? timestamp(metadata.updatedAt) ?? createdAtMs ?? initial.mtimeMs,
    modifiedAtMs: initial.mtimeMs, isArchived: metadata.isArchived === true,
    ...(cliSessionId ? { cliSessionId } : {}), ...(unarchivedCliSessionId ? { unarchivedCliSessionId } : {}), priorCliSessionIds, cliIds,
    sourceLabel: source.label, sourceScope: JSON.stringify([key(sourceDirectory), accountId, organizationId]), sourceDirectory,
    accountId, organizationId, path: path.join(realParent, filename), size: initial.size };
}

/** Read only small Desktop metadata files; conversation JSONL bodies are intentionally not opened here. */
export function scanClaudeDesktopSessions(options: ClaudeDesktopSessionOptions = {}): ClaudeDesktopSessionRecord[] {
  const budget = limits(options), records: ClaudeDesktopSessionRecord[] = [];
  scanning: for (const source of sources(options, budget)) {
    for (const account of entries(source, source.sessions, budget)) {
      if (!account.isDirectory()) continue;
      const accountDir = path.join(source.sessions, account.name);
      for (const organization of entries(source, accountDir, budget)) {
        if (!organization.isDirectory()) continue;
        for (const file of entries(source, path.join(accountDir, organization.name), budget)) {
          if (!file.isFile() || !recordName.test(file.name)) continue;
          if (budget.files++ >= budget.maxFiles) break scanning;
          try { records.push(readRecord(source, path.join(accountDir, organization.name, file.name), budget)); }
          catch { /* One damaged, deleted, oversized or replaced record does not hide other histories. */ }
        }
      }
    }
  }
  return records.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.path.localeCompare(b.path));
}

/** Re-derive allowed roots on every read; never trust a path returned earlier or supplied through IPC. */
export function readClaudeDesktopSession(file: string, options: ClaudeDesktopSessionOptions = {}): ClaudeDesktopSessionRecord {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file) || file.split(/[\\/]/).some(part => part === '.' || part === '..')) throw new Error('Claude 桌面会话路径无效');
  const budget = limits(options), requested = path.resolve(file);
  for (const source of sources(options, budget)) {
    const realSessions = safeDirectory(source.anchor, source.sessions);
    let candidate: string | undefined;
    if (inside(source.sessions, requested)) candidate = requested;
    else if (inside(realSessions, requested)) candidate = path.join(source.sessions, path.relative(realSessions, requested));
    if (candidate) return readRecord(source, candidate, budget);
  }
  throw new Error('只能读取已核对的 Claude 桌面会话目录中的元数据');
}
