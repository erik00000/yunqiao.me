import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const names = ['ChatGPT Beta', 'ChatGPT', 'Codex'];
const knownExecutable = /^(?:ChatGPT(?: Beta)?|Codex)\.exe$/i;
const appxName = /^(?:OpenAI[._-])?(?:ChatGPT|Codex)(?:[._-](?:Desktop|Beta))?$/i;
const productName = /^(?:OpenAI\s+)?(?:ChatGPT(?: Beta)?|Codex)(?:\s+Desktop)?(?:\s+[\d.]+)?$/i;
export interface WindowsDesktopCandidateOptions {
  home: string;
  isolated?: boolean;
  environment?: Record<string, string | undefined>;
  /** Trusted test seam. These fixed read-only sources never come from an IPC request. */
  readHost?: (source: 'appx' | 'uninstall' | 'shortcuts') => unknown;
}
const scripts = {
  appx: "$ErrorActionPreference='Stop'; $a=@(); Get-AppxPackage | Where-Object {$_.Name -match '^(OpenAI[._-])?(ChatGPT|Codex)([._-](Desktop|Beta))?$'} | Select-Object -First 32 | ForEach-Object { try { $p=$_; $m=Get-AppxPackageManifest -Package $p; $a+=@{name=$p.Name;root=$p.InstallLocation;executables=@($m.Package.Applications.Application | ForEach-Object {$_.Executable})} } catch {} }; $a | ConvertTo-Json -Depth 4 -Compress",
  uninstall: "$a=@(); foreach($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')) { Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | Select-Object -First 2048 | Where-Object {$_.DisplayName -match '^(OpenAI\\s+)?(ChatGPT( Beta)?|Codex)(\\s+Desktop)?(\\s+[\\d.]+)?$'} | Select-Object -First 32 | ForEach-Object {$a+=@{name=$_.DisplayName;root=$_.InstallLocation;icon=$_.DisplayIcon}} }; $a | ConvertTo-Json -Depth 3 -Compress",
  shortcuts: "$a=@(); $q=New-Object System.Collections.Queue; foreach($r in @(($env:APPDATA+'\\Microsoft\\Windows\\Start Menu\\Programs'),($env:ProgramData+'\\Microsoft\\Windows\\Start Menu\\Programs'))) {if(Test-Path -LiteralPath $r -PathType Container){$q.Enqueue(@{path=$r;depth=0})}}; $w=New-Object -ComObject WScript.Shell; $visited=0; while($q.Count -gt 0 -and $visited -lt 256 -and $a.Count -lt 128){$item=$q.Dequeue();$visited++; Get-ChildItem -LiteralPath $item.path -ErrorAction SilentlyContinue | Select-Object -First 1024 | ForEach-Object {if(-not($_.Attributes -band [IO.FileAttributes]::ReparsePoint)){if($_.PSIsContainer -and $item.depth -lt 4){$q.Enqueue(@{path=$_.FullName;depth=($item.depth+1)})}elseif($_.Name -match '^(ChatGPT( Beta)?|Codex)(?: Desktop)?\\.lnk$'){try{$s=$w.CreateShortcut($_.FullName);if(-not $s.Arguments){$a+=@{name=$_.BaseName;target=$s.TargetPath}}}catch{}}}}}; $a | ConvertTo-Json -Depth 3 -Compress",
};
function nativeHost(source: keyof typeof scripts): unknown {
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(scripts[source], 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return raw ? JSON.parse(raw) : [];
}
const rows = (value: unknown): any[] => Array.isArray(value) ? value.slice(0, 128) : value && typeof value === 'object' ? [value] : [];
const safeAbsolute = (value: unknown): value is string => typeof value === 'string' && value.length < 4096 && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

/** Only candidate paths are returned. The caller must independently verify a desktop shell and coding capability. */
export function windowsDesktopCandidates(options: WindowsDesktopCandidateOptions): string[] {
  const environment = options.environment ?? process.env;
  const roots = options.isolated ? [path.join(options.home, 'AppData', 'Local')]
    : [environment.LOCALAPPDATA || path.join(options.home, 'AppData', 'Local'), environment.ProgramFiles, environment.PROGRAMFILES, environment['ProgramFiles(x86)']].filter(safeAbsolute);
  const result: string[] = [], seen = new Set<string>(), preferred: string[] = [], preferredKeys = new Set<string>();
  let hostCandidate = false;
  const add = (value: unknown) => {
    if (!safeAbsolute(value) || !knownExecutable.test(path.basename(value))) return;
    const file = path.resolve(value);
    if (options.isolated && !inside(path.resolve(options.home), file)) return;
    const key = file.toLowerCase();
    if (hostCandidate && !preferredKeys.has(key)) { preferredKeys.add(key); preferred.push(file); }
    if (!seen.has(key)) { seen.add(key); result.push(file); }
  };
  const installation = (root: string) => {
    if (!safeAbsolute(root)) return;
    for (const executable of ['ChatGPT.exe', 'ChatGPT Beta.exe', 'Codex.exe']) { add(path.join(root, executable)); add(path.join(root, 'app', executable)); }
    // Squirrel-style versions are only inspected under an already identified installation directory.
    let directory: fs.Dir | undefined;
    try {
      const stat = fs.lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      directory = fs.opendirSync(root); let inspected = 0, versions = 0;
      for (let entry = directory.readSync(); entry && inspected++ < 256 && versions < 16; entry = directory.readSync()) {
        if (!entry.isDirectory() || !/^app-\d+(?:\.\d+){1,5}(?:-[A-Za-z0-9.-]+)?$/i.test(entry.name)) continue;
        const folder = path.join(root, entry.name); const info = fs.lstatSync(folder); if (!info.isDirectory() || info.isSymbolicLink()) continue;
        versions++; for (const executable of ['ChatGPT.exe', 'ChatGPT Beta.exe', 'Codex.exe']) add(path.join(folder, executable));
      }
    } catch { /* Standard exact paths remain candidates when a version directory cannot be enumerated. */ }
    finally { directory?.closeSync(); }
  };
  for (const root of roots) for (const name of names) for (const relative of [path.join('Programs', name), path.join('OpenAI', name), name]) installation(path.join(root, relative));
  if (!options.isolated && (process.platform === 'win32' || options.readHost)) {
    hostCandidate = true;
    const readHost = options.readHost ?? nativeHost;
    try {
      for (const item of rows(readHost('appx'))) {
        if (!item || !appxName.test(item.name) || !safeAbsolute(item.root)) continue;
        for (const relative of (Array.isArray(item.executables) ? item.executables : []).slice(0, 32)) {
          if (typeof relative !== 'string' || !relative || path.win32.isAbsolute(relative) || /[\u0000-\u001f]/.test(relative)) continue;
          const file = path.resolve(item.root, ...relative.split(/[\\/]/)); if (inside(path.resolve(item.root), file)) add(file);
        }
      }
    } catch { /* Appx availability does not disable shortcuts or ordinary installations. */ }
    try {
      for (const item of rows(readHost('uninstall'))) {
        if (!item || !productName.test(item.name)) continue;
        if (safeAbsolute(item.root)) installation(item.root);
        if (typeof item.icon === 'string') {
          const match = /^\s*(?:"([^"]+)"|([^",]+?))(?:,\s*-?\d+)?\s*$/.exec(item.icon);
          if (match) add(match[1] || match[2]);
        }
      }
    } catch { /* Registry failures do not disable other candidate sources. */ }
    try {
      for (const item of rows(readHost('shortcuts'))) if (item && productName.test(item.name)) add(item.target);
    } catch { /* Missing shortcuts are normal for Store installations. */ }
  }
  // Registered targets take priority over leftover version directories from an older installation.
  return [...preferred, ...result.filter(file => !preferredKeys.has(file.toLowerCase()))];
}
