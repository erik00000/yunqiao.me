import { AuroraStore } from './store/index.js';
import { catalogPresets, ensureCatalog, refreshCatalog } from './catalog.js';
import { manageModels } from './modelManagement.js';
import { getLocalClientsSnapshot, syncLocalClients, restoreIgnoredLocalSource } from './localClients.js';
import { activeRequests } from './gateway/liveUsage.js';
import path from 'node:path';
import fs from 'node:fs';
import { readText, atomicWrite, digest } from './agents/configFiles.js';
import { getCoexistCatalog } from './gateway/coexist.js';
import { runExtensionAction } from './extensions/index.js';
import { AGENT_ADAPTERS, detectAll, detectReset, getAdapter, connectionParameters, exportEnvScript, configureDesktopPath, type ConnectContext } from './agents/adapters.js';
import { scanSessions, readSession, resumeCommand, exportSessionMarkdown } from './sessions.js';
import { BUILTIN_MIDDLEWARE, SAMPLE_PLUGIN, getMiddlewareStatus } from './plugins/middleware.js';
import { desktopInfo, launchAndInject, injectorStatus, BUILTIN_INJECT_SCRIPTS } from './injector.js';
import { diagnoseSessions, repairSessions, listCodexAssets, toggleCodexAsset, readAgentsMd, writeAgentsMd, readCodexFlags, writeCodexFlag, CODEX_FLAGS } from './codex.js';
import { openUpstream, readAll } from './gateway/upstream.js';
import { buildUpstreamHttp, parseClientRequest } from './protocol/index.js';
import type { GatewayStatus } from './gateway/server.js';
import type { Provider, UsageRecord } from './store/types.js';
import { buildInfo } from './buildInfo.js';
import { runHistoryRepairAction } from './historyRepair.js';
import { runSessionIndexRepairAction } from './sessionIndexRepair.js';
import {
  checkUpdate,
  fetchCloudCatalog,
  importCloudProviders,
} from './cloud.js';
import { GITHUB_RELEASE_PAGE } from './releaseSources.js';

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
  localClientWarnings?: string[];
}

interface ClientFileSnapshot { path: string; existed: boolean; content: string }
interface ClientFileExpected { existed: boolean; hash: string }
function snapshotClientFiles(paths: string[]): ClientFileSnapshot[] {
  return paths.map(file => ({ path: file, content: readText(file), existed: fs.existsSync(file) }));
}
function expectedClientFiles(files: ClientFileSnapshot[]): Map<string, ClientFileExpected> {
  return new Map(files.map(file => [file.path, { existed: file.existed, hash: digest(file.content) }]));
}
/** The adapter's manifest records the exact bytes it wrote, independently of later external edits. */
function clientManifestExpected(backup: string | undefined, files: ClientFileSnapshot[], restoring = false): Map<string, ClientFileExpected> {
  if (!backup || !files.length) throw new Error('缺少可核验的客户端备份');
  const root = path.join(path.dirname(files[0].path), '.aurora-backups');
  const within = (file: string) => { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
  if (!within(backup)) throw new Error('客户端备份路径无效');
  const manifest = JSON.parse(readText(backup));
  if (manifest.format !== 'aurora-client-backup-v1' || !Array.isArray(manifest.files)) throw new Error('客户端备份格式无效');
  const expected = expectedClientFiles(files), seen = new Set<string>();
  for (const entry of manifest.files) {
    const file = files.find(item => path.resolve(item.path) === path.resolve(entry.path));
    if (!file || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(entry.installedHash)
      || (entry.backup !== null && (typeof entry.backup !== 'string' || !within(entry.backup)))) throw new Error('客户端备份记录无效');
    seen.add(file.path);
    if (restoring) {
      if (entry.backup !== null && !fs.existsSync(entry.backup)) throw new Error('客户端原始备份丢失');
      expected.set(file.path, { existed: entry.backup !== null, hash: digest(entry.backup === null ? '' : readText(entry.backup)) });
    } else expected.set(file.path, { existed: true, hash: entry.installedHash });
  }
  if (!restoring && seen.size !== files.length) throw new Error('客户端备份记录不完整');
  return expected;
}
/** Never undo another application's edit while recovering a failed state commit. */
function rollbackClientFiles(files: ClientFileSnapshot[], expected: Map<string, ClientFileExpected>): string[] {
  const failed: string[] = [];
  for (const file of [...files].reverse()) {
    try {
      const current = snapshotClientFiles([file.path])[0], currentHash = digest(current.content);
      if (current.existed === file.existed && currentHash === digest(file.content)) continue;
      const applied = expected.get(file.path);
      if (!applied || current.existed !== applied.existed || currentHash !== applied.hash) { failed.push(file.path); continue; }
      if (file.existed) atomicWrite(file.path, file.content);
      else if (current.existed) fs.unlinkSync(file.path);
    } catch { failed.push(file.path); }
  }
  return failed;
}
function clientStateFailure(files: ClientFileSnapshot[], expected: Map<string, ClientFileExpected>, backup?: string, reason = '无法保存客户端连接状态') {
  const failed = rollbackClientFiles(files, expected);
  detectReset();
  return { ok: false, ...(backup ? { backup } : {}), message: `${reason}；${failed.length ? `部分配置无法自动回滚或已被其他程序修改，请手动检查：${failed.join('、')}` : '已恢复本次操作前的客户端配置'}${backup ? `；首次接入前备份保留：${backup}` : ''}` };
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
      try { deps.store.settings.restoreIfUnchanged(before, next); }
      catch {
        try { await deps.restartGateway?.(); }
        catch { throw new Error('网关重启失败；配置随后已变化或无法恢复，已保留当前文件，当前网关也未能启动，请检查系统设置'); }
        throw new Error('网关重启失败；配置随后已变化或无法恢复，已保留当前文件并按当前配置恢复网关，请检查系统设置');
      }
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
  if (!p) return { ok: false, models: [], message: '供应商已不存在，请刷新列表' };
  const connection = (provider: Provider) => JSON.stringify({ baseUrl: provider.baseUrl, format: provider.format,
    headers: provider.headers, proxy: provider.proxy || deps.store.getSettings().proxy,
    keys: provider.apiKeys.map(k => ({ key: k.key, enabled: k.enabled })) });
  const startedConnection = connection(p), startedModels = new Set(p.models.map(m => m.id));
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
      const models = list.slice(0, 10000).flatMap((x: any) => {
        const rawId = x?.id ?? x?.name;
        if (typeof rawId !== 'string') return [];
        const id = rawId.replace(/^models\//, '').trim();
        if (!id || id.length > 512 || /[\s\u0000-\u001f]/.test(id)) return [];
        const context = x.context_window ?? x.input_token_limit ?? x.inputTokenLimit;
        return [{ id, ...(Number.isSafeInteger(context) && context > 0 ? { contextWindow: context } : {}) }];
      });
      if (models.length) {
        // A network response must not restore a deleted provider or overwrite edits made while it was loading.
        const current = deps.store.getProvider(p.id);
        if (!current) return { ok: false, models: [], message: '供应商已删除，本次同步结果已丢弃' };
        if (connection(current) !== startedConnection) return { ok: false, models: current.models, message: '供应商连接配置已变化，请重新同步模型' };
        const merged = [...current.models];
        for (const m of models) {
          if (!merged.find((x) => x.id === m.id) && !(startedModels.has(m.id) && !current.models.some(x => x.id === m.id)))
            merged.push({
              id: m.id,
              contextWindow: m.contextWindow,
            });
        }
        try { if (merged.length !== current.models.length) deps.store.saveProvider({ ...current, models: merged }); }
        catch { return { ok: false, models: current.models, message: '模型已获取，但本地保存失败，请检查数据目录后重试' }; }
        return { ok: true, models: merged, added: merged.length - current.models.length };
      }
    } catch {
      continue;
    }
  }
  return { ok: false, models: deps.store.getProvider(p.id)?.models || [], message: '这家供应商没有公开的模型列表接口，请手动添加模型' };
}

export function summarizeUsage(records: UsageRecord[]) {
  const byDay = new Map<string, { cost: number; tokens: number; calls: number; unpricedCalls: number }>();
  const byProvider = new Map<string, { cost: number; tokens: number; calls: number; unpricedCalls: number; name: string }>();
  const byModel = new Map<string, { cost: number; tokens: number; calls: number; unpricedCalls: number }>();
  const byAgent = new Map<string, { calls: number; tokens: number }>();
  let totalIn = 0,
    totalOut = 0,
    totalCost = 0,
    totalCache = 0,
    totalCacheWrite = 0,
    cacheInput = 0,
    cacheReports = 0,
    cacheWriteReports = 0,
    errors = 0,
    unpricedCalls = 0;

  for (const r of records) {
    const day = r.ts.slice(0, 10);
    const tokens = r.inputTokens + r.outputTokens;
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
    const unknownPrice = r.costKnown === false && r.status >= 200 && r.status < 300 ? 1 : 0;
    const cost = r.costKnown === false ? 0 : r.cost;
    unpricedCalls += unknownPrice;
    totalCost += cost;
    totalCache += r.cacheRead || 0;
    totalCacheWrite += r.cacheWrite || 0;
    if (r.cacheWriteKnown || r.cacheWrite > 0) cacheWriteReports++;
    if (r.cacheReadKnown || r.cacheRead > 0) { cacheInput += r.inputTokens; cacheReports++; }
    if (r.error || r.status < 200 || r.status >= 400) errors++;
    const d = byDay.get(day) ?? { cost: 0, tokens: 0, calls: 0, unpricedCalls: 0 };
    byDay.set(day, { cost: d.cost + cost, tokens: d.tokens + tokens, calls: d.calls + 1, unpricedCalls: d.unpricedCalls + unknownPrice });
    const p = byProvider.get(r.providerId) ?? { cost: 0, tokens: 0, calls: 0, unpricedCalls: 0, name: r.providerName };
    byProvider.set(r.providerId, { cost: p.cost + cost, tokens: p.tokens + tokens, calls: p.calls + 1, unpricedCalls: p.unpricedCalls + unknownPrice, name: r.providerName });
    const mo = byModel.get(r.model) ?? { cost: 0, tokens: 0, calls: 0, unpricedCalls: 0 };
    byModel.set(r.model, { cost: mo.cost + cost, tokens: mo.tokens + tokens, calls: mo.calls + 1, unpricedCalls: mo.unpricedCalls + unknownPrice });
    const ag = byAgent.get(r.agent) ?? { calls: 0, tokens: 0 };
    byAgent.set(r.agent, { calls: ag.calls + 1, tokens: ag.tokens + tokens });
  }

  return {
    totals: {
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheRead: totalCache,
      cacheWrite: totalCacheWrite,
      cacheRate: cacheInput ? Math.min(1, totalCache / cacheInput) : 0,
      cacheReports,
      cacheWriteReports,
      cost: totalCost,
      unpricedCalls,
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
  if (action.startsWith('extension.')) return runExtensionAction(deps, action, payload);
  configureDesktopPath(store.readExtra<any>('extensions.json', {})?.connection?.exePath);
  if (action.startsWith('codex.repair.')) return runHistoryRepairAction(action, payload);
  if (action.startsWith('codex.indexRepair.')) return runSessionIndexRepairAction(action, payload);
  switch (action) {
    case 'state.get': {
      const catalog = await ensureCatalog(store);
      const { nativeCatalog: _native, ...codexCoexist } = getCoexistCatalog(store);
      const agents = store.listAgents();
      if (!agents['chatgpt-desktop'] && agents['codex-desktop']) store.saveAgent({ ...agents['codex-desktop'], id: 'chatgpt-desktop' });
      const localClients = getLocalClientsSnapshot(store), localWarnings = deps.localClientWarnings || [];
      return {
        settings: store.getSettings(),
        providers: store.listProviders(),
        localClients: { ...localClients, ok: localClients.ok && !localWarnings.length, warnings: [...localClients.warnings, ...localWarnings] },
        codexCoexist,
        groups: store.listGroups(),
        agents: store.listAgents(),
        plugins: store.listPlugins(),
        middlewareStatus: getMiddlewareStatus(store),
        presets: catalogPresets(store, catalog),
        catalog: { source: catalog.source, fetchedAt: catalog.fetchedAt, version: catalog.version, warning: catalog.warning, syncing: catalog.syncing },
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
        build: buildInfo,
        platform: deps.platform ?? process.platform,
        detected: detectAll(true),
        mode: deps.platform === 'web' ? 'web' : 'desktop',
      };
    }

    case 'provider.save':
      return store.saveProvider(payload);
    case 'model.batch.preview':
      return manageModels(store, payload);
    case 'model.batch.apply':
      return manageModels(store, payload, true);
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
    case 'localClients.scan':
    case 'localClients.restore': {
      if (deps.platform === 'web') return { ok: false, message: '请在电脑端检测与导入本地客户端配置' };
      return action === 'localClients.restore'
        ? restoreIgnoredLocalSource(store, String(payload.sourceId || ''), { gatewayUrl: deps.gatewayUrl() })
        : syncLocalClients(store, { force: true, gatewayUrl: deps.gatewayUrl() });
    }
    case 'cloud.catalog': {
      const data = payload.url && payload.url !== store.getSettings().catalogUrl
        ? await fetchCloudCatalog(payload.url, store)
        : payload.refresh ? await refreshCatalog(store) : await ensureCatalog(store);
      return { ok: true, ...data };
    }
    case 'cloud.import': {
      const items = payload.providers ?? [];
      const r = importCloudProviders(store, items);
      return { ok: true, added: r.added, merged: r.merged, count: r.providers.length };
    }
    case 'update.check': {
      try {
        return { ok: true, ...(await checkUpdate(deps.version ?? payload.current ?? '0.1.0', { platform: payload.platform, arch: payload.arch, source: payload.source, minimumVersion: payload.minimumVersion })) };
      } catch (e: any) {
        return { ok: false, message: String(e?.message ?? e), fallbackUrl: '', releaseUrl: GITHUB_RELEASE_PAGE };
      }
    }
    case 'account.scan':
      return { ok: true, accounts: getLocalClientsSnapshot(store).accounts };
    case 'account.import': {
      return { ok: false, message: '本机 API 配置已改为自动发现，请在“我的供应商”重新扫描。官方账号登录凭据不作为 API Key 导入。' };
    }

    /* ---------- Codex 增强 ---------- */
    case 'codex.diagnose':
      return diagnoseSessions();
    case 'codex.repairSessions':
      return { ok: false, message: '请使用历史会话中的批量修复，先预览范围后执行；旧版全库直接改写入口已停用。' };
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
      const sharedCodex = adapter.id === 'codex-cli' || adapter.id === 'chatgpt-desktop';
      const authMode = payload.authMode || 'api';
      if (!['api', 'coexist'].includes(authMode) || (authMode === 'coexist' && !sharedCodex)) return { ok: false, message: '此客户端不支持所选账号模式' };
      if (action === 'agent.parameters' && authMode === 'coexist') return { ok: false, message: '共存模式请通过配置向导应用；官方登录由原客户端使用，不导出登录凭据。' };
      const coexist = authMode === 'coexist' ? getCoexistCatalog(store) : undefined;
      if (coexist && !coexist.officialModelCount) return { ok: false, message: coexist.warnings[0] || '请先在官方客户端登录并加载模型列表，再开启共存模式。' };
      if (coexist && !['127.0.0.1', '0.0.0.0', '::'].includes(store.getSettings().gatewayHost)) return { ok: false, message: '共存模式需要本机网关。请在系统设置中选择“仅本机”或“局域网”监听范围。' };
      const provider = sharedCodex && authMode === 'coexist' && payload.providerId === 'official' ? {
        id: 'official', name: 'ChatGPT 官方账号', format: 'openai-responses' as const, baseUrl: 'https://chatgpt.com/backend-api/codex',
        apiKeys: [], models: coexist!.models.filter(m => m.official).map(m => ({ id: m.upstreamModel, displayName: m.displayName, contextWindow: m.contextWindow })),
        enabled: true, priority: 0, createdAt: '', updatedAt: '',
      } : store.getProvider(String(payload.providerId || ''));
      if (!provider) return { ok: false, message: '请选择有效供应商' };
      if (payload.mode && !['gateway', 'direct'].includes(payload.mode)) return { ok: false, message: '不支持的接入模式' };
      const states = store.listAgents();
      const prior = states[adapter.id] || (sharedCodex ? states['codex-cli'] || states['chatgpt-desktop'] || states['codex-desktop'] : undefined);
      const context: ConnectContext = {
        provider, model: String(payload.model || provider.models[0]?.id || ''), modelMap: payload.modelMap,
        mode: payload.mode || 'gateway', gatewayUrl: deps.gatewayUrl(), token: store.getSettings().gatewayToken,
        previousBackup: prior?.connected || prior?.pendingReapply ? prior.backupPath : undefined,
        expectedRevision: payload.revision,
        authMode, modelCatalogPath: path.join(store.dir, 'codex-model-catalog.json'),
      };
      const preview = adapter.preview(context);
      if (action === 'agent.preview' || !preview.ok) return preview;
      if (action === 'agent.parameters') return { ok: true, ...connectionParameters(context, adapter.protocol), script: exportEnvScript(context, adapter.protocol), note: adapter.supportNote };
      if (context.mode === 'gateway' && !deps.gatewayStatus().running) return { ok: false, message: '本地网关未运行，请先启动网关后再应用配置' };
      if (context.expectedRevision && context.expectedRevision !== preview.revision) return { ok: false, message: '配置或连接参数在预览后已变化，请重新预览再应用' };
      context.expectedRevision = preview.revision;
      const catalogFile = context.modelCatalogPath!;
      let clientBefore: ClientFileSnapshot[], catalogBefore: ClientFileSnapshot[];
      try {
        clientBefore = snapshotClientFiles(adapter.configPaths());
        catalogBefore = coexist ? snapshotClientFiles([catalogFile]) : [];
      } catch { return { ok: false, message: '无法安全读取本次操作前的配置，未应用连接。请检查客户端配置与云桥数据目录权限。' }; }
      const catalogExpected = coexist ? new Map([[catalogFile, { existed: true, hash: digest(JSON.stringify(coexist.nativeCatalog, null, 2)) }]]) : new Map<string, ClientFileExpected>();
      if (coexist) {
        try { store.writeExtra('codex-model-catalog.json', coexist.nativeCatalog); }
        catch { return clientStateFailure(catalogBefore, catalogExpected, prior?.backupPath, '无法保存共存模型目录'); }
      }
      const result = adapter.connect(context);
      if (coexist && !result.ok) {
        const failed = rollbackClientFiles(catalogBefore, catalogExpected);
        if (failed.length) return { ...result, message: `${result.message}；模型目录无法自动回滚或已被其他程序修改，请手动检查：${failed.join('、')}` };
      }
      if (result.ok) {
        const ids = sharedCodex ? (['codex-cli', 'chatgpt-desktop', 'codex-desktop'] as const) : [adapter.id];
        let expected = new Map(catalogExpected);
        try {
          expected = new Map([...clientManifestExpected(result.backup, clientBefore), ...catalogExpected]);
          store.saveAgents(ids.map(id => ({ id, connected: true, pendingReapply: false, providerId: provider.id, model: context.model, modelMap: context.modelMap, mode: context.mode, authMode, configPath: result.path, backupPath: result.backup })));
        } catch { return clientStateFailure([...clientBefore, ...catalogBefore], expected, result.backup); }
      }
      return result;
    }
    case 'agent.disconnect': {
      const adapter = getAdapter(String(payload.agentId || ''));
      if (!adapter) return { ok: false, message: '未知客户端' };
      const current = store.listAgents()[adapter.id];
      if (!current?.backupPath) return adapter.disconnect();
      let before: ClientFileSnapshot[], expected: Map<string, ClientFileExpected>;
      try {
        before = snapshotClientFiles(adapter.configPaths());
        expected = clientManifestExpected(current.backupPath, before, true);
      } catch { return { ok: false, message: '无法安全读取当前配置或原始备份，未断开连接。请检查客户端配置与备份目录权限。' }; }
      const result = adapter.disconnect(current?.backupPath);
      if (result.ok) {
        const ids = adapter.id === 'codex-cli' || adapter.id === 'chatgpt-desktop' ? (['codex-cli', 'chatgpt-desktop', 'codex-desktop'] as const) : [adapter.id];
        try { store.saveAgents(ids.map(id => ({ id, connected: false, pendingReapply: false, backupPath: undefined }))); }
        catch { return clientStateFailure(before, expected, current.backupPath); }
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
    case 'usage.live':
      return activeRequests(store);
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


