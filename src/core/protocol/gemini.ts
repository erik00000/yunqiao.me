/**
 * Gemini 原生协议（Gemini CLI / Antigravity 说这个）
 */
import type { Block, IRRequest, IRResponse, Message, StreamEvent, ToolChoice } from '../types.js';
import { blocksToText, msgId, stableHash } from '../util.js';

export function parseGeminiRequest(body: any): IRRequest {
  const raw = body ?? {};
  const messages: Message[] = [];
  const nameById = new Map<string, string>();

  for (const c of raw.contents ?? []) {
    const role: Message['role'] = c.role === 'model' ? 'assistant' : 'user';
    const blocks: Block[] = [];
    for (const p of c.parts ?? []) {
      if (typeof p.text === 'string') {
        if (p.text) blocks.push({ type: 'text', text: p.text });
      } else if (p.inlineData)
        blocks.push({
          type: 'image',
          mediaType: p.inlineData.mimeType ?? 'image/png',
          data: p.inlineData.data,
          source: 'base64',
        });
      else if (p.functionCall) {
        const id = p.functionCall.id ?? `gem_${stableHash(p.functionCall.name + blocks.length)}`;
        nameById.set(id, p.functionCall.name);
        blocks.push({
          type: 'tool_use',
          id,
          name: p.functionCall.name,
          input: p.functionCall.args ?? {},
        });
      } else if (p.functionResponse) {
        blocks.push({
          type: 'tool_result',
          toolUseId:
            p.functionResponse.id ??
            [...nameById.entries()].find(([, n]) => n === p.functionResponse.name)?.[0] ??
            p.functionResponse.name,
          content: [{ type: 'text', text: JSON.stringify(p.functionResponse.response ?? {}) }],
        });
      }
    }
    if (blocks.length) messages.push({ role, blocks });
  }

  const decls = (raw.tools ?? []).flatMap((t: any) => t.functionDeclarations ?? []);
  const tools = decls.map((d: any) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters ?? { type: 'object', properties: {} },
  }));

  let toolChoice: ToolChoice = { type: 'auto' };
  const mode = raw.toolConfig?.functionCallingConfig?.mode;
  if (mode === 'ANY') {
    const allowed = raw.toolConfig.functionCallingConfig.allowedFunctionNames?.[0];
    toolChoice = allowed ? { type: 'tool', name: allowed } : { type: 'any' };
  } else if (mode === 'NONE') toolChoice = { type: 'none' };

  const sysParts = raw.systemInstruction?.parts ?? raw.system_instruction?.parts ?? [];

  return {
    model: raw.model,
    system: sysParts.map((p: any) => p.text ?? '').join('\n'),
    messages,
    tools,
    toolChoice,
    maxTokens: raw.generationConfig?.maxOutputTokens,
    temperature: raw.generationConfig?.temperature,
    topP: raw.generationConfig?.topP,
    stop: raw.generationConfig?.stopSequences,
    stream: !!raw.stream,
    reasoning: raw.generationConfig?.thinkingConfig?.thinkingBudget
      ? raw.generationConfig.thinkingConfig.thinkingBudget > 8192
        ? 'high'
        : 'medium'
      : undefined,
    raw,
    sessionKey: hashFirst(messages),
  };
}

function hashFirst(messages: Message[]): string | undefined {
  const first = messages.find((m) => m.role === 'user');
  return first ? stableHash(blocksToText(first.blocks).slice(0, 400)) : undefined;
}

export function encodeGeminiRequest(ir: IRRequest, opt: { model: string; maxTokens?: number }): any {
  const contents: any[] = [];
  const nameById = new Map<string, string>();

  // 先扫一遍，拿到 tool id → name 映射
  for (const m of ir.messages)
    for (const b of m.blocks) if (b.type === 'tool_use') nameById.set(b.id, b.name);

  for (const m of ir.messages) {
    const parts: any[] = [];
    for (const b of m.blocks) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'image')
        parts.push(
          b.source === 'base64'
            ? { inlineData: { mimeType: b.mediaType, data: b.data } }
            : { fileData: { mimeType: b.mediaType, fileUri: b.data } },
        );
      else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
      else if (b.type === 'tool_result')
        parts.push({
          functionResponse: {
            name: nameById.get(b.toolUseId) ?? 'tool',
            response: { result: blocksToText(b.content) },
          },
        });
      else if (b.type === 'thinking' && b.text) parts.push({ text: b.text });
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }

  const body: any = { contents };
  if (ir.system) body.systemInstruction = { parts: [{ text: ir.system }] };
  if (ir.tools.length)
    body.tools = [
      {
        functionDeclarations: ir.tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          parameters: sanitizeGeminiSchema(t.parameters),
        })),
      },
    ];
  if (ir.tools.length && ir.toolChoice.type !== 'auto')
    body.toolConfig = {
      functionCallingConfig: {
        mode: ir.toolChoice.type === 'none' ? 'NONE' : ir.toolChoice.type === 'tool' || ir.toolChoice.type === 'any' ? 'ANY' : 'AUTO',
        ...(ir.toolChoice.type === 'tool' ? { allowedFunctionNames: [ir.toolChoice.name] } : {}),
      },
    };
  const gen: any = {};
  if (typeof ir.temperature === 'number') gen.temperature = ir.temperature;
  if (typeof ir.topP === 'number') gen.topP = ir.topP;
  const max = opt.maxTokens ?? ir.maxTokens;
  if (max) gen.maxOutputTokens = max;
  if (ir.stop?.length) gen.stopSequences = ir.stop;
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

/** Gemini 的 schema 不接受 $schema / additionalProperties */
function sanitizeGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const { $schema, additionalProperties, ...rest } = schema;
  if (rest.properties) {
    rest.properties = Object.fromEntries(
      Object.entries(rest.properties).map(([k, v]) => [k, sanitizeGeminiSchema(v)]),
    );
  }
  if (rest.items) rest.items = sanitizeGeminiSchema(rest.items);
  return rest;
}

export function parseGeminiResponse(json: any): IRResponse {
  const cand = json?.candidates?.[0] ?? {};
  const blocks: Block[] = [];
  for (const p of cand.content?.parts ?? []) {
    if (typeof p.text === 'string' && p.text) blocks.push({ type: 'text', text: p.text });
    else if (p.functionCall)
      blocks.push({
        type: 'tool_use',
        id: `gem_${stableHash(p.functionCall.name ?? 'f')}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
  }
  const u = json?.usageMetadata ?? {};
  return {
    id: json?.responseId ?? msgId(),
    model: json?.modelVersion ?? '',
    blocks,
    stopReason: blocks.some((b) => b.type === 'tool_use')
      ? 'tool_use'
      : cand.finishReason === 'MAX_TOKENS'
        ? 'max_tokens'
        : 'end_turn',
    usage: {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: u.candidatesTokenCount ?? 0,
      cacheReadTokens: u.cachedContentTokenCount ?? 0,
      reasoningTokens: u.thoughtsTokenCount ?? 0,
    },
  };
}

export class GeminiStreamDecoder {
  private started = false;
  private textIdx = 1;
  private toolIdx = 2;
  private sentTool = false;

  push(_e: string | undefined, data: string): StreamEvent[] {
    if (!data || data === '[DONE]') return [];
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      return [];
    }
    const out: StreamEvent[] = [];
    if (j.error) return [{ type: 'error', message: j.error.message ?? '上游返回流式错误' }];
    if (!this.started) {
      this.started = true;
      out.push({ type: 'start', id: j.responseId ?? msgId(), model: j.modelVersion ?? '' });
    }
    const cand = j.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) {
      if (typeof p.text === 'string' && p.text) out.push({ type: p.thought ? 'thinking_delta' : 'text_delta', index: p.thought ? 0 : this.textIdx, text: p.text });
      else if (p.functionCall) {
        const idx = this.toolIdx++;
        out.push({
          type: 'tool_start',
          index: idx,
          id: p.functionCall.id ?? `gem_${stableHash(p.functionCall.name ?? 'f')}_${idx}`,
          name: p.functionCall.name,
        });
        out.push({ type: 'tool_delta', index: idx, json: JSON.stringify(p.functionCall.args ?? {}) });
        this.sentTool = true;
      }
    }
    if (j.usageMetadata)
      out.push({
        type: 'usage',
        usage: {
          inputTokens: j.usageMetadata.promptTokenCount ?? 0,
          outputTokens: j.usageMetadata.candidatesTokenCount ?? 0,
        },
      });
    if (cand?.finishReason) {
      const r = cand.finishReason;
      out.push({
        type: 'stop',
        stopReason:
          r === 'MAX_TOKENS' ? 'max_tokens' : this.sentTool ? 'tool_use' : 'end_turn',
      });
    }
    return out;
  }
}

export class GeminiStreamEncoder {
  private toolParts = new Map<number, { id: string; name: string; json: string }>();
  private usage: any = null;
  private finish = 'STOP';
  private completed = false;

  constructor(private ctx: { requestId: string; model: string; clientModel: string }) {}

  push(e: StreamEvent): string {
    switch (e.type) {
      case 'text_delta':
        return this.emit([{ text: e.text }]);
      case 'thinking_delta':
        return e.text ? this.emit([{ text: e.text, thought: true }]) : '';
      case 'tool_start':
        this.toolParts.set(e.index, { id: e.id, name: e.name, json: '' });
        return '';
      case 'tool_delta': {
        const tool = this.toolParts.get(e.index);
        if (tool) tool.json += e.json;
        return '';
      }
      case 'usage':
        this.usage = {
          promptTokenCount: e.usage.inputTokens ?? this.usage?.promptTokenCount ?? 0,
          candidatesTokenCount: e.usage.outputTokens ?? this.usage?.candidatesTokenCount ?? 0,
          cachedContentTokenCount: e.usage.cacheReadTokens ?? this.usage?.cachedContentTokenCount ?? 0,
        };
        return '';
      case 'stop':
        this.finish = e.stopReason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP';
        return '';
      case 'error':
        this.completed = true;
        return `data: ${JSON.stringify({ error: { code: 502, message: e.message, status: 'INTERNAL' } })}\n\n`;
      default:
        return '';
    }
  }

  private emit(parts: any[]): string {
    const payload: any = {
      candidates: [{ content: { role: 'model', parts }, index: 0 }],
      ...(this.usage ? { usageMetadata: this.usage } : {}),
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  end(): string {
    if (this.completed) return '';
    this.completed = true;
    let out = '';
    const parts: any[] = [];
    for (const tool of this.toolParts.values()) {
      try { parts.push({ functionCall: { id: tool.id, name: tool.name, args: JSON.parse(tool.json || '{}') } }); }
      catch { return `data: ${JSON.stringify({ error: { code: 502, message: '上游返回了不完整的工具参数', status: 'INTERNAL' } })}\n\n`; }
    }
    out += `data: ${JSON.stringify({
      candidates: [
        {
          content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
          finishReason: this.finish,
          index: 0,
        },
      ],
      ...(this.usage ? { usageMetadata: this.usage } : {}),
    })}\n\n`;
    return out;
  }
}

export function buildGeminiResponse(res: IRResponse): any {
  const parts: any[] = [];
  for (const b of res.blocks) {
    if (b.type === 'text') parts.push({ text: b.text });
    else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
  }
  return {
    candidates: [
      {
        content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
        finishReason: res.stopReason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: res.usage.inputTokens,
      candidatesTokenCount: res.usage.outputTokens,
      totalTokenCount: res.usage.inputTokens + res.usage.outputTokens,
    },
  };
}
