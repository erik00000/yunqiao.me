import nativeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { windowsDesktopCandidates } from './windowsDesktopCandidates.js';

// Electron treats *.asar paths as virtual directories. Capability inspection needs
// the archive's real bytes and metadata; never toggle process.noAsar globally.
const fs: typeof nativeFs = process.versions.electron ? createRequire(process.execPath)('original-fs') : nativeFs;

export interface CodingDesktopDetection {
  installed: boolean; executable?: string; exePath?: string; productName?: string;
  supportsCodexConfig: boolean; version?: string; evidence: string[];
  bundlePath?: string; bundleId?: string; resourcesPath?: string;
  detectionError?: string;
}
export interface MacApplication {
  bundlePath: string; executable: string; bundleId?: string; version?: string;
  productName: string; resourcesPath: string; infoPlist: string;
}
export interface MacApplicationOptions {
  readPlist?: (file: string) => Record<string, unknown>;
  canExecute?: (file: string) => boolean;
}
export interface DesktopDetectionOptions extends MacApplicationOptions {
  platform?: NodeJS.Platform; home?: string; isolatedHome?: string;
}
const cache = new Map<string, { at: number; value: CodingDesktopDetection }>();
export function clearDesktopDetectionCache(): void { cache.clear(); }
const names = ['ChatGPT Beta', 'ChatGPT', 'Codex'];
const regular = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const exists = (file: string) => { try { fs.statSync(file); return true; } catch { return false; } };
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const text = (value: unknown) => typeof value === 'string' && value.length <= 1000 && !/[\u0000-\u001f]/.test(value) ? value.trim() : '';

function readPlist(file: string): Record<string, unknown> {
  try {
    const output = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const value = JSON.parse(output);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Report the app metadata failure without copying subprocess output. */ }
  throw new Error('无法读取应用包 Info.plist，请选择安装完整的 .app');
}

/** Resolve the bundle's declared main executable, never its display name or a helper. */
export function resolveMacApplication(candidate: string, options: MacApplicationOptions = {}): MacApplication | null {
  if (!path.isAbsolute(candidate) || /[\u0000-\u001f]/.test(candidate) || !exists(candidate)) return null;
  const requested = fs.realpathSync(candidate);
  let bundle = fs.statSync(requested).isDirectory() ? requested : path.dirname(requested);
  while (!/\.app$/i.test(bundle) && path.dirname(bundle) !== bundle) bundle = path.dirname(bundle);
  if (!/\.app$/i.test(bundle) || !fs.statSync(bundle).isDirectory()) return null;
  const infoPlist = path.join(bundle, 'Contents', 'Info.plist');
  if (!regular(infoPlist) || fs.statSync(infoPlist).size > 1024 * 1024 || !inside(bundle, fs.realpathSync(infoPlist))) throw new Error('应用包 Info.plist 缺失、过大或指向包外');
  const metadata = (options.readPlist || readPlist)(infoPlist);
  const executableName = text(metadata.CFBundleExecutable);
  if (!executableName || /[\\/]/.test(executableName) || executableName === '.' || executableName === '..') throw new Error('应用包没有有效的 CFBundleExecutable');
  const executablePath = path.join(bundle, 'Contents', 'MacOS', executableName);
  if (!regular(executablePath)) throw new Error('应用包声明的主程序不存在');
  const executable = fs.realpathSync(executablePath);
  if (!inside(bundle, executable)) throw new Error('应用包主程序指向包外，不能作为桌面客户端启动');
  if (requested !== bundle && requested !== executable) throw new Error('请选择 .app 或其 Info.plist 声明的主程序，不能选择辅助进程');
  const canExecute = options.canExecute || ((file: string) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
  if (!canExecute(executable)) throw new Error('应用包主程序没有执行权限，请重新安装客户端');
  return { bundlePath: bundle, executable, infoPlist, resourcesPath: path.join(bundle, 'Contents', 'Resources'),
    bundleId: text(metadata.CFBundleIdentifier) || undefined,
    productName: text(metadata.CFBundleDisplayName) || text(metadata.CFBundleName) || path.basename(bundle, path.extname(bundle)),
    version: text(metadata.CFBundleShortVersionString) || text(metadata.CFBundleVersion) || undefined };
}

function powershell(source: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function candidates(options: DesktopDetectionOptions): string[] {
  const platform = options.platform || process.platform, isolated = options.isolatedHome ?? process.env.AURORA_CLIENT_HOME;
  const home = isolated || options.home || os.homedir();
  if (platform === 'darwin') return names.flatMap(name => (isolated ? [path.join(home, 'Applications')] : ['/Applications', path.join(home, 'Applications')]).map(root => path.join(root, name + '.app')));
  if (platform !== 'win32') return [];
  return windowsDesktopCandidates({ home, isolated: !!isolated });
}

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
interface DesktopResources { read(file: string, limit: number): Buffer | undefined; label: string }

function confinedFile(root: string, file: string): string | undefined {
  try {
    const resolved = fs.realpathSync(file);
    return regular(resolved) && inside(fs.realpathSync(root), resolved) ? resolved : undefined;
  } catch { return undefined; }
}
function boundedFile(file: string, limit: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r'); const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) return undefined;
    const buffer = Buffer.alloc(stat.size);
    return fs.readSync(fd, buffer, 0, buffer.length, 0) === buffer.length ? buffer : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function resourcePath(value: string): string | undefined {
  if (!value || value.length > 1024 || /[\\\u0000-\u001f]/.test(value) || path.posix.isAbsolute(value)) return undefined;
  const normalized = path.posix.normalize(value);
  return normalized === '..' || normalized.startsWith('../') || normalized === '.' ? undefined : normalized;
}
/** Read ASAR's structured file table, never infer capabilities from filenames in a raw header. */
function archiveResources(root: string): DesktopResources | undefined {
  const archive = confinedFile(root, path.join(root, 'app.asar'));
  if (!archive) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(archive, 'r'); const stat = fs.fstatSync(fd), header = Buffer.alloc(16);
    if (fs.readSync(fd, header, 0, 16, 0) !== 16 || header.readUInt32LE(0) !== 4) return undefined;
    const headerBytes = header.readUInt32LE(4), payloadBytes = header.readUInt32LE(8), jsonBytes = header.readUInt32LE(12);
    if (headerBytes < 8 || headerBytes > 32 * 1024 * 1024 || headerBytes % 4 || payloadBytes !== headerBytes - 4 ||
        jsonBytes <= 0 || jsonBytes > headerBytes - 8 || headerBytes - 8 - jsonBytes > 3 || 8 + headerBytes > stat.size) return undefined;
    const data = Buffer.alloc(jsonBytes);
    if (fs.readSync(fd, data, 0, data.length, 16) !== data.length) return undefined;
    const tree = JSON.parse(data.toString('utf8'));
    if (!tree?.files || typeof tree.files !== 'object' || Array.isArray(tree.files)) return undefined;
    const contentOffset = 8 + headerBytes;
    return { label: 'app.asar', read(file, limit) {
      const normalized = resourcePath(file); if (!normalized) return undefined;
      let entry: any = tree;
      for (const segment of normalized.split('/')) {
        if (!entry?.files || typeof entry.files !== 'object' || !Object.hasOwn(entry.files, segment)) return undefined;
        entry = entry.files[segment];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.link !== undefined) return undefined;
      }
      if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > limit) return undefined;
      if (entry.unpacked === true) {
        const unpacked = path.join(root, 'app.asar.unpacked'), physical = confinedFile(root, path.join(unpacked, ...normalized.split('/')));
        const data = physical ? boundedFile(physical, Math.min(limit, entry.size)) : undefined;
        return data?.length === entry.size ? data : undefined;
      }
      if (typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset)) return undefined;
      const offset = Number(entry.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || contentOffset + offset + entry.size > stat.size) return undefined;
      let input: number | undefined;
      try {
        input = fs.openSync(archive, 'r'); const current = fs.fstatSync(input);
        // Updating archives must be retried rather than pairing an old table with new content.
        if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ino !== stat.ino) return undefined;
        const bytes = Buffer.alloc(entry.size);
        return fs.readSync(input, bytes, 0, bytes.length, contentOffset + offset) === bytes.length ? bytes : undefined;
      } catch { return undefined; }
      finally { if (input !== undefined) fs.closeSync(input); }
    } };
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function unpackedResources(root: string): DesktopResources {
  return { label: 'app', read(file, limit) {
    const normalized = resourcePath(file); if (!normalized) return undefined;
    const target = confinedFile(root, path.join(root, 'app', ...normalized.split('/')));
    return target ? boundedFile(target, limit) : undefined;
  } };
}
function inspectResources(root: string): string[] {
  const evidence: string[] = [];
  try { if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) return []; } catch { return []; }
  const sources = [archiveResources(root), unpackedResources(root)].filter((value): value is DesktopResources => !!value);
  let desktopRuntime = false;
  for (const source of sources) {
    let pkg: any;
    try { const data = source.read('package.json', 256 * 1024); if (!data) continue; pkg = JSON.parse(data.toString('utf8')); }
    catch { continue; }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) continue;
    const main = resourcePath(typeof pkg.main === 'string' ? pkg.main : 'index.js');
    if (!main) continue;
    const resolveScript = (requested: string, limit: number) => {
      for (const file of /\.(?:js|cjs|mjs)$/.test(requested) ? [requested] : [requested + '.js', requested + '.cjs', requested + '.mjs', requested + '/index.js']) {
        const data = source.read(file, limit); if (data) return { file, data };
      }
      return undefined;
    };
    const entry = resolveScript(main, MAX_ENTRY_BYTES); if (!entry) continue;
    desktopRuntime = true;
    const pending = [entry], seen = new Set<string>();
    let bytes = 0, codex = false, protocol = false, configuration = false;
    while (pending.length && seen.size < 16 && bytes < MAX_SCRIPT_BYTES) {
      const item = pending.shift()!; if (seen.has(item.file)) continue;
      seen.add(item.file); bytes += item.data.length;
      const code = item.data.toString('utf8');
      codex ||= /\bCODEX_HOME\b|\bcodex(?:-app-server|-desktop|-client)?\b/i.test(code);
      protocol ||= /["'`]\s*(?:thread\/(?:start|resume|read)|turn\/start|app-server)\s*["'`]|\bapp-server-client\b/.test(code);
      configuration ||= /\bmodel_(?:provider|providers|context_window|auto_compact_token_limit)\b|\bCODEX_HOME\b/.test(code);
      if (codex && protocol && configuration) { evidence.push(`${source.label} 桌面入口包含 Codex 配置与会话协议`); break; }
      // Follow only explicit local JS dependencies of the declared main entrypoint.
      // Documentation, source maps, arbitrary assets and remote imports never count.
      const imports = code.matchAll(/(?:\brequire\s*\(|\bimport\s*\(|\bfrom\s*|\bimport\s*)["'](\.[^"'\r\n]{1,1024})["']/g);
      for (const match of imports) {
        if (pending.length + seen.size >= 16) break;
        const relative = resourcePath(path.posix.join(path.posix.dirname(item.file), match[1]));
        if (!relative || seen.has(relative)) continue;
        const limit = Math.min(MAX_ENTRY_BYTES, MAX_SCRIPT_BYTES - bytes - pending.reduce((total, queued) => total + queued.data.length, 0));
        if (limit <= 0) break;
        const child = resolveScript(relative, limit); if (child && !pending.some(queued => queued.file === child.file)) pending.push(child);
      }
    }
  }
  if (!desktopRuntime) return [];
  for (const folder of ['', 'bin', 'cli', 'app.asar.unpacked', 'app.asar.unpacked/bin', 'app.asar.unpacked/cli']) {
    for (const binary of ['codex.exe', 'codex', 'app-server.exe', 'app-server', 'codex-app-server.exe', 'codex-app-server']) {
      const relative = folder ? `${folder}/${binary}` : binary;
      const file = confinedFile(root, path.join(root, ...relative.split('/')));
      if (file && fs.statSync(file).size > 0) evidence.push(`桌面 resources/${relative}`);
    }
  }
  return evidence;
}

export function inspectCodingDesktop(candidate: string, options: DesktopDetectionOptions = {}): CodingDesktopDetection {
  const platform = options.platform || process.platform;
  const missing = { installed: false, supportsCodexConfig: false, evidence: [] };
  if (!path.isAbsolute(candidate)) return missing;
  const mac = platform === 'darwin' ? resolveMacApplication(candidate, options) : null;
  const executable = mac?.executable || candidate;
  if ((platform === 'darwin' && !mac) || !regular(executable)) return missing;
  if (platform === 'win32' && !/\.exe$/i.test(executable)) throw new Error('请选择桌面客户端的 .exe 程序');
  let version = mac?.version, productName = mac?.productName || path.basename(executable, path.extname(executable));
  if (platform === 'win32' && process.platform === 'win32' && !(options.isolatedHome ?? process.env.AURORA_CLIENT_HOME)) try {
    const meta = JSON.parse(powershell(`$v=(Get-Item -LiteralPath '${executable.replace(/'/g, "''")}').VersionInfo; @{version=$v.FileVersion;name=$v.ProductName}|ConvertTo-Json -Compress`));
    version = meta.version || undefined; productName = meta.name || productName;
  } catch { /* Binary metadata is optional. */ }
  const evidence: string[] = [];
  const roots = mac ? [mac.resourcesPath] : [path.join(path.dirname(executable), 'resources'), path.resolve(path.dirname(executable), '../Resources')];
  for (const root of roots) evidence.push(...inspectResources(root));
  return { installed: true, executable, exePath: mac?.bundlePath || executable, productName, version, supportsCodexConfig: evidence.length > 0, evidence,
    ...(mac ? { bundlePath: mac.bundlePath, bundleId: mac.bundleId, resourcesPath: mac.resourcesPath } : {}) };
}

export function detectCodingDesktop(exePath?: string, options?: DesktopDetectionOptions): CodingDesktopDetection {
  const isolated = options?.isolatedHome ?? process.env.AURORA_CLIENT_HOME;
  const key = JSON.stringify([process.platform, isolated || '', exePath || 'auto']);
  const cached = !options && cache.get(key);
  if (cached && Date.now() - cached.at < 15000) return cached.value;
  const unavailable = (file: string): CodingDesktopDetection => ({ installed: false, supportsCodexConfig: false, evidence: [], exePath: file,
    detectionError: '客户端程序暂时不可用，可能正在更新或安装不完整。请稍后重新检测，或在连接设置中重新选择程序路径。' });
  const configured = (): CodingDesktopDetection[] => {
    try { const value = inspectCodingDesktop(path.resolve(exePath!), options); return [value.installed ? value : unavailable(exePath!)]; }
    catch { return [unavailable(exePath!)]; }
  };
  const detected = exePath ? configured() : candidates(options || {}).flatMap(file => {
    try { const value = inspectCodingDesktop(file, options); return value.installed ? [value] : []; } catch { return [unavailable(file)]; }
  });
  const value = detected.find(item => item.supportsCodexConfig) || detected.find(item => item.installed) || detected.find(item => item.detectionError) || { installed: false, supportsCodexConfig: false, evidence: [] };
  // Host discovery is expensive, including when no installation is found. Keep all
  // results briefly; explicit refresh/path selection clears this cache immediately.
  if (!options) cache.set(key, { at: Date.now(), value });
  return value;
}
