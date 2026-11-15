import { parentPort, workerData } from 'node:worker_threads';
import { AGENT_ADAPTERS, configureDesktopPath, type AgentDetection } from './adapters.js';

// This worker only reads client installation/configuration locations. It never
// creates a store, imports accounts, writes configuration, or starts a client.
if (parentPort) {
  try {
    configureDesktopPath(typeof workerData?.exePath === 'string' ? workerData.exePath : undefined);
    const data: Record<string, AgentDetection> = {};
    // Windows desktop registration/resource probes can take several seconds.
    // Finish the inexpensive CLI/manual clients first so a timeout preserves them.
    const adapters = [...AGENT_ADAPTERS.filter(adapter => adapter.id !== 'chatgpt-desktop'), ...AGENT_ADAPTERS.filter(adapter => adapter.id === 'chatgpt-desktop')];
    for (const adapter of adapters) {
      try { data[adapter.id] = adapter.detect(); }
      catch { data[adapter.id] = { installed: false, configured: false, detectionError: '暂时无法检测此客户端，请稍后重新检测。' }; }
      parentPort.postMessage({ type: 'progress', id: adapter.id, detection: data[adapter.id] });
    }
    parentPort.postMessage({ type: 'complete', data });
  } catch {
    // Never send subprocess output or parser errors back to the renderer.
    parentPort.postMessage({ type: 'failed' });
  } finally { parentPort.close(); }
}
