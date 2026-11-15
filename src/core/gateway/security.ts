import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import type { IncomingMessage } from 'node:http';

export function validGatewayToken(req: IncomingMessage, expected: string): boolean {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const supplied = String(req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? bearer ?? '');
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function allowedHost(req: IncomingMessage, boundHost: string): boolean {
  let host: string;
  try { host = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
  catch { return false; }
  const local = new Set(['localhost', '127.0.0.1', '::1', boundHost.toLowerCase()]);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) local.add(address.address.toLowerCase());
  }
  return local.has(host);
}

export function allowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // CLI and native Capacitor HTTP requests do not send an Origin.
  if (['capacitor://localhost', 'http://localhost', 'https://localhost'].includes(origin)) return true;
  try {
    const u = new URL(origin);
    return ['http:', 'https:'].includes(u.protocol) && u.host === req.headers.host;
  } catch { return false; }
}

/** The gateway is not a remote shell. Native desktop IPC has a separate action boundary. */
export const REMOTE_ACTIONS = new Set([
  'state.get', 'usage.summary', 'usage.recent', 'usage.live', 'sessions.scan', 'sessions.read', 'sessions.resume', 'sessions.export',
  'cloud.catalog', 'update.check', 'gateway.status', 'gateway.url', 'provider.test', 'provider.models', 'provider.balance',
  'provider.resetCooldown', 'provider.save', 'provider.toggle', 'agent.detect', 'agents.detect', 'agent.preview',
  'agent.connect', 'agent.disconnect', 'account.scan', 'codex.diagnose', 'codex.assets', 'codex.flags',
]);

/** Return metadata only; API keys and executable plugin source never leave the host through RPC. */
export function redactRemoteResult(value: any, field = '', credentialEntry = false): any {
  if (field === 'balanceQuery' && value && typeof value === 'object') return { adapter: value.adapter, auth: value.auth };
  if (/^(apiKey|token|accessToken|access_token|refreshToken|refresh_token|gatewayToken|webdavPass|password|passwordHash|code)$/i.test(field)) return '';
  if (field === 'headers') return {};
  if (Array.isArray(value)) return value.map((entry) => redactRemoteResult(entry, '', field === 'apiKeys'));
  if (value && typeof value === 'object') {
    const isCredential = credentialEntry || (typeof value.key === 'string' && typeof value.id === 'string'
      && typeof value.enabled === 'boolean' && ('weight' in value || 'label' in value) && !('baseUrl' in value));
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) out[key] = key === 'key' && isCredential ? '' : redactRemoteResult(item, key);
    if (isCredential && typeof value.key === 'string') out.hasKey = !!value.key;
    return out;
  }
  if (typeof value === 'string' && /proxy|url/i.test(field)) {
    try { const u = new URL(value); u.username = ''; u.password = ''; return u.href; } catch { /* not a URL */ }
  }
  return value;
}
