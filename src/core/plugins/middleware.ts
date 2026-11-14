import type { AuroraStore, PluginRecord } from '../store/index.js';
import type { IRRequest } from '../types.js';
import { Script, createContext } from 'node:vm';

export interface MiddlewareContext {
  agent: string;
  protocol: string;
  requestId: string;
}

export interface MiddlewareResult {
  ir: IRRequest;
  blocked?: { status: number; message: string };
  notes: string[];
}

type Hook = (ir: IRRequest, ctx: MiddlewareContext, options?: any) => IRRequest | void | { block: string };

/** 内置中间件：不写代码也能用的常用能力 */
export const BUILTIN_MIDDLEWARE: Array<{
  id: string;
  name: string;
  description: string;
  defaultOptions: Record<string, unknown>;
  hook: Hook;
}> = [
  {
    id: 'model-map',
    name: '模型别名',
    description: '把客户端请求的模型名映射成别的名字，例如 fast → deepseek/deepseek-chat',
    defaultOptions: { mapping: { fast: 'deepseek/deepseek-chat', smart: 'claude/claude-sonnet-4-5' } },
    hook: (ir, _ctx, options) => {
      const map = (options?.mapping ?? {}) as Record<string, string>;
      if (map[ir.model]) ir.model = map[ir.model];
    },
  },
  {
    id: 'system-prompt',
    name: '统一系统提示',
    description: '给每个请求追加一段系统提示词（团队规范、输出语言等）',
    defaultOptions: { text: '始终使用简体中文回答。' },
    hook: (ir, _ctx, options) => {
      const text = String(options?.text ?? '').trim();
      if (text) ir.system = ir.system ? `${text}\n\n${ir.system}` : text;
    },
  },
  {
    id: 'word-guard',
    name: '敏感词拦截',
    description: '命中词表直接拒绝，或替换成 ***',
    defaultOptions: { words: [], action: 'block' },
    hook: (ir, _ctx, options) => {
      const words = (options?.words ?? []) as string[];
      if (!words.length) return;
      const hay = JSON.stringify(ir.messages);
      const hit = words.find((w) => w && hay.includes(w));
      if (!hit) return;
      if (options?.action === 'mask') {
        const replaced = JSON.stringify(ir.messages).split(hit).join('***');
        ir.messages = JSON.parse(replaced);
        return;
      }
      return { block: `请求包含被拦截的词：${hit}` };
    },
  },
  {
    id: 'param-override',
    name: '参数覆盖',
    description: '强制设置 temperature / maxTokens / reasoning 等字段',
    defaultOptions: { temperature: 0.3 },
    hook: (ir, _ctx, options) => {
      if (typeof options?.temperature === 'number') ir.temperature = options.temperature;
      if (typeof options?.maxTokens === 'number') ir.maxTokens = options.maxTokens;
      if (typeof options?.reasoning === 'string') ir.reasoning = options.reasoning;
    },
  },
  {
    id: 'token-budget',
    name: '上下文裁剪',
    description: '超过上限时丢弃最早的对话轮次，避免因超出窗口被上游拒绝',
    defaultOptions: { maxTokens: 180000 },
    hook: (ir, _ctx, options) => {
      const budget = Number(options?.maxTokens ?? 180000);
      const est = (m: any) => JSON.stringify(m).length / 3.2;
      if (JSON.stringify(ir.messages).length / 3.2 <= budget) return;
      const { messages } = trimMessages(ir.messages, budget, est);
      ir.messages = messages;
    },
  },
];

function trimMessages(messages: any[], budget: number, est: (m: any) => number) {
  if (!Number.isFinite(budget) || budget <= 0) return { messages };
  let total = messages.reduce((a, m) => a + est(m), 0);
  let first = 0;
  // Drop complete user turns, including their tool use/result pairs, and retain the last turn intact.
  while (total > budget) {
    const next = messages.findIndex((m, i) => i > first && m.role === 'user' && !m.blocks?.some((b: any) => b.type === 'tool_result'));
    if (next < 0) break;
    for (let i = first; i < next; i++) total -= est(messages[i]);
    first = next;
  }
  return { messages: messages.slice(first) };
}

/**
 * 应用所有启用的中间件。用户插件是 JS 片段，导出一个
 * `function onRequest(ir, ctx)`；出错不影响主请求（fail-open）。
 */
export function applyMiddleware(
  store: AuroraStore,
  ir: IRRequest,
  ctx: MiddlewareContext,
): MiddlewareResult {
  const notes: string[] = [];
  let current = ir;
  for (const plugin of store.listPlugins()) {
    if (!plugin.enabled) continue;
    try {
      if (plugin.builtin) {
        const def = BUILTIN_MIDDLEWARE.find((b) => b.id === plugin.id);
        if (!def) continue;
        const r = def.hook(current, ctx, plugin.options ?? def.defaultOptions);
        if (r && typeof r === 'object' && 'block' in (r as any)) {
          return { ir: current, blocked: { status: 403, message: (r as any).block }, notes };
        }
        if (r) current = r as IRRequest;
        notes.push(plugin.id);
      } else if (plugin.code) {
        const fn = compilePlugin(plugin);
        if (!fn) continue;
        const r = fn(current, ctx);
        if (r && typeof r === 'object' && 'block' in (r as any)) {
          return { ir: current, blocked: { status: 403, message: (r as any).block }, notes };
        }
        if (r) current = r as IRRequest;
        notes.push(plugin.id);
      }
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '执行失败';
      notes.push(`${plugin.id}: ${message.slice(0, 200)}`);
      // fail-open：插件写坏了也不能把用户请求打死
    }
  }
  return { ir: current, notes };
}

const compiled = new Map<string, Hook>();
function compilePlugin(p: PluginRecord): Hook | null {
  const cached = compiled.get(p.id + ':' + p.updatedAt);
  if (cached) return cached;
  try {
    const script = new Script(
      `"use strict";
       const module = { exports: {} };
       const options = JSON.parse(optionsJson);
       const ir = JSON.parse(irJson);
       const ctx = JSON.parse(ctxJson);
       ${p.code}
       const fn = typeof onRequest === 'function' ? onRequest :
         typeof module.exports === 'function' ? module.exports : module.exports.onRequest;
       if (typeof fn !== 'function') throw new Error('插件缺少 onRequest 函数');
       const result = fn(ir, ctx);
       if (result && typeof result.then === 'function') throw new Error('中间件必须为同步函数');
       JSON.stringify(result || ir);`,
       { filename: `plugin-${p.id}.js` },
    );
    const hook: Hook = (ir, ctx) => {
      const context = createContext({ irJson: JSON.stringify(ir), ctxJson: JSON.stringify(ctx), optionsJson: JSON.stringify(p.options ?? {}) },
        { codeGeneration: { strings: false, wasm: false } });
      return JSON.parse(script.runInContext(context, { timeout: 100 }));
    };
    // This timeout protects against accidental loops; user scripts must still be locally trusted.
    if (compiled.size >= 128) compiled.clear();
    compiled.set(p.id + ':' + p.updatedAt, hook);
    return hook;
  } catch {
    return null;
  }
}

export const SAMPLE_PLUGIN = `// 云桥AI中间件示例：把 <think>...</think> 从请求里剥掉
function onRequest(ir, ctx) {
  for (const m of ir.messages) {
    for (const b of m.blocks) {
      if (b.type === 'text' && b.text && b.text.includes('<think>')) {
        b.text = b.text.replace(/<think>[\\s\\S]*?<\\/think>/g, '').trim();
      }
    }
  }
  return ir;
}`;

