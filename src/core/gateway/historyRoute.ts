/** A history alias carries a fixed supplier/model; it never carries credentials. */
export const CODEX_HISTORY_PREFIX = '/codex-history';
export const CODEX_COEXIST_HISTORY_PREFIX = '/codex-coexist/history';
export interface CodexHistoryTarget { target: string; providerId: string; model: string }
export interface CodexHistoryRoute extends CodexHistoryTarget {
  mode: 'api' | 'coexist';
  endpoint: 'models' | 'responses' | 'compact';
}

function targetParts(target: string): CodexHistoryTarget | null {
  const slash = target.indexOf('/'), providerId = target.slice(0, slash), model = target.slice(slash + 1);
  if (slash < 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(providerId)
    || !model || model.length > 400 || model.trim() !== model || /[\u0000-\u001f\u007f]/.test(model)) return null;
  return { target, providerId, model };
}

export function codexHistoryBasePath(target: string, mode: 'api' | 'coexist' = 'api'): string {
  if (!targetParts(target) || !['api', 'coexist'].includes(mode) || Buffer.from(target, 'utf8').toString('utf8') !== target) throw new Error('历史兼容连接的供应商或模型无效');
  const encoded = Buffer.from(target, 'utf8').toString('base64url');
  if (encoded.length > 3200) throw new Error('历史兼容连接的模型标识过长');
  return `${mode === 'api' ? CODEX_HISTORY_PREFIX : CODEX_COEXIST_HISTORY_PREFIX}/${encoded}/v1`;
}

/** Strict canonical base64url and UTF-8 prevent encoded slashes or alternate spellings. */
export function parseCodexHistoryRoute(pathname: string): CodexHistoryRoute | null {
  const match = /^\/(codex-history|codex-coexist\/history)\/([A-Za-z0-9_-]{1,3200})\/v1\/(models|responses(?:\/compact)?)$/.exec(pathname.split('?')[0]);
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2], 'base64url');
    if (bytes.toString('base64url') !== match[2]) return null;
    const target = new TextDecoder('utf-8', { fatal: true }).decode(bytes), parts = targetParts(target);
    if (!parts || Buffer.from(target, 'utf8').toString('base64url') !== match[2]) return null;
    return { ...parts, mode: match[1] === 'codex-history' ? 'api' : 'coexist',
      endpoint: match[3] === 'responses/compact' ? 'compact' : match[3] as 'models' | 'responses' };
  } catch { return null; }
}
