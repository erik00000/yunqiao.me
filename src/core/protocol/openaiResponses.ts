/**
 * OpenAI Responses API —— Codex CLI / Codex 桌面版的 API 协议。
 *
 * 协议约束：
 *  - message / function_call 使用对应类型的独立 item.id，关联工具结果使用 call_id
 *  - `reasoning` 项必须带 encrypted_content 或 summary，否则部分上游 400
 *  - function_call_output 必须用 call_id 关联，不能用 item id
 */
import type { Block, IRRequest, IRResponse, Message, StreamEvent, ToolChoice } from '../types.js';
import { blocksToText, msgId, responsesCallId, stableHash, newId } from '../util.js';

/* ============================ 入站解析 ============================ */

export function parseResponsesRequest(body: any): IRRequest {
  const raw = body ?? {};
  const messages: Message[] = [];
  const input = raw.input;
  const pendingAssistant: Block[] = [];
  const flushAssistant = () => {
    if (pendingAssistant.length) {
      messages.push({ role: 'assistant', blocks: pendingAssistant.splice(0) });
    }
  };

  if (typeof input === 'string') {
    if (input.trim()) messages.push({ role: 'user', blocks: [{ type: 'text', text: input }] });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (item.type === 'message' || item.role) {
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        const blocks = responsesContentToBlocks(item.content);
        if (role === 'assistant') {
          flushAssistant();
          messages.push({ role, blocks });
        } else {
          flushAssistant();
          messages.push({ role, blocks });
        }
        continue;
      }
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        pendingAssistant.push({
          type: 'tool_use',
          id: item.call_id ?? item.id ?? responsesCallId(),
          name: item.name ?? 'tool',
          input: safeParse(item.arguments ?? item.input),
        });
        continue;
      }
      if (item.type === 'reasoning') {
        const text = (item.summary ?? []).map((s: any) => s.text ?? '').join('\n');
        if (text) pendingAssistant.push({ type: 'thinking', text });
        continue;
      }
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        flushAssistant();
        messages.push({
          role: 'user',
          blocks: [
            {
              type: 'tool_result',
              toolUseId: item.call_id ?? item.id ?? '',
              content: [{ type: 'text', text: outputToText(item.output) }],
            },
          ],
        });
        continue;
      }
    }
  }
  flushAssistant();

  const tools = (raw.tools ?? [])
    .filter((t: any) => t.type === 'function' || t.name)
    .map((t: any) => ({
      name: t.name ?? t.function?.name,
      description: t.description ?? t.function?.description,
      parameters: t.parameters ?? t.function?.parameters ?? { type: 'object', properties: {} },
    }));

  let toolChoice: ToolChoice = { type: 'auto' };
  if (raw.tool_choice === 'none') toolChoice = { type: 'none' };
  else if (raw.tool_choice === 'required') toolChoice = { type: 'any' };
  else if (raw.tool_choice?.name) toolChoice = { type: 'tool', name: raw.tool_choice.name };

  return {
    model: raw.model,
    system: typeof raw.instructions === 'string' ? raw.instructions : '',
    messages,
    tools,
    toolChoice,
    maxTokens: raw.max_output_tokens,
    temperature: raw.temperature,
    topP: raw.top_p,
    stream: !!raw.stream,
    reasoning: raw.reasoning?.effort ?? undefined,
    raw,
    sessionKey: raw.prompt_cache_key ?? hashFirst(messages),
  };
}

function hashFirst(messages: Message[]): string | undefined {
  const first = messages.find((m) => m.role === 'user');
  return first ? stableHash(blocksToText(first.blocks).slice(0, 400)) : undefined;
}

function outputToText(output: any): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output))
    return output.map((o: any) => o?.text ?? o?.content ?? JSON.stringify(o)).join('\n');
  if (output == null) return '';
  return JSON.stringify(output);
}

function responsesContentToBlocks(content: any): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const p of content) {
    if (typeof p === 'string') out.push({ type: 'text', text: p });
    else if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text')
      out.push({ type: 'text', text: p.text ?? '' });
    else if (p.type === 'input_image') {
      const url: string = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url ?? '';
      if (url.startsWith('data:')) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(url);
        if (m) out.push({ type: 'image', mediaType: m[1], data: m[2], source: 'base64' });
      } else if (url) out.push({ type: 'image', mediaType: 'image/*', data: url, source: 'url' });
    }
  }
  return out;
}

function safeParse(s: any): unknown {
  if (typeof s !== 'string') return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

/* ============================ 出站编码 ============================ */

export function encodeResponsesRequest(
  ir: IRRequest,
  opt: { model: string; maxTokens?: number; supportReasoning?: boolean },
): any {
  const input: any[] = [];
  for (const m of ir.messages) {
    if (m.role === 'assistant') {
      for (const b of m.blocks) {
        if (b.type === 'text')
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: b.text }],
          });
        else if (b.type === 'tool_use')
          input.push({
            type: 'function_call',
            id: newId('fc_', 24),
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
        else if (b.type === 'thinking')
          input.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: b.text }] });
      }
      continue;
    }
    const toolOutputs: any[] = [];
    const content: any[] = [];
    for (const b of m.blocks) {
      if (b.type === 'tool_result')
        toolOutputs.push({ type: 'function_call_output', call_id: b.toolUseId, output: blocksToText(b.content) });
      else if (b.type === 'text') content.push({ type: 'input_text', text: b.text });
      else if (b.type === 'image')
        content.push({
          type: 'input_image',
          image_url: b.source === 'url' ? b.data : `data:${b.mediaType};base64,${b.data}`,
        });
    }
    input.push(...toolOutputs);
    if (content.length) input.push({ type: 'message', role: 'user', content });
  }

  const body: any = {
    model: opt.model,
    input,
    stream: ir.stream,
    store: false,
  };
  if (ir.system) body.instructions = ir.system;
  if (ir.tools.length)
    body.tools = ir.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
      strict: false,
    }));
  if (ir.toolChoice.type === 'none') body.tool_choice = 'none';
  else if (ir.toolChoice.type === 'any') body.tool_choice = 'required';
  else if (ir.toolChoice.type === 'tool') body.tool_choice = { type: 'function', name: ir.toolChoice.name };
  if (typeof ir.temperature === 'number') body.temperature = ir.temperature;
  if (typeof ir.topP === 'number') body.top_p = ir.topP;
  const max = opt.maxTokens ?? ir.maxTokens;
  if (max) body.max_output_tokens = max;
  if (ir.reasoning && ir.reasoning !== 'off' && opt.supportReasoning !== false)
    body.reasoning = { effort: ir.reasoning, summary: 'auto' };
  if (ir.sessionKey) body.prompt_cache_key = ir.sessionKey;
  return body;
}

/* ============================ 响应解码 ============================ */

export function parseResponsesResponse(json: any): IRResponse {
  const blocks: Block[] = [];
  for (const item of json?.output ?? []) {
    if (item.type === 'message') {
      const text = (item.content ?? [])
        .map((c: any) => (c.type === 'output_text' ? c.text : ''))
        .join('');
      if (text) blocks.push({ type: 'text', text });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      blocks.push({
        type: 'tool_use',
        id: item.call_id ?? item.id,
        name: item.name,
        input: safeParse(item.arguments),
      });
    } else if (item.type === 'reasoning') {
      const text = (item.summary ?? []).map((s: any) => s.text ?? '').join('\n');
      if (text) blocks.push({ type: 'thinking', text });
    }
  }
  const u = json?.usage ?? {};
  return {
    id: json?.id ?? msgId(),
    model: json?.model ?? '',
    blocks,
    stopReason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.input_tokens_details?.cached_tokens,
      reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

/* ============================ 流式解码 ============================ */

export class ResponsesStreamDecoder {
  private started = false;
  private itemToIndex = new Map<string, number>();
  private nextIndex = 0;
  private textIndex: number | null = null;
  private hasTools = false;

  push(_event: string | undefined, data: string): StreamEvent[] {
    if (!data || data === '[DONE]') return [];
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      return [];
    }
    const out: StreamEvent[] = [];
    const t: string = j.type ?? '';
    if (!this.started && (t === 'response.created' || t === 'response.in_progress')) {
      this.started = true;
      out.push({ type: 'start', id: j.response?.id ?? msgId(), model: j.response?.model ?? '' });
      return out;
    }
    switch (t) {
      case 'response.output_item.added': {
        const item = j.item ?? {};
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          this.hasTools = true;
          const idx = this.nextIndex++;
          this.itemToIndex.set(item.id ?? item.call_id ?? String(idx), idx);
          out.push({
            type: 'tool_start',
            index: idx,
            id: item.call_id ?? item.id ?? responsesCallId(),
            name: item.name ?? 'tool',
          });
        } else if (item.type === 'message') {
          this.textIndex = this.textIndex ?? this.nextIndex++;
        }
        break;
      }
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta': {
        const key = j.item_id ?? '';
        const idx = this.itemToIndex.get(key);
        if (idx != null) out.push({ type: 'tool_delta', index: idx, json: j.delta ?? '' });
        break;
      }
      case 'response.output_text.delta': {
        const idx = this.textIndex ?? (this.textIndex = this.nextIndex++);
        out.push({ type: 'text_delta', index: idx, text: j.delta ?? '' });
        break;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const idx = 900;
        out.push({ type: 'thinking_delta', index: idx, text: j.delta ?? '' });
        break;
      }
      case 'response.completed': {
        const r = j.response ?? {};
        if (r.usage)
          out.push({
            type: 'usage',
            usage: {
              inputTokens: r.usage.input_tokens ?? 0,
              outputTokens: r.usage.output_tokens ?? 0,
              cacheReadTokens: r.usage.input_tokens_details?.cached_tokens,
            },
          });
        out.push({ type: 'stop', stopReason: this.hasTools ? 'tool_use' : 'end_turn' });
        break;
      }
      case 'response.incomplete':
        out.push({ type: 'stop', stopReason: 'max_tokens' });
        break;
      case 'response.failed':
      case 'error':
        out.push({ type: 'error', message: j.response?.error?.message ?? j.message ?? 'upstream failed' });
        break;
      default:
        break;
    }
    return out;
  }
}

/* ============================ 流式编码（写给 Codex） ============================ */

export class ResponsesStreamEncoder {
  private seq = 0;
  private createdAt = Math.floor(Date.now() / 1000);
  private output: any[] = [];
  private itemByIndex = new Map<number, { id: string; outputIndex: number; kind: 'text' | 'tool'; buf: string }>();
  private nextOutputIndex = 0;
  private textItem: { id: string; outputIndex: number; buf: string } | null = null;
  private completed = false;
  private started = false;
  private incomplete = false;
  private usage: any = null;

  constructor(private ctx: { requestId: string; model: string; clientModel: string }) {}

  private ev(obj: any): string {
    this.seq++;
    return `event: ${obj.type}\ndata: ${JSON.stringify({ ...obj, sequence_number: this.seq })}\n\n`;
  }

  private responseObject(status: string): any {
    return {
      id: this.ctx.requestId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.ctx.clientModel || this.ctx.model,
      output: this.output,
      parallel_tool_calls: true,
      tool_choice: 'auto',
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  push(e: StreamEvent): string {
    switch (e.type) {
      case 'start':
        if (this.started) return '';
        this.started = true;
        return (
          this.ev({ type: 'response.created', response: this.responseObject('in_progress') }) +
          this.ev({ type: 'response.in_progress', response: this.responseObject('in_progress') })
        );
      case 'text_delta': {
        let out = '';
        if (!this.textItem) {
          const item = {
            id: msgId(),
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
            outputIndex: this.nextOutputIndex++,
            buf: '',
          };
          this.textItem = item;
          this.output.push(item);
          out += this.ev({
            type: 'response.output_item.added',
            output_index: item.outputIndex,
            item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          });
          out += this.ev({
            type: 'response.content_part.added',
            item_id: item.id,
            output_index: item.outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
        }
        this.textItem.buf += e.text;
        out += this.ev({
          type: 'response.output_text.delta',
          item_id: this.textItem.id,
          output_index: this.textItem.outputIndex,
          content_index: 0,
          delta: e.text,
          logprobs: [],
        });
        return out;
      }
      case 'tool_start': {
        const item = {
          id: newId('fc_', 24),
          outputIndex: this.nextOutputIndex++,
          kind: 'tool' as const,
          buf: '',
          callId: e.id,
          name: e.name,
        };
        this.itemByIndex.set(e.index, {
          id: item.id,
          outputIndex: item.outputIndex,
          kind: 'tool',
          buf: '',
        });
        this.output.push({ ...item, type: 'function_call' });
        return this.ev({
          type: 'response.output_item.added',
          output_index: item.outputIndex,
          item: {
            id: item.id,
            type: 'function_call',
            status: 'in_progress',
            call_id: item.callId,
            name: item.name,
            arguments: '',
          },
        });
      }
      case 'tool_delta': {
        const rec = this.itemByIndex.get(e.index);
        if (!rec) return '';
        rec.buf += e.json;
        return this.ev({
          type: 'response.function_call_arguments.delta',
          item_id: rec.id,
          output_index: rec.outputIndex,
          delta: e.json,
        });
      }
      case 'thinking_delta':
        // Foreign reasoning is not an OpenAI encrypted reasoning item; native streams bypass this encoder.
        return '';
      case 'usage':
        this.usage = {
          input_tokens: e.usage.inputTokens ?? this.usage?.input_tokens ?? 0,
          output_tokens: e.usage.outputTokens ?? this.usage?.output_tokens ?? 0,
          input_tokens_details: { cached_tokens: e.usage.cacheReadTokens ?? this.usage?.input_tokens_details?.cached_tokens ?? 0 },
        };
        this.usage.total_tokens = this.usage.input_tokens + this.usage.output_tokens;
        return '';
      case 'stop':
        this.incomplete = e.stopReason === 'max_tokens';
        return '';
      case 'error':
        this.completed = true;
        return this.ev({ type: 'response.failed', response: { ...this.responseObject('failed'), error: { code: e.code || 'upstream_error', message: e.message } } });
      default:
        return '';
    }
  }

  end(): string {
    if (this.completed) return '';
    this.completed = true;
    let out = '';
    if (this.textItem) {
      const finalItem = {
        id: this.textItem.id,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.textItem.buf, annotations: [] }],
      };
      out += this.ev({
        type: 'response.output_text.done',
        item_id: this.textItem.id,
        output_index: this.textItem.outputIndex,
        content_index: 0,
        text: this.textItem.buf,
      });
      out += this.ev({
        type: 'response.content_part.done',
        item_id: this.textItem.id,
        output_index: this.textItem.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: this.textItem.buf, annotations: [] },
      });
      out += this.ev({ type: 'response.output_item.done', output_index: this.textItem.outputIndex, item: finalItem });
      this.output[this.textItem.outputIndex] = finalItem;
    }
    for (const [, rec] of this.itemByIndex) {
      const original = this.output[rec.outputIndex];
      const finalItem = { id: rec.id, type: 'function_call', status: 'completed', call_id: original.callId, name: original.name, arguments: rec.buf };
      out += this.ev({
        type: 'response.function_call_arguments.done',
        item_id: rec.id,
        output_index: rec.outputIndex,
        arguments: rec.buf,
      });
      out += this.ev({
        type: 'response.output_item.done',
        output_index: rec.outputIndex,
        item: finalItem,
      });
      this.output[rec.outputIndex] = finalItem;
    }
    if (!this.textItem && this.itemByIndex.size === 0) {
      const item = { id: msgId(), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] };
      this.output.push(item);
      out += this.ev({ type: 'response.output_item.added', output_index: 0, item });
      out += this.ev({ type: 'response.output_item.done', output_index: 0, item });
    }
    out += this.ev({ type: this.incomplete ? 'response.incomplete' : 'response.completed',
      response: { ...this.responseObject(this.incomplete ? 'incomplete' : 'completed'),
        ...(this.incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) } });
    return out;
  }
}

export function buildResponsesResponse(
  res: IRResponse,
  ctx: { requestId: string; model: string; clientModel: string },
): any {
  const output: any[] = [];
  for (const b of res.blocks) {
    if (b.type === 'text')
      output.push({
        id: msgId(),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: b.text, annotations: [] }],
      });
    else if (b.type === 'tool_use')
      output.push({
        id: newId('fc_', 24),
        type: 'function_call',
        status: 'completed',
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      });
  }
  return {
    id: ctx.requestId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: res.stopReason === 'max_tokens' ? 'incomplete' : 'completed',
    ...(res.stopReason === 'max_tokens' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    model: ctx.clientModel || ctx.model,
    output,
    usage: {
      input_tokens: res.usage.inputTokens,
      output_tokens: res.usage.outputTokens,
      total_tokens: res.usage.inputTokens + res.usage.outputTokens,
    },
  };
}
