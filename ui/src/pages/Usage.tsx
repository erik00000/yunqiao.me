import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Ico, Stat } from '../components/ui';
import { UsageRecord, UsageSummary, call, fmtCost, fmtNum, fmtTime } from '../lib/api';

export default function Usage({ state }: PageProps) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [recent, setRecent] = useState<UsageRecord[]>([]);
  const [days, setDays] = useState(14);
  const [tab, setTab] = useState<'overview' | 'requests'>('overview');
  const [live, setLive] = useState<any[]>([]);
  const [summaryError, setSummaryError] = useState('');
  const [liveError, setLiveError] = useState('');
  const loadSequence = useRef(0);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const [sum, requests] = await Promise.allSettled([call<UsageSummary>('usage.summary', { days }), call<UsageRecord[]>('usage.recent')]);
    if (!mounted.current || sequence !== loadSequence.current) return;
    if (sum.status === 'fulfilled') setSummary(sum.value);
    if (requests.status === 'fulfilled') setRecent(requests.value);
    setSummaryError([sum.status === 'rejected' ? `用量统计：${sum.reason?.message || '读取失败'}` : '', requests.status === 'rejected' ? `请求日志：${requests.reason?.message || '读取失败'}` : ''].filter(Boolean).join('；'));
  }, [days]);

  useEffect(() => {
    mounted.current = true;
    setSummary(null);
    void load();
    let alive = true, fetching = false;
    const poll = async () => { if (fetching || document.hidden) return; fetching = true; try { const r = await call<any[]>('usage.live'); if (alive) { setLive(r); setLiveError(''); } } catch (e: any) { if (alive) setLiveError(e.message); } finally { fetching = false; } };
    void poll();
    const liveTimer = setInterval(poll, 1500);
    const refreshVisible = () => { if (!document.hidden) { void load(); void poll(); } };
    const summaryTimer = setInterval(() => { if (!document.hidden) void load(); }, 8000);
    const off = window.aurora?.onUsage(() => { if (!document.hidden) void load(); });
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { alive = false; mounted.current = false; loadSequence.current++; off?.(); clearInterval(liveTimer); clearInterval(summaryTimer); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [load]);

  const maxCost = Math.max(0.01, ...(summary?.byDay ?? []).map((d) => d.cost));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>用量统计</h1>
          <p>实时查看经过网关的请求、缓存与用量。桌面客户端内可开启「用量状态栏」查看原生会话数据。</p>
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

      {(summaryError || liveError) && <div className="notice warning" role="alert">{[summaryError, liveError].filter(Boolean).join('；')}</div>}
      <div className="card" style={{ marginBottom: 16 }}><div className="card-title"><span className={`dot ${live.length ? 'on' : 'off'}`} />实时请求<span className="sub">每 1.5 秒更新 · {live.length} 个进行中</span></div>{!live.length ? <p className="hint">等待下一次对话。请求完成后会自动计入统计和日志。</p> : <div className="list">{live.map(r => <div className="list-row" key={r.id}><div className="grow"><b>{r.model}</b><p className="hint">{r.agent} · {r.providerName || '等待路由'} · {r.phase === 'streaming' ? '生成中' : r.phase === 'retrying' ? '正在重试' : '连接中'} · {Math.max(0, Math.round((Date.now() - r.startedAtMs) / 1000))} 秒{r.threadId ? ` · 会话 ${r.threadId.slice(0, 12)}` : ''}</p></div><div className="tag-list"><span className="chip">输入 {r.inputTokens == null ? '待返回' : fmtNum(r.inputTokens)}</span><span className="chip">输出 {r.outputTokens == null ? r.estimatedOutputTokens == null ? '待返回' : `约 ${fmtNum(r.estimatedOutputTokens)}` : fmtNum(r.outputTokens)}</span><span className="chip">缓存读 {r.cacheRead == null ? '未提供' : fmtNum(r.cacheRead)}</span><span className="chip">缓存写 {r.cacheWrite == null ? '未提供' : fmtNum(r.cacheWrite)}</span></div></div>)}</div>}</div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="card">
          <Stat k="已知价格估算" v={summary ? fmtCost(summary.totals.cost) : '—'} />
        </div>
        <div className="card">
          <Stat k="总 tokens" v={summary ? fmtNum(summary.totals.inputTokens + summary.totals.outputTokens) : '—'} />
        </div>
        <div className="card">
          <Stat k="调用次数" v={summary?.totals.calls ?? '—'} />
        </div>
        <div className="card">
          <Stat k="失败请求" v={summary?.totals.errors ?? '—'} />
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 18 }}><div className="card"><Stat k="输入 Token（含缓存）" v={summary ? fmtNum(summary.totals.inputTokens) : '—'} /></div><div className="card"><Stat k="缓存读取 Token" v={summary?.totals.cacheReports ? fmtNum(summary.totals.cacheRead) : '—'} /></div><div className="card"><Stat k="缓存写入 Token" v={summary?.totals.cacheWriteReports ? fmtNum(summary.totals.cacheWrite) : '—'} /></div><div className="card"><Stat k="缓存命中率" v={summary?.totals.cacheReports ? `${((summary.totals.cacheRate || 0) * 100).toFixed(1)}%` : '—'} /></div></div><p className="hint">命中率 = 缓存读取 ÷ 输入总量，仅统计提供缓存数据的请求。上游未返回的字段显示「—」，生成中的输出估算以完成后的上游数据为准。费用按本地价格估算。</p>

      {!!summary?.totals.unpricedCalls && <div className="notice">{summary.totals.unpricedCalls} 次请求价格未配置，未计入费用估算。可在模型管理中补充价格。</div>}
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
              每日已知价格估算 <span className="sub">美元</span>
            </div>
            <div className="bars">
              {(summary?.byDay ?? []).map((d) => (
                <div key={d.day} className="bar" style={{ height: `${Math.max(3, (d.cost / maxCost) * 100)}%` }}>
                  <span>
                    {d.day} · {fmtCost(d.cost)} · {d.calls} 次{d.unpricedCalls ? ` · ${d.unpricedCalls} 次未计价` : ''}
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
                  <span className="mono">{fmtCost(p.cost)}{p.unpricedCalls ? ` · ${p.unpricedCalls} 次未计价` : ''}</span>
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
                  <span className="mono">{fmtCost(m.cost)}{m.unpricedCalls ? ` · ${m.unpricedCalls} 次未计价` : ''}</span>
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
                  <th>缓存读 / 写</th>
                  <th>命中率</th>
                  <th style={{ width: 80 }}>耗时</th>
                  <th style={{ width: 80 }}>费用</th>
                </tr>
              </thead>
              <tbody>
                {recent.slice(0, 120).map((r, i) => (
                  <tr key={r.requestId + i}>
                    <td className="mono" style={{ fontSize: 10.5 }}>{fmtTime(r.ts)}</td>
                    <td>
                      <span className={`chip ${r.status >= 200 && r.status < 300 ? 'ok' : 'bad'}`}>{r.status || 'ERR'}</span>
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
                    <td className="mono">{r.cacheReadKnown || r.cacheRead > 0 ? fmtNum(r.cacheRead) : '—'} / {r.cacheWriteKnown || r.cacheWrite > 0 ? fmtNum(r.cacheWrite) : '—'}</td>
                    <td>{(r.cacheReadKnown || r.cacheRead > 0) && r.inputTokens > 0 ? `${Math.min(100, r.cacheRead / r.inputTokens * 100).toFixed(1)}%` : '—'}{r.estimated && <small> 估算</small>}</td>
                    <td className="mono">{r.latencyMs}ms</td>
                    <td className="mono">{r.costKnown === false ? '价格未配置' : fmtCost(r.cost)}</td>
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
