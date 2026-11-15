import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  const roots = isolated ? [path.join(home, 'AppData', 'Local')] : [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env.PROGRAMFILES].filter(Boolean) as string[];
  const result: string[] = [];
  for (const name of names) for (const root of roots) for (const relative of [path.join('Programs', name), path.join('OpenAI', name), path.join('OpenAI', name, 'app'), name]) {
    for (const exe of [name, name.replace(' Beta', ''), 'Codex']) result.push(path.join(root, relative, exe + '.exe'));
  }
  if (!isolated && process.platform === 'win32') try {
    const raw = powershell("$a=@(); Get-AppxPackage *OpenAI* -ErrorAction SilentlyContinue | ForEach-Object { $r=$_.InstallLocation; foreach($p in @('app\\ChatGPT.exe','ChatGPT.exe','app\\Codex.exe','Codex.exe')){ $f=Join-Path $r $p; if(Test-Path -LiteralPath $f){$a+=$f} } }; $w=New-Object -ComObject WScript.Shell; Get-ChildItem -Path ($env:APPDATA+'\\Microsoft\\Windows\\Start Menu'),($env:ProgramData+'\\Microsoft\\Windows\\Start Menu') -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | Where-Object {$_.Name -match '^(ChatGPT|Codex)'} | ForEach-Object {$a+=$w.CreateShortcut($_.FullName).TargetPath}; $a | Select-Object -Unique | ConvertTo-Json -Compress");
    const parsed = raw ? JSON.parse(raw) : [];
    result.push(...(Array.isArray(parsed) ? parsed : [parsed]).filter(value => typeof value === 'string'));
  } catch { /* Standard paths remain usable without Store metadata. */ }
  return [...new Set(result)];
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
  if (/^codex(?:\.exe)?$/i.test(path.basename(executable)) || /^codex$/i.test(productName)) evidence.push('Codex 产品程序');
  const roots = mac ? [mac.resourcesPath] : [path.join(path.dirname(executable), 'resources'), path.resolve(path.dirname(executable), '../Resources')];
  for (const root of roots) {
    for (const bin of ['codex.exe', 'codex', 'app-server.exe', 'codex-app-server.exe', 'codex-app-server']) if (regular(path.join(root, bin))) evidence.push(`resources/${bin}`);
    const asar = path.join(root, 'app.asar');
    if (!regular(asar)) continue;
    let fd: number | undefined;
    try {
      fd = fs.openSync(asar, 'r');
      const header = Buffer.alloc(16); fs.readSync(fd, header, 0, 16, 0); const size = header.readUInt32LE(12);
      if (size > 0 && size < 32 * 1024 * 1024) {
        const data = Buffer.alloc(size); fs.readSync(fd, data, 0, size, 16);
        if (/codex(?:-app-server|-desktop|\.exe)|app-server-client|codex-client/i.test(data.toString('utf8'))) evidence.push('应用资源包含 Codex 客户端模块');
      }
    } catch { /* Unknown resource formats do not imply support. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
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
  if (!options && !value.detectionError) cache.set(key, { at: Date.now(), value });
  return value;
}
