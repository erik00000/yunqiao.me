/**
 * Anthropic Messages 协议（Claude Code / Claude Desktop 说这个）
 *
 * 已知坑位（来自 cc-switch / magpie / Codex++ 的用户 issue）：
 *  - `content[].thinking` 必须回传（DeepSeek 思考模式），否则 400
 *  - thinking 的 signature 由官方签名；只能透传真实签名，不能跨供应商伪造
 *  - 空 content 数组会被上游拒绝
 *  - max_tokens 必填
 */
import type {
  Block,
  IRRequest,
  IRResponse,
  Message,
  StreamEvent,
  ToolChoice,
  ToolDef,
  Usage,
} from '../types.js';
import {
  blocksToText,
  estimateTokens,
  isFakeSignature,
  msgId,
  stableHash,
} from '../util.js';

/* ============================ 入站解析 ============================ */

export function parseAnthropicRequest(body: any): IRRequest {
  const raw = body ?? {};
  const messages: Message[] = [];

  for (const m of raw.messages ?? []) {
    const role: Message['role'] = m.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, blocks: parseAnthropicContent(m.content) });
  }

  const tools: ToolDef[] = (raw.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema ?? { type: 'object', properties: {} },
  }));

  let toolChoice: ToolChoice = { type: 'auto' };
  if (raw.tool_choice?.type === 'any') toolChoice = { type: 'any' };
  else if (raw.tool_choice?.type === 'none') toolChoice = { type: 'none' };
  else if (raw.tool_choice?.type === 'tool' && raw.tool_choice.name)
    toolChoice = { type: 'tool', name: raw.tool_choice.name };

  let system = '';
  if (typeof raw.system === 'string') system = raw.system;
  else if (Array.isArray(raw.system))
    system = raw.system.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');

  return {
    model: raw.model,
    system,
    messages,
    tools,
    toolChoice,
    maxTokens: raw.max_tokens,
    temperature: raw.temperature,
    topP: raw.top_p,
    stop: raw.stop_sequences,
    stream: !!raw.stream,
    reasoning: raw.thinking?.type === 'enabled'
      ? budgetToLevel(raw.thinking.budget_tokens)
      : undefined,
    raw,
    sessionKey:
      raw.metadata?.user_id ??
      (raw.messages?.length ? hashConversationStart(raw.messages) : undefined),
  };
}

function budgetToLevel(budget?: number): 'low' | 'medium' | 'high' {
  if (!budget) return 'medium';
  if (budget <= 2048) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
}

function levelToBudget(level: 'off' | 'low' | 'medium' | 'high'): number {
  return level === 'low' ? 2048 : level === 'medium' ? 8192 : 16384;
}

function hashConversationStart(messages: any[]): string {
  const first = messages[0];
  const text = typeof first?.content === 'string' ? first.content : blocksToText(first?.content ?? []);
  return stableHash(text.slice(0, 400));
}

export function parseAnthropicContent(content: any): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text.length) out.push({ type: 'text', text: b.text });
        break;
      case 'image':
        if (b.source?.type === 'base64')
          out.push({
            type: 'image',
            mediaType: b.source.media_type ?? 'image/png',
            data: b.source.data,
            source: 'base64',
          });
        else if (b.source?.type === 'url')
          out.push({ type: 'image', mediaType: 'image/*', data: b.source.url, source: 'url' });
        break;
      case 'tool_use':
        out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
        break;
      case 'tool_result': {
        const inner =
          typeof b.content === 'string'
            ? ([{ type: 'text', text: b.content }] as Block[])
            : parseAnthropicContent(b.content);
        out.push({
          type: 'tool_result',
          toolUseId: b.tool_use_id,
          content: inner.length ? inner : [{ type: 'text', text: '' }],
          isError: !!b.is_error,
        });
        break;
      }
      case 'thinking':
        out.push({ type: 'thinking', text: b.thinking ?? '', signature: b.signature });
        break;
      case 'redacted_thinking':
        out.push({ type: 'redacted_thinking', data: b.data ?? '' });
        break;
      default:
        break;
    }
  }
  return out;
}

/* ============================ 出站编码 ============================ */

export interface EncodeTargetOptions {
  model: string;
  maxTokens?: number;
  /** 上游是否支援思考 */
  supportThinking?: boolean;
}

export function encodeAnthropicRequest(ir: IRRequest, opt: EncodeTargetOptions): any {
  const messages = ir.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: encodeAnthropicContent(m.blocks, m.role) }))
    .filter((m) => m.content.length > 0);

  const body: any = {
    model: opt.model,
    max_tokens: opt.maxTokens ?? ir.maxTokens ?? 8192,
    messages,
  };
  if (ir.system) body.system = ir.system;
  if (ir.tools.length)
    body.tools = ir.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.parameters ?? { type: 'object', properties: {} },
    }));
  if (ir.tools.length && ir.toolChoice.type !== 'auto') {
    if (ir.toolChoice.type === 'any') body.tool_choice = { type: 'any' };
    else if (ir.toolChoice.type === 'none') body.tool_choice = { type: 'none' };
    else if (ir.toolChoice.type === 'tool')
      body.tool_choice = { type: 'tool', name: ir.toolChoice.name };
  }
  if (typeof ir.temperature === 'number') body.temperature = ir.temperature;
  if (typeof ir.topP === 'number') body.top_p = ir.topP;
  if (ir.stop?.length) body.stop_sequences = ir.stop;
  if (ir.stream) body.stream = true;
  if (ir.reasoning && ir.reasoning !== 'off' && opt.supportThinking !== false) {
    body.thinking = { type: 'enabled', budget_tokens: levelToBudget(ir.reasoning) };
  }
  return body;
}

export function encodeAnthropicContent(blocks: Block[], role: string): any[] {
  const out: any[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        if (b.text) out.push({ type: 'text', text: b.text });
        break;
      case 'image':
        out.push(
          b.source === 'url'
            ? { type: 'image', source: { type: 'url', url: b.data } }
            : {
                type: 'image',
                source: { type: 'base64', media_type: b.mediaType, data: b.data },
              },
        );
        break;
      case 'tool_use':
        out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
        break;
      case 'tool_result':
        out.push({
          type: 'tool_result',
          tool_use_id: b.toolUseId,
          content: b.content.map((x) =>
            x.type === 'text' ? { type: 'text', text: x.text } : { type: 'text', text: '[附件]' },
          ),
          ...(b.isError ? { is_error: true } : {}),
        });
        break;
      case 'thinking':
        // 伪签名（我们自己生成的）不要回传给官方，否则 400 invalid signature
        if (b.text && b.signature && !isFakeSignature(b.signature))
          out.push({ type: 'thinking', thinking: b.text, signature: b.signature });
        break;
      case 'redacted_thinking':
        if (b.data) out.push({ type: 'redacted_thinking', data: b.data });
        break;
      default:
        break;
    }
  }
  // 上游拒绝空 content，包括 assistant 的空轮
  if (!out.length) out.push({ type: 'text', text: role === 'assistant' ? '…' : '(empty)' });
  return out;
}

/* ============================ 响应解码 ============================ */

export function parseAnthropicResponse(json: any): IRResponse {
  const blocks: Block[] = [];
  for (const b of json?.content ?? []) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text ?? '' });
    else if (b.type === 'tool_use')
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
    else if (b.type === 'thinking')
      blocks.push({ type: 'thinking', text: b.thinking ?? '', signature: b.signature });
    else if (b.type === 'redacted_thinking')
      blocks.push({ type: 'redacted_thinking', data: b.data ?? '' });
  }
  const u = json?.usage ?? {};
  return {
    id: json?.id ?? msgId(),
    model: json?.model ?? '',
    blocks,
    stopReason: mapStop(json?.stop_reason),
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}

function mapStop(s?: string): IRResponse['stopReason'] {
  switch (s) {
    case 'max_tokens':
    case 'tool_use':
    case 'stop_sequence':
      return s;
    case 'end_turn':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/* ============================ 流式解码（上游 Anthropic） ============================ */

export class AnthropicStreamDecoder {
  private blockKinds = new Map<number, { type: string; id?: string; name?: string; buf: string }>();
  private started = false;

  push(eventName: string | undefined, data: string): StreamEvent[] {
    if (!data || data === '[DONE]') return [];
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      return [];
    }
    const out: StreamEvent[] = [];
    switch (j.type) {
      case 'message_start':
        out.push({ type: 'start', id: j.message?.id ?? msgId(), model: j.message?.model ?? '' });
        if (j.message?.usage)
          out.push({
            type: 'usage',
            usage: {
              inputTokens: j.message.usage.input_tokens ?? 0,
              cacheReadTokens: j.message.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: j.message.usage.cache_creation_input_tokens ?? 0,
            },
          });
        break;
      case 'content_block_start': {
        const idx = j.index ?? 0;
        const cb = j.content_block ?? {};
        this.blockKinds.set(idx, { type: cb.type, id: cb.id, name: cb.name, buf: '' });
        if (cb.type === 'tool_use')
          out.push({ type: 'tool_start', index: idx, id: cb.id, name: cb.name });
        else if (cb.type === 'thinking' && cb.thinking)
          out.push({ type: 'thinking_delta', index: idx, text: cb.thinking });
        else if (cb.type === 'text' && cb.text)
          out.push({ type: 'text_delta', index: idx, text: cb.text });
        break;
      }
      case 'content_block_delta': {
        const idx = j.index ?? 0;
        const d = j.delta ?? {};
        if (d.type === 'text_delta') out.push({ type: 'text_delta', index: idx, text: d.text ?? '' });
        else if (d.type === 'thinking_delta')
          out.push({ type: 'thinking_delta', index: idx, text: d.thinking ?? '' });
        else if (d.type === 'input_json_delta')
          out.push({ type: 'tool_delta', index: idx, json: d.partial_json ?? '' });
        else if (d.type === 'signature_delta') {
          out.push({ type: 'thinking_delta', index: idx, text: '', signature: d.signature ?? '' });
        }
        break;
      }
      case 'content_block_stop':
        out.push({ type: 'block_stop', index: j.index ?? 0 });
        break;
      case 'message_delta':
        if (j.delta?.stop_reason) out.push({ type: 'stop', stopReason: mapStop(j.delta.stop_reason) });
        if (j.usage)
          out.push({
            type: 'usage',
            usage: { outputTokens: j.usage.output_tokens ?? 0 },
          });
        break;
      case 'message_stop':
        break;
      case 'error':
        out.push({ type: 'error', message: j.error?.message ?? 'upstream error' });
        break;
      default:
        break;
    }
    return out;
  }
}

/* ============================ 流式编码（写给 Anthropic 客户端） ============================ */

export class AnthropicStreamEncoder {
  private nextIndex = 0;
  private open = new Map<number, number>(); // IR index → anthropic index
  private kinds = new Map<number, string>();
  private inputTokens = 0;
  private outputTokens = 0;
  private started = false;
  private stopReason: IRResponse['stopReason'] = 'end_turn';
  private thinkingBuf = new Map<number, string>();

  constructor(private ctx: { requestId: string; model: string; clientModel: string; preserveThinking?: boolean }) {}

  private ev(name: string, obj: any): string {
    return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
  }

  push(e: StreamEvent): string {
    switch (e.type) {
      case 'start':
        if (this.started) return '';
        this.started = true;
        return this.ev('message_start', {
          type: 'message_start',
          message: {
            id: e.id || this.ctx.requestId,
            type: 'message',
            role: 'assistant',
            model: this.ctx.clientModel || this.ctx.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 1 },
          },
        });
      case 'text_delta': {
        let out = '';
        if (!this.open.has(e.index)) out += this.openBlock(e.index, 'text');
        out += this.ev('content_block_delta', {
          type: 'content_block_delta',
          index: this.open.get(e.index)!,
          delta: { type: 'text_delta', text: e.text },
        });
        return out;
      }
      case 'thinking_delta': {
        if (!this.ctx.preserveThinking) return '';
        let out = '';
        if (!this.open.has(e.index)) out += this.openBlock(e.index, 'thinking');
        if (e.signature) return out + this.ev('content_block_delta', {
          type: 'content_block_delta', index: this.open.get(e.index)!, delta: { type: 'signature_delta', signature: e.signature },
        });
        out += this.ev('content_block_delta', {
          type: 'content_block_delta',
          index: this.open.get(e.index)!,
          delta: { type: 'thinking_delta', thinking: e.text },
        });
        return out;
      }
      case 'tool_start': {
        let out = '';
        if (!this.open.has(e.index)) out += this.openBlock(e.index, 'tool_use', e.id, e.name);
        return out;
      }
      case 'tool_delta':
        if (!this.open.has(e.index)) return '';
        return this.ev('content_block_delta', {
          type: 'content_block_delta',
          index: this.open.get(e.index)!,
          delta: { type: 'input_json_delta', partial_json: e.json },
        });
      case 'block_stop': {
        if (!this.open.has(e.index)) return '';
        let out = '';
        out += this.ev('content_block_stop', {
          type: 'content_block_stop',
          index: this.open.get(e.index)!,
        });
        this.open.delete(e.index);
        return out;
      }
      case 'usage':
        if (e.usage.inputTokens) this.inputTokens = e.usage.inputTokens;
        if (e.usage.outputTokens) this.outputTokens = e.usage.outputTokens;
        return '';
      case 'stop':
        this.stopReason = e.stopReason;
        return '';
      case 'error':
        return this.ev('error', { type: 'error', error: { type: 'api_error', message: e.message } });
      default:
        return '';
    }
  }

  private openBlock(index: number, kind: string, id?: string, name?: string): string {
    const ai = this.nextIndex++;
    this.open.set(index, ai);
    this.kinds.set(index, kind);
    const content_block =
      kind === 'tool_use'
        ? { type: 'tool_use', id: id ?? `toolu_${ai}`, name: name ?? 'tool', input: {} }
        : kind === 'thinking'
          ? { type: 'thinking', thinking: '' }
          : { type: 'text', text: '' };
    return this.ev('content_block_start', { type: 'content_block_start', index: ai, content_block });
  }

  end(): string {
    let out = '';
    // 关闭所有仍然打开的块
    for (const [irIdx, ai] of this.open) {
      out += this.ev('content_block_stop', { type: 'content_block_stop', index: ai });
    }
    this.open.clear();
    if (!this.started) out += this.push({ type: 'start', id: this.ctx.requestId, model: this.ctx.model });
    out += this.ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens || 1 },
    });
    out += this.ev('message_stop', { type: 'message_stop' });
    return out;
  }
}

export function anthropicUsage(json: any): Usage {
  return {
    inputTokens: json?.input_tokens ?? 0,
    outputTokens: json?.output_tokens ?? 0,
  };
}

export function anthropicPromptFromIR(ir: IRRequest): number {
  return estimateTokens(ir.system + ir.messages.map((m) => blocksToText(m.blocks)).join(''));
}
