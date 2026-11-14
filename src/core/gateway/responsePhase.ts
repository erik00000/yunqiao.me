// Ported from CodexPlusPlus MessagePhaseFill, commit 75d25e0. AGPL-3.0-only.
// Preserve native phases; delay only a completed assistant item until its role is known.
const toolTypes = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call']);
export function fillResponsePhases(response: any): any {
  if (response?.status !== 'completed' || !Array.isArray(response.output)) return response;
  const hasTool = response.output.some((item: any) => toolTypes.has(item.type));
  return { ...response, output: response.output.map((item: any, index: number) => item.type === 'message' && item.role === 'assistant' && item.phase == null ? { ...item, phase: !hasTool && index === response.output.length - 1 ? 'final_answer' : 'commentary' } : item) };
}
export class ResponsePhaseStream {
  private buffer = '';
  private pending?: { raw: string; value: any };
  private sawTool = false;
  private passthrough = false;
  private release(phase?: string): string {
    const p = this.pending; this.pending = undefined;
    if (!p) return '';
    if (!phase) return p.raw;
    p.value.item.phase = phase;
    return this.replaceData(p.raw, p.value);
  }
  private replaceData(raw: string, value: any) {
    let inserted = false;
    return raw.split(/\r?\n/).filter(line => !line.startsWith('data:') || !inserted && (inserted = true)).map(line => line.startsWith('data:') ? `data: ${JSON.stringify(value)}` : line).join('\n');
  }
  push(chunk: string): string {
    if (this.passthrough) return chunk;
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) { this.passthrough = true; const raw = this.release() + this.buffer; this.buffer = ''; return raw; }
    let out = '', match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const raw = this.buffer.slice(0, match.index + match[0].length); this.buffer = this.buffer.slice(raw.length);
      let value: any;
      try { value = JSON.parse(raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')); }
      catch {
        // A terminal sentinel is not evidence of successful completion. Flush
        // the original item before it so clients never lose the pending message.
        if (raw.split(/\r?\n/).some(line => /^data:\s*\[DONE\]\s*$/.test(line))) out += this.release();
        out += raw; continue;
      }
      const type = value.type;
      if (type === 'response.created') { out += this.release(); this.sawTool = false; }
      if (['response.output_item.added', 'response.output_item.done'].includes(type) && toolTypes.has(value.item?.type)) this.sawTool = true;
      if (this.pending) {
        if (['response.output_item.added', 'response.output_item.done'].includes(type)) out += this.release('commentary');
        else if (type === 'response.completed') out += this.release(this.sawTool ? 'commentary' : 'final_answer');
        else if (['response.failed', 'response.incomplete', 'error'].includes(type)) out += this.release();
      }
      if (type === 'response.output_item.done' && value.item?.type === 'message' && value.item.role === 'assistant' && value.item.phase == null) this.pending = { raw, value };
      else if (type === 'response.completed' && value.response) out += this.replaceData(raw, { ...value, response: fillResponsePhases(value.response) });
      else out += raw;
    }
    return out;
  }
  end(): string { const remaining = this.release() + this.buffer; this.buffer = ''; return remaining; }
}
