import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// This opt-in Windows integration test launches only a private, windowless fixture.
// It never sends stop/kill signals. Each fixture exits via its own stop file or timer.
if (process.platform !== 'win32') {
  console.log('SKIP native client lifecycle: Windows only');
  process.exit(0);
}

const runFile = promisify(execFile);
const workspace = path.resolve(import.meta.dirname, '..');
const temporaryRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-client-native-')));
const previousHome = process.env.AURORA_CLIENT_HOME;
const require = createRequire(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
const fixtures = [];

function fixture(name) {
  const dir = path.join(temporaryRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const value = { dir, exe: path.join(dir, 'Claude.exe'), ready: path.join(dir, 'ready.txt'), stop: path.join(dir, 'stop.txt'), exited: path.join(dir, 'exited.txt'), launches: path.join(dir, 'launches.txt'), heartbeat: path.join(dir, 'heartbeat.txt') };
  fixtures.push(value);
  return value;
}

async function waitFor(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function launches(f) { return read(f.launches).trim().split(/\r?\n/).filter(Boolean).length; }
function alive(f) { return fs.existsSync(f.heartbeat) && Date.now() - fs.statSync(f.heartbeat).mtimeMs < 3000 && !fs.existsSync(f.exited); }
const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
async function powershell(source) {
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  return runFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
}

async function shortcutTo(shortcut, executable, args = '') {
  fs.mkdirSync(path.dirname(shortcut), { recursive: true });
  await powershell(`$ErrorActionPreference='Stop'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(shortcut)}); $s.TargetPath=${psQuote(executable)}; $s.Arguments=${psQuote(args)}; $s.Save()`);
}

async function compileFixture(f) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework'].map(name => path.join(systemRoot, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')).find(file => fs.existsSync(file));
  assert(compiler, '.NET Framework C# compiler is required for native lifecycle integration');
  const source = path.join(temporaryRoot, 'WindowlessFixture.cs');
  if (!fs.existsSync(source)) fs.writeFileSync(source, `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
internal static class WindowlessFixture {
  [STAThread] private static void Main() {
    string root = AppDomain.CurrentDomain.BaseDirectory;
    string pid = Process.GetCurrentProcess().Id.ToString();
    File.AppendAllText(Path.Combine(root, "launches.txt"), pid + Environment.NewLine);
    File.WriteAllText(Path.Combine(root, "ready.txt"), pid);
    DateTime deadline = DateTime.UtcNow.AddSeconds(90);
    while (DateTime.UtcNow < deadline && !File.Exists(Path.Combine(root, "stop.txt"))) {
      File.WriteAllText(Path.Combine(root, "heartbeat.txt"), DateTime.UtcNow.Ticks.ToString());
      Thread.Sleep(100);
    }
    File.WriteAllText(Path.Combine(root, "exited.txt"), pid);
  }
}
`, 'utf8');
  await runFile(compiler, ['/nologo', '/target:winexe', '/optimize+', '/out:' + f.exe, source], { windowsHide: true, timeout: 20000 });
}

async function startSentinel(f) {
  const child = spawn(f.exe, [], { cwd: f.dir, detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  await waitFor(() => alive(f), 'Private sentinel did not start');
}

async function stopFixtures() {
  for (const f of fixtures) fs.writeFileSync(f.stop, 'exit');
  for (const f of fixtures) {
    if (fs.existsSync(f.ready)) await waitFor(() => fs.existsSync(f.exited), 'Private fixture did not acknowledge its stop file', 10000);
  }
  await delay(300);
}

try {
  process.env.AURORA_CLIENT_HOME = temporaryRoot;
  const selected = fixture("selected client 'quoted'");
  const sentinel = fixture('same-name-other-location');
  await compileFixture(selected);
  fs.copyFileSync(selected.exe, sentinel.exe);

  // The lifecycle imports and assertions are below so fixture isolation remains
  // explicit and cannot accidentally fall back to an installed application.
  const bundle = path.join(temporaryRoot, 'client-lifecycle.cjs');
  await build({ entryPoints: [path.join(workspace, 'src/main/clientLifecycle.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = require(bundle);
  assert.equal(typeof api.createClientLifecycle, 'function');
  assert(api.nativeClientLifecycleRuntime);

  // Native driver calls are supplied by the module's public runtime contract.
  // No CLI action is exercised by this test.
  const detected = { installed: true, configured: false, command: selected.exe };
  const runtime = { ...api.nativeClientLifecycleRuntime, home: () => temporaryRoot, detect: () => detected };
  const lifecycle = api.createClientLifecycle(runtime);

  const info = await lifecycle.describeClientLifecycle({ agentId: 'claude-desktop' });
  assert.equal(info.ok, true); assert.equal(info.installed, true); assert.equal(info.supported, true);
  console.log('PASS native quoted Windows path resolves to the selected private fixture'); passed++;

  const missing = await runtime.resolveTarget('claude-desktop', { installed: false, configured: false });
  assert.equal(missing, null, 'An isolated profile must not discover or launch an installed desktop application');
  console.log('PASS an isolated profile never falls back to real installed applications'); passed++;

  const noDetection = { installed: false, configured: false };
  const menuSuffix = path.join('Microsoft', 'Windows', 'Start Menu', 'Programs');
  const userMenu = path.join(temporaryRoot, 'AppData', 'Roaming', menuSuffix);
  const commonMenu = path.join(temporaryRoot, 'ProgramData', menuSuffix);
  const unrelatedShortcut = path.join(userMenu, 'Vendor Folder', 'Claude Documentation.lnk');
  await shortcutTo(unrelatedShortcut, selected.exe);
  assert.equal(await runtime.resolveTarget('claude-desktop', noDetection), null);
  console.log('PASS Start Menu discovery ignores similar names outside its exact client whitelist'); passed++;

  const junctionTarget = path.join(temporaryRoot, 'outside-start-menu');
  await shortcutTo(path.join(junctionTarget, 'Claude.lnk'), selected.exe);
  const junction = path.join(userMenu, 'Linked Folder');
  assert(path.relative(temporaryRoot, junctionTarget) && !path.relative(temporaryRoot, junctionTarget).startsWith('..'));
  fs.symlinkSync(junctionTarget, junction, 'junction');
  try {
    assert.equal(await runtime.resolveTarget('claude-desktop', noDetection), null);
    assert(fs.existsSync(path.join(junctionTarget, 'Claude.lnk')));
  } finally { fs.unlinkSync(junction); }
  console.log('PASS Start Menu discovery does not follow a directory junction'); passed++;

  const userShortcut = path.join(userMenu, 'Vendor Folder', 'Claude.lnk');
  await shortcutTo(userShortcut, selected.exe);
  const userDiscovered = await runtime.resolveTarget('claude-desktop', noDetection);
  assert.equal(userDiscovered.executable.toLowerCase(), fs.realpathSync.native(selected.exe).toLowerCase());
  fs.unlinkSync(userShortcut);
  const commonShortcut = path.join(commonMenu, 'Vendor Folder', 'Claude.lnk');
  await shortcutTo(commonShortcut, selected.exe);
  const commonDiscovered = await runtime.resolveTarget('claude-desktop', noDetection);
  assert.equal(commonDiscovered.executable.toLowerCase(), fs.realpathSync.native(selected.exe).toLowerCase());
  console.log('PASS nested user and machine Start Menu shortcuts resolve the selected private fixture'); passed++;

  await shortcutTo(commonShortcut, selected.exe, '--fixture-argument');
  await assert.rejects(runtime.resolveTarget('claude-desktop', noDetection), /快捷方式包含额外启动参数/);
  fs.unlinkSync(commonShortcut);
  console.log('PASS a discovered Start Menu shortcut with extra arguments is rejected'); passed++;

  const shortcut = path.join(temporaryRoot, "Claude 'quoted'.lnk");
  await shortcutTo(shortcut, selected.exe);
  const resolvedShortcut = await runtime.resolveTarget('claude-desktop', { ...detected, command: shortcut });
  assert.equal(resolvedShortcut.executable.toLowerCase(), fs.realpathSync.native(selected.exe).toLowerCase());
  await shortcutTo(shortcut, selected.exe, '--fixture-argument');
  await assert.rejects(runtime.resolveTarget('claude-desktop', { ...detected, command: shortcut }), /快捷方式包含额外启动参数/);
  console.log('PASS native shortcut COM resolves an exact target and rejects added arguments'); passed++;

  await startSentinel(sentinel);
  const first = await lifecycle.restartClient({ agentId: 'claude-desktop' });
  assert.equal(first.ok, true, first.message); assert.equal(first.operation, 'started');
  await waitFor(() => alive(selected), 'Selected private fixture did not start');
  assert.equal(launches(selected), 1); assert.equal(launches(sentinel), 1); assert(alive(sentinel));
  console.log('PASS native lifecycle starts a private WinExe without affecting a same-name sentinel'); passed++;

  const target = await runtime.resolveTarget('claude-desktop', detected);
  const snapshot = await runtime.listProcesses(target);
  assert.equal(snapshot.uncertain, false); assert.equal(snapshot.processes.length, 1);
  const selectedProcess = snapshot.processes[0];
  assert.equal(selectedProcess.pid, Number(read(selected.ready)));
  assert.equal(selectedProcess.hasWindow, false);
  assert.equal(selectedProcess.protected, false);
  assert.match(selectedProcess.ownerSid, /^S-1-/);
  assert.equal(selectedProcess.executable.toLowerCase(), selected.exe.toLowerCase());
  assert.equal(await runtime.closeProcess(target, { ...selectedProcess, started: selectedProcess.started + '1' }), 'changed');
  assert.equal(await runtime.closeProcess(target, { ...selectedProcess, sessionId: selectedProcess.sessionId + 10000 }), 'changed');
  assert.equal(await runtime.closeProcess(target, selectedProcess), 'blocked');
  assert(alive(selected)); assert(alive(sentinel));
  console.log('PASS native CIM identity and close checks reject changed identity and windowless targets'); passed++;

  const second = await lifecycle.restartClient({ agentId: 'claude-desktop' });
  assert.equal(second.ok, false); assert.equal(second.operation, 'failed'); assert.match(second.message, /托盘|后台/);
  assert.equal(launches(selected), 1); assert.equal(launches(sentinel), 1);
  assert(alive(selected)); assert(alive(sentinel));
  console.log('PASS a remaining background fixture blocks restart and preserves both processes'); passed++;

  // Read only the native driver's identity projection; no close request targets Node.
  const selfSnapshot = await runtime.listProcesses({ ...target, executable: process.execPath });
  const self = selfSnapshot.processes.find(entry => entry.pid === process.pid);
  assert(self, 'Native process projection did not identify the test host');
  assert.equal(self.protected, true);
  console.log('PASS native ancestor protection marks its invoking host without closing it'); passed++;
  console.log(`${passed} native client lifecycle checks passed`);
} finally {
  if (previousHome === undefined) delete process.env.AURORA_CLIENT_HOME;
  else process.env.AURORA_CLIENT_HOME = previousHome;
  await stopFixtures();
  const resolved = fs.realpathSync.native(temporaryRoot);
  assert.equal(resolved, temporaryRoot);
  assert(path.basename(resolved).startsWith('aurora-client-native-'));
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
