import { parentPort, workerData } from 'node:worker_threads';
import { scanSessions, readSession, exportSessionMarkdown } from './sessions.js';
import { listCodexAssets } from './codex.js';
import { detectCodingDesktop } from './desktopDetection.js';

// Never accept code/module names, launch clients, or construct an AuroraStore here.
// Existing read functions retain their file containment and size validation.
if (parentPort) {
  try {
    const input = workerData?.input;
    let value: unknown;
    switch (workerData?.job) {
      case 'sessions.scan': value = scanSessions(); break;
      case 'sessions.read': value = readSession(input.path); break;
      case 'sessions.export': value = input.summary ? exportSessionMarkdown(input.summary)
        : readSession(input.path).map(m => `## ${m.role}\n\n${m.text}\n`).join('\n'); break;
      case 'codex.assets': value = listCodexAssets(); break;
      case 'desktop.detect': value = detectCodingDesktop(input?.exePath); break;
      default: throw new Error('不支持的只读扫描任务');
    }
    parentPort.postMessage({ ok: true, value });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : '本地扫描失败，请重试' });
  } finally { parentPort.close(); }
}
