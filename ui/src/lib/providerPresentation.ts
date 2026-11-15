import type { Provider, ProviderBalanceResult } from './api';

export type ProviderView = 'grid' | 'list';
export type BalanceFilter = 'all' | 'failed' | 'unknown' | 'nonpositive' | 'paused';
export const PROVIDER_VIEW_KEY = 'aurora.providers.view';

export function readProviderView(): ProviderView {
  try { return window.localStorage.getItem(PROVIDER_VIEW_KEY) === 'list' ? 'list' : 'grid'; }
  catch { return 'grid'; }
}

export function persistProviderView(view: ProviderView) {
  try { window.localStorage.setItem(PROVIDER_VIEW_KEY, view); } catch { /* Restricted storage still permits switching this page. */ }
}

export interface ProviderBalanceView { result?: ProviderBalanceResult; error?: string }

/** Flags describe individual query results, never the availability of an entire provider. */
export function providerBalanceFacts(provider: Provider, view?: ProviderBalanceView) {
  const paused = !provider.enabled || provider.balanceQuery?.adapter === 'disabled';
  if (paused) return { paused: true, failed: false, unknown: false, nonpositive: false };
  const items = (view?.result?.items || []).filter(item => item.status !== 'disabled');
  const independentAuth = provider.balanceQuery?.adapter === 'custom' && ['none', 'token'].includes(provider.balanceQuery.auth || '');
  const missingKey = !independentAuth && provider.apiKeys.some(key => key.enabled && !items.some(item => item.keyId === key.id));
  return {
    paused: false,
    failed: !!view?.error || items.some(item => item.status === 'error'),
    unknown: !items.length || missingKey || items.some(item => item.status !== 'ok' || item.stale || !item.entries.length
      || item.entries.some(entry => !entry.unlimited && !(typeof entry.remaining === 'number' && Number.isFinite(entry.remaining)))),
    nonpositive: items.some(item => item.status === 'ok' && !item.stale && item.entries.some(entry => !entry.unlimited
      && typeof entry.remaining === 'number' && Number.isFinite(entry.remaining) && entry.remaining <= 0)),
  };
}
