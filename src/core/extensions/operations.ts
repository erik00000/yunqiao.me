import type { AuroraStore } from '../store/index.js';
const active = new Set<string>();
export function extensionOperationBusy(store: AuroraStore): boolean { return active.has(store.dir); }
/** Serialize mutations from both Aurora's UI and the injected settings bridge. */
export async function extensionOperation<T>(store: AuroraStore, operation: () => Promise<T>): Promise<T> {
  if (active.has(store.dir)) throw new Error('另一个扩展操作正在进行，请等待完成');
  active.add(store.dir);
  try { return await operation(); } finally { active.delete(store.dir); }
}
