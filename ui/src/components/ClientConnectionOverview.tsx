import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { call, fmtTime, type AgentCatalogItem, type UsageRecord } from '../lib/api';
import { clientConnectionRows } from '../lib/clientConnections';
import { useProviderBalances } from '../hooks/useProviderBalances';
import ProviderCompactBalance from './ProviderCompactBalance';
import { Btn, Ico } from './ui';
import '../styles/client-connections.css';

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
    <div className="section-heading"><div><h2>当前连接</h2><p className="hint">查看已保存的配置、最近成功请求与供应商余额。</p></div><div className="row wrap">
      <Btn size="sm" disabled={loading || balances.anyBusy} onClick={() => { refreshRef.current(); void balances.refreshAll(true); }}><Ico name="refresh" size={13} />{loading || balances.anyBusy ? '刷新中…' : '刷新连接状态'}</Btn>
    </div></div>
    {error && <div className="notice warning" role="alert">{error}</div>}
    <div className="client-connection-list">{rows.map(row => <article className={`client-connection-row is-${row.status}`} key={row.id} aria-label={`${row.agents.map(agent => agent.name).join(' / ')} 当前连接`}>
      <div className="connection-route"><strong>{row.agents.map(agent => agent.name).join(' / ')}</strong><span aria-hidden="true">→</span><b>{row.providerName}</b><span aria-hidden="true">→</span><code>{row.model}</code></div>
      <div className="connection-result"><span className={`chip ${row.status === 'success' ? 'ok' : row.status === 'warning' ? 'warn' : ''}`}>{row.label}</span><span className="chip">{row.connection.authMode === 'coexist' ? '官方账号共存' : row.connection.mode === 'direct' ? '直连供应商' : '本地网关'}</span>
        <span className="hint">最近成功：{row.lastSuccessAt ? <time dateTime={row.lastSuccessAt} title={new Date(row.lastSuccessAt).toLocaleString('zh-CN')}>{fmtTime(row.lastSuccessAt)}</time> : row.connection.mode === 'direct' ? '直连无法观测' : '暂无匹配记录'}</span>
        {row.lastFailureAt && <span className="hint">最近失败：<time dateTime={row.lastFailureAt}>{fmtTime(row.lastFailureAt)}</time></span>}
      </div>
      <p className="connection-detail">{row.detail}</p>
      <div className="connection-bottom">
        {row.provider ? <div className="connection-balance"><ProviderCompactBalance provider={row.provider} view={balances.views[row.provider.id]} busy={balances.busy[row.provider.id]} />
          {balances.views[row.provider.id]?.result.items.find(item => item.updatedAt)?.updatedAt && <span className="hint">余额更新时间：{fmtTime(balances.views[row.provider.id].result.items.find(item => item.updatedAt)!.updatedAt!)}</span>}
          <button className="text-button" onClick={() => go('providers')}>余额详情与供应商设置 →</button></div>
          : <p className="hint">{row.connection.providerId === 'official' ? '官方账号额度请在原客户端查看。' : '请重新选择有效的供应商。'}</p>}
        <div className="connection-controls"><Btn size="sm" variant="primary" onClick={() => onConfigure(row.agents.find(agent => agent.id === 'chatgpt-desktop') || row.agents[0])}>配置与测试</Btn>
          {row.label === '本地网关已停止' && <Btn size="sm" onClick={() => go('settings')}>打开网关设置</Btn>}
          <Btn size="sm" onClick={() => go('usage')}>查看请求</Btn></div>
      </div>
    </article>)}</div>
    <p className="hint connection-footnote">成功时间来自近期网关记录。供应商测试不计为客户端验证；修改连接后需重新发起对话。余额由供应商返回，各 Key 不合并计数。</p>
  </section>;
}
