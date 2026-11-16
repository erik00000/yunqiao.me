import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { call, fmtTime, type AgentCatalogItem, type Provider, type UsageRecord } from '../lib/api';
import { clientConnectionRows } from '../lib/clientConnections';
import { providerBalanceFacts, type ProviderBalanceView } from '../lib/providerPresentation';
import { balanceUnavailable, useProviderBalances } from '../hooks/useProviderBalances';
import ProviderCompactBalance from './ProviderCompactBalance';
import { Btn, Ico } from './ui';
import '../styles/client-connections.css';

const balanceScope = { account: '账户余额', key: '密钥额度', subscription: '套餐额度' };

function connectionBalanceEntries(provider: Provider, view?: ProviderBalanceView) {
  return providerBalanceFacts(provider, view).paused ? [] : (view?.result?.items || []).filter(item => item.status !== 'disabled')
    .flatMap(item => item.entries.map(entry => ({ item, entry })));
}

function ConnectionBalance({ provider, view, busy }: { provider: Provider; view?: ProviderBalanceView; busy?: boolean }) {
  const facts = providerBalanceFacts(provider, view);
  const entries = connectionBalanceEntries(provider, view);
  const first = entries[0];
  const remaining = first?.entry.remaining;
  const known = typeof remaining === 'number' && Number.isFinite(remaining);
  const stale = !!first && (first.item.stale || first.item.status !== 'ok');
  const value = first?.entry.unlimited ? '不限额' : known
    ? new Intl.NumberFormat('zh-CN', remaining !== 0 && Math.abs(remaining) < 0.01
      ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 }).format(remaining)
    : facts.paused ? '已暂停' : busy ? '查询中…' : '余额未知';
  const unit = first?.entry.currency === 'POINTS' ? '额度点数' : first?.entry.currency === 'UNKNOWN' ? '单位未提供' : first?.entry.currency;
  const notes = [
    stale ? '上次成功结果' : facts.failed ? '有查询失败' : busy && first ? '更新中…' : '',
    facts.nonpositive ? '存在零或负余额' : '',
    facts.unknown && first && !stale ? '有余额未知' : '',
    entries.length > 1 ? `另 ${entries.length - 1} 项` : '',
  ].filter(Boolean);
  const unavailable = !first ? balanceUnavailable(provider) : '';
  return <div className={`connection-balance-summary${facts.failed || facts.nonpositive || stale ? ' needs-attention' : ''}`}
    aria-label={`${provider.name} 当前余额`} aria-busy={!!busy}>
    <span className="connection-balance-label">{entries.length > 1 ? '首项额度' : first ? first.entry.label || balanceScope[first.entry.scope] : '供应商余额'}</span>
    <strong title={first ? `${first.item.keyLabel || '未命名 Key'} · ${first.entry.label || balanceScope[first.entry.scope]}：${first.entry.unlimited ? '不限额' : known ? remaining : '未知'} ${unit || ''}` : unavailable || '供应商未提供可用余额'}>
      {value}{first && !first.entry.unlimited && unit && <small>{unit}</small>}
    </strong>
    {(notes.length > 0 || unavailable) && <span className="connection-balance-note">{notes.join(' · ') || unavailable}</span>}
  </div>;
}

export default function ClientConnectionOverview({ state, go, onConfigure }: Pick<PageProps, 'state' | 'go'> & { onConfigure: (agent: AgentCatalogItem) => void }) {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const hasConnections = state.agentCatalog.some(agent => state.agents[agent.id]?.connected || state.agents[agent.id]?.pendingReapply);
  useEffect(() => {
    if (!hasConnections) { setRecords([]); return; }
    let alive = true, pending = false;
    let pushed: UsageRecord[] = [];
    const merge = (left: UsageRecord[], right: UsageRecord[]) => [...new Map([...left, ...right].map(record => [record.requestId, record])).values()]
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 200);
    const refresh = async () => {
      if (!alive || pending) return;
      pending = true; setLoading(true);
      try {
        const response = await call<UsageRecord[]>('usage.recent');
        if (!alive) return;
        if (!Array.isArray(response)) throw new Error();
        setRecords(merge(response, pushed)); setError('');
      } catch { if (alive) setError('请求记录暂时无法更新，当前显示上次读取的结果。'); }
      finally { pending = false; if (alive) setLoading(false); }
    };
    refreshRef.current = () => { void refresh(); };
    const off = window.aurora?.onUsage?.(record => {
      if (!alive) return;
      pushed = merge(pushed, [record]); setRecords(previous => merge(previous, [record]));
    });
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 15000);
    return () => { alive = false; refreshRef.current = () => {}; off?.(); clearInterval(timer); };
  }, [hasConnections]);
  const rows = useMemo(() => clientConnectionRows(state, records), [state, records]);
  const providers = state.providers.filter(provider => rows.some(row => row.provider?.id === provider.id));
  const balances = useProviderBalances(providers, state.settings.proxy);
  if (!rows.length) return null;
  return <section className="client-connections" aria-label="当前客户端连接">
    <div className="section-heading"><h2>当前连接 <span className="connection-count">{rows.length}</span></h2>
      <Btn size="sm" variant="ghost" disabled={loading || balances.anyBusy} onClick={() => { refreshRef.current(); void balances.refreshAll(true); }}><Ico name="refresh" size={13} />{loading || balances.anyBusy ? '刷新中…' : '刷新连接状态'}</Btn>
    </div>
    {error && <div className="notice warning" role="alert">{error}</div>}
    <div className="client-connection-list">{rows.map(row => {
      const balanceEntries = row.provider ? connectionBalanceEntries(row.provider, balances.views[row.provider.id]) : [];
      const balanceUpdatedAt = balanceEntries[0]?.item.updatedAt;
      return <article className={`client-connection-row is-${row.status}`} key={row.id} aria-label={`${row.agents.map(agent => agent.name).join(' / ')} 当前连接`}>
      <div className="connection-top">
        <div className="connection-identity"><span className="connection-client-icon" aria-hidden="true"><Ico name="plug" size={21} /></span>
          <div className="connection-route"><strong>{row.agents.map(agent => agent.name).join(' / ')}</strong>
            <div className="connection-destination"><b>{row.providerName}</b><span aria-hidden="true">→</span><code>{row.model}</code></div>
          </div>
        </div>
        {row.provider ? <ConnectionBalance provider={row.provider} view={balances.views[row.provider.id]} busy={balances.busy[row.provider.id]} />
          : <div className="connection-balance-summary"><span className="connection-balance-label">供应商余额</span><span className="hint">{row.connection.providerId === 'official' ? '原客户端查看' : '暂不可用'}</span></div>}
      </div>
      {row.status === 'warning' && <p className="connection-warning">{row.detail}</p>}
      <div className="connection-bottom">
        <div className="connection-result"><span className={`connection-status is-${row.status}`}><i aria-hidden="true" />{row.label}</span>
          {row.lastSuccessAt ? <span className="connection-last-success">最近成功 <time dateTime={row.lastSuccessAt} title={new Date(row.lastSuccessAt).toLocaleString('zh-CN')}>{fmtTime(row.lastSuccessAt)}</time></span>
            : row.connection.mode === 'direct' && <span className="connection-last-success">直连无法观测</span>}
        </div>
        <div className="connection-controls"><Btn size="sm" variant="primary" onClick={() => onConfigure(row.agents.find(agent => agent.id === 'chatgpt-desktop') || row.agents[0])}>配置与测试</Btn>
          {row.label === '本地网关已停止' && <Btn size="sm" onClick={() => go('settings')}>打开网关设置</Btn>}
          <Btn size="sm" variant="ghost" onClick={() => go('usage')}>查看请求</Btn></div>
      </div>
      <details className="connection-details"><summary>连接详情<span className="connection-details-chevron" aria-hidden="true" /></summary>
        <div className="connection-details-body">
          <div className="connection-detail"><span className="connection-detail-label">连接方式</span><span>{row.connection.authMode === 'coexist' ? '官方账号共存' : row.connection.mode === 'direct' ? '直连供应商' : '本地网关'}</span></div>
          {row.status !== 'warning' && <p className="connection-detail-description">{row.detail}</p>}
          {row.lastFailureAt && <p className="connection-detail-description">最近失败：<time dateTime={row.lastFailureAt} title={new Date(row.lastFailureAt).toLocaleString('zh-CN')}>{fmtTime(row.lastFailureAt)}</time></p>}
          {row.provider ? <div className="connection-balance"><ProviderCompactBalance provider={row.provider} view={balances.views[row.provider.id]} busy={balances.busy[row.provider.id]} />
            {balanceUpdatedAt && <span className="hint">{balanceEntries.length > 1 ? '首项余额更新时间' : '余额更新时间'}：{fmtTime(balanceUpdatedAt)}</span>}
            <button className="text-button" onClick={() => go('providers')}>余额详情与供应商设置 →</button></div>
            : <p className="hint">{row.connection.providerId === 'official' ? '官方账号额度请在原客户端查看。' : '请重新选择有效的供应商。'}</p>}
          <p className="hint connection-footnote">成功时间来自近期网关记录。供应商测试不计为客户端验证；修改连接后需重新发起对话。余额由供应商返回，各 Key 不合并计数。</p>
        </div>
      </details>
    </article>;
    })}</div>
  </section>;
}
