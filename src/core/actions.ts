import { AuroraStore } from './store/index.js';
import { PROVIDER_PRESETS } from './presets/providers.js';
import { AGENT_ADAPTERS, detectAll, detectReset, getAdapter, connectionParameters, exportEnvScript, type ConnectContext } from './agents/adapters.js';
import { scanSessions, readSession, resumeCommand, exportSessionMarkdown } from './sessions.js';
import { BUILTIN_MIDDLEWARE, SAMPLE_PLUGIN } from './plugins/middleware.js';
import { desktopInfo, launchAndInject, injectorStatus, BUILTIN_INJECT_SCRIPTS } from './injector.js';
import { diagnoseSessions, repairSessions, listCodexAssets, toggleCodexAsset, readAgentsMd, writeAgentsMd, readCodexFlags, writeCodexFlag, CODEX_FLAGS } from './codex.js';
import { openUpstream, readAll } from './gateway/upstream.js';
import { buildUpstreamHttp, parseClientRequest } from './protocol/index.js';
import type { GatewayStatus } from './gateway/server.js';
import type { UsageRecord } from './store/types.js';
import {
  checkUpdate,
  fetchCloudCatalog,
  importAccountAsProvider,
  importCloudProviders,
  scanLocalAccounts,
} from './cloud.js';

/**
 * 与 Electron 无关的动作层：桌面端的 IPC 和网关的 /api/rpc 共用同一份实现，
 * 这样 Web 控制台 / 手机端拿到的行为和桌面端完全一致。
 */

export interface ActionDeps {
  store: AuroraStore;
  gatewayStatus: () => GatewayStatus;
  gatewayUrl: () => string;
  restartGateway?: () => Promise<void>;
  resetCooldowns?: () => void;
  platform?: string;
  version?: string;
  dataDir: string;
}

const settingsQueues = new WeakMap<AuroraStore, Promise<unknown>>();
async function saveSettingsAndRestart(deps: ActionDeps, payload: any) {
  const previous = settingsQueues.get(deps.store) || Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const before = deps.store.getSettings();
    const next = deps.store.saveSettings(payload);
    try {
      if (next.gatewayPort !== before.gatewayPort || next.gatewayHost !== before.gatewayHost || next.lanShare !== before.lanShare) await deps.restartGateway?.();
    } catch (error) {
      deps.store.saveSettings(before);
      try { await deps.restartGateway?.(); }
      catch (restoreError) { throw new Error(`${String((error as Error).message)}；原配置已还原，但原网关重启失败：${String((restoreError as Error).message)}`); }
      throw error;
    }
    return next;
  });
  settingsQueues.set(deps.store, task);
  try { return await task; }
  finally { if (settingsQueues.get(deps.store) === task) settingsQueues.delete(deps.store); }
}


/** 各客户端的官方下载地址（拿不准的留空，界面上就不显示按钮，避免给错链接） */
const store = (q: string) => 'ms-windows-store://search/?query=' + encodeURIComponent(q);

const AGENT_DOWNLOADS: Record<string, { win?: string; winAlt?: string; mac?: string; linux?: string; note?: string }> = {
  'claude-code': { win: store('Node.js LTS'), winAlt: 'https://docs.claude.com/en/docs/claude-code/setup', mac: 'https://docs.claude.com/en/docs/claude-code/setup', linux: 'https://docs.claude.com/en/docs/claude-code/setup', note: '需要 Node.js 18+，装完运行 claude 登录' },
  'claude-desktop': { win: store('Claude'), winAlt: 'https://claude.ai/download', mac: 'https://claude.ai/download', note: '官方桌面客户端' },
  'codex-cli': { win: store('Windows Terminal'), winAlt: 'https://github.com/openai/codex/releases', mac: 'https://github.com/openai/codex/releases', linux: 'https://github.com/openai/codex/releases', note: 'Codex CLI 与桌面版同源' },
  'codex-desktop': { win: store('Codex'), winAlt: 'https://chatgpt.com/codex', mac: 'https://chatgpt.com/codex', note: '从 ChatGPT 官网下载 Codex 桌面版' },
  'chatgpt-desktop': { win: store('ChatGPT'), winAlt: 'https://chatgpt.com/download', mac: 'https://chatgpt.com/download', note: '官方桌面客户端' },
  'gemini-cli': { win: store('Node.js LTS'), winAlt: 'https://github.com/google-gemini/gemini-cli', mac: 'https://github.com/google-gemini/gemini-cli', linux: 'https://github.com/google-gemini/gemini-cli', note: 'npm i -g @google/gemini-cli' },
  'qwen-code': { win: 'https://github.com/QwenLM/qwen-code', mac: 'https://github.com/QwenLM/qwen-code', linux: 'https://github.com/QwenLM/qwen-code' },
  opencode: { win: 'https://github.com/sst/opencode', mac: 'https://github.com/sst/opencode', linux: 'https://github.com/sst/opencode' },
  deepseek: { win: 'https://platform.deepseek.com', mac: 'https://platform.deepseek.com', note: '先去开放平台拿 API Key' },
  'kimi-code': { win: 'https://platform.moonshot.cn', mac: 'https://platform.moonshot.cn' },
  antigravity: { win: 'https://antigravity.google', mac: 'https://antigravity.google' },
};

function downloadsFor(id: string) {
  const d = AGENT_DOWNLOADS[id];
  if (!d) return undefined;
  const isWin = process.platform === 'win32';
  return {
    ...d,
    current: isWin ? d.win : process.platform === 'darwin' ? d.mac : d.linux,
    alt: isWin ? d.winAlt : undefined,
    storeHint: isWin,
  };
}
function extractErr(text: string): string {
  try {
    const j = JSON.parse(text);
    return j?.error?.message ?? j?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export async function testProvider(deps: ActionDeps, payload: { providerId: string; model?: string }) {
  const p = deps.store.getProvider(payload.providerId);
  if (!p) return { ok: false, message: '供应商不存在' };
  const key = p.apiKeys.find((k) => k.enabled && k.key);
  let local = false;
  try { local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(p.baseUrl).hostname); } catch { return { ok: false, message: '供应商地址无效' }; }
  if (!key?.key && !local)
    return { ok: false, message: '这家供应商还没有填 API Key' };
  const model = payload.model ?? p.models[0]?.id ?? '';
  if (!model) return { ok: false, message: '还没有配置模型' };
  const t0 = Date.now();
  try {
    const ir = parseClientRequest('openai-chat', {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      stream: false,
    });
    const req = buildUpstreamHttp(
      ir,
      {
        baseUrl: p.baseUrl,
        apiKey: key?.key || '',
        format: p.format,
        model,
        maxTokens: 8,
        extraHeaders: p.headers,
        supportsThinking: false,
      },
      'openai-chat',
    );
    const res = await openUpstream(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      proxy: p.proxy || deps.store.getSettings().proxy || undefined,
      timeoutMs: 30000,
    });
    const text = await readAll(res.stream, 512 * 1024);
    let response: any;
    try { response = JSON.parse(text); } catch { /* invalid API response */ }
    const valid = response && !response.error && (
      p.format === 'anthropic' ? response.type === 'message' && Array.isArray(response.content) :
      p.format === 'openai-chat' ? Array.isArray(response.choices) && !!response.choices[0]?.message :
      p.format === 'openai-responses' ? Array.isArray(response.output) && response.status !== 'failed' :
      Array.isArray(response.candidates) && response.candidates.length > 0
    );
    const ok = res.status >= 200 && res.status < 300 && !!valid;
    return {
      ok,
      status: res.status,
      latencyMs: Date.now() - t0,
      message: ok ? `连通正常（${Date.now() - t0}ms）` : (response?.error || res.status >= 400 ? extractErr(text) : `接口返回 HTTP ${res.status}，但内容不符合 ${p.format} 响应格式`),
      sample: text.slice(0, 800),
    };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e), latencyMs: Date.now() - t0 };
  }
}

export async function fetchProviderModels(deps: ActionDeps, payload: { providerId: string }) {
  const p = deps.store.getProvider(payload.providerId);
  if (!p) return { ok: false, models: [] };
  const key = p.apiKeys.find((k) => k.enabled && k.key);
  const base = p.baseUrl.replace(/\/+$/, '');
  const urls = p.format === 'gemini'
    ? [`${base}${/\/v1(?:beta)?$/.test(base) ? '' : '/v1beta'}/models`]
    : [...new Set([`${base}${/\/v1$/.test(base) ? '' : '/v1'}/models`, `${base}/models`])];
  const headers: Record<string, string> = p.format === 'anthropic'
    ? { 'x-api-key': key?.key || '', 'anthropic-version': '2023-06-01' }
    : p.format === 'gemini' ? { 'x-goog-api-key': key?.key || '' }
    : { authorization: `Bearer ${key?.key || ''}` };
  for (const url of urls) {
    try {
      const res = await openUpstream(url, {
        method: 'GET',
        headers: { ...headers, ...(p.headers || {}) },
        proxy: p.proxy || deps.store.getSettings().proxy || undefined,
        timeoutMs: 15000,
      });
      const text = await readAll(res.stream, 4 * 1024 * 1024);
      if (res.status < 200 || res.status >= 300) continue;
      const json = JSON.parse(text);
      const list: any[] = json?.data ?? json?.models ?? [];
      if (!Array.isArray(list) || json.error) continue;
      const models = list
        .map((x: any) => ({
          id: (x.id ?? x.name ?? '').replace(/^models\//, ''),
          contextWindow: x.context_window ?? x.input_token_limit ?? x.inputTokenLimit,
        }))
        .filter((x: any) => x.id);
      if (models.length) {
        const merged = [...p.models];
        for (const m of models) {
          if (!merged.find((x) => x.id === m.id))
            merged.push({
              id: m.id,
              contextWindow: m.contextWindow,
            });
        }
        deps.store.saveProvider({ ...p, models: merged });
        return { ok: true, models: merged, added: merged.length - p.models.length };
      }
    } catch {
      continue;
    }
  }
  return { ok: false, models: p.models, message: '这家供应商没有公开的模型列表接口，请手动添加模型' };
}

export function summarizeUsage(records: UsageRecord[]) {
  const byDay = new Map<string, { cost: number; tokens: number; calls: number }>();
  const byProvider = new Map<string, { cost: number; tokens: number; calls: number; name: string }>();
  const byModel = new Map<string, { cost: number; tokens: number; calls: number }>();
  const byAgent = new Map<string, { calls: number; tokens: number }>();
  let totalIn = 0,
    totalOut = 0,
    totalCost = 0,
    totalCache = 0,
    errors = 0;

  for (const r of records) {
    const day = r.ts.slice(0, 10);
    const tokens = r.inputTokens + r.outputTokens;
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
    totalCost += r.cost;
    totalCache += r.cacheRead;
    if (r.status >= 400) errors++;
    const d = byDay.get(day) ?? { cost: 0, tokens: 0, calls: 0 };
    byDay.set(day, { cost: d.cost + r.cost, tokens: d.tokens + tokens, calls: d.calls + 1 });
    const p = byProvider.get(r.providerId) ?? { cost: 0, tokens: 0, calls: 0, name: r.providerName };
    byProvider.set(r.providerId, { cost: p.cost + r.cost, tokens: p.tokens + tokens, calls: p.calls + 1, name: r.providerName });
    const mo = byModel.get(r.model) ?? { cost: 0, tokens: 0, calls: 0 };
    byModel.set(r.model, { cost: mo.cost + r.cost, tokens: mo.tokens + tokens, calls: mo.calls + 1 });
    const ag = byAgent.get(r.agent) ?? { calls: 0, tokens: 0 };
    byAgent.set(r.agent, { calls: ag.calls + 1, tokens: ag.tokens + tokens });
  }

  return {
    totals: {
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheRead: totalCache,
      cost: totalCost,
      calls: records.length,
      errors,
    },
    byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? -1 : 1)),
    byProvider: [...byProvider.entries()].map(([id, v]) => ({ id, ...v })),
    byModel: [...byModel.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.cost - a.cost),
    byAgent: [...byAgent.entries()].map(([id, v]) => ({ id, ...v })),
  };
}

/** 返回 null 表示「这个动作需要桌面端处理」 */
export async function runAction(deps: ActionDeps, action: string, payload: any): Promise<any | null> {
  const store = deps.store;
  payload = payload ?? {};
  switch (action) {
    case 'state.get':
      return {
        settings: store.getSettings(),
        providers: store.listProviders(),
        groups: store.listGroups(),
        agents: store.listAgents(),
        plugins: store.listPlugins(),
        presets: PROVIDER_PRESETS,
        builtinMiddleware: BUILTIN_MIDDLEWARE.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          defaultOptions: b.defaultOptions,
        })),
        agentCatalog: AGENT_ADAPTERS.map((a) => ({
          id: a.id,
          name: a.name,
          vendor: a.vendor,
          description: a.description,
          protocol: a.protocol,
          hotSwitch: a.hotSwitch,
          needsInstall: a.needsInstall,
          support: a.support,
          category: a.category,
          supportNote: a.supportNote,
          docsUrl: a.docsUrl,
          configPath: a.configPaths()[0],
          launchHint: a.launchHint(''),
          downloads: downloadsFor(a.id),
        })),
        gateway: deps.gatewayStatus(),
        gatewayUrl: deps.gatewayUrl(),
        dataDir: deps.dataDir,
        version: deps.version ?? '0.1.0',
        platform: deps.platform ?? process.platform,
        detected: detectAll(true),
        mode: deps.platform === 'web' ? 'web' : 'desktop',
      };

    case 'provider.save':
      return store.saveProvider(payload);
    case 'provider.delete':
      store.deleteProvider(payload.id);
      return { ok: true };
    case 'provider.test':
      return testProvider(deps, payload);
    case 'provider.models':
      return fetchProviderModels(deps, payload);
    case 'provider.resetCooldown':
      deps.resetCooldowns?.();
      return { ok: true };

    /* ---------- 云端 ---------- */
    case 'cloud.catalog': {
      const url = payload.url || store.getSettings().catalogUrl;
      const data = await fetchCloudCatalog(url, store);
      return { ok: true, ...data };
    }
    case 'cloud.import': {
      const items = payload.providers ?? [];
      const r = importCloudProviders(store, items);
      return { ok: true, added: r.added, merged: r.merged, count: r.providers.length };
    }
    case 'update.check': {
      const s = store.getSettings();
      try {
        return { ok: true, ...(await checkUpdate(payload.url || s.updateUrl, payload.current ?? deps.version ?? '0.1.0')) };
      } catch (e: any) {
        return { ok: false, message: String(e?.message ?? e) };
      }
    }
    case 'account.scan':
      return { ok: true, accounts: scanLocalAccounts() };
    case 'account.import': {
      const acc = payload.account;
      const p = importAccountAsProvider(store, acc);
      return { ok: true, provider: p };
    }

    /* ---------- Codex 增强 ---------- */
    case 'codex.diagnose':
      return diagnoseSessions();
    case 'codex.repairSessions':
      return repairSessions(payload.provider);
    case 'codex.assets':
      return { ok: true, assets: listCodexAssets() };
    case 'codex.toggleAsset':
      return toggleCodexAsset(payload.id, !!payload.enabled);
    case 'codex.readAgents':
      return { ok: true, text: readAgentsMd() };
    case 'codex.writeAgents':
      return writeAgentsMd(String(payload.text ?? ''));
    case 'codex.flags':
      return { ok: true, flags: readCodexFlags(), schema: CODEX_FLAGS };
    case 'inject.info': {
      const st = store.getSettings();
      const info = await desktopInfo(st.codexVersion);
      return { ok: true, info, scripts: injectScripts(store) };
    }
    case 'inject.status':
      return { ok: true, ...(await injectorStatus()) };
    case 'inject.run': {
      const st = store.getSettings();
      const info = await desktopInfo(st.codexVersion);
      if (info.version) store.saveSettings({ codexVersion: info.version });
      return launchAndInject(injectScripts(store));
    }
    case 'inject.saveScript': {
      const list = injectScripts(store);
      const s = payload.script;
      const i = list.findIndex((x) => x.id === s.id);
      if (i >= 0) list[i] = { ...list[i], ...s };
      else list.push({ id: 'inject:' + Date.now(), name: s.name || '自定义', code: s.code || '', enabled: true });
      store.saveSettings({ codexVersion: store.getSettings().codexVersion });
      writeInjectScripts(store, list);
      return { ok: true, scripts: list };
    }
    case 'inject.deleteScript': {
      const list = injectScripts(store).filter((x) => x.id !== payload.id);
      writeInjectScripts(store, list);
      return { ok: true, scripts: list };
    }
    case 'codex.setFlag':
      return writeCodexFlag(String(payload.key), String(payload.value));

    case 'group.save':
      return store.saveGroup(payload);
    case 'group.delete':
      store.deleteGroup(payload.id);
      return { ok: true };

    case 'settings.save':
      return saveSettingsAndRestart(deps, payload);

    case 'agent.detect':
      detectReset();
      return detectAll();
    case 'agent.preview':
    case 'agent.parameters':
    case 'agent.connect': {
      const adapter = getAdapter(String(payload.agentId || ''));
      if (!adapter) return { ok: false, message: '未知客户端' };
      if (adapter.support === 'unsupported') return { ok: false, message: adapter.supportNote, files: [], warnings: [] };
      const provider = store.getProvider(String(payload.providerId || ''));
      if (!provider) return { ok: false, message: '请选择有效供应商' };
      if (payload.mode && !['gateway', 'direct'].includes(payload.mode)) return { ok: false, message: '不支持的接入模式' };
      const sharedCodex = adapter.id === 'codex-cli' || adapter.id === 'codex-desktop';
      const prior = store.listAgents()[adapter.id] || (sharedCodex ? store.listAgents()[adapter.id === 'codex-cli' ? 'codex-desktop' : 'codex-cli'] : undefined);
      const context: ConnectContext = {
        provider, model: String(payload.model || provider.models[0]?.id || ''), modelMap: payload.modelMap,
        mode: payload.mode || 'gateway', gatewayUrl: deps.gatewayUrl(), token: store.getSettings().gatewayToken,
        previousBackup: prior?.connected || prior?.pendingReapply ? prior.backupPath : undefined,
        expectedRevision: payload.revision,
      };
      const preview = adapter.preview(context);
      if (action === 'agent.preview' || !preview.ok) return preview;
      if (action === 'agent.parameters') return { ok: true, ...connectionParameters(context, adapter.protocol), script: exportEnvScript(context, adapter.protocol), note: adapter.supportNote };
      if (context.mode === 'gateway' && !deps.gatewayStatus().running) return { ok: false, message: '本地网关未运行，请先启动网关后再应用配置' };
      const result = adapter.connect(context);
      if (result.ok) {
        const ids = sharedCodex ? (['codex-cli', 'codex-desktop'] as const) : [adapter.id];
        for (const id of ids) store.saveAgent({ id, connected: true, pendingReapply: false, providerId: provider.id, model: context.model, modelMap: context.modelMap, mode: context.mode, configPath: result.path, backupPath: result.backup });
      }
      return result;
    }
    case 'agent.disconnect': {
      const adapter = getAdapter(String(payload.agentId || ''));
      if (!adapter) return { ok: false, message: '未知客户端' };
      const current = store.listAgents()[adapter.id];
      const result = adapter.disconnect(current?.backupPath);
      if (result.ok) {
        const ids = adapter.id === 'codex-cli' || adapter.id === 'codex-desktop' ? (['codex-cli', 'codex-desktop'] as const) : [adapter.id];
        for (const id of ids) store.saveAgent({ id, connected: false, pendingReapply: false, backupPath: undefined });
      }
      return result;
    }

    case 'plugin.save':
      return store.savePlugin(payload);
    case 'plugin.delete':
      store.deletePlugin(payload.id);
      return { ok: true };
    case 'plugin.sample':
      return SAMPLE_PLUGIN;

    case 'gateway.status':
      return deps.gatewayStatus();
    case 'gateway.url':
      return deps.gatewayUrl();
    case 'gateway.restart':
      await deps.restartGateway?.();
      return deps.gatewayStatus();

    case 'usage.recent':
      return store.recentRequests(200);
    case 'usage.summary':
      return summarizeUsage(store.readUsage(payload?.days ?? 14));

    case 'sessions.scan':
      return scanSessions();
    case 'sessions.read':
      return readSession(payload.path);
    case 'sessions.resume':
      return { command: resumeCommand(payload.summary) };
    case 'sessions.export': {
      const md = payload.summary
        ? exportSessionMarkdown(payload.summary)
        : readSession(payload.path)
            .map((m) => `## ${m.role}\n\n${m.text}\n`)
            .join('\n');
      return { ok: true, markdown: md };
    }

    default:
      return null;
  }
}






/* ------------------------------ 注入脚本存取 ------------------------------ */

const INJECT_FILE = 'inject-scripts.json';

function injectScripts(store: AuroraStore): Array<{ id: string; name: string; code: string; enabled: boolean }> {
  const saved = store.readExtra<Array<{ id: string; name: string; code: string; enabled: boolean }> | null>(INJECT_FILE, null);
  if (saved && Array.isArray(saved)) return saved;
  return BUILTIN_INJECT_SCRIPTS.map((s) => ({ ...s }));
}

function writeInjectScripts(store: AuroraStore, list: Array<{ id: string; name: string; code: string; enabled: boolean }>): void {
  store.writeExtra(INJECT_FILE, list);
}


