import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import type { AuroraStore, Provider } from './store/index.js';
import { newId, nowIso } from './util.js';

/**
 * 云端目录 + 更新检查 + 官方账号导入。
 * 这里所有网络请求都用原生 http(s)，不引第三方库。
 */

export interface CloudProvider {
  key: string;
  name: string;
  vendor?: string;
  format: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
  baseUrl: string;
  region?: string;
  color?: string;
  icon?: string;
  docs?: string;
  note?: string;
  tags?: string[];
  official?: boolean;
  sort?: number;
  models?: Array<{
    id: string;
    contextWindow?: number;
    inputPrice?: number;
    outputPrice?: number;
    capabilities?: { tools?: boolean; vision?: boolean; thinking?: boolean };
  }>;
}

export interface CloudCatalog {
  version: number;
  updatedAt: string;
  providers: CloudProvider[];
  source?: 'remote' | 'cache';
  fetchedAt?: string;
  warning?: string;
}

function webUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error(`${label}格式不正确`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label}格式不正确`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${label}仅支持不含密码的 HTTP / HTTPS 地址`);
  }
  return url.href.replace(/\/$/, '');
}

function getJson<T = any>(urlStr: string, timeoutMs = 12000, headers: Record<string, string> = {}, redirects = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(webUrl(urlStr, '远端地址'));
    } catch {
      return reject(new Error('远端地址格式不正确，仅支持 HTTP / HTTPS'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { accept: 'application/json', 'user-agent': 'yunqiao/0.1', ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u);
          if (redirects >= 3 || (u.protocol === 'https:' && next.protocol !== 'https:')) {
            reject(new Error('远端重定向次数过多或降级到不安全连接'));
            return;
          }
          getJson<T>(next.href, timeoutMs, {}, redirects + 1).then(resolve, reject);
          return;
        }
        let buf = '';
        let size = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          size += Buffer.byteLength(c);
          if (size > 8 * 1024 * 1024) {
            res.destroy(new Error('远端目录超过 8MB 限制'));
            return;
          }
          buf += c;
        });
        res.on('error', reject);
        res.on('end', () => {
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            return reject(new Error(`目录服务返回 HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(buf) as T);
          } catch {
            reject(new Error('远端返回的不是有效 JSON'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/* ------------------------------ 云端目录 ------------------------------ */

export function validateCloudProvider(raw: unknown): CloudProvider {
  const p = raw as Record<string, any>;
  if (!p || typeof p !== 'object' || typeof p.key !== 'string' || !p.key.trim() || p.key.length > 160
      || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 160
      || !['openai-chat', 'openai-responses', 'anthropic', 'gemini'].includes(p.format)) {
    throw new Error('目录供应商的标识、名称或协议不正确');
  }
  if (p.models != null && (!Array.isArray(p.models) || p.models.length > 10000)) {
    throw new Error(`供应商「${p.name}」的模型列表不正确`);
  }
  const optionalText = (s: unknown, max = 1000) => typeof s === 'string' ? s.slice(0, max) : undefined;
  const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  const seen = new Set<string>();
  const models = (p.models ?? []).map((m: any) => {
    if (!m || typeof m.id !== 'string' || !m.id.trim() || m.id.length > 512) {
      throw new Error(`供应商「${p.name}」存在无效模型名称`);
    }
    return {
      id: m.id.trim(), contextWindow: number(m.contextWindow), inputPrice: number(m.inputPrice), outputPrice: number(m.outputPrice),
      capabilities: {
        tools: m.capabilities?.tools === true,
        vision: m.capabilities?.vision === true,
        thinking: m.capabilities?.thinking === true,
      },
    };
  }).filter((m: { id: string }) => !seen.has(m.id) && !!seen.add(m.id));
  return {
    key: p.key.trim(), name: p.name.trim(), format: p.format, baseUrl: webUrl(p.baseUrl, `供应商「${p.name}」地址`),
    vendor: optionalText(p.vendor, 160), region: optionalText(p.region, 40),
    color: typeof p.color === 'string' && /^#[\da-f]{3,8}$/i.test(p.color) ? p.color : undefined,
    icon: optionalText(p.icon, 16), docs: p.docs ? webUrl(p.docs, '文档地址') : undefined,
    note: optionalText(p.note, 4000), tags: Array.isArray(p.tags) ? p.tags.filter((t: unknown) => typeof t === 'string').slice(0, 20) : [],
    official: p.official === true, sort: number(p.sort), models,
  };
}

export function validateCloudCatalog(data: any): CloudCatalog {
  if (!Array.isArray(data?.providers) || data.providers.length > 2000) throw new Error('目录格式不正确（providers 必须为数组且不超过 2000 家）');
  const providers = data.providers.map(validateCloudProvider);
  if (new Set(providers.map((p: CloudProvider) => p.key)).size !== providers.length) throw new Error('目录存在重复的供应商标识');
  return { version: Number.isSafeInteger(data.version) && data.version >= 0 ? data.version : 0,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '', providers };
}

export async function fetchCloudCatalog(url: string, store?: AuroraStore): Promise<CloudCatalog> {
  const endpoint = webUrl(url, '目录地址');
  const cacheName = `catalog-${createHash('sha256').update(endpoint).digest('hex').slice(0, 20)}.json`;
  try {
    const catalog = validateCloudCatalog(await getJson(endpoint));
    const result: CloudCatalog = { ...catalog, source: 'remote', fetchedAt: nowIso() };
    store?.writeExtra(cacheName, result);
    return result;
  } catch (error) {
    const cached = store?.readExtra<CloudCatalog | null>(cacheName, null);
    if (cached) {
      try {
        return { ...validateCloudCatalog(cached), source: 'cache', fetchedAt: cached.fetchedAt,
          warning: '远端暂时不可用，显示上次成功同步的本地目录。' };
      } catch { /* invalid cache cannot become a trusted catalog */ }
    }
    throw error;
  }
}

/** 把云端条目转成本地供应商；已存在（按 presetId/name 匹配）就合并模型 */
export function importCloudProviders(
  store: AuroraStore,
  items: CloudProvider[],
): { added: number; merged: number; providers: Provider[] } {
  const existing = store.listProviders();
  let added = 0;
  let merged = 0;
  const touched: Provider[] = [];

  const validated = items.map(validateCloudProvider);
  for (const item of validated) {
    const hit = existing.find(
      (p) => p.presetId === item.key || (p.baseUrl.replace(/\/$/, '') === item.baseUrl && p.format === item.format),
    );
    const models = (item.models ?? []).map((m) => ({
      id: m.id,
      contextWindow: m.contextWindow ?? 128000,
      inputPrice: m.inputPrice ?? 0,
      outputPrice: m.outputPrice ?? 0,
      capabilities: m.capabilities ?? { tools: true },
    }));
    if (hit) {
      const map = new Map(hit.models.map((m) => [m.id, m]));
      for (const m of models) if (!map.has(m.id)) map.set(m.id, m);
      const next = store.saveProvider({
        ...hit,
        models: [...map.values()],
        baseUrl: hit.baseUrl || item.baseUrl,
        color: hit.color ?? item.color,
        icon: hit.icon ?? item.icon,
      });
      touched.push(next);
      merged++;
    } else {
      const created = store.saveProvider({
        name: item.name,
        presetId: item.key,
        format: item.format,
        baseUrl: item.baseUrl,
        apiKeys: [{ id: newId('key_', 6), label: '默认', key: '', enabled: true, weight: 1 }],
        models,
        enabled: true,
        priority: 10,
        color: item.color ?? '#6d8cff',
        icon: item.icon ?? '◆',
        notes: item.note,
        official: item.official,
        rateMultiplier: 1,
      });
      touched.push(created);
      existing.push(created);
      added++;
    }
  }
  return { added, merged, providers: touched };
}

/* ------------------------------ 更新 ------------------------------ */

export interface UpdateInfo {
  version: string;
  notes: string;
  mandatory: boolean;
  hasUpdate: boolean;
  url: string;
  publishedAt?: string;
  current: string;
}

function cmpVersion(a: string, b: string): number {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export async function checkUpdate(url: string, current: string): Promise<UpdateInfo> {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const full = `${url}${url.includes('?') ? '&' : '?'}platform=${platform}&arch=${arch}&current=${encodeURIComponent(current)}`;
  const r = await getJson<any>(full);
  const latest = String(r?.version ?? '0.0.0');
  return {
    version: latest,
    notes: String(r?.notes ?? ''),
    mandatory: !!r?.mandatory,
    hasUpdate: !!r?.hasUpdate || cmpVersion(latest, current) > 0,
    url: String(r?.url ?? ''),
    publishedAt: r?.publishedAt,
    current,
  };
}

/* ------------------------------ 官方账号 ------------------------------ */

export interface LocalAccount {
  id: string;
  kind: 'claude' | 'chatgpt' | 'copilot';
  label: string;
  source: string;
  email?: string;
  plan?: string;
  /** Login secrets are never exposed by scanning. */
  authKind?: 'api-key' | 'oauth';
  importable?: boolean;
  baseUrl?: string;
  format: 'anthropic' | 'openai-responses' | 'openai-chat';
  found: boolean;
  note?: string;
}

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function home(...p: string[]): string {
  return path.join(os.homedir(), ...p);
}

/** 扫描本机各客户端已有的官方登录态（只读，不上传） */
export function scanLocalAccounts(): LocalAccount[] {
  const out: LocalAccount[] = [];

  // Claude Code：~/.claude/.credentials.json（或 macOS keychain，这里只读文件）
  const claudePaths = [
    process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json') : '',
    home('.claude', '.credentials.json'),
  ].filter(Boolean);
  for (const p of claudePaths) {
    const j = readJson(p);
    if (!j) continue;
    const oauth = j.claudeAiOauth ?? j;
    const token = oauth.accessToken ?? oauth.access_token;
    if (!token) continue;
    out.push({
      id: 'claude',
      kind: 'claude',
      label: 'Claude 官方订阅',
      source: p,
      email: oauth.email ?? j.email,
      plan: oauth.subscriptionType ?? oauth.plan,
      authKind: 'oauth',
      importable: false,
      baseUrl: 'https://api.anthropic.com',
      format: 'anthropic',
      found: true,
      note: '已检测到 Claude Code 登录态。订阅登录由官方客户端管理，不能当作通用 API Key 导入。',
    });
    break;
  }

  // Codex / ChatGPT：~/.codex/auth.json
  const codexAuth = readJson(process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'auth.json') : home('.codex', 'auth.json'));
  if (codexAuth) {
    const token =
      codexAuth.tokens?.access_token ?? codexAuth.access_token ?? codexAuth.OPENAI_API_KEY ?? '';
    if (token) {
      out.push({
        id: 'chatgpt',
        kind: 'chatgpt',
        label: codexAuth.OPENAI_API_KEY ? 'OpenAI API（Codex 配置）' : 'ChatGPT 订阅（Codex 登录态）',
        source: (process.env.CODEX_HOME ?? home('.codex')) + '/auth.json',
        email: codexAuth.tokens?.account_id ?? codexAuth.account_id,
        plan: codexAuth.tokens?.plan_type ?? codexAuth.plan_type,
        authKind: codexAuth.OPENAI_API_KEY ? 'api-key' : 'oauth',
        importable: !!codexAuth.OPENAI_API_KEY,
        baseUrl: codexAuth.OPENAI_API_KEY ? 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api/codex',
        format: 'openai-responses',
        found: true,
        note: codexAuth.OPENAI_API_KEY ? '已检测到明确配置的 OpenAI API Key，可导入后手动确认 API 地址和模型。' : '已检测到 Codex OAuth 登录。订阅额度与 API 额度分开，保持官方客户端登录即可。',
      });
    }
  }

  // GitHub Copilot：~/.config/github-copilot/hosts.json 或 apps.json
  for (const p of [
    path.join(process.env.APPDATA ?? home('AppData', 'Roaming'), 'github-copilot', 'hosts.json'),
    home('.config', 'github-copilot', 'hosts.json'),
  ]) {
    const j = readJson(p);
    if (!j) continue;
    const first = Object.entries(j)[0] as [string, any] | undefined;
    if (!first) continue;
    const [, v] = first;
    if (v?.oauth_token) {
      out.push({
        id: 'copilot',
        kind: 'copilot',
        label: 'GitHub Copilot 订阅',
        source: p,
        email: first[0],
        authKind: 'oauth',
        importable: false,
        baseUrl: 'https://api.githubcopilot.com',
        format: 'openai-chat',
        found: true,
        note: '已检测到 GitHub Copilot 登录态。令牌交换与续期由官方插件管理，不导入网关。',
      });
      break;
    }
  }

  return out;
}

/** Only an explicitly stored API key can be imported; subscription OAuth is not an API key. */
export function importAccountAsProvider(store: AuroraStore, acc: LocalAccount): Provider {
  const account = scanLocalAccounts().find((item) => item.id === acc?.id);
  if (!account?.importable || account.kind !== 'chatgpt') {
    throw new Error('这是官方订阅登录态，不能作为通用 API Key 使用。请在对应客户端登录，或从厂商开放平台创建 API Key。');
  }
  const authPath = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'auth.json') : home('.codex', 'auth.json');
  const apiKey = readJson(authPath)?.OPENAI_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('本机配置中没有可导入的 OpenAI API Key');
  const previous = store.listProviders().find((p) => p.presetId === 'imported-openai-api');
  return store.saveProvider({
    ...(previous ?? {}),
    name: account.label, presetId: 'imported-openai-api', format: 'openai-responses',
    baseUrl: previous?.baseUrl ?? 'https://api.openai.com/v1',
    apiKeys: [{ id: previous?.apiKeys[0]?.id ?? newId('key_', 6), label: '本机 API Key', key: apiKey, enabled: true, weight: 1 }],
    models: previous?.models ?? [], enabled: true, priority: 10, official: true,
    icon: '◍', color: '#10a37f',
    notes: `从本机 Codex API 配置导入。请同步模型列表并测试连接。\n导入时间：${nowIso()}`,
  });
}
