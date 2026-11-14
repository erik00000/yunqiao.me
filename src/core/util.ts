/**
 * 通用工具：id 生成、SSE 解析、token 粗估、上下文裁剪。
 * 零依赖 —— 打包体积小，也不会被原生模块坑到。
 */

export function newId(prefix: string, len = 24): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}${s}`;
}

/** 不同上游对 id 前缀有硬性校验（Codex 要求 ctc_ / fc_） */
export function openaiToolCallId(): string {
  return newId('call_', 24);
}
export function responsesCallId(): string {
  return newId('ctc_', 24);
}
export function msgId(): string {
  return newId('msg_', 24);
}

/** 稳定 hash，用于生成确定性伪 signature（同一段 thinking 每次签名一致） */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * 31) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).padEnd(16, '0');
}

/** Claude Code 会把 signature 原样回传；我们用 base64('aurora:'+hash) 的形态兼容 */
export function fakeSignature(text: string): string {
  const h = stableHash(text);
  return Buffer.from(`aurora:v1:${h}`).toString('base64');
}

export function isFakeSignature(sig?: string): boolean {
  if (!sig) return false;
  try {
    return Buffer.from(sig, 'base64').toString('utf8').startsWith('aurora:v1:');
  } catch {
    return false;
  }
}

/**
 * 粗估 token：中英混排。用于上下文裁剪，不追求精确。
 * 中文按 1.6 字/token，西文按 4 字符/token。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c > 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.6 + other / 4);
}

export function blocksToText(blocks: any[]): string {
  let out = '';
  for (const b of blocks ?? []) {
    if (b?.type === 'text') out += b.text ?? '';
    else if (b?.type === 'tool_result') out += blocksToText(b.content ?? []);
    else if (b?.type === 'tool_use') out += JSON.stringify(b.input ?? {});
    else if (b?.type === 'image') out += '[image]';
  }
  return out;
}

export function safeJsonParse<T = any>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** 增量 SSE 解析器：处理跨 chunk 截断 */
export class SseParser {
  private buf = '';
  push(chunk: string): Array<{ event?: string; data: string }> {
    this.buf += chunk;
    const out: Array<{ event?: string; data: string }> = [];
    let idx: number;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + (this.buf[idx] === '\r' ? 4 : 2));
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) out.push({ event, data: dataLines.join('\n') });
      else if (event) out.push({ event, data: '' });
    }
    return out;
  }
}

/** 上下文裁剪：保留 system + 最近消息，丢弃超出的最老轮次 */
export function trimToWindow(
  messages: any[],
  budgetTokens: number,
  estimate: (m: any) => number,
): { messages: any[]; dropped: number; trimmed: boolean } {
  let total = messages.reduce((a, m) => a + estimate(m), 0);
  if (total <= budgetTokens) return { messages, dropped: 0, trimmed: false };
  const kept: any[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const cost = estimate(m);
    if (total - cost < budgetTokens || kept.length === 0) {
      kept.unshift(m);
      total -= cost;
    } else {
      break;
    }
  }
  // 保证第一条是 user，避免上游 400
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return { messages: kept, dropped: messages.length - kept.length, trimmed: true };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function dayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
