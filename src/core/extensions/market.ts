import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import type { AuroraStore } from '../store/index.js';
import { atomicWrite, applyPlan, patchToml, planned, readText } from '../agents/configFiles.js';

export type MarketSource = 'public' | 'full';
export interface MarketEntry { id: string; name: string; displayName: string; description: string; version: string; author: string; tags: string[]; license: string; path: string; tree: string; bytes: number; skills: number; requiresAuth: boolean }
export interface MarketIndex { schemaVersion: number; repository: string; revision: string; updatedAt: string; plugins: MarketEntry[] }
export interface NativeInstall { source: MarketSource; id: string; name: string; version: string; tree: string; revision: string; enabled: boolean; installedAt: string; license: string }
export const REPOSITORIES = { public: 'BigPizzaV3/CodexPlusPlusPluginCache', full: 'BigPizzaV3/CodexPlusPlusFullPluginCache' };
export function resourceRoot(): string {
  const resourcePath = (process as any).resourcesPath;
  const roots = [process.env.AURORA_EXTENSION_ASSETS, resourcePath && path.join(resourcePath, 'codexplusplus'), path.join(process.cwd(), 'third_party', 'codexplusplus')].filter(Boolean) as string[];
  const root = roots.find(p => fs.existsSync(path.join(p, 'UPSTREAM.json'))); if (!root) throw new Error('未找到 CodexPlusPlus 扩展资源，请重新安装云桥'); return root;
}
export function safeRelative(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f:*?"<>|]/.test(value) || value.startsWith('/') || value.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s) || s.toLowerCase() === '.git')) throw new Error('插件包含不安全的文件路径');
  if (value.split('/').some(s => /^\.env(?:\.|$)/i.test(s) && !/\.(?:example|sample|template)$/i.test(s))) throw new Error('插件包不能包含环境密钥文件');
  return value;
}
export function validateIndex(value: any, source: MarketSource): MarketIndex {
  if (!value || value.schemaVersion !== 1 || value.repository !== REPOSITORIES[source] || !/^[a-f0-9]{40}$/.test(value.revision) || !Array.isArray(value.plugins) || value.plugins.length > 20_000) throw new Error('插件目录格式或来源无效');
  const ids = new Set<string>();
  for (const p of value.plugins) {
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9._~-]{1,150}$/.test(p.id) || ids.has(p.id) || !/^[a-zA-Z0-9._-]{1,150}$/.test(p.name) || !/^[a-zA-Z0-9._+-]{1,150}$/.test(p.version) || !/^[a-f0-9]{40}$/.test(p.tree)) throw new Error('插件目录包含无效或重复项目');
    safeRelative(p.name); safeRelative(p.version); safeRelative(p.path); ids.add(p.id);
  }
  return value;
}
async function download(url: string, max: number): Promise<Buffer> {
  const u = new URL(url); if (u.protocol !== 'https:' || !['raw.githubusercontent.com', 'api.github.com'].includes(u.hostname)) throw new Error('插件来源必须是配置的 GitHub 公开仓库');
  const r = await fetch(u, { signal: AbortSignal.timeout(45000), redirect: 'error', headers: { 'User-Agent': 'Aurora-Desktop-Extensions', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`插件下载失败：HTTP ${r.status}${r.status === 403 ? '，GitHub 公开 API 可能达到速率限制，请稍后重试' : ''}`);
  if (Number(r.headers.get('content-length')) > max) throw new Error('插件文件超过大小限制');
  if (!r.body) throw new Error('插件下载为空'); const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of r.body as any) { total += chunk.length; if (total > max) throw new Error('插件文件超过大小限制'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export function loadIndex(store: AuroraStore, source: MarketSource): MarketIndex {
  if (!Object.hasOwn(REPOSITORIES, source)) throw new Error('未知插件市场');
  const cached = store.readExtra<any>(`extension-catalog-${source}.json`, null);
  if (cached) try { return validateIndex(cached, source); } catch { /* Packaged snapshot remains available. */ }
  return validateIndex(JSON.parse(fs.readFileSync(path.join(resourceRoot(), 'catalog', `${source}.json`), 'utf8')), source);
}
export async function refreshIndex(store: AuroraStore, source: MarketSource): Promise<MarketIndex> {
  if (!Object.hasOwn(REPOSITORIES, source)) throw new Error('未知插件市场');
  const data = await download(`https://raw.githubusercontent.com/${REPOSITORIES[source]}/main/plugin-index.json`, 24 * 1024 * 1024);
  const index = validateIndex(JSON.parse(data.toString('utf8')), source); store.writeExtra(`extension-catalog-${source}.json`, index); return index;
}
export function gitBlobHash(data: Buffer): string { return createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex'); }
export interface GitEntry { path: string; mode: string; type: string; sha: string; size?: number }
export function verifyTree(entries: GitEntry[], expected: string): GitEntry[] {
  const seen = new Set<string>(); let total = 0;
  if (entries.length > 5000) throw new Error('插件文件过多');
  for (const e of entries) {
    safeRelative(e.path); const fold = e.path.toLowerCase(); if (seen.has(fold)) throw new Error('插件路径存在大小写冲突'); seen.add(fold);
    if (!/^[a-f0-9]{40}$/.test(e.sha) || !((e.type === 'blob' && ['100644', '100755'].includes(e.mode)) || (e.type === 'tree' && e.mode === '040000'))) throw new Error('插件包含符号链接、子模块或未知文件类型');
    if (e.type === 'blob') { if (!Number.isSafeInteger(e.size) || e.size! < 0 || e.size! > 16 * 1024 * 1024) throw new Error('插件文件大小无效'); total += e.size!; }
  }
  if (total > 64 * 1024 * 1024) throw new Error('插件包超过 64 MB 限制');
  function treeHash(prefix: string): string {
    const children = entries.filter(e => path.posix.dirname(e.path) === (prefix || '.')).sort((a, b) => Buffer.compare(Buffer.from(path.posix.basename(a.path) + (a.type === 'tree' ? '/' : '')), Buffer.from(path.posix.basename(b.path) + (b.type === 'tree' ? '/' : ''))));
    const records = children.map(e => { const sha = e.type === 'tree' ? treeHash(e.path) : e.sha; if (sha !== e.sha) throw new Error('插件目录校验失败'); return Buffer.concat([Buffer.from(`${e.type === 'tree' ? '40000' : e.mode} ${path.posix.basename(e.path)}\0`), Buffer.from(sha, 'hex')]); });
    const data = Buffer.concat(records); return createHash('sha1').update(Buffer.from(`tree ${data.length}\0`)).update(data).digest('hex');
  }
  for (const e of entries) { const parent = path.posix.dirname(e.path); if (parent !== '.' && !entries.some(p => p.type === 'tree' && p.path === parent)) throw new Error('插件目录缺少父节点'); }
  if (treeHash('') !== expected) throw new Error('插件目录哈希与索引不一致'); return entries.filter(e => e.type === 'blob');
}
function codexHome(): string { return process.env.AURORA_CLIENT_HOME ? path.join(process.env.AURORA_CLIENT_HOME, '.codex') : process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
export function marketName(source: MarketSource, id: string): string { return `aurora-plugin-${createHash('sha256').update(`${source}:${id}`).digest('hex').slice(0, 16)}`; }
function marketRoot(store: AuroraStore, source: MarketSource, id: string): string { return path.join(store.dir, 'extensions', 'native', marketName(source, id)); }
export function packageRoot(store: AuroraStore, p: NativeInstall): string { return path.join(marketRoot(store, p.source, p.id), 'packages', p.name, p.version); }
export function installedPlugins(store: AuroraStore): Record<string, NativeInstall> { return store.readExtra('extension-native.json', {}); }
export function nativeKey(source: MarketSource, id: string): string { return `${source}:${id}`; }
function patchRegistration(store: AuroraStore, entry: NativeInstall, enabled: boolean, remove = false, marketManifest?: unknown): void {
  const market = marketName(entry.source, entry.id); const file = path.join(codexHome(), 'config.toml');
  const plan = planned(file, '');
  let config = plan.before; config = patchToml(config, `marketplaces.${market}`, { source_type: remove ? null : 'local', source: remove ? null : marketRoot(store, entry.source, entry.id) });
  config = patchToml(config, `plugins.${JSON.stringify(`${entry.name}@${market}`)}`, { enabled: remove ? null : enabled });
  plan.after = config;
  const files = [plan];
  if (marketManifest) files.push(planned(path.join(marketRoot(store, entry.source, entry.id), '.agents', 'plugins', 'marketplace.json'), JSON.stringify(marketManifest, null, 2)));
  applyPlan(`plugin-${market}`, files);
}
const installJobs = new Map<string, Promise<NativeInstall>>();
const installFailures = new Map<string, string>();
const jobKey = (store: AuroraStore, source: MarketSource, id: string) => `${store.dir}:${source}:${id}`;
export function installNative(store: AuroraStore, source: MarketSource, id: string): Promise<NativeInstall> {
  const key = jobKey(store, source, id); const existing = installJobs.get(key); if (existing) return existing;
  installFailures.delete(key);
  const job = doInstallNative(store, source, id).catch(error => { installFailures.set(key, (error as Error).message); throw error; }).finally(() => installJobs.delete(key));
  installJobs.set(key, job); return job;
}
export function nativeInstallStatus(store: AuroraStore, source: MarketSource, id: string): any {
  const key = jobKey(store, source, id),busy = installJobs.has(key),record = installedPlugins(store)[nativeKey(source,id)];
  const failure = installFailures.get(key);
  return { status: failure ? 'failed' : 'ok', source, id, busy, stage: busy ? 'downloading' : failure || !record ? 'failed' : 'complete', message: failure || (record ? '插件已安装，可在云桥启用后重启客户端' : '没有安装记录'), installedVersion: record?.version,
    plugin: record ? { ...record, installed: true, installedVersion: record.version } : undefined, nativeResult: record ? { appsNeedingAuth: [], authPolicy: 'ON_USE' } : undefined, restartRequired: true };
}
async function doInstallNative(store: AuroraStore, source: MarketSource, id: string): Promise<NativeInstall> {
  const index = loadIndex(store, source); const p = index.plugins.find(x => x.id === id); if (!p) throw new Error('目录中没有此插件');
  const current = installedPlugins(store); const key = nativeKey(source, id);
  if (current[key]?.tree === p.tree && fs.existsSync(packageRoot(store, current[key]))) return current[key];
  const tree = JSON.parse((await download(`https://api.github.com/repos/${index.repository}/git/trees/${p.tree}?recursive=1`, 8 * 1024 * 1024)).toString('utf8'));
  if (tree.truncated || tree.sha !== p.tree || !Array.isArray(tree.tree)) throw new Error('GitHub 返回了不完整的插件树');
  const files = verifyTree(tree.tree, p.tree);
  const root = marketRoot(store, source, id); fs.mkdirSync(root, { recursive: true });
  const temp = path.join(root, `.download-${randomBytes(6).toString('hex')}`); fs.mkdirSync(temp);
  const record: NativeInstall = { source, id, name: p.name, version: p.version, tree: p.tree, revision: index.revision, enabled: current[key]?.enabled || false, installedAt: new Date().toISOString(), license: p.license || '未声明许可' };
  let cursor = 0;
  try {
    const downloads = await Promise.allSettled(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (cursor < files.length) { const e = files[cursor++]; const suffix = `${p.path}/${e.path}`.split('/').map(encodeURIComponent).join('/'); const data = await download(`https://raw.githubusercontent.com/${index.repository}/${index.revision}/${suffix}`, 16 * 1024 * 1024);
        if (data.length !== e.size || gitBlobHash(data) !== e.sha) throw new Error(`插件文件校验失败：${e.path}`);
        const destination = path.join(temp, ...e.path.split('/')); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, data, { mode: e.mode === '100755' ? 0o700 : 0o600, flag: 'wx' });
      }
    }));
    const failure = downloads.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    const manifestFile = ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json'].map(f => path.join(temp, f)).find(f => fs.existsSync(f));
    if (!manifestFile) throw new Error('插件没有有效的清单文件'); const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.name !== p.name || String(manifest.version) !== p.version) throw new Error('插件清单名称或版本与目录不一致');
    const dest = packageRoot(store, record); fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      const actual: string[] = [];
      const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isSymbolicLink()) throw new Error('缓存包含符号链接'); if (e.isDirectory()) walk(f); else if (e.isFile()) actual.push(path.relative(dest, f).replace(/\\/g, '/')); else throw new Error('缓存包含未知文件类型'); } };
      walk(dest);
      if (actual.length !== files.length || files.some(e => !actual.includes(e.path) || gitBlobHash(fs.readFileSync(path.join(dest, ...e.path.split('/')))) !== e.sha)) throw new Error('同版本插件缓存与目录校验不一致，请手动检查缓存目录');
    } else fs.renameSync(temp, dest);
    const marketManifest = { name: marketName(source, id), interface: { displayName: `云桥插件 · ${p.displayName || p.name}` }, plugins: [{ name: p.name, source: { source: 'local', path: dest }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }] };
    patchRegistration(store, record, record.enabled, false, marketManifest); const latest = installedPlugins(store); latest[key] = record; store.writeExtra('extension-native.json', latest); return record;
  } finally {
    // Only remove this operation's random staging directory, never client packages or user files.
    const resolved = path.resolve(temp); if (resolved.startsWith(path.resolve(root) + path.sep) && path.basename(resolved).startsWith('.download-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
export function toggleNative(store: AuroraStore, source: MarketSource, id: string, enabled: boolean): NativeInstall {
  const all = installedPlugins(store); const record = all[nativeKey(source, id)]; if (!record) throw new Error('请先安装此插件');
  if (!fs.existsSync(packageRoot(store, record))) throw new Error('插件文件已丢失，请重新安装');
  patchRegistration(store, record, enabled); record.enabled = enabled; store.writeExtra('extension-native.json', all); return record;
}
export function removeNative(store: AuroraStore, source: MarketSource, id: string): void {
  const all = installedPlugins(store); const key = nativeKey(source, id); const record = all[key]; if (!record) return;
  patchRegistration(store, record, false, true); delete all[key]; store.writeExtra('extension-native.json', all);
  // Retain downloaded source and its licenses for audit/recovery; no arbitrary package hooks execute.
}
export function nativeAliases(index: MarketIndex): Map<string, string> {
  const counts = new Map<string, number>(); for (const p of index.plugins) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  return new Map(index.plugins.map(p => [p.id, counts.get(p.name)! > 1 ? `${p.name}-${createHash('sha256').update(p.id).digest('hex').slice(0, 10)}` : p.name]));
}
export function nativeSummary(store: AuroraStore, source: MarketSource, p: MarketEntry, index?: MarketIndex, installs?: Record<string, NativeInstall>, alias?: string): any {
  const record = (installs || installedPlugins(store))[nativeKey(source, p.id)];
  return { id: `${p.name}@${marketName(source, p.id)}`, name: alias || p.name, codexPlusIndexId: p.id, source: { type: 'git', url: `https://github.com/${REPOSITORIES[source]}.git`, path: p.path, sha: (index || loadIndex(store, source)).revision }, installed: !!record, enabled: record?.enabled || false,
    version: p.version, localVersion: record?.version || null, authPolicy: 'ON_USE', installPolicy: 'AVAILABLE', availability: 'AVAILABLE', disabledReason: null, keywords: p.tags || [], mustShowInstallationInterstitial: false,
    interface: { displayName: p.displayName || p.name, shortDescription: p.description, longDescription: p.description, developerName: p.author, category: 'Productivity', capabilities: [], screenshots: [], logo: null, logoDark: null, composerIcon: null } };
}
export async function nativeRequest(store: AuroraStore, payload: any): Promise<any> {
  const method = String(payload.method || ''); const params = payload.params || {};
  const source: MarketSource = payload.source === 'public' || /virtual-public|index-public/.test(String(params.marketplacePath || params.localMarketplaceName || '')) ? 'public' : 'full';
  if (['plugin/list', 'list-plugins', 'search-plugins', 'installed-plugins', 'plugin/installed'].includes(method)) {
    const installedOnly = /installed/.test(method); const query = String(params.query || '').toLowerCase();
    const index = loadIndex(store, source); const all = installedPlugins(store), aliases = nativeAliases(index);
    const plugins = index.plugins.filter(p => (!query || `${p.name} ${p.displayName} ${p.description}`.toLowerCase().includes(query)) && (!installedOnly || all[nativeKey(source, p.id)])).map(p => nativeSummary(store, source, p, index, all, aliases.get(p.id)));
    return { marketplaces: [{ name: `codex-plus-index-${source}`, path: path.join(store.dir, 'codex-plus-plugin-market', `virtual-${source}`, '.agents', 'plugins', 'marketplace.json'), interface: { displayName: `云桥插件 · ${source === 'full' ? '完整库' : '公开库'}` }, plugins }], marketplaceLoadErrors: [], featuredPluginIds: [] };
  }
  const index = loadIndex(store, source), aliases = nativeAliases(index); const item = index.plugins.find(p => p.id === params.codexPlusIndexId || p.id === params.id || aliases.get(p.id) === params.pluginName || `${p.name}@${marketName(source, p.id)}` === params.pluginId);
  if (!item) throw new Error('插件目录中没有找到此项目');
  if (['plugin/install', 'install-plugin'].includes(method)) { await installNative(store, source, item.id); return { appsNeedingAuth: [], authPolicy: 'ON_USE' }; }
  if (['plugin/read', 'read-plugin'].includes(method)) return { plugin: { summary: nativeSummary(store, source, item, index, undefined, aliases.get(item.id)), marketplaceName: `codex-plus-index-${source}`, description: item.description, skills: [], mcpServers: [], hooks: [], apps: [], appTemplates: [] } };
  throw new Error(`尚未适配此原生插件操作：${method}`);
}
