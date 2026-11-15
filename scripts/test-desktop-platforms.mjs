import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-desktop-platforms-')));
const bundle = path.join(temporaryRoot, 'api.cjs');
await build({ stdin: { contents: `export * from './src/core/desktopDetection.ts'; export { desktopDebugLaunch } from './src/core/injector.ts'; export * from './src/core/clientProcesses.ts'; export { dreamThemeSource } from './src/core/extensions/theme.ts';`, resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const api = createRequire(import.meta.url)(bundle);
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const metadata = (executable = 'Desktop Main') => ({ CFBundleExecutable: executable, CFBundleIdentifier: 'io.aurora.private.desktop-fixture', CFBundleDisplayName: 'ChatGPT Beta', CFBundleShortVersionString: '3.2.1', CFBundleVersion: '321' });
const options = { platform: 'darwin', isolatedHome: temporaryRoot, readPlist: file => JSON.parse(fs.readFileSync(file, 'utf8')), canExecute: () => true };
const app = path.join(temporaryRoot, 'Applications', 'ChatGPT Beta.app');
const main = path.join(app, 'Contents', 'MacOS', 'Desktop Main');
const plist = path.join(app, 'Contents', 'Info.plist');
write(main, 'private test executable placeholder'); write(plist, JSON.stringify(metadata()));
let passed = 0;
function test(label, run) { run(); passed++; console.log(`PASS ${label}`); }

try {
  test('macOS .app and its declared executable resolve with actual names and version', () => {
    const result = api.resolveMacApplication(app, options);
    assert.equal(result.executable, fs.realpathSync(main)); assert.equal(result.bundlePath, fs.realpathSync(app));
    assert.equal(result.bundleId, metadata().CFBundleIdentifier); assert.equal(result.version, '3.2.1');
    assert.equal(result.resourcesPath, path.join(app, 'Contents', 'Resources'));
    assert.deepEqual(api.resolveMacApplication(main, options), result);
  });
  test('plain macOS chat applications are installed without claiming Electron programming support', () => {
    const result = api.inspectCodingDesktop(app, options);
    assert.equal(result.installed, true); assert.equal(result.supportsCodexConfig, false);
    assert.throws(() => api.desktopDebugLaunch(result, 9222, 'darwin'), /原生聊天版/);
  });
  test('macOS isolated discovery reads Applications and actual Contents/Resources', () => {
    write(path.join(app, 'Contents', 'Resources', 'codex'), 'resource marker');
    const found = api.detectCodingDesktop(undefined, options);
    assert.equal(found.executable, main); assert.equal(found.supportsCodexConfig, true);
    assert.equal(found.exePath, app); assert.equal(found.version, '3.2.1');
    const launch = api.desktopDebugLaunch(found, 9333, 'darwin');
    assert.equal(launch.command, '/usr/bin/open');
    assert.deepEqual(launch.args, ['-n', '-a', app, '--args', '--remote-debugging-port=9333', '--remote-debugging-address=127.0.0.1']);
  });
  test('Windows isolated discovery preserves executable and resource layouts', () => {
    const exe = path.join(temporaryRoot, 'AppData', 'Local', 'Programs', 'ChatGPT', 'ChatGPT.exe');
    write(exe, 'private fixture'); write(path.join(path.dirname(exe), 'resources', 'app-server.exe'), 'private resource');
    const found = api.detectCodingDesktop(undefined, { platform: 'win32', isolatedHome: temporaryRoot });
    assert.equal(found.executable, exe); assert.equal(found.supportsCodexConfig, true);
    assert.deepEqual(api.desktopDebugLaunch(found, 9222, 'win32'), { command: exe, args: ['--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1'] });
  });
  test('invalid, escaping and non-executable bundle main programs fail before launch', () => {
    write(plist, JSON.stringify(metadata('../outside')));
    assert.throws(() => api.resolveMacApplication(app, options), /CFBundleExecutable/);
    write(plist, JSON.stringify(metadata('Missing')));
    assert.throws(() => api.resolveMacApplication(app, options), /不存在/);
    write(plist, JSON.stringify(metadata()));
    assert.throws(() => api.resolveMacApplication(app, { ...options, canExecute: () => false }), /执行权限/);
    const helper = path.join(app, 'Contents', 'MacOS', 'Helper'); write(helper, 'helper');
    assert.throws(() => api.resolveMacApplication(helper, options), /辅助进程/);
    assert.equal(api.resolveMacApplication(path.join(temporaryRoot, 'missing.app'), options), null);
  });
  test('configured application metadata failures do not break detection and recover after an update', () => {
    write(plist, '{malformed');
    assert.throws(() => api.inspectCodingDesktop(app, options));
    const unavailable = api.detectCodingDesktop(app, options);
    assert.equal(unavailable.installed, false); assert.equal(unavailable.supportsCodexConfig, false);
    assert.match(unavailable.detectionError, /更新|安装/);
    assert.equal(unavailable.executable, undefined);
    write(plist, JSON.stringify(metadata()));
    assert.equal(api.detectCodingDesktop(app, options).installed, true);
  });
  test('repair process detection covers Windows desktop and CLI without unrelated names', () => {
    const rows = '"ChatGPT.exe","1"\r\n"Codex.exe","2"\r\n"not-codex.exe","3"\r\n"ChatGPT Beta.exe","4"';
    assert.deepEqual(api.parseCodingClientProcesses(rows, 'win32'), ['ChatGPT.exe', 'Codex.exe', 'ChatGPT Beta.exe']);
    assert.deepEqual(api.codingProcessCommand('win32').args, ['/FO', 'CSV', '/NH']);
  });
  test('macOS repair detects custom bundle main and helper processes using comm only', () => {
    const rows = '/Applications/ChatGPT Beta.app/Contents/MacOS/Desktop Main\n/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper\n/usr/local/bin/codex\n/usr/bin/node\n/Applications/Other.app/Contents/MacOS/Other';
    assert.deepEqual(api.parseCodingClientProcesses(rows, 'darwin'), ['Desktop Main', 'Codex Helper', 'codex']);
    assert.deepEqual(api.codingProcessCommand('darwin'), { command: '/bin/ps', args: ['-ww', '-axo', 'comm='] });
    assert.deepEqual(api.parseCodingClientProcesses('/custom/Renamed.app/Contents/MacOS/Main', 'darwin', ['/custom/Renamed.app/Contents/MacOS/Main']), ['Main']);
    assert.deepEqual(api.parseCodingClientProcesses('/custom/Renamed.app/Contents/Frameworks/Utility Helper', 'darwin', ['/custom/Renamed.app/Contents/MacOS/Main']), ['Utility Helper']);
  });
  test('all bundled themes compile for both Windows and macOS artwork', () => {
    for (const platform of ['win32', 'darwin']) for (const theme of ['dream', 'snow', 'glass', 'tiger']) {
      const source = api.dreamThemeSource({ theme }, platform); new Function(source);
      assert(source.includes(platform === 'win32' ? '"windows"' : '"macos"'));
    }
  });
  test('extension Mod shortcuts select Command on macOS and Control on Windows', () => {
    const file = fs.readFileSync(path.join(workspace, 'third_party/codexplusplus/assets/inject/renderer-inject/92-extension-extras.js'), 'utf8');
    const start = file.indexOf('  const codexPlusIsMac =');
    const end = file.indexOf('  function codexPlusRegisterShortcut', start);
    assert(start >= 0 && end > start);
    for (const platform of ['MacIntel', 'Win32']) {
      const context = vm.createContext({ navigator: { platform } });
      const spec = vm.runInContext(file.slice(start, end) + '\ncodexPlusParseShortcut("Mod+Shift+K")', context);
      assert.equal(spec.meta, platform === 'MacIntel'); assert.equal(spec.ctrl, platform === 'Win32'); assert.equal(spec.shift, true);
    }
  });
  console.log(`${passed} desktop platform checks passed`);
} finally {
  assert.equal(path.dirname(temporaryRoot).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert(path.basename(temporaryRoot).startsWith('aurora-desktop-platforms-'));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
