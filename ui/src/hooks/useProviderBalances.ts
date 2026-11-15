import { useCallback, useEffect, useRef, useState } from 'react';
import { call, type Provider, type ProviderBalanceResult } from '../lib/api';

export const BALANCE_REFRESH_MS = 5 * 60 * 1000;
export function balanceFingerprint(provider: Provider, globalProxy = ''): string {
  const hiddenCredentials = provider.apiKeys.some(key => key.hasKey && !key.key)
    || (provider.balanceQuery?.auth === 'token' && !provider.balanceQuery.token);
  return JSON.stringify({ enabled: provider.enabled, presetId: provider.presetId, baseUrl: provider.baseUrl, format: provider.format,
    keys: provider.apiKeys.map(key => ({ id: key.id, label: key.label, key: key.key, hasKey: key.hasKey, enabled: key.enabled })),
    query: provider.balanceQuery, headers: provider.headers, proxy: provider.proxy || globalProxy,
    credentialRevision: hiddenCredentials || !window.aurora ? provider.updatedAt : undefined });
}

export function balanceUnavailable(provider: Provider): string {
  if (!provider.enabled) return '供应商已停用，余额查询已暂停';
  if (provider.balanceQuery?.adapter === 'disabled') return '已关闭余额查询';
  if (provider.balanceQuery?.adapter === 'custom' && ['token', 'none'].includes(provider.balanceQuery.auth || '')) return '';
  if (!provider.apiKeys.some(key => key.enabled && (key.key || key.hasKey))) return '没有已启用且已配置的 API Key';
  return '';
}

interface BalanceView { fingerprint: string; result: ProviderBalanceResult; error?: string }
interface Flight { fingerprint: string; identity: symbol; token: symbol; promise: Promise<void> }

export function useProviderBalances(providers: Provider[], globalProxy = '') {
  const [views, setViews] = useState<Record<string, BalanceView>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const latest = useRef(new Map<string, { provider: Provider; fingerprint: string; identity: symbol }>());
  latest.current = new Map(providers.map(provider => {
    const fingerprint = balanceFingerprint(provider, globalProxy), previous = latest.current.get(provider.id);
    return [provider.id, { provider, fingerprint, identity: previous?.fingerprint === fingerprint ? previous.identity : Symbol(provider.id) }];
  }));
  const flights = useRef(new Map<string, Flight>());
  const seen = useRef(new Map<string, string>());
  const lifecycle = useRef(0);
  const alive = useRef(true);
  const batch = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async function fetchBalance(providerId: string, keyId?: string, force = false): Promise<void> {
    const current = latest.current.get(providerId);
    if (!alive.current || !current || balanceUnavailable(current.provider)) return;
    const { provider, fingerprint, identity } = current;
    const epoch = lifecycle.current;
    const existing = flights.current.get(providerId);
    if (existing) {
      await existing.promise;
      if (existing.identity !== identity && alive.current && lifecycle.current === epoch && latest.current.get(providerId)?.identity === identity) {
        await fetchBalance(providerId, keyId, force);
      }
      return;
    }
    const token = Symbol(providerId);
    const isConfigCurrent = () => alive.current && lifecycle.current === epoch && latest.current.get(providerId)?.identity === identity;
    const isCurrent = () => isConfigCurrent() && flights.current.get(providerId)?.token === token;
    setBusy(previous => ({ ...previous, [providerId]: true }));
    const promise = (async () => {
      try {
        const result = await call<ProviderBalanceResult>('provider.balance', { providerId, ...(keyId ? { keyId } : {}), force });
        if (!isCurrent()) return;
        if (!result || result.providerId !== providerId || !Array.isArray(result.items)) throw new Error('余额查询返回格式不正确');
        setViews(previous => {
          if (!isConfigCurrent()) return previous;
          const old = previous[providerId]?.fingerprint === fingerprint ? previous[providerId].result : undefined;
          const merged = keyId && old ? { ...result, items: [
            ...old.items.flatMap(item => item.keyId === keyId ? result.items.filter(next => next.keyId === keyId) : [item]),
            ...result.items.filter(item => !old.items.some(previousItem => previousItem.keyId === item.keyId)),
          ] } : result;
          return { ...previous, [providerId]: { fingerprint, result: merged } };
        });
      } catch (error: any) {
        if (!isCurrent()) return;
        const message = error?.message || '余额查询失败，请稍后重试';
        setViews(previous => {
          if (!isConfigCurrent()) return previous;
          const old = previous[providerId]?.fingerprint === fingerprint ? previous[providerId].result : undefined;
          const items = (old?.items || []).map(item => !keyId || item.keyId === keyId
            ? { ...item, status: 'error' as const, stale: item.entries.length > 0, cached: false, checkedAt: new Date().toISOString(), message } : item);
          return { ...previous, [providerId]: { fingerprint, error: message, result: { providerId, adapter: provider.balanceQuery?.adapter || 'auto', items } } };
        });
      } finally {
        if (flights.current.get(providerId)?.token === token) {
          flights.current.delete(providerId);
          if (alive.current && lifecycle.current === epoch) setBusy(previous => {
            const next = { ...previous }; delete next[providerId]; return next;
          });
        }
      }
    })();
    flights.current.set(providerId, { fingerprint, identity, token, promise });
    await promise;
  }, []);

  const refreshMany = useCallback(async (ids: string[], force: boolean) => {
    const queue = [...ids];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length && alive.current) {
        const id = queue.shift()!;
        if (!force && document.visibilityState === 'hidden') return;
        await refresh(id, undefined, force);
      }
    }));
  }, [refresh]);

  const refreshAll = useCallback((force = true) => {
    if (batch.current) return batch.current;
    const epoch = lifecycle.current;
    setBatchBusy(true);
    const work = refreshMany([...latest.current.keys()], force).finally(() => {
      if (batch.current === work) batch.current = null;
      if (alive.current && lifecycle.current === epoch) setBatchBusy(false);
    });
    batch.current = work;
    return work;
  }, [refreshMany]);

  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refreshAll(false); }, BALANCE_REFRESH_MS);
    const visible = () => { if (document.visibilityState !== 'hidden') void refreshAll(false); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive.current = false; lifecycle.current++; flights.current.clear(); seen.current.clear(); batch.current = null;
      window.clearInterval(timer); document.removeEventListener('visibilitychange', visible);
    };
  }, [refreshAll]);

  const revision = JSON.stringify(providers.map(provider => [provider.id, balanceFingerprint(provider, globalProxy)]));
  useEffect(() => {
    const changed: string[] = [];
    for (const [id, item] of latest.current) {
      if (seen.current.get(id) !== item.fingerprint) changed.push(id);
    }
    seen.current = new Map([...latest.current].map(([id, item]) => [id, item.fingerprint]));
    setViews(previous => Object.fromEntries(Object.entries(previous).filter(([id, value]) => latest.current.get(id)?.fingerprint === value.fingerprint)));
    if (document.visibilityState !== 'hidden') void refreshMany(changed, false);
  }, [revision, refreshMany]);

  const currentViews = Object.fromEntries(Object.entries(views).filter(([id, view]) => latest.current.get(id)?.fingerprint === view.fingerprint));
  return { views: currentViews, busy, batchBusy, anyBusy: Object.values(busy).some(Boolean), refresh, refreshAll };
}
