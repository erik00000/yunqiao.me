import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface WindowsPackagedLaunchRequest {
  executable: string;
  port: number;
  packagedPath: boolean;
  /** Trusted diagnostic seam. Inspection never activates an application. */
  inspectOnly?: boolean;
}
export type WindowsPackagedLaunchReply =
  | { kind: 'unpackaged' }
  | { kind: 'resolved'; aumid: string }
  | { kind: 'activated'; pid: number }
  | { kind: 'blocked'; code: string };
export interface WindowsPackagedLaunchRuntime {
  platform: NodeJS.Platform;
  isolatedHome?: string;
  /** Main-process test injection only; never populated from renderer payloads. */
  run(request: WindowsPackagedLaunchRequest): Promise<WindowsPackagedLaunchReply>;
}

// Fixed source, also exercised with private registration fixtures in tests. The
// selected executable and port arrive as base64-encoded JSON, never shell code.
export const windowsPackagedLaunchSource = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
function Block([string]$code) { @{ kind = 'blocked'; code = $code } | ConvertTo-Json -Compress; exit }
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace YunqiaoPackagedDesktop {
  [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
    [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
    [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr items, out uint processId);
  }
  public static class Native {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);
    public static string Canonical(string name) {
      using (SafeFileHandle handle = CreateFile(name, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var result = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
        if (length == 0 || length >= result.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        string value = result.ToString();
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + value.Substring(8);
        return value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) ? value.Substring(4) : value;
      }
    }
    public static uint Activate(string aumid, string arguments) {
      object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
      try {
        uint pid;
        int result = ((IApplicationActivationManager)instance).ActivateApplication(aumid, arguments, 0, out pid);
        Marshal.ThrowExceptionForHR(result);
        if (pid == 0) throw new InvalidOperationException("No activation process");
        return pid;
      } finally { if (Marshal.IsComObject(instance)) Marshal.ReleaseComObject(instance); }
    }
  }
}
'@
  $executable = [YunqiaoPackagedDesktop.Native]::Canonical([string]$inputData.executable)
  if ($executable -ine [string]$inputData.executable) { Block 'target-changed' }
  if ([IO.Path]::GetFileName($executable) -notmatch '^(ChatGPT( Beta)?|Codex)\.exe$') { Block 'invalid-target' }
  if ([int]$inputData.port -lt 1024 -or [int]$inputData.port -gt 65535) { Block 'invalid-port' }
  $packages = @(Get-AppxPackage -ErrorAction Stop | Select-Object -First 2049)
  if ($packages.Count -gt 2048) { Block 'ambiguous' }
  $candidates = @(); $insidePackage = $false
  foreach ($package in $packages) {
    if (![string]$package.InstallLocation) { continue }
    if (![IO.Path]::IsPathRooted([string]$package.InstallLocation)) { continue }
    $registeredRoot = [IO.Path]::GetFullPath([string]$package.InstallLocation).TrimEnd('\')
    $lexicallyRelated = $executable.StartsWith($registeredRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    try { $root = [YunqiaoPackagedDesktop.Native]::Canonical($registeredRoot).TrimEnd('\') }
    catch {
      # A stale/unreadable unrelated package must not disable ordinary desktop
      # apps. A selected package still fails closed; aliases that cannot resolve
      # cannot become an activation candidate or bypass packagedPath below.
      if ($lexicallyRelated) { Block 'registry-unavailable' }
      continue
    }
    if (!$executable.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
    $insidePackage = $true
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop
    $applications = @($manifest.Package.Applications.Application)
    if ($applications.Count -gt 64) { Block 'ambiguous' }
    foreach ($application in $applications) {
      $relative = [string]$application.Executable
      $parts = @($relative -split '[\\/]')
      if (!$relative -or [IO.Path]::IsPathRooted($relative) -or $parts.Count -gt 32) { continue }
      $invalid = @($parts | Where-Object { !$_ -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[:\x00-\x1f\x7f]' -or $_ -match '[ .]$' -or $_ -ieq 'resources' })
      if ($invalid.Count -or $parts[-1] -notmatch '^(ChatGPT( Beta)?|Codex)\.exe$') { continue }
      $file = [IO.Path]::GetFullPath((Join-Path $root $relative))
      if (!$file.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $file -PathType Leaf)) { continue }
      $actual = [YunqiaoPackagedDesktop.Native]::Canonical($file)
      if (!$actual.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $actual -ine $executable) { continue }
      $appId = [string]$application.Id; $family = [string]$package.PackageFamilyName
      if ($appId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$' -or $family -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$') { Block 'invalid-identity' }
      $candidates += @{ aumid = $family + '!' + $appId; package = $package; root = $root }
    }
  }
  if (!$candidates.Count) {
    if ($inputData.packagedPath -or $insidePackage) { Block 'unregistered' }
    @{ kind = 'unpackaged' } | ConvertTo-Json -Compress; exit
  }
  if ($candidates.Count -ne 1) { Block 'ambiguous' }
  $match = $candidates[0]
  if ($inputData.inspectOnly) { @{ kind = 'resolved'; aumid = $match.aumid } | ConvertTo-Json -Compress; exit }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Block 'elevated' }
  # Revalidate the registration in the same helper immediately before activation.
  # AUMIDs survive Store updates; an old selected path must not launch a new package.
  $current = @(Get-AppxPackage -Name $match.package.Name -ErrorAction Stop | Where-Object { $_.PackageFullName -eq $match.package.PackageFullName })
  if ($current.Count -ne 1 -or [YunqiaoPackagedDesktop.Native]::Canonical([string]$current[0].InstallLocation).TrimEnd('\') -ine $match.root -or [YunqiaoPackagedDesktop.Native]::Canonical($executable) -ine $executable) { Block 'target-changed' }
  try {
    $arguments = '--remote-debugging-port=' + [int]$inputData.port + ' --remote-debugging-address=127.0.0.1'
    $activatedPid = [YunqiaoPackagedDesktop.Native]::Activate($match.aumid, $arguments)
    @{ kind = 'activated'; pid = $activatedPid } | ConvertTo-Json -Compress
  } catch { Block 'activation-failed' }
} catch { Block 'registry-unavailable' }
`;

const messages: Record<string, string> = {
  'target-changed': '桌面客户端或商店包在启动前已更新，请重新检测并选择当前安装的程序。',
  'invalid-target': '所选程序不是受支持的 ChatGPT / Codex 桌面主程序，请重新选择。',
  'invalid-port': '调试端口必须是 1024–65535 的整数。',
  'registry-unavailable': '无法核对当前用户的 Windows 商店应用注册信息，未直接运行包内程序。请以安装客户端的 Windows 账号运行云桥后重试。',
  'ambiguous': '所选程序对应多个商店应用入口，无法安全确定启动目标，请重新选择已安装的客户端。',
  'unregistered': '所选程序位于商店应用包中，但没有找到当前用户已注册的对应启动入口。请从开始菜单确认客户端可用，重新安装或重新选择程序后再连接。',
  'invalid-identity': '商店应用清单没有有效的启动标识，请重新安装客户端后再连接。',
  'elevated': '商店版客户端需要普通用户权限启动。请关闭云桥的“以管理员身份运行”，重新打开后再连接。',
  'activation-failed': 'Windows 未能以商店包身份启动客户端。请完全退出客户端，确认开始菜单可以打开，并以普通权限重新连接。',
};

async function nativeRun(request: WindowsPackagedLaunchRequest): Promise<WindowsPackagedLaunchReply> {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (!path.win32.isAbsolute(systemRoot) || /[\x00-\x1f\x7f]/.test(systemRoot)) throw new Error('Windows 系统目录无效，无法启动商店客户端。');
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const data = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const source = `$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json\n` + windowsPackagedLaunchSource;
  return new Promise((resolve, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(new Error(error.killed ? 'Windows 商店应用激活超时，请检查客户端窗口或系统提示后重试；未改用直接启动。' : messages['registry-unavailable'])); return; }
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
        catch { reject(new Error('Windows 返回的商店启动信息不完整，请重新检测客户端后重试。')); }
      });
  });
}

function knownPackagePath(executable: string): boolean {
  if (/(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(executable)) return true;
  let current = path.dirname(executable);
  for (let depth = 0; depth < 8; depth++) {
    try { fs.lstatSync(path.join(current, 'AppxManifest.xml')); return true; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw new Error(messages['registry-unavailable']); }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return false;
}

/** MSIX activation is a distinct operation: errors must never fall through to raw spawn. */
export async function launchWindowsPackagedDesktop(executable: string, port: number, runtime?: WindowsPackagedLaunchRuntime): Promise<{ packaged: boolean; pid?: number }> {
  const host = runtime ?? { platform: process.platform, isolatedHome: process.env.AURORA_CLIENT_HOME, run: nativeRun };
  if (host.platform !== 'win32') throw new Error('商店应用激活仅支持 Windows。');
  if (typeof executable !== 'string' || executable.length > 4096 || !path.win32.isAbsolute(executable) || /[\x00-\x1f\x7f]/.test(executable)
    || !/^(?:ChatGPT(?: Beta)?|Codex)\.exe$/i.test(path.win32.basename(executable))) throw new Error(messages['invalid-target']);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(messages['invalid-port']);
  let selected: string;
  try { selected = fs.realpathSync.native(executable); if (!fs.statSync(selected).isFile()) throw new Error(); }
  catch { throw new Error('桌面程序路径不可用，请重新检测或重新选择客户端。'); }
  if (!/^(?:ChatGPT(?: Beta)?|Codex)\.exe$/i.test(path.win32.basename(selected))) throw new Error(messages['invalid-target']);
  const packagedPath = knownPackagePath(executable) || knownPackagePath(selected);
  if (host.isolatedHome) {
    const relative = path.relative(fs.realpathSync.native(host.isolatedHome), selected);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || packagedPath) throw new Error('隔离运行期间不会查询或激活真实 Windows 商店应用，请使用隔离的普通桌面测试程序。');
    return { packaged: false };
  }
  const reply = await host.run({ executable: selected, port, packagedPath });
  if (reply?.kind === 'activated' && Number.isInteger(reply.pid) && reply.pid > 0 && reply.pid <= 0xffffffff) return { packaged: true, pid: reply.pid };
  if (reply?.kind === 'unpackaged' && !packagedPath) return { packaged: false };
  if (reply?.kind === 'blocked') throw new Error(messages[reply.code] || messages['registry-unavailable']);
  throw new Error(packagedPath ? messages.unregistered : 'Windows 未确认商店客户端启动结果，请重新检测后重试。');
}
