import React from 'react';
import { type Provider, type ProviderBalanceEntry, type ProviderBalanceResult } from '../lib/api';
import { balanceUnavailable } from '../hooks/useProviderBalances';
import { Btn, Ico } from './ui';

const scopeLabel = { account: '账户余额', key: '密钥额度', subscription: '套餐额度' };
const unitLabel = (currency: string) => currency === 'POINTS' ? '额度点数' : currency === 'UNKNOWN' ? '单位未提供' : currency;
function amount(value?: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value) : '—';
}
function time(value?: string) {
  if (!value) return '尚无成功记录';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '更新时间未知';
}
function Entry({ entry }: { entry: ProviderBalanceEntry }) {
  return <div className="balance-entry">
    <div className="balance-entry-title"><span>{entry.label || scopeLabel[entry.scope]}</span><span className="balance-scope">{scopeLabel[entry.scope]}</span></div>
    <div className="balance-value"><strong className="balance-amount">{entry.unlimited ? '不限额' : amount(entry.remaining)}</strong><span>{unitLabel(entry.currency)}</span></div>
    {(entry.total !== undefined || entry.used !== undefined) && <div className="balance-secondary">已用 {amount(entry.used)} · 总额 {amount(entry.total)} {unitLabel(entry.currency)}</div>}
    {entry.resetsAt && <div className="balance-secondary">重置时间：<time dateTime={entry.resetsAt} title={entry.resetsAt}>{time(entry.resetsAt)}</time></div>}
  </div>;
}

export default function ProviderBalance({ provider, result, error, busy, onRefresh }: {
  provider: Provider; result?: ProviderBalanceResult; error?: string; busy?: boolean; onRefresh: (keyId?: string) => void;
}) {
  const unavailable = balanceUnavailable(provider);
  const items = result?.items || [];
  const renderItem = (item: ProviderBalanceResult['items'][number]) => <div className={`provider-balance-item ${item.stale ? 'is-stale' : ''}`} data-key-id={item.keyId} key={item.keyId}>
    <div className="balance-key-heading"><b>{item.keyLabel || '未命名 Key'}</b><Btn size="sm" variant="ghost" title={`刷新 ${item.keyLabel || '未命名 Key'} 余额`} disabled={!!busy || item.status === 'disabled'} onClick={() => onRefresh(item.keyId)}><Ico name="refresh" size={12} />刷新</Btn></div>
    {item.entries.map((entry, index) => <Entry key={`${entry.scope}:${entry.currency}:${index}`} entry={entry} />)}
    {!item.entries.length && <p className="balance-empty"><span className="balance-amount">—</span> {item.message || ({ ok: '上游未提供余额数值', error: '查询失败', unsupported: '暂不支持自动查询，请配置自定义接口', disabled: '此 Key 已停用', unconfigured: '尚未配置查询凭据' }[item.status])}</p>}
    {!!item.entries.length && item.message && <p className={item.status === 'error' ? 'balance-error' : 'balance-secondary'} role={item.status === 'error' ? 'alert' : undefined}>{item.message}</p>}
    <div className="balance-time">{item.updatedAt ? <>上次成功：<time dateTime={item.updatedAt} title={item.updatedAt}>{time(item.updatedAt)}</time></> : '尚无成功记录'}{item.cached && <span className="balance-cache">缓存</span>}</div>
    {item.stale && <p className="balance-stale">刷新失败，显示上次成功的余额</p>}
  </div>;
  return <section className="provider-balance" aria-label={`${provider.name} 余额与额度`} aria-busy={!!busy}>
    <div className="balance-heading"><span><Ico name="chart" size={13} />余额与额度</span><Btn size="sm" variant="ghost" disabled={!!busy || !!unavailable} onClick={() => onRefresh()}>{busy ? '查询中…' : '刷新余额'}</Btn></div>
    {unavailable ? <p className="balance-empty">{unavailable}</p> : <>
      {error && !items.some(item => item.status === 'error' && item.message === error) && <p className="balance-error" role="alert">{error}{items.some(item => item.entries.length) ? '，保留上次成功结果。' : ''}</p>}
      {!items.length && <p className="balance-empty">{busy ? '正在读取供应商余额…' : result?.message || (error ? '暂无可用余额数据' : '尚未查询余额')}</p>}
      {items[0] && renderItem(items[0])}
      {items.length > 1 && <details className="balance-more"><summary>其他 {items.length - 1} 个 Key 的余额</summary>{items.slice(1).map(renderItem)}</details>}
      {items.length > 1 && <p className="balance-note">各 Key 单独展示，同一账户的余额可能重复。</p>}
    </>}
  </section>;
}
