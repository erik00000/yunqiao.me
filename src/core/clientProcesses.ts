import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
/** comm contains only executable names/paths; never request args or command lines. */
export function parseCodingClientProcesses(output: string, platform: NodeJS.Platform, executables: string[] = []): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const expected = new Set(executables.map(file => paths.basename(file).toLowerCase()));
  const expectedBundles = platform === 'darwin' ? executables.flatMap(file => /^(.*\.app)\/Contents\/MacOS\/[^/]+$/i.exec(file)?.[1] || []) : [];
  return [...new Set(output.split(/\r?\n/).flatMap(line => {
    const command = platform === 'win32' ? /^"([^"]+)"/.exec(line)?.[1] || '' : line.trim();
    const name = paths.basename(command);
    let actual = command;
    if (platform === 'darwin' && path.posix.isAbsolute(command)) try { actual = fs.realpathSync(command); } catch { /* Keep the kernel-reported path when the process exits during inspection. */ }
    const codingBundle = platform === 'darwin' && (/\/(?:ChatGPT(?: Beta)?|Codex)\.app\/Contents\/(?:MacOS|Frameworks|Resources)\//i.test(command) || expectedBundles.some(bundle => actual.startsWith(bundle + '/Contents/')));
    return /^(?:codex|chatgpt(?: beta)?)(?:\.exe)?$/i.test(name) || expected.has(name.toLowerCase()) || codingBundle ? [name] : [];
  }))];
}
export function codingProcessCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  return platform === 'win32' ? { command: 'tasklist', args: ['/FO', 'CSV', '/NH'] } : { command: '/bin/ps', args: ['-ww', '-axo', 'comm='] };
}
const failure = () => new Error('无法确认 ChatGPT / Codex 客户端是否已退出，请手动检查后重试');
export async function runningCodingClients(executables: string[] = []): Promise<string[]> {
  const { command, args } = codingProcessCommand(process.platform);
  try { const { stdout } = await runFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }); return parseCodingClientProcesses(stdout, process.platform, executables); }
  catch { throw failure(); }
}
export function runningCodingClientsSync(executables: string[] = []): string[] {
  const { command, args } = codingProcessCommand(process.platform);
  try { return parseCodingClientProcesses(execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }), process.platform, executables); }
  catch { throw failure(); }
}
