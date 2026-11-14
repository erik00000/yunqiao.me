import { createHash } from 'node:crypto';
import type { AuroraStore } from './store/index.js';
import { PROVIDER_PRESETS, type ProviderPreset } from './presets/providers.js';
import { fetchCloudCatalog, validateCloudCatalog, type CloudCatalog } from './cloud.js';

type CatalogSnapshot = Omit<CloudCatalog, 'source'> & { source: 'remote' | 'cache' | 'builtin'; syncing?: boolean };
type Session = { endpoint: string; snapshot?: CatalogSnapshot; pending?: Promise<CatalogSnapshot>; attempted: boolean };
const sessions = new WeakMap<AuroraStore, Session>();

function session(store: AuroraStore): Session {
  const endpoint = store.getSettings().catalogUrl;
  let s = sessions.get(store);
  if (!s || s.endpoint !== endpoint) {
    s = { endpoint, attempted: false };
    const key = `catalog-${createHash('sha256').update(new URL(endpoint).href.replace(/\/$/, '')).digest('hex').slice(0, 20)}.json`;
    const cache = store.readExtra<any>(key, null);
    try { if (cache) s.snapshot = { ...validateCloudCatalog(cache), source: 'cache', fetchedAt: cache.fetchedAt }; } catch { /* Refresh invalid caches. */ }
    sessions.set(store, s);
  }
  return s;
}

function snapshotOf(s: Session): CatalogSnapshot {
  return s.snapshot ? { ...s.snapshot, syncing: !!s.pending } : {
    version: 0, updatedAt: '', source: 'builtin', syncing: !!s.pending,
    warning: '尚未取得官方目录，暂用随软件提供的离线预设；联网后可刷新。',
    providers: PROVIDER_PRESETS.map(p => ({ ...p, key: p.id, name: p.nameZh || p.name })),
  };
}

export function catalogSnapshot(store: AuroraStore): CatalogSnapshot {
  return snapshotOf(session(store));
}

/** One refresh per application launch, shared by all screens; explicit refresh bypasses it. */
export async function refreshCatalog(store: AuroraStore): Promise<CatalogSnapshot> {
  const s = session(store);
  if (!s.pending) {
    s.attempted = true;
    s.pending = fetchCloudCatalog(s.endpoint, store).then(data => {
      s.snapshot = { ...data, source: data.source || 'remote' };
      return s.snapshot;
    }).catch((error: Error) => {
      const fallback = snapshotOf(s);
      s.snapshot = { ...fallback, warning: `${fallback.source === 'builtin' ? '官方目录暂不可用，使用离线预设' : '更新暂不可用，保留本地缓存'}：${error.message}` };
      return s.snapshot;
    }).finally(() => { s.pending = undefined; });
  }
  await s.pending;
  // A response started for a previous endpoint must never replace the current directory in a caller.
  if (session(store) !== s) return ensureCatalog(store);
  return snapshotOf(s);
}

export async function ensureCatalog(store: AuroraStore): Promise<CatalogSnapshot> {
  const s = session(store);
  if (!s.attempted) void refreshCatalog(store);
  // Existing installations render cached data immediately. First launch waits for its first fetch.
  if (!s.snapshot && s.pending) await s.pending;
  if (session(store) !== s) return ensureCatalog(store);
  return catalogSnapshot(store);
}

export function catalogPresets(store: AuroraStore, snapshot = catalogSnapshot(store)): ProviderPreset[] {
  return snapshot.providers.map(p => ({
    ...p, id: p.key, nameZh: p.name, vendor: p.vendor || p.name,
    region: (p.region || 'global') as ProviderPreset['region'],
    color: p.color || '#4f66e8', icon: p.icon || '◆', models: p.models || [],
  }));
}
