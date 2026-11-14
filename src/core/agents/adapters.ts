import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId, Provider } from '../store/types.js';
import { nowIso } from '../util.js';
import { applyPlan, restorePlan, jsonObject, planned, plannedJson, readText, patchToml, patchEnv, redactConfig, digest, type PlannedFile } from './configFiles.js';

export interface ConnectContext {
  provider: Provider;
  model: string;
  modelMap?: Record<string, string>;
  gatewayUrl: string;
  mode: 'gateway' | 'direct';
  token?: string;
  previousBackup?: string;
  expectedRevision?: string;
}
export interface ConnectResult { ok: boolean; path?: string; backup?: string; message: string; restartRequired?: boolean; extraFiles?: string[] }
export interface ConnectPreview { ok: boolean; message: string; files: PlannedFile[]; warnings: string[]; requiresRestart: boolean; revision?: string; manual?: { baseUrl: string; apiKey: string; model: string } }
export interface AgentDetection { installed: boolean; configured: boolean; command?: string; configPath?: string; version?: string }
export interface AgentAdapter {
  id: AgentId; name: string; vendor: string; description: string; needsInstall: boolean; protocol: string; hotSwitch: boolean;
  support: 'automatic' | 'manual' | 'unsupported'; category: 'cli' | 'desktop' | 'service'; supportNote: string; docsUrl: string;
  configPaths(): string[];
  preview(ctx: ConnectContext): ConnectPreview;
  connect(ctx: ConnectContext): ConnectResult;
  disconnect(backupPath?: string): ConnectResult;
  detect(): AgentDetection;
  launchHint(model: string): string;
}

// Isolated client profile for portable deployments and integration tests.
function home(...parts: string[]): string { return path.join(process.env.AURORA_CLIENT_HOME || os.homedir(), ...parts); }
function envDir(name: string, fallback: string): string { return process.env.AURORA_CLIENT_HOME ? fallback : process.env[name] || fallback; }
function localData(): string { return envDir('LOCALAPPDATA', home('AppData', 'Local')); }
function cliPath(command: string): string | undefined {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    if (!folder) continue;
    for (const ext of extensions) {
      const candidate = path.join(folder, command + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* continue */ }
    }
  }
  return undefined;
}
function desktopPath(name: string): string | undefined {
  const candidates = process.platform === 'win32' ? [
    path.join(localData(), 'Programs', name, `${name}.exe`), path.join(localData(), name, `${name}.exe`),
    path.join(localData(), 'OpenAI', name, `${name}.exe`), path.join(localData(), 'Microsoft', 'WindowsApps', `${name}.exe`),
    path.join(envDir('APPDATA', home('AppData', 'Roaming')), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`),
  ] : process.platform === 'darwin' ? [`/Applications/${name}.app`, home('Applications', `${name}.app`)] : [home('.local', 'bin', name.toLowerCase())];
  return candidates.find(p => fs.existsSync(p));
}
function codexConfig(): string { return path.join(envDir('CODEX_HOME', home('.codex')), 'config.toml'); }
function claudeCodeConfig(): string { return path.join(envDir('CLAUDE_CONFIG_DIR', home('.claude')), 'settings.json'); }

export function connectionParameters(ctx: ConnectContext, protocol: string): { baseUrl: string; apiKey: string; model: string } {
  const url = new URL(ctx.mode === 'gateway' ? ctx.gatewayUrl : ctx.provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('接口地址必须是 HTTP(S) URL，且不能包含账号密码');
  let baseUrl = url.toString().replace(/\/+$/, '');
  if (protocol === 'openai-chat' || protocol === 'openai-responses') {
    if (ctx.mode === 'gateway' || !new URL(baseUrl).pathname.replace(/\//g, '')) baseUrl += '/v1';
  }
  const apiKey = ctx.mode === 'gateway' ? ctx.token || '' : ctx.provider.apiKeys.find(k => k.enabled && k.key)?.key || '';
  if (ctx.mode === 'gateway' && !apiKey) throw new Error('本地网关令牌尚未生成，请先启动网关');
  if (/\r|\n/.test(apiKey) || /[\r\n\u0000]/.test(ctx.model)) throw new Error('密钥或模型名不能包含换行符');
  return { baseUrl, apiKey, model: ctx.mode === 'gateway' ? `${ctx.provider.id}/${ctx.model}` : ctx.model };
}
function validate(ctx: ConnectContext, adapter: AgentAdapter): void {
  if (ctx.mode !== 'gateway' && ctx.mode !== 'direct') throw new Error('不支持的接入模式');
  if (!ctx.model?.trim()) throw new Error('请选择模型');
  if (!ctx.provider.enabled) throw new Error('请先启用供应商');
  const providerHost = new URL(ctx.provider.baseUrl).hostname;
  if (!ctx.provider.apiKeys.some(k => k.enabled && k.key) && !['localhost', '127.0.0.1', '[::1]'].includes(providerHost)) throw new Error('请先填写并启用供应商 API Key');
  if (!ctx.provider.models.some(m => m.id === ctx.model)) throw new Error('此模型不在所选供应商的模型列表中');
  if (ctx.mode === 'direct' && ctx.provider.format !== adapter.protocol) throw new Error('直连模式要求供应商与客户端协议一致；请选择本地网关接入');
  for (const [role, model] of Object.entries(ctx.modelMap || {})) {
    if (!['sonnet', 'opus', 'haiku'].includes(role) || !ctx.provider.models.some(m => m.id === model)) throw new Error('模型映射必须使用当前供应商已有的模型');
  }
  connectionParameters(ctx, adapter.protocol);
}
function planRevision(files: PlannedFile[]): string { return digest(JSON.stringify(files.map(f => [f.path, f.existed, digest(f.before), digest(f.after)]))); }

type AdapterSpec = Pick<AgentAdapter, 'id' | 'name' | 'vendor' | 'description' | 'protocol' | 'support' | 'category' | 'supportNote' | 'docsUrl'> & {
  paths?: () => string[]; command?: string; desktop?: string; hint?: string; plan?: (ctx: ConnectContext) => PlannedFile[]; warnings?: string[];
};
function makeAdapter(spec: AdapterSpec): AgentAdapter {
  const adapter: AgentAdapter = {
    ...spec, needsInstall: spec.category !== 'service', hotSwitch: false,
    configPaths: spec.paths || (() => []), launchHint: () => spec.hint || `完全退出并重新启动 ${spec.name}`,
    detect() {
      const command = spec.command ? cliPath(spec.command) : spec.desktop ? desktopPath(spec.desktop) : undefined;
      return { installed: !!command, configured: this.configPaths().some(p => fs.existsSync(p)), command, configPath: this.configPaths()[0] };
    },
    preview(ctx) {
      const base = { files: [], warnings: [...(spec.warnings || [])], requiresRestart: spec.support === 'automatic' };
      if (spec.support === 'unsupported') return { ...base, ok: false, message: spec.supportNote };
      try {
        validate(ctx, this);
        if (spec.support === 'manual') return { ...base, ok: true, message: spec.supportNote, manual: { ...connectionParameters(ctx, this.protocol), apiKey: '••••••••' } };
        const files = spec.plan!(ctx);
        return { ...base, ok: true, message: '将先备份现有配置，再应用以下变更。预览中的密钥已隐藏。', revision: planRevision(files), files: files.map(f => ({ ...f, before: redactConfig(f.before), after: redactConfig(f.after) })) };
      } catch (error) { return { ...base, ok: false, message: String((error as Error).message) }; }
    },
    connect(ctx) {
      if (spec.support !== 'automatic') return { ok: false, message: spec.supportNote };
      try {
        validate(ctx, this);
        const files = spec.plan!(ctx);
        if (ctx.expectedRevision && ctx.expectedRevision !== planRevision(files)) throw new Error('配置或连接参数在预览后已变化，请重新预览再应用');
        const backup = applyPlan(this.id.startsWith('codex-') ? 'codex-cli' : this.id, files, ctx.previousBackup);
        detectReset();
        return { ok: true, path: files[0].path, backup, extraFiles: files.slice(1).map(f => f.path), restartRequired: true, message: `${spec.name} 配置已保存并备份。${this.launchHint(ctx.model)}。` };
      } catch (error) { return { ok: false, message: String((error as Error).message) }; }
    },
    disconnect(backup) {
      if (spec.support !== 'automatic') return { ok: false, message: '此客户端没有由云桥写入的配置' };
      try { restorePlan(this.id.startsWith('codex-') ? 'codex-cli' : this.id, backup, this.configPaths()); detectReset(); return { ok: true, message: `已恢复首次接入前的 ${spec.name} 配置，请重新启动客户端。`, restartRequired: true }; }
      catch (error) { return { ok: false, message: String((error as Error).message) }; }
    },
  };
  return adapter;
}

const claudeCode = makeAdapter({
  id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', category: 'cli', support: 'automatic', protocol: 'anthropic',
  description: 'Anthropic 编程助手，支持国内外模型通过本地网关接入。', supportNote: '写入用户级 settings.json 的端点、密钥和模型；保留权限、MCP、插件等设置。',
  docsUrl: 'https://code.claude.com/docs/en/llm-gateway', command: 'claude', paths: () => [claudeCodeConfig()], hint: '新开终端或重新启动 Claude Code',
  warnings: ['项目级配置、系统环境变量和组织策略可能覆盖用户级设置；正在运行的会话请重启后验证。'],
  plan(ctx) {
    const file = claudeCodeConfig(), settings = jsonObject(file), ep = connectionParameters(ctx, 'anthropic');
    if (settings.env && (typeof settings.env !== 'object' || Array.isArray(settings.env))) throw new Error('Claude Code env 必须是对象');
    settings.env = { ...(settings.env || {}), ANTHROPIC_BASE_URL: ep.baseUrl, ANTHROPIC_AUTH_TOKEN: ep.apiKey, ANTHROPIC_MODEL: ep.model };
    delete settings.env.ANTHROPIC_API_KEY;
    for (const role of ['opus', 'sonnet', 'haiku']) { const model = ctx.modelMap?.[role] || ctx.model; settings.env[`ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`] = ctx.mode === 'gateway' ? `${ctx.provider.id}/${model}` : model; }
    return [plannedJson(file, settings)];
  },
});
function codexPlan(ctx: ConnectContext): PlannedFile[] {
  const file = codexConfig(), ep = connectionParameters(ctx, 'openai-responses');
  let text = patchToml(readText(file), '', { model: ep.model, model_provider: 'aurora' });
  text = patchToml(text, 'model_providers.aurora', { name: '云桥 AI', base_url: ep.baseUrl, wire_api: 'responses', experimental_bearer_token: ep.apiKey, env_key: null, requires_openai_auth: false, stream_idle_timeout_ms: 300000 });
  return [planned(file, text)];
}
const codexCli = makeAdapter({
  id: 'codex-cli', name: 'Codex CLI', vendor: 'OpenAI', category: 'cli', support: 'automatic', protocol: 'openai-responses', description: 'OpenAI 终端编程助手，使用 Responses 协议。',
  supportNote: '配置独立的 aurora provider，保留账号登录态和其他 TOML 配置。', docsUrl: 'https://developers.openai.com/codex/config-reference', command: 'codex', paths: () => [codexConfig()], hint: '完全退出后重新运行 codex', plan: codexPlan,
  warnings: ['Codex CLI 与 Codex 桌面共享用户级配置；当前 profile 或项目配置可能覆盖此设置。'],
});
const codexDesktop = makeAdapter({
  id: 'codex-desktop', name: 'Codex 桌面版', vendor: 'OpenAI', category: 'desktop', support: 'automatic', protocol: 'openai-responses', description: 'OpenAI 编程桌面客户端，与 Codex CLI 共用模型供应商设置。',
  supportNote: '接入自定义 Responses 供应商；与 ChatGPT 日常聊天桌面应用是不同产品。', docsUrl: 'https://developers.openai.com/codex/config-reference', desktop: 'Codex', paths: () => [codexConfig()], hint: '完全退出 Codex（包括托盘）后重新打开', plan: codexPlan,
  warnings: ['此变更也会影响 Codex CLI；切换供应商后部分历史会话可能被客户端按 provider 筛选，可到历史会话页查看。'],
});
const DESKTOP_PROFILE = '753cb857-baa9-45ce-a04b-000000003425';
function desktopConfigPaths(): string[] {
  const root = process.platform === 'win32' ? localData() : process.platform === 'darwin' ? home('Library', 'Application Support') : envDir('XDG_CONFIG_HOME', home('.config'));
  return [path.join(root, 'Claude', 'claude_desktop_config.json'), path.join(root, 'Claude-3p', 'claude_desktop_config.json'), path.join(root, 'Claude-3p', 'configLibrary', '_meta.json'), path.join(root, 'Claude-3p', 'configLibrary', `${DESKTOP_PROFILE}.json`)];
}
const claudeDesktop = makeAdapter({
  id: 'claude-desktop', name: 'Claude 桌面版', vendor: 'Anthropic', category: 'desktop', support: 'automatic', protocol: 'anthropic', description: '通过支持第三方配置的 Claude Desktop 版本接入模型网关。',
  supportNote: '使用 Claude Desktop 的 3P profile；Sonnet、Opus、Haiku 可映射为国内外模型。需要支持 Gateway 的新版客户端。',
  docsUrl: 'https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/zh/2-providers/2.6-claude-desktop.md', desktop: 'Claude', paths: desktopConfigPaths,
  warnings: ['仅适用于支持 3P / Gateway 的 Claude Desktop 版本；旧版不会读取此配置。', '模型映射模式使用期间需保持云桥网关运行。客户端功能也取决于上游模型能力。'],
  plan(ctx) {
    const [normal, thirdParty, metaFile, profileFile] = desktopConfigPaths(), ep = connectionParameters(ctx, 'anthropic');
    if (ctx.mode === 'direct' && !/^(?:anthropic\/)?claude-(?:sonnet|opus|haiku)-/.test(ctx.model)) throw new Error('Claude Desktop 直连需要可识别的 Claude 角色模型；其他模型请选择网关接入');
    const main = jsonObject(normal); main.deploymentMode = '3p';
    const third = jsonObject(thirdParty); third.deploymentMode = '3p';
    const meta = jsonObject(metaFile);
    if (meta.entries && !Array.isArray(meta.entries)) throw new Error('Claude Desktop profile 索引 entries 不是数组');
    meta.entries = (meta.entries || []).filter((x: any) => x?.id !== DESKTOP_PROFILE); meta.entries.push({ id: DESKTOP_PROFILE, name: '云桥 AI' }); meta.appliedId = DESKTOP_PROFILE;
    const profile = jsonObject(profileFile);
    Object.assign(profile, { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: ctx.mode === 'gateway' ? ep.baseUrl + '/claude-desktop' : ep.baseUrl, inferenceGatewayAuthScheme: 'bearer', inferenceGatewayApiKey: ep.apiKey,
      inferenceModels: ctx.mode === 'gateway' ? ['sonnet', 'opus', 'haiku'].map(role => ({ name: `claude-${role}-aurora`, labelOverride: `${ctx.provider.name} · ${ctx.modelMap?.[role] || ctx.model}` })) : [ctx.model] });
    return [plannedJson(normal, main), plannedJson(thirdParty, third), plannedJson(metaFile, meta), plannedJson(profileFile, profile)];
  },
});
const geminiCli = makeAdapter({
  id: 'gemini-cli', name: 'Gemini CLI', vendor: 'Google', category: 'cli', support: 'automatic', protocol: 'gemini', description: 'Google 终端助手，通过 Gemini 原生 API 或网关使用模型。',
  supportNote: '写入官方支持的用户级 .gemini/.env 与 API Key 身份设置。', docsUrl: 'https://geminicli.com/docs/reference/configuration/', command: 'gemini', paths: () => [home('.gemini', 'settings.json'), home('.gemini', '.env')],
  warnings: ['当前终端已有环境变量或项目 .env 可能覆盖用户级 .env；接入后请新开终端。'],
  plan(ctx) {
    const [file, envFile] = [home('.gemini', 'settings.json'), home('.gemini', '.env')], settings = jsonObject(file), ep = connectionParameters(ctx, 'gemini');
    settings.security = { ...(settings.security || {}), auth: { ...(settings.security?.auth || {}), selectedType: 'gemini-api-key' } }; settings.model = { ...(settings.model || {}), name: ep.model };
    return [plannedJson(file, settings), planned(envFile, patchEnv(readText(envFile), { GOOGLE_GEMINI_BASE_URL: ep.baseUrl, GEMINI_API_KEY: ep.apiKey, GEMINI_MODEL: ep.model }))];
  },
});
const manualSpecs: AdapterSpec[] = [
  { id: 'workbuddy', name: 'WorkBuddy / CodeBuddy', vendor: '腾讯', category: 'desktop', protocol: 'openai-chat', support: 'manual', desktop: 'WorkBuddy', description: '腾讯 AI 工作助手，提供适配供应商的连接参数。', supportNote: '不同版本的自定义模型入口和协议支持有差异。请在客户端支持的自定义模型页面填写参数，云桥不写入未经验证的配置字段。', docsUrl: 'https://www.codebuddy.ai/' },
  { id: 'deepseek', name: 'DeepSeek API / 兼容客户端', vendor: '深度求索', category: 'service', protocol: 'openai-chat', support: 'manual', description: '为支持 OpenAI 兼容接口的客户端生成 DeepSeek 等模型的连接参数。', supportNote: 'DeepSeek 是模型服务。可把参数填入支持自定义接口的应用；不会替换 DeepSeek 官方网页或 App 的模型。', docsUrl: 'https://api-docs.deepseek.com/' },
  { id: 'qwen-code', name: 'Qwen Code', vendor: '阿里云', category: 'cli', protocol: 'openai-chat', support: 'manual', command: 'qwen', description: '通义千问终端编程助手，提供 OpenAI 兼容接入参数。', supportNote: '按当前版本官方文档设置 OPENAI_BASE_URL、OPENAI_API_KEY 和模型；设置完请在客户端选择对应身份方式。', docsUrl: 'https://qwenlm.github.io/qwen-code-docs/' },
  { id: 'kimi-code', name: 'Kimi Code', vendor: '月之暗面', category: 'cli', protocol: 'openai-chat', support: 'manual', command: 'kimi', description: 'Kimi 编程助手，可按官方模型配置接入。', supportNote: '使用 Kimi Code 当前版本的 /setup 或模型配置入口；请核实它接受的供应商协议。', docsUrl: 'https://moonshotai.github.io/kimi-cli/' },
  { id: 'opencode', name: 'OpenCode', vendor: 'OpenCode', category: 'cli', protocol: 'openai-chat', support: 'manual', command: 'opencode', description: '开放的编程助手，可使用自定义 OpenAI 兼容供应商。', supportNote: '在 opencode.json 的 provider 中使用 @ai-sdk/openai-compatible，填写 baseURL、apiKey 和模型。现有 JSONC 配置请在客户端中维护。', docsUrl: 'https://opencode.ai/docs/providers/' },
  { id: 'chatgpt-desktop', name: 'ChatGPT 桌面版', vendor: 'OpenAI', category: 'desktop', protocol: 'openai-responses', support: 'unsupported', desktop: 'ChatGPT', description: 'OpenAI 官方聊天应用，使用自己的账号和订阅服务。', supportNote: '尚无可核实的第三方模型端点配置入口。管理 OpenAI API 供应商请使用 Codex 或支持自定义 API 的客户端；API 与 ChatGPT 订阅分别计费。', docsUrl: 'https://chatgpt.com/download/' },
  { id: 'zcode', name: 'ZCode', vendor: 'ZCode', category: 'cli', protocol: 'openai-chat', support: 'manual', command: 'zcode', description: '提供标准 API 连接参数，由客户端自定义模型入口接入。', supportNote: '该客户端版本和配置格式尚未验证，云桥只生成参数，不自动改写配置。', docsUrl: '' },
  { id: 'antigravity', name: 'Antigravity', vendor: 'Google', category: 'desktop', protocol: 'gemini', support: 'unsupported', desktop: 'Antigravity', description: 'Google 编程产品。', supportNote: '尚未验证其第三方网关配置机制，不能把 Gemini CLI 环境变量当作该产品支持的配置。', docsUrl: 'https://antigravity.google/' },
];
export const AGENT_ADAPTERS: AgentAdapter[] = [claudeCode, claudeDesktop, codexCli, codexDesktop, geminiCli, ...manualSpecs.map(makeAdapter)];
export function getAdapter(id: string): AgentAdapter | undefined { return AGENT_ADAPTERS.find(a => a.id === id); }
let detectCache: { at: number; data: Record<string, AgentDetection> } | null = null;
export function detectAll(_fast = false): Record<string, AgentDetection> {
  if (detectCache && Date.now() - detectCache.at < 60_000) return detectCache.data;
  const data: Record<string, AgentDetection> = {};
  for (const adapter of AGENT_ADAPTERS) { try { data[adapter.id] = adapter.detect(); } catch { data[adapter.id] = { installed: false, configured: false }; } }
  detectCache = { at: Date.now(), data }; return data;
}
export function detectReset(): void { detectCache = null; }
export function exportEnvScript(ctx: ConnectContext, protocol: string): string {
  const ep = connectionParameters(ctx, protocol);
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const prefix = process.platform === 'win32' ? '$env:' : 'export ';
  const literal = process.platform === 'win32' ? (value: string) => `'${value.replace(/'/g, "''")}'` : quote;
  const values: Record<string, string> = protocol === 'anthropic' ? { ANTHROPIC_BASE_URL: ep.baseUrl, ANTHROPIC_AUTH_TOKEN: ep.apiKey, ANTHROPIC_MODEL: ep.model } : protocol === 'gemini' ? { GOOGLE_GEMINI_BASE_URL: ep.baseUrl, GEMINI_API_KEY: ep.apiKey, GEMINI_MODEL: ep.model } : { OPENAI_BASE_URL: ep.baseUrl, OPENAI_API_KEY: ep.apiKey, OPENAI_MODEL: ep.model };
  return [`# 云桥 AI · 当前终端环境变量 (${nowIso()})`, ...Object.entries(values).map(([key, value]) => `${prefix}${key}=${literal(value)}`)].join('\n');
}
