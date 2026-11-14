import React, { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Ico, Stat } from '../components/ui';
import { UsageRecord, UsageSummary, call, fmtCost, fmtNum, fmtTime } from '../lib/api';

export default function Usage({ state }: PageProps) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [recent, setRecent] = useState<UsageRecord[]>([]);
  const [days, setDays] = useState(14);
  const [tab, setTab] = useState<'overview' | 'requests'>('overview');

  async function load() {
    setSummary(await call<UsageSummary>('usage.summary', { days }));
    setRecent(await call<UsageRecord[]>('usage.recent'));
  }

  useEffect(() => {
    load();
    const off = window.aurora?.onUsage((r) => setRecent((s) => [r, ...s].slice(0, 200)));
    return () => off?.();
  }, [days]);

  const maxCost = Math.max(0.01, ...(summary?.byDay ?? []).map((d) => d.cost));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>用量统计</h1>
          <p>不经过网关的请求统计不到；走网关的每一次调用都会记录 token、缓存、首字延迟和估算费用。</p>
        </div>
        <div className="actions">
          <div className="seg">
            {[7, 14, 30].map((d) => (
              <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
                {d} 天
              </button>
            ))}
          </div>
          <Btn onClick={load}>
            <Ico name="refresh" size={13} /> 刷新
          </Btn>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="card">
          <Stat k="总花费" v={fmtCost(summary?.totals.cost ?? 0)} />
        </div>
        <div className="card">
          <Stat k="总 tokens" v={fmtNum((summary?.totals.inputTokens ?? 0) + (summary?.totals.outputTokens ?? 0))} />
        </div>
        <div className="card">
          <Stat k="调用次数" v={summary?.totals.calls ?? 0} />
        </div>
        <div className="card">
          <Stat k="失败请求" v={summary?.totals.errors ?? 0} />
        </div>
      </div>

      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>
          概览
        </button>
        <button className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>
          请求日志 ({recent.length})
        </button>
      </div>

      {tab === 'overview' ? (
        <div className="grid cols-2">
          <div className="card">
            <div className="card-title">
              每日花费 <span className="sub">美元</span>
            </div>
            <div className="bars">
              {(summary?.byDay ?? []).map((d) => (
                <div key={d.day} className="bar" style={{ height: `${Math.max(3, (d.cost / maxCost) * 100)}%` }}>
                  <span>
                    {d.day} · {fmtCost(d.cost)} · {d.calls} 次
                  </span>
                </div>
              ))}
              {!summary?.byDay?.length && <div style={{ color: 'var(--muted)', fontSize: 12 }}>暂无数据</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-title">按供应商</div>
            <div className="list">
              {(summary?.byProvider ?? []).map((p) => (
                <div key={p.id} className="list-row">
                  <div className="grow">
                    <div>{p.name ?? p.id}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{p.calls} 次 · {fmtNum(p.tokens)} tokens</div>
                  </div>
                  <span className="mono">{fmtCost(p.cost)}</span>
                </div>
              ))}
              {!summary?.byProvider?.length && <div style={{ color: 'var(--muted)', fontSize: 12 }}>暂无数据</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-title">按模型</div>
            <div className="list scroll-y" style={{ maxHeight: 320 }}>
              {(summary?.byModel ?? []).map((m) => (
                <div key={m.id} className="list-row">
                  <div className="grow mono ellipsis" style={{ fontSize: 11.5 }}>
                    {m.id}
                  </div>
                  <span className="chip">{m.calls}</span>
                  <span className="mono">{fmtCost(m.cost)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-title">按客户端</div>
            <div className="list">
              {(summary?.byAgent ?? []).map((a) => (
                <div key={a.id} className="list-row">
                  <div className="grow">{a.id}</div>
                  <span className="chip">{a.calls} 次</span>
                  <span className="mono">{fmtNum(a.tokens)}</span>
                </div>
              ))}
              {!summary?.byAgent?.length && <div style={{ color: 'var(--muted)', fontSize: 12 }}>暂无数据</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {recent.length === 0 ? (
            <Empty icon="📊" title="还没有请求" hint="接入一个客户端，随便发一句话，这里就会出现记录。" />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 78 }}>时间</th>
                  <th style={{ width: 64 }}>状态</th>
                  <th>客户端 / 模型</th>
                  <th style={{ width: 140 }}>供应商</th>
                  <th style={{ width: 90 }}>输入</th>
                  <th style={{ width: 90 }}>输出</th>
                  <th style={{ width: 80 }}>耗时</th>
                  <th style={{ width: 80 }}>费用</th>
                </tr>
              </thead>
              <tbody>
                {recent.slice(0, 120).map((r, i) => (
                  <tr key={r.requestId + i}>
                    <td className="mono" style={{ fontSize: 10.5 }}>{fmtTime(r.ts)}</td>
                    <td>
                      <span className={`chip ${r.status < 400 ? 'ok' : 'bad'}`}>{r.status || 'ERR'}</span>
                    </td>
                    <td>
                      <div style={{ fontSize: 11.5 }}>{r.agent}</div>
                      <div className="mono ellipsis" style={{ fontSize: 10.5, color: 'var(--muted)', maxWidth: 260 }}>
                        {r.requestModel}
                        {r.requestModel !== r.model ? ` → ${r.model}` : ''}
                      </div>
                      {r.error && <div style={{ fontSize: 10.5, color: 'var(--danger)' }}>{r.error.slice(0, 120)}</div>}
                    </td>
                    <td className="ellipsis">{r.providerName}</td>
                    <td className="mono">{fmtNum(r.inputTokens)}</td>
                    <td className="mono">{fmtNum(r.outputTokens)}</td>
                    <td className="mono">{r.latencyMs}ms</td>
                    <td className="mono">{fmtCost(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
