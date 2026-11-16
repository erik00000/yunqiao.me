import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// No package registration or application activation. Native Windows cases run
// the production PowerShell resolver against private files and fake manifests.
// Activation-branch tests replace the unique COM call with a fixture-only stub;
// the real registry probe always uses inspectOnly and never activates an app.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-packaged-launch-')));
const runFile = promisify(execFile);
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS', name); };
const write = (file, value = 'private desktop fixture') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
try {
  const bundle = path.join(root, 'module.cjs');
  await build({ entryPoints: ['src/core/windowsPackagedLaunch.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  if (process.platform !== 'win32') {
    await assert.rejects(() => api.launchWindowsPackagedDesktop('/fixture/ChatGPT.exe', 9222), /Windows/);
    console.log('SKIP native packaged launch: Windows only');
  } else {
    const ordinary = write(path.join(root, 'ordinary', 'ChatGPT.exe'));
    const install = path.join(root, "WindowsApps", "OpenAI.CodexBeta_1.0_fixture '中文 &");
    const selected = write(path.join(install, 'app', 'ChatGPT.exe'));
    const foreign = write(path.join(root, 'foreign', 'app', 'ChatGPT.exe'));
    write(path.join(install, 'AppxManifest.xml'), '<Package />');
    const packageRecord = { Name: 'OpenAI.CodexBeta', PackageFullName: 'OpenAI.CodexBeta_1.0_fixture', PackageFamilyName: 'OpenAI.CodexBeta_fixture', InstallLocation: install };
    const manifest = applications => '<Package><Applications>' + applications + '</Applications></Package>';
    const app = (id = 'DesktopMain', executable = 'app\\ChatGPT.exe') => `<Application Id="${id}" Executable="${executable}" />`;
    const runtime = run => ({ platform: 'win32', run });
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let sequence = 0;
    async function probe(executable = selected, fixture = {}, actualRegistry = false, activationFixture = false) {
      assert(!(actualRegistry && activationFixture), 'Real registry inspection must never activate');
      const activationLog = path.join(root, `activation-${sequence++}.json`);
      const fixtureData = { packages: [packageRecord], manifests: { [packageRecord.PackageFullName]: manifest(app()) }, ...fixture };
      const request = { executable: fs.realpathSync.native(executable), port: 9333, packagedPath: executable === selected, inspectOnly: !activationFixture };
      const json = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
      let productionSource = api.windowsPackagedLaunchSource;
      if (activationFixture) {
        const replaceOnce = (before, after) => {
          assert.equal(productionSource.split(before).length - 1, 1, 'Fixture must replace exactly one known production expression');
          productionSource = productionSource.replace(before, after);
          assert(!productionSource.includes(before), 'Real activation expression must not survive the test replacement');
        };
        replaceOnce('$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', '[bool]$fixtureData.elevated');
        replaceOnce('[YunqiaoPackagedDesktop.Native]::Activate($match.aumid, $arguments)', 'Invoke-FixtureActivation -Aumid $match.aumid -Arguments $arguments');
        assert(!productionSource.includes('[YunqiaoPackagedDesktop.Native]::Activate('));
        fixtureData.activationLog = activationLog;
      }
      const source = `$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json(request)}')) | ConvertFrom-Json\n`
        + (actualRegistry ? '' : `$fixtureData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json(fixtureData)}')) | ConvertFrom-Json
function Get-AppxPackage {
  param([string]$Name)
  if ($fixtureData.registryError) { throw 'private registry error' }
  if ($Name -and $fixtureData.PSObject.Properties.Name -contains 'currentPackages') { @($fixtureData.currentPackages) | Where-Object { $_.Name -eq $Name }; return }
  @($fixtureData.packages) | Where-Object { !$Name -or $_.Name -eq $Name }
}
function Get-AppxPackageManifest {
  param([string]$Package)
  if ($fixtureData.manifestError) { throw 'private manifest error' }
  [xml]$fixtureData.manifests.$Package
}
function Invoke-FixtureActivation {
  param([string]$Aumid, [string]$Arguments)
  if ($fixtureData.activationError) { throw 'private activation error' }
  [IO.File]::WriteAllText($fixtureData.activationLog, (@{ aumid=$Aumid; arguments=$Arguments } | ConvertTo-Json -Compress))
  [uint32]321
}
`) + productionSource;
      const { stdout } = await runFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      if (activationFixture) result.activation = fs.existsSync(activationLog) ? JSON.parse(fs.readFileSync(activationLog, 'utf8')) : null;
      return result;
    }
    await check('Only a validated executable and numeric loopback port reach the host', async () => {
      let called = 0;
      const host = runtime(async () => { called++; return { kind: 'unpackaged' }; });
      for (const value of ['ChatGPT.exe', 'C:\\Apps\\ChatGPT.exe\nwhoami', process.execPath, path.join(root, 'missing', 'ChatGPT.exe')]) await assert.rejects(() => api.launchWindowsPackagedDesktop(value, 9222, host));
      for (const port of [0, 1023, 65536, '9222', 9222.5, NaN]) await assert.rejects(() => api.launchWindowsPackagedDesktop(ordinary, port, host), /端口/);
      assert.equal(called, 0);
    });
    await check('Ordinary desktop launch may fall through; registered launches preserve their returned PID', async () => {
      assert.deepEqual(await api.launchWindowsPackagedDesktop(ordinary, 9222, runtime(async request => { assert.equal(request.packagedPath, false); return { kind: 'unpackaged' }; })), { packaged: false });
      assert.deepEqual(await api.launchWindowsPackagedDesktop(selected, 9333, runtime(async request => { assert.equal(request.executable, fs.realpathSync.native(selected)); assert.equal(request.port, 9333); assert.equal(request.packagedPath, true); return { kind: 'activated', pid: 123 }; })), { packaged: true, pid: 123 });
    });
    await check('Known WindowsApps or manifest-bearing paths can never silently fall through', async () => {
      const manifestExe = write(path.join(root, 'copied-package', 'ChatGPT.exe')); write(path.join(path.dirname(manifestExe), 'AppxManifest.xml'), '<Package />');
      for (const file of [selected, manifestExe]) await assert.rejects(() => api.launchWindowsPackagedDesktop(file, 9222, runtime(async () => ({ kind: 'unpackaged' }))), /注册/);
      for (const reply of [{ kind: 'activated', pid: 0 }, { kind: 'activated', pid: -1 }, { kind: 'resolved', aumid: 'ignored!App' }, null]) await assert.rejects(() => api.launchWindowsPackagedDesktop(selected, 9222, runtime(async () => reply)));
    });
    await check('Registration, elevation and activation failures produce actionable sanitized errors', async () => {
      for (const code of ['target-changed', 'registry-unavailable', 'ambiguous', 'unregistered', 'invalid-identity', 'elevated', 'activation-failed', 'private-unknown-code']) {
        await assert.rejects(() => api.launchWindowsPackagedDesktop(selected, 9222, runtime(async () => ({ kind: 'blocked', code }))), error => /[\u4e00-\u9fff]/.test(error.message) && !error.message.includes('private-unknown'));
      }
    });
    await check('Isolated profiles cannot query or activate the real package registry', async () => {
      const host = { ...runtime(async () => { throw Error('must not inspect host'); }), isolatedHome: root };
      assert.deepEqual(await api.launchWindowsPackagedDesktop(ordinary, 9222, host), { packaged: false });
      await assert.rejects(() => api.launchWindowsPackagedDesktop(selected, 9222, host), /隔离/);
      await assert.rejects(() => api.launchWindowsPackagedDesktop(ordinary, 9222, { ...host, isolatedHome: path.dirname(selected) }), /隔离/);
    });
    await check('Production PowerShell compiles COM interop and resolves the exact manifest Application, including Beta packages', async () => {
      assert.deepEqual(await probe(), { kind: 'resolved', aumid: 'OpenAI.CodexBeta_fixture!DesktopMain' });
      const alternate = manifest(app('Other', 'helper.exe') + app('ChangedId', 'app\\ChatGPT.exe'));
      assert.equal((await probe(selected, { manifests: { [packageRecord.PackageFullName]: alternate } })).aumid, 'OpenAI.CodexBeta_fixture!ChangedId');
    });
    await check('Read-only native registry inspection recognizes an unregistered ordinary installation without activating apps', async () => {
      assert.equal((await probe(ordinary, {}, true)).kind, 'unpackaged');
    });
    await check('Native activation control flow submits only the selected AUMID and validated loopback debug flags', async () => {
      const result = await probe(selected, {}, false, true);
      assert.equal(result.kind, 'activated'); assert.equal(result.pid, 321);
      assert.deepEqual(result.activation, { aumid: 'OpenAI.CodexBeta_fixture!DesktopMain', arguments: '--remote-debugging-port=9333 --remote-debugging-address=127.0.0.1' });
    });
    await check('Registration changes, elevation and COM failure stop native activation with Chinese guidance', async () => {
      for (const [fixture, expected, text] of [
        [{ currentPackages: [] }, 'target-changed', /已更新/],
        [{ currentPackages: [{ ...packageRecord, InstallLocation: path.dirname(foreign) }] }, 'target-changed', /已更新/],
        [{ elevated: true }, 'elevated', /管理员/],
        [{ activationError: true }, 'activation-failed', /商店包身份/],
      ]) {
        const result = await probe(selected, fixture, false, true);
        assert.equal(result.kind, 'blocked'); assert.equal(result.code, expected); assert.equal(result.activation, null);
        await assert.rejects(() => api.launchWindowsPackagedDesktop(selected, 9333, runtime(async () => result)), error => text.test(error.message) && !error.message.includes('private'));
      }
    });
    await check('Missing or mismatched registration never activates a different package', async () => {
      assert.equal((await probe(selected, { packages: [] })).code, 'unregistered');
      assert.equal((await probe(selected, { packages: [{ ...packageRecord, InstallLocation: path.dirname(path.dirname(foreign)) }] })).code, 'unregistered');
      assert.equal((await probe(selected, { registryError: true })).code, 'registry-unavailable');
      assert.equal((await probe(selected, { manifestError: true })).code, 'registry-unavailable');
    });
    await check('A stale unrelated package cannot block the selected package or an ordinary executable', async () => {
      const stale = { ...packageRecord, Name: 'Unrelated.Stale', PackageFullName: 'Unrelated_1', InstallLocation: path.join(root, 'missing-package') };
      assert.equal((await probe(selected, { packages: [stale, packageRecord] })).kind, 'resolved');
      assert.equal((await probe(ordinary, { packages: [stale] })).kind, 'unpackaged');
    });
    await check('Ambiguous applications and manifest path escapes are rejected', async () => {
      assert.equal((await probe(selected, { manifests: { [packageRecord.PackageFullName]: manifest(app('One') + app('Two')) } })).code, 'ambiguous');
      for (const executable of ['..\\app\\ChatGPT.exe', 'app\\..\\app\\ChatGPT.exe', 'app\\resources\\ChatGPT.exe', 'C:\\Windows\\ChatGPT.exe', 'app\\ChatGPT.exe:stream', 'app\\ChatGPT.exe.']) {
        assert.equal((await probe(selected, { manifests: { [packageRecord.PackageFullName]: manifest(app('Bad', executable)) } })).code, 'unregistered');
      }
    });
    await check('A manifest link to a different installation cannot claim the selected application', async () => {
      const linked = path.join(install, 'linked'); fs.symlinkSync(path.dirname(foreign), linked, 'junction');
      assert.equal((await probe(foreign, { manifests: { [packageRecord.PackageFullName]: manifest(app('Outside', 'linked\\ChatGPT.exe')) } })).kind, 'unpackaged');
      assert.equal((await probe(selected, { manifests: { [packageRecord.PackageFullName]: manifest(app('Outside', 'linked\\ChatGPT.exe')) } })).code, 'unregistered');
      fs.unlinkSync(linked);
    });
  }
  console.log(`Windows packaged desktop launch: ${passed} checks passed; no application was activated`);
} finally {
  if (path.dirname(root) === fs.realpathSync.native(os.tmpdir()) && path.basename(root).startsWith('yunqiao-packaged-launch-')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
