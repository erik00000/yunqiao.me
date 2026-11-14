import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionSummary } from './store/types.js';

/**
 * 历史会话聚合：把各客户端的本地会话日志读成统一结构。
 * 只读，不改原文件；支持搜索、导出、复制恢复命令。
 */

function home(...p: string[]): string {
  return path.join(process.env.AURORA_CLIENT_HOME || os.homedir(), ...p);
}
function clientDir(env: string, fallback: string): string { return process.env.AURORA_CLIENT_HOME ? fallback : process.env[env] || fallback; }
function sessionRoots(): Array<{ dir: string; agent: string }> {
  return [
    { dir: path.join(clientDir('CLAUDE_CONFIG_DIR', home('.claude')), 'projects'), agent: 'Claude Code' },
    { dir: path.join(clientDir('CODEX_HOME', home('.codex')), 'sessions'), agent: 'Codex' },
    { dir: path.join(clientDir('CODEX_HOME', home('.codex')), 'archived_sessions'), agent: 'Codex' },
    { dir: home('.gemini', 'tmp'), agent: 'Gemini CLI' },
    { dir: home('.codebuddy', 'sessions'), agent: 'CodeBuddy' },
  ];
}
function checkSessionPath(file: string): void {
  if (typeof file !== 'string' || !/\.jsonl?$/.test(file)) throw new Error('会话路径无效');
  let resolved: string;
  try { resolved = fs.realpathSync(file); } catch { throw new Error('会话文件不存在'); }
  const allowed = sessionRoots().some(({ dir }) => {
    try { const rel = path.relative(fs.realpathSync(dir), resolved); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); }
    catch { return false; }
  });
  if (!allowed) throw new Error('只能读取已支持客户端目录下的会话文件');
}

/** 只读文件头部若干字节，避免超大会话文件把内存打满 */
function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir: string, filter: (f: string) => boolean, out: string[] = [], depth = 0): string[] {  if (depth > 8 || out.length >= 5000) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= 5000) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(full, filter, out, depth + 1);
    } else if (e.isFile() && filter(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 从一行日志里抽出「谁说的、说了什么」，兼容 Claude Code 与 Codex 两种结构 */
function extractLine(o: any): { role: 'user' | 'assistant' | 'tool' | ''; text: string; model?: string; cwd?: string; toolName?: string } {
  // Codex：{type:'response_item', payload:{type:'message', role, content:[{type:'input_text',text}]}}
  const payload = o?.payload ?? {};
  let role: any = o?.message?.role ?? o?.role ?? '';
  let content = o?.message?.content ?? o?.content ?? payload?.content;
  if (!role && payload?.type === 'message') role = payload.role;
  if (!role && o?.type === 'event_msg' && payload?.type === 'user_message') {
    role = 'user';
    content = payload.message;
  }
  if (!role && o?.type === 'user') role = 'user';
  if (!role && o?.type === 'assistant') role = 'assistant';
  if (!role && o?.type === 'gemini') role = 'assistant';
  if (!role && payload?.type === 'function_call') { role = 'assistant'; content = [{ type: 'function_call', name: payload.name, arguments: payload.arguments }]; }
  if (!role && payload?.type === 'function_call_output') { role = 'tool'; content = [{ type: 'function_call_output', output: payload.output }]; }
  const model = o?.message?.model ?? payload?.model ?? o?.model;
  const cwd = o?.cwd ?? payload?.cwd;

  let text = '';
  let toolName = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (!b) continue;
      if (typeof b === 'string') parts.push(b);
      else if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text' || (!b.type && typeof b.text === 'string')) parts.push(b.text ?? '');
      else if (b.type === 'tool_use') {
        toolName = b.name ?? '';
        parts.push(`\n调用工具：${b.name}\n${JSON.stringify(b.input ?? {}, null, 2)}`);
      } else if (b.type === 'tool_result')
        parts.push(`\n工具结果：\n${typeof b.content === 'string' ? b.content : JSON.stringify(b.content).slice(0, 2000)}`);
      else if (b.type === 'thinking') parts.push(`\n[思考]\n${b.thinking ?? ''}`);
      else if (b.type === 'image') parts.push('[图片]');
      else if (b.type === 'function_call') {
        toolName = b.name ?? '';
        parts.push(`\n调用工具：${b.name}\n${b.arguments ?? ''}`);
      } else if (b.type === 'function_call_output') parts.push(`\n工具结果：\n${b.output ?? ''}`);
    }
    text = parts.join('');
  }
  const r = String(role).toLowerCase();
  const norm: 'user' | 'assistant' | 'tool' | '' =
    r === 'user' || r === 'human'
      ? 'user'
      : r === 'assistant' || r === 'ai'
        ? 'assistant'
        : r === 'tool' || r === 'function'
          ? 'tool'
          : '';
  return { role: norm, text, model, cwd, toolName };
}

function summarize(file: string, agent: string): SessionSummary | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let title = '';
  let messageCount = 0;
  let model = '';
  let cwd = '';
  let id = path.basename(file).replace(/\.jsonl?$/, '');
  let truncated = false;
  try {
    // 只读文件头：Codex 的长会话可能有几百 MB，整个读进来会把主进程打死
    const isJson = file.endsWith('.json');
    const head = readHead(file, isJson ? 8 * 1024 * 1024 : 256 * 1024);
    const document = isJson ? JSON.parse(head) : null;
    const lines = isJson ? (document.messages || []).map((x: any) => JSON.stringify(x)) : head.split('\n').filter(Boolean).slice(0, 600);
    if (document?.sessionId) id = document.sessionId;
    truncated = stat.size > Buffer.byteLength(head) || (!isJson && head.split('\n').length > 600);
    for (const line of lines) {
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === 'session_meta' && typeof o.payload?.id === 'string') id = o.payload.id;
      if (typeof o.sessionId === 'string') id = o.sessionId;
      const ex = extractLine(o);
      cwd = cwd || ex.cwd || '';
      model = model || ex.model || '';
      if (!ex.role) continue;
      messageCount++;
      if (!title && ex.role === 'user' && ex.text.trim()) {
        const cleaned = ex.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // Codex 会把 AGENTS.md 注入到第一条 user 消息前面，跳过它找真正的提问
        if (cleaned && !/^#/.test(cleaned) && !/AGENTS\.md instructions/i.test(cleaned) && cleaned.length > 2) {
          title = cleaned.slice(0, 80);
        }
      }
    }
  } catch {
    return null;
  }
  if (!title) title = path.basename(file, '.jsonl');
  return {
    id,
    agent,
    title,
    project: cwd ? path.basename(cwd) : undefined,
    cwd: cwd || undefined,
    path: file,
    messageCount,
    tokens: 0,
    cost: 0,
    model: model || undefined,
    updatedAt: stat.mtime.toISOString(),
    createdAt: stat.birthtime?.toISOString?.() ?? stat.mtime.toISOString(),
    sizeBytes: stat.size,
    truncated,
  };
}

export function scanSessions(): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const root of sessionRoots()) {
    for (const f of walk(root.dir, n => n.endsWith('.jsonl') || (root.agent === 'Gemini CLI' && /^session.*\.json$/.test(n)))) {
      const s = summarize(f, root.agent);
      if (s) out.push(s);
    }
  }

  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  model?: string;
  ts?: string;
  toolName?: string;
}

export function readSession(file: string, limit = 400): SessionMessage[] {
  checkSessionPath(file);
  limit = Math.max(1, Math.min(2000, Number(limit) || 400));
  const out: SessionMessage[] = [];
  let txt = '';
  try {
    txt = readHead(file, file.endsWith('.json') ? 8 * 1024 * 1024 : 4 * 1024 * 1024);
  } catch {
    return out;
  }
  let lines = txt.split('\n');
  if (file.endsWith('.json')) {
    try { lines = (JSON.parse(txt).messages || []).map((x: any) => JSON.stringify(x)); }
    catch { throw new Error('此 JSON 会话文件不完整或超过 8 MB，请在原客户端中打开'); }
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ex = extractLine(o);
    const ts = o.timestamp ?? o.ts ?? o.created_at ?? o?.payload?.timestamp;
    if (!ex.role || !ex.text.trim()) continue;
    out.push({ role: ex.role, text: ex.text, ts, model: ex.model, toolName: ex.toolName });
    if (out.length >= limit) break;
  }
  return out;
}

export function resumeCommand(s: SessionSummary): string {
  if (!s || typeof s.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/.test(s.id)) return '';
  if (s.agent === 'Claude Code') return `claude --resume ${s.id}`;
  if (s.agent === 'Codex') return `codex resume ${s.id}`;
  if (s.agent === 'Gemini CLI') return `gemini --resume ${s.id}`;
  return '';
}

export function exportSessionMarkdown(s: SessionSummary): string {
  const msgs = readSession(s.path, 2000);
  const head = [
    `# ${s.title}`,
    '',
    `- 客户端：${s.agent}`,
    `- 模型：${s.model ?? '未知'}`,
    `- 目录：${s.cwd ?? '—'}`,
    `- 更新时间：${new Date(s.updatedAt).toLocaleString('zh-CN')}`,
    `- 已索引消息数：${s.messageCount}${s.truncated ? '（部分）' : ''}`,
    ...(s.sizeBytes > (s.path.endsWith('.json') ? 8 : 4) * 1024 * 1024 || msgs.length >= 2000 ? ['- 导出范围：仅包含读取上限内的消息，完整会话请在原客户端打开。'] : []),
    '',
    '---',
    '',
  ].join('\n');
  const body = msgs
    .map((m) => `## ${m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具'}\n\n${m.text}\n`)
    .join('\n');
  return head + body;
}
