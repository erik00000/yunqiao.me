import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// LaunchServices/AppKit acceptance uses only private Cocoa applications. No real clients,
// Terminal AppleEvents, kill signals, user credentials or user application files are accessed.
if (process.platform !== 'darwin') { console.log('SKIP native macOS lifecycle: macOS only'); process.exit(0); }
const runFile = promisify(execFile);
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-macos-native-')));
const priorHome = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = temporary;
let checks = 0;
const fixtures = [];
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(condition, message, timeout = 15000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await condition()) return; await wait(100); } throw new Error(message); }
const text = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const launches = fixture => text(path.join(fixture.state, 'launches.log')).trim().split('\n').filter(Boolean).length;
const alive = fixture => { const pid = Number(text(path.join(fixture.state, 'pid'))); try { return !!pid && Date.now() - fs.statSync(path.join(fixture.state, 'heartbeat')).mtimeMs < 3000; } catch { return false; } };
const check = async (label, fn) => { await fn(); checks++; console.log(`PASS ${label}`); };
const fixtureSource = `#import <Cocoa/Cocoa.h>
#include <unistd.h>
@interface FixtureDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSString *root;
@property(nonatomic, strong) NSDate *deadline;
@property(nonatomic, strong) NSTimer *timer;
- (void)tick:(NSTimer *)timer;
@end
@implementation FixtureDelegate
- (BOOL)exists:(NSString *)name { return [[NSFileManager defaultManager] fileExistsAtPath:[self.root stringByAppendingPathComponent:name]]; }
- (void)write:(NSString *)name text:(NSString *)value { [value writeToFile:[self.root stringByAppendingPathComponent:name] atomically:YES encoding:NSUTF8StringEncoding error:nil]; }
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.root = [[[[NSBundle mainBundle] bundlePath] stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"fixture-state"]; self.deadline = [NSDate dateWithTimeIntervalSinceNow:90];
  NSString *line = [NSString stringWithFormat:@"%d\\n", getpid()];
  NSString *log = [self.root stringByAppendingPathComponent:@"launches.log"];
  if (![[NSFileManager defaultManager] fileExistsAtPath:log]) [[NSData data] writeToFile:log atomically:YES];
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:log]; [handle seekToEndOfFile]; [handle writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [handle closeFile];
  [self write:@"pid" text:[NSString stringWithFormat:@"%d", getpid()]];
  self.timer = [NSTimer scheduledTimerWithTimeInterval:0.1 target:self selector:@selector(tick:) userInfo:nil repeats:YES]; [self tick:self.timer];
}
- (void)tick:(NSTimer *)timer {
  [self write:@"heartbeat" text:[NSString stringWithFormat:@"%.6f", [NSDate timeIntervalSinceReferenceDate]]];
  if ([self exists:@"stop"] || [self.deadline timeIntervalSinceNow] <= 0) [[NSApplication sharedApplication] terminate:nil];
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  [self write:@"quit-request" text:[NSString stringWithFormat:@"%d", getpid()]];
  if ([self exists:@"refuse"] && ![self exists:@"stop"] && [self.deadline timeIntervalSinceNow] > 0) return NSTerminateCancel;
  return NSTerminateNow;
}
- (void)applicationWillTerminate:(NSNotification *)notification { [self write:@"exited" text:[NSString stringWithFormat:@"%d", getpid()]]; [self.timer invalidate]; }
@end
int main(int argc, const char *argv[]) { @autoreleasepool { NSApplication *application = [NSApplication sharedApplication]; [application setActivationPolicy:NSApplicationActivationPolicyAccessory]; FixtureDelegate *delegate = [FixtureDelegate new]; application.delegate = delegate; [application run]; } return 0; }
`;
async function makeFixture(parent, bundleId) {
  const bundle = path.join(temporary, parent, 'Claude.app'), executable = path.join(bundle, 'Contents', 'MacOS', 'ClaudeLauncher');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  const source = path.join(temporary, 'Fixture.m'); fs.writeFileSync(source, fixtureSource);
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>YunQiao Private Lifecycle Fixture</string><key>CFBundleExecutable</key><string>ClaudeLauncher</string><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/></dict></plist>`);
  await runFile('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-Wno-incompatible-pointer-types', '-framework', 'Cocoa', source, '-o', executable], { timeout: 60000, maxBuffer: 1024 * 1024 });
  await runFile('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const state = path.join(path.dirname(bundle), 'fixture-state'); fs.mkdirSync(state);
  const fixture = { bundle, executable, bundleId, state }; fixtures.push(fixture); return fixture;
}
async function diagnostic(fixtures) {
  console.log('Private fixture markers', JSON.stringify(fixtures.map(fixture => ({ bundleId: fixture.bundleId, alive: alive(fixture), launches: launches(fixture), pid: Number(text(path.join(fixture.state, 'pid'))) || null }))));
  const source = `ObjC.import('AppKit'); ObjC.import('Foundation');
function run(argv) {
  var fixtures = JSON.parse(argv[0]); var output = [];
  var applications = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < Number(applications.count); i++) {
    var app = applications.objectAtIndex(i); var id = ''; try { id = String(ObjC.unwrap(app.bundleIdentifier) || ''); } catch (_) { continue; }
    if (!fixtures.some(function(fixture) { return fixture.bundleId === id; })) continue;
    var row = { bundleId: id, pid: Number(app.processIdentifier) };
    try { row.bundlePath = ObjC.unwrap(app.bundleURL.path); } catch(e) { row.bundleError = String(e); }
    try { row.executablePath = ObjC.unwrap(app.executableURL.path); } catch(e) { row.executableError = String(e); }
    try { row.canonicalBundle = ObjC.unwrap(app.bundleURL.URLByResolvingSymlinksInPath.path); } catch(e) { row.canonicalError = String(e); }
    try { row.isTerminatedType = typeof app.isTerminated; row.isTerminated = Boolean(app.isTerminated); row.terminatedType = typeof app.terminated; row.terminated = Boolean(app.terminated); } catch(e) { row.terminatedError = String(e); }
    try { row.launchDateNil = app.launchDate.isNil(); row.launchTime = Number(app.launchDate.timeIntervalSince1970); } catch(e) { row.launchError = String(e); }
    output.push(row);
  }
  return JSON.stringify({ count: Number(applications.count), fixtures: output });
}`;
  try { const result = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source, JSON.stringify(fixtures.map(({ bundleId }) => ({ bundleId })))], { timeout: 15000 }); console.log('Private fixture AppKit', result.stdout.trim()); }
  catch (error) { console.log('Private fixture AppKit diagnostic failed', String(error.stderr || error.message).slice(0, 2000)); }
  for (const fixture of fixtures) {
    const pid = Number(text(path.join(fixture.state, 'pid'))); if (!pid) continue;
    try { const result = await runFile('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'ppid=', '-o', 'lstart='], { timeout: 5000 }); console.log('Private fixture process', fixture.bundleId, result.stdout.trim()); } catch { console.log('Private fixture exited', fixture.bundleId); }
  }
}

try {
  const output = path.join(temporary, 'lifecycle.cjs');
  await build({ entryPoints: ['src/main/clientLifecycle.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(output);
  const target = await makeFixture('Applications', 'io.yunqiao.lifecycle.fixture.target');
  const sentinel = await makeFixture("other path ' quoted", 'io.yunqiao.lifecycle.fixture.sentinel');
  const detected = { installed: true, configured: false, command: target.bundle };
  const runtime = { ...api.nativeClientLifecycleRuntime, detect: () => detected };
  const lifecycle = api.createClientLifecycle(runtime);
  const payload = { agentId: 'claude-desktop' };
  await check('Real macOS bundle metadata resolves the declared executable and discovers only isolated apps', async () => {
    const info = await lifecycle.describeClientLifecycle(payload); assert.equal(info.installed, true); assert.equal(info.supported, true); assert.equal(launches(target), 0);
    const resolved = await runtime.resolveTarget(payload.agentId, detected); assert.equal(resolved.executable, target.executable); assert.equal(resolved.bundleId, target.bundleId); assert.equal(resolved.bundlePath, target.bundle);
    const discovered = await runtime.resolveTarget(payload.agentId, { installed: false, configured: false }); assert.equal(discovered.bundlePath, target.bundle);
    assert.equal(await runtime.resolveTarget('workbuddy', { installed: false, configured: false }), null);
  });
  await runFile('/usr/bin/open', ['-n', '-a', sentinel.bundle], { timeout: 15000 }); await until(() => alive(sentinel), 'Private sentinel did not start through LaunchServices');
  const sentinelPid = Number(text(path.join(sentinel.state, 'pid')));
  await check('LaunchServices starts the private target and AppKit verifies exact bundle/executable/UID identity', async () => {
    const result = await lifecycle.restartClient(payload); if (!result.ok) await diagnostic([target, sentinel]); assert.equal(result.ok, true, result.message); assert.equal(result.operation, 'started');
    await until(() => alive(target), 'Private target did not initialize');
    const resolved = await runtime.resolveTarget(payload.agentId, detected); const found = await runtime.listProcesses(resolved);
    assert.equal(found.uncertain, false); assert.equal(found.processes.length, 1); assert.equal(found.processes[0].executable, target.executable); assert.equal(found.processes[0].ownerSid, 'uid:' + process.getuid()); assert(found.processes[0].started.includes('|')); assert.equal(launches(target), 1);
  });
  await check('A mismatched start identity cannot request application termination', async () => {
    const resolved = await runtime.resolveTarget(payload.agentId, detected); const row = (await runtime.listProcesses(resolved)).processes[0];
    assert.equal(await runtime.closeProcess(resolved, { ...row, started: '1|not the launch identity' }), 'changed');
    assert.equal(await runtime.closeProcess(resolved, { ...row, ownerSid: 'uid:999999' }), 'changed');
    assert.equal(fs.existsSync(path.join(target.state, 'quit-request')), false); assert(alive(target));
  });
  await check('AppKit normal quit restarts only the exact target while the same-name sentinel survives', async () => {
    const previousPid = Number(text(path.join(target.state, 'pid'))); const result = await lifecycle.restartClient(payload); assert.equal(result.ok, true, result.message); assert.equal(result.operation, 'restarted');
    await until(() => alive(target) && launches(target) === 2 && Number(text(path.join(target.state, 'pid'))) !== previousPid, 'Target did not restart with a new process');
    assert.equal(Number(text(path.join(target.state, 'exited'))), previousPid); assert.equal(Number(text(path.join(sentinel.state, 'pid'))), sentinelPid); assert.equal(launches(sentinel), 1); assert(alive(sentinel));
  });
  await check('An application that refuses normal quit is left running without a second instance', async () => {
    fs.writeFileSync(path.join(target.state, 'refuse'), 'hold'); const previousPid = Number(text(path.join(target.state, 'pid'))), before = launches(target);
    const result = await lifecycle.restartClient(payload); assert.equal(result.ok, false); assert.equal(result.operation, 'failed'); assert(alive(target)); assert.equal(Number(text(path.join(target.state, 'pid'))), previousPid); assert.equal(launches(target), before); assert(alive(sentinel));
    fs.unlinkSync(path.join(target.state, 'refuse'));
  });
  await check('Changing bundle metadata invalidates the target before any launch', async () => {
    const resolved = await runtime.resolveTarget(payload.agentId, detected); fs.appendFileSync(path.join(target.bundle, 'Contents', 'Info.plist'), '\n'); assert.equal(runtime.validateTarget(resolved), false); assert.equal(launches(target), 2);
  });
  console.log(`Native macOS lifecycle: ${checks} checks passed (${os.arch()}, real Cocoa/LaunchServices/AppKit; Terminal automation not exercised)`);
} finally {
  // Only fixtures inside this test's unique root receive their private self-exit marker.
  for (const fixture of fixtures) fs.writeFileSync(path.join(fixture.state, 'stop'), 'exit');
  for (const fixture of fixtures) {
    const pid = Number(text(path.join(fixture.state, 'pid')));
    if (pid) await until(() => Number(text(path.join(fixture.state, 'exited'))) === pid, 'Private fixture did not acknowledge its stop file', 20000);
  }
  await wait(300);
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  if (path.dirname(temporary) === fs.realpathSync(os.tmpdir()) && path.basename(temporary).startsWith('yunqiao-macos-native-')) fs.rmSync(temporary, { recursive: true, force: true });
}
