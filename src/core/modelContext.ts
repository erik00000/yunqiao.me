/** A configurable recommendation for unidentified text-model limits, not verified provider capacity. */
export const DEFAULT_CHATGPT_CONTEXT_WINDOW = 272000;

/** Match explicit GPT/Codex text IDs only; protocol compatibility alone says nothing about model family. */
export function isChatgptTextModel(id: string): boolean {
  if (typeof id !== 'string') return false;
  const name = id.toLowerCase().replace(/^(?:openai|official)\//, '');
  if (!/^(?:(?:gpt|chatgpt)-\d|codex(?:-(?:mini|latest)(?:[-_.]|$)|$))/.test(name)) return false;
  if (/(?:^|[-_.])(image|audio|realtime|tts|transcribe|transcription|embedding|embeddings|whisper|speech|moderation|classifier|safety)(?:[-_.]|$)/.test(name)) return false;
  return !/^codex-(?:auto-review|review|classifier|safety)(?:[-_.]|$)/.test(name) && !/[\s/]/.test(name);
}

export function isValidContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Default trigger is 90% of the configured window, rounded down to a positive token count. */
export function defaultAutoCompactTokenLimit(contextWindow: unknown): number | undefined {
  if (!isValidContextWindow(contextWindow)) return undefined;
  // Integer arithmetic keeps the policy exact even at the safe-integer boundary.
  return Math.max(1, Number(BigInt(contextWindow) * 9n / 10n));
}

/** Pure: preserve explicit values; callers validate input before saving. No default is persisted on reads. */
export function applyContextDefaults<T extends { id: string; contextWindow?: number }>(model: T): T {
  return model.contextWindow === undefined && isChatgptTextModel(model.id)
    ? { ...model, contextWindow: DEFAULT_CHATGPT_CONTEXT_WINDOW }
    : model;
}
