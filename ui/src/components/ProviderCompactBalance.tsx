import React from 'react';
import type { Provider } from '../lib/api';
import { providerBalanceFacts, type ProviderBalanceView } from '../lib/providerPresentation';
import { balanceUnavailable } from '../hooks/useProviderBalances';

const scopeLabel = { account: '账户余额', key: '密钥额度', subscription: '套餐额度' };
const unitLabel = (currency: string) => currency === 'POINTS' ? '额度点数' : currency === 'UNKNOWN' ? '单位未提供' : currency;

export default function ProviderCompactBalance({ provider, view, busy }: {
  provider: Provider; view?: ProviderBalanceView; busy?: boolean;
}) {
  const facts = providerBalanceFacts(provider, view);
  const items = facts.paused ? [] : (view?.result?.items || []).filter(item => item.status !== 'disabled');
  const entries = items.flatMap(item => item.entries.map(entry => ({ item, entry })));
  const unknownOnly = !entries.length && !facts.failed;
  return <div className="provider-compact-balance" aria-label={`${provider.name} 余额摘要`} aria-busy={!!busy}>
    <div className="provider-balance-flags">
      {busy && <span className="chip">查询中…</span>}
      {facts.failed && <span className="chip provider-query-warning">有查询失败</span>}
      {facts.nonpositive && <span className="chip provider-query-warning">存在零或负余额</span>}
      {facts.unknown && !unknownOnly && <span className="chip">有余额未知</span>}
    </div>
    {entries.slice(0, 2).map(({ item, entry }, index) => <div className="provider-balance-preview" key={`${item.keyId}:${index}`}>
      <span>{item.keyLabel || '未命名 Key'} · {entry.label || scopeLabel[entry.scope]}</span>
      <strong>{entry.unlimited ? '不限额' : typeof entry.remaining === 'number' && Number.isFinite(entry.remaining)
        ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(entry.remaining) : '—'} <small>{unitLabel(entry.currency)}</small></strong>
      {(item.stale || item.status === 'error') && <small className="provider-query-warning">上次成功结果</small>}
    </div>)}
    {entries.length > 2 && <span className="provider-summary-note">另有 {entries.length - 2} 项，展开查看各 Key</span>}
    {!entries.length && <span className="provider-summary-note">{balanceUnavailable(provider) || (facts.failed ? '当前余额未知，展开查看失败原因' : '余额未知或尚未提供')}</span>}
  </div>;
}
