export interface ExtensionItem {
  id: string; name: string; description: string; version?: string;
  source: 'bundled' | 'builtin' | 'public' | 'full'; license?: string;
  installed: boolean; enabled: boolean; status: string; reason?: string;
  configSchema?: any; config?: any; requiresRestart?: boolean; requiresAuth?: boolean; tags?: string[];
  availableVersion?: string; updateAvailable?: boolean; catalogMissing?: boolean; missingFiles?: boolean; packagePresent?: boolean;
}
export interface ExtensionState {
  ok: boolean; message?: string; upstream: { repository: string; version: string; revision: string; license: string };
  client: { installed: boolean; detecting?: boolean; exePath?: string; version?: string; lastVersion?: string; versionChanged?: boolean; running: boolean; debugPortOpen?: boolean; connected?: boolean; compatible?: boolean; message?: string };
  items: ExtensionItem[]; connection: { port: number; exePath?: string; lastVersion?: string };
  runtime: { connected: boolean; checking?: boolean; targetTitle?: string; targetUrl?: string; applied?: number | string[]; errors?: any[] };
}
type Transport = NonNullable<Window['aurora']>;
interface Snapshot { data: ExtensionState | null; loading: boolean; error: string; mutating: boolean; updatedAt: number; }
const stores = new WeakMap<Transport, ExtensionSnapshot>();
const empty: Snapshot = { data: null, loading: false, error: '', mutating: false, updatedAt: 0 };

/** Memory only: plugin configuration must never cross desktop transports or enter browser storage. */
class ExtensionSnapshot {
  private value: Snapshot = empty;
  private listeners = new Set<() => void>();
  private epoch = 0;
  private flight: Promise<ExtensionState | false> | null = null;
  constructor(private transport?: Transport) {}
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<Snapshot>) { this.value = { ...this.value, ...patch }; for (const listener of this.listeners) listener(); }
  private invalidate() { this.epoch++; this.flight = null; this.publish({ updatedAt: 0, loading: false }); }
  private async invoke(action: string, payload?: unknown) {
    const result = await this.transport!.invoke(action, payload);
    if (result && typeof result === 'object' && 'error' in result && !('ok' in result)) throw new Error(result.error);
    return result;
  }
  private validate(value: any): ExtensionState {
    if (value?.ok !== true || !Array.isArray(value.items) || !value.client || !value.runtime || !value.connection) throw new Error(value?.message || '无法读取插件库，请重试');
    return value;
  }
  refresh = (force = false): Promise<ExtensionState | false> => {
    if (!this.transport || this.value.mutating) return Promise.resolve(false);
    if (this.flight) return this.flight;
    if (force) this.invalidate();
    if (this.value.data && this.value.updatedAt && Date.now() - this.value.updatedAt < 30_000) return Promise.resolve(this.value.data);
    const epoch = this.epoch;
    this.publish({ loading: true, error: '' });
    let flight!: Promise<ExtensionState | false>;
    flight = (async () => {
      try {
        // Local manifests and installed state become available without waiting for OS/CDP probes.
        let result = this.validate(await this.invoke('extension.list', { probeClient: false }));
        if (epoch !== this.epoch) return false;
        this.publish({ data: result });
        if (result.client.detecting || result.runtime.checking) {
          result = this.validate(await this.invoke('extension.list'));
          if (epoch !== this.epoch) return false;
          if (result.client.detecting || result.runtime.checking) throw new Error('客户端检测尚未完成，请刷新列表重试');
        }
        this.publish({ data: result, updatedAt: Date.now(), error: '' });
        return result;
      } catch (error: any) {
        if (epoch === this.epoch) this.publish({ error: error?.message || '无法读取插件库，请重试' });
        return false;
      } finally {
        if (this.flight === flight) this.flight = null;
        if (epoch === this.epoch) this.publish({ loading: false });
      }
    })();
    this.flight = flight;
    return flight;
  };
  /** Invalidate both before and after writes, including writes completed after the page unmounts. */
  mutate = async (action: string, payload?: unknown): Promise<any> => {
    if (!this.transport || this.value.mutating) throw new Error('已有插件操作正在进行，请稍后重试');
    const before = this.value, wasReading = !!this.flight;
    this.invalidate();
    this.publish({ mutating: true });
    let canceled = false;
    try {
      const result = await this.invoke(action, payload);
      canceled = action === 'agent.desktop.select' && result?.canceled === true;
      return result;
    } finally {
      this.invalidate();
      this.publish({ mutating: false, ...(canceled ? { updatedAt: before.updatedAt, error: before.error } : {}) });
      if (!canceled || wasReading) void this.refresh();
    }
  };
}
const remote = new ExtensionSnapshot();
export function extensionSnapshot(transport = window.aurora): ExtensionSnapshot {
  if (!transport) return remote;
  let store = stores.get(transport);
  if (!store) { store = new ExtensionSnapshot(transport); stores.set(transport, store); }
  return store;
}
