import React, { memo, startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Ico, useToast, copyText } from '../components/ui';
import { SessionSummary, call, fmtBytes, fmtTime } from '../lib/api';
import HistoryRepair from '../components/HistoryRepair';

interface Msg {
  role: string;
  text: string;
  model?: string;
  ts?: string;
}
const Message = memo(function Message({ message }: { message: Msg }) {
  const [expanded, setExpanded] = useState(false);
  const long = message.text.length > 5000;
  return <div className={`chat-msg ${message.role}`} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}>
    <div className="who">{message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : message.role}{message.ts ? ' · ' + fmtTime(message.ts) : ''}</div>
    {long && !expanded ? message.text.slice(0, 5000) : message.text}
    {long && <div style={{ marginTop: 10 }}><Btn size="sm" onClick={() => setExpanded(value => !value)}>{expanded ? '收起长消息' : `展开完整消息（${message.text.length} 字符）`}</Btn></div>}
  </div>;
});

export default function Sessions({}: PageProps) {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const deferredQuery = useDeferredValue(q);
  const [active, setActive] = useState<SessionSummary | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [reading, setReading] = useState(false);
  const [agentFilter, setAgentFilter] = useState('all');
  const [providerFilter, setProviderFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [sessionKind, setSessionKind] = useState<'main' | 'subagent' | 'all'>('main');
  const [visible, setVisible] = useState(100);
  const [visibleMessages, setVisibleMessages] = useState(50);
  const readingPath = useRef('');
  const readSequence = useRef(0);
  const scanSequence = useRef(0);

  async function scan() {
    const sequence = ++scanSequence.current;
    setLoading(true);
    try {
      const next = await call<SessionSummary[]>('sessions.scan');
      if (sequence !== scanSequence.current) return;
      startTransition(() => setSessions(next));
      const selected = next.find(session => session.path === readingPath.current) || null;
      setActive(selected);
      if (!selected) {
        readingPath.current = '';
        readSequence.current++;
        setMessages([]);
        setReading(false);
      }
    } catch (e: any) {
      if (sequence === scanSequence.current) toast.push(String(e?.message ?? e), 'bad');
    } finally {
      if (sequence === scanSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    scan();
    return () => { readSequence.current++; scanSequence.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const matching = useMemo(() => {
    const key = deferredQuery.trim().toLowerCase();
    return sessions.filter(
      (s) => (agentFilter === 'all' || s.agent === agentFilter) && (!providerFilter || s.modelProvider === providerFilter)
        && (!sourceFilter || s.sourceLabel === sourceFilter) && (!key ||
        s.title.toLowerCase().includes(key) ||
        (s.cwd ?? '').toLowerCase().includes(key) ||
        s.agent.toLowerCase().includes(key) ||
        (s.modelProvider || '').toLowerCase().includes(key) ||
        (s.sourceLabel || '').toLowerCase().includes(key) ||
        (s.subagentId || '').toLowerCase().includes(key) ||
        s.id.toLowerCase().includes(key)),
    );
  }, [sessions, deferredQuery, agentFilter, providerFilter, sourceFilter]);
  const subagentCount = useMemo(() => matching.filter(s => s.isSubagent).length, [matching]);
  const list = useMemo(() => matching.filter(s => sessionKind === 'all' || !!s.isSubagent === (sessionKind === 'subagent')), [matching, sessionKind]);
  useEffect(() => setVisible(100), [q, agentFilter, providerFilter, sourceFilter, sessionKind]);
  const sourceCounts = useMemo(() => sessions.reduce<Record<string, number>>((counts, session) => {
    if (session.sourceLabel) counts[session.sourceLabel] = (counts[session.sourceLabel] || 0) + 1;
    return counts;
  }, {}), [sessions]);
  const providerCounts = useMemo(() => sessions.reduce<Record<string, number>>((counts, session) => {
    if (session.modelProvider) counts[session.modelProvider] = (counts[session.modelProvider] || 0) + 1;
    return counts;
  }, {}), [sessions]);

  async function open(s: SessionSummary) {
    const sequence = ++readSequence.current;
    setActive(s);
    setMessages([]);
    setVisibleMessages(50);
    setReading(true);
    readingPath.current = s.path;
    try {
      const next = await call<Msg[]>('sessions.read', { path: s.path });
      if (sequence === readSequence.current) startTransition(() => setMessages(next));
    } catch (e: any) {
      if (sequence === readSequence.current) toast.push('读取失败：' + e.message, 'bad');
    } finally {
      if (sequence === readSequence.current) setReading(false);
    }
  }

  const parents = useMemo(() => active?.parentSessionId ? sessions.filter(s => s.agent === active.agent && s.id === active.parentSessionId && s.path !== active.path
    && s.sourceScope === active.sourceScope && (active.agent !== 'Claude Code' || !s.isSubagent)) : [], [active, sessions]);
  // Duplicate IDs can exist across projects or imported logs. Never pick an arbitrary parent.
  const parent = parents.length === 1 ? parents[0] : undefined;
  const parentLabel = active?.agent === 'Claude Code' ? '所属主会话' : '父会话';

  function openParent() {
    if (!parent) return;
    setQ(parent.id);
    setAgentFilter(parent.agent);
    setProviderFilter('');
    setSourceFilter('');
    setSessionKind(parent.isSubagent ? 'subagent' : 'main');
    open(parent);
  }

  const byAgent = useMemo(() => sessions.reduce<Record<string, number>>((a, s) => {
    a[s.agent] = (a[s.agent] ?? 0) + 1;
    return a;
  }, {}), [sessions]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>历史会话</h1>
          <p>
            按客户端与供应商检索历史，主会话与子代理分开查看，支持阅读与导出。
          </p>
        </div>
        <div className="actions">
          <Btn variant="primary" disabled={!window.aurora} onClick={() => setRepairing(true)}><Ico name="shield" size={13} />批量修复历史 / 区域迁移</Btn>
          <input className="input" aria-label="搜索历史会话" style={{ width: 220 }} placeholder="搜索标题 / 目录 / 会话 ID" value={q} onChange={(e) => setQ(e.target.value)} />
          <Btn onClick={scan} disabled={loading}>
            <Ico name="refresh" size={13} /> {loading ? '扫描中…' : '重新扫描'}
          </Btn>
        </div>
      </div>
      {repairing && <HistoryRepair initialSource={providerFilter} onClose={() => setRepairing(false)} onRepaired={scan} />}

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <button className={`chip ${agentFilter === 'all' ? 'accent' : ''}`} onClick={() => setAgentFilter('all')}>全部 {sessions.length}</button>
        {Object.entries(byAgent).map(([k, v]) => (
          <button key={k} className={`chip ${agentFilter === k ? 'accent' : ''}`} onClick={() => setAgentFilter(k)}>
            {k} · {v}
          </button>
        ))}
        <div className="grow" />
        {!!Object.keys(sourceCounts).length && <select aria-label="历史会话来源" className="select" style={{ width: 230 }} value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
          <option value="">全部会话来源</option>
          {sourceFilter && !sourceCounts[sourceFilter] && <option value={sourceFilter}>{sourceFilter} · 0</option>}
          {Object.entries(sourceCounts).sort(([a], [b]) => a.localeCompare(b)).map(([label, count]) => <option key={label} value={label}>{label} · {count}</option>)}
        </select>}
        <select aria-label="历史供应商区域" className="select" style={{ width: 230 }} value={providerFilter} onChange={e => setProviderFilter(e.target.value)}>
          <option value="">全部供应商区域</option>
          {providerFilter && !providerCounts[providerFilter] && <option value={providerFilter}>{providerFilter} · 0</option>}
          {Object.entries(providerCounts).sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => <option key={id} value={id}>{id} · {count}</option>)}
        </select>
      </div>

      <div className="filter-bar">
        <div className="segments" role="group" aria-label="会话类型">
          <button className={sessionKind === 'main' ? 'selected' : ''} aria-pressed={sessionKind === 'main'} onClick={() => setSessionKind('main')}>主会话 {matching.length - subagentCount}</button>
          <button className={sessionKind === 'subagent' ? 'selected' : ''} aria-pressed={sessionKind === 'subagent'} onClick={() => setSessionKind('subagent')}>子代理 {subagentCount}</button>
          <button className={sessionKind === 'all' ? 'selected' : ''} aria-pressed={sessionKind === 'all'} onClick={() => setSessionKind('all')}>全部会话 {matching.length}</button>
        </div>
        <span className="hint">{sessionKind === 'main' && subagentCount ? `已隐藏 ${subagentCount} 个子代理会话，可切换到“子代理”或“全部会话”查看。` : '仅按已识别的会话关系分类，未识别的会话保留在主会话中。'}</span>
      </div>

      <div className="split">
        <div className="card" style={{ padding: 8 }}>
          <div className="scroll-y" style={{ maxHeight: '68vh' }}>
            {list.length === 0 && !loading && (
              <Empty icon="🗂️" title={sessionKind === 'main' && subagentCount ? '当前筛选下只有子代理会话' : '没有找到会话'} hint={sessionKind === 'main' && subagentCount ? '点击上方“子代理”或“全部会话”查看，原始历史仍完整保留。' : sessions.length ? '试试其他关键词、客户端、供应商或会话类型。' : '先在客户端里聊几句，再回来重新扫描。'} />
            )}
            {list.slice(0, visible).map((s) => (
              <div
                key={s.path}
                className="list-row"
                style={{ cursor: 'pointer', borderRadius: 10, background: active?.path === s.path ? 'rgba(109,140,255,.14)' : undefined }}
                onClick={() => open(s)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(s); } }}
              >
                <div className="grow">
                  <div className="ellipsis" style={{ fontSize: 12.5 }}>
                    {s.title || '(无标题)'}
                  </div>
                  <div className="ellipsis" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                    {s.agent} · {s.project ?? '—'} · {s.messageCount} 条 · {fmtTime(s.updatedAt)}
                  </div>
                  {(s.modelProvider || s.sourceLabel || s.agent.startsWith('Claude') || s.archived || s.isSubagent) && <div className="row wrap" style={{ marginTop: 5 }}>
                    {s.isSubagent && <span className="chip accent">子代理{s.subagentId ? ` · ${s.subagentId}` : ''}</span>}
                    {s.sourceLabel && <span className="chip" title="会话文件的存储来源，不代表模型供应商">{s.sourceLabel}</span>}
                    {s.modelProvider ? <span className="chip mono">{s.modelProvider}</span> : s.agent.startsWith('Claude') && <span className="chip" title="原始历史未记录供应商，不根据模型名称或当前配置推断">供应商未记录</span>}
                    {s.archived && <span className="chip">已归档</span>}
                  </div>}
                </div>
              </div>
            ))}
            {list.length > visible && <Btn onClick={() => setVisible(v => v + 100)}>加载更多（还剩 {list.length - visible} 个）</Btn>}
          </div>
        </div>

        <div className="card">
          {!active ? (
            <Empty icon="💬" title="选一个会话看内容" hint="左侧选择会话，查看已解析的对话内容。大型文件会限制读取长度。" />
          ) : (
            <>
              <div className="card-title">
                <span className="ellipsis">{active.title}</span>
                <span className="sub">{active.agent}</span>
              </div>
              {active.isSubagent && <div className="notice" style={{ marginBottom: 12 }}>
                <div className="row wrap"><b>子代理会话</b>{active.subagentId && <code>{active.subagentId}</code>}<div className="grow" />{parent && <Btn size="sm" onClick={openParent}>查看{parentLabel}</Btn>}</div>
                <p className="hint" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{active.parentSessionId ? `${parentLabel} ID：${active.parentSessionId}` : '原始记录未提供所属会话 ID。'}{active.parentSessionId && !parent ? parents.length > 1 ? ' · 找到多个同 ID 会话，请按目录检索确认。' : ' · 本次扫描未找到对应会话。' : ''}</p>
              </div>}
              {active.contentNote && <div className={`notice${active.contentStatus === 'ambiguous' ? ' warning' : ''}`} style={{ marginBottom: 12 }}>{active.contentNote}</div>}
              {active.agent.startsWith('Claude') && !active.modelProvider && <p className="hint" style={{ marginBottom: 10 }}>原始历史未记录供应商，无法根据模型名称或当前配置确定当时使用的服务。来源角标仅表示存储目录。</p>}
              <div className="row wrap" style={{ marginBottom: 10 }}>
                <span className="chip">{fmtBytes(active.sizeBytes)}</span>
                {active.model && <span className="chip">{active.model}</span>}
                {active.modelProvider && <span className="chip mono">区域：{active.modelProvider}</span>}
                {active.sourceLabel && <span className="chip">来源：{active.sourceLabel}</span>}
                {active.cwd && <span className="chip mono ellipsis" style={{ maxWidth: 320 }}>{active.cwd}</span>}
                <div style={{ flex: 1 }} />
                <Btn
                  size="sm"
                  disabled={!!active.isSubagent || active.canResume === false || active.sourceKind === 'desktop' || active.agent === 'Claude Desktop'}
                  onClick={async () => {
                    try { const r = await call('sessions.resume', { summary: active }); if (!r.command) return toast.push('此客户端暂不支持命令恢复', 'info'); await copyText(r.command); toast.push('恢复命令已复制', 'ok'); } catch (e: any) { toast.push(e.message, 'bad'); }
                  }}
                >
                  <Ico name="copy" size={12} /> 复制恢复命令
                </Btn>
                <Btn
                  size="sm"
                  onClick={async () => {
                    try {
                      const r = await call('sessions.export', { summary: active });
                      if (!r.ok || typeof r.markdown !== 'string') throw new Error(r.message || '导出失败');
                      const url = URL.createObjectURL(new Blob([r.markdown], { type: 'text/markdown;charset=utf-8' }));
                      const link = document.createElement('a'); link.href = url; link.download = `${active.agent}-${active.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
                      toast.push('Markdown 已导出', 'ok');
                    } catch (e: any) { toast.push(e.message, 'bad'); }
                  }}
                >
                  导出
                </Btn>
              </div>
              <div className="scroll-y" style={{ maxHeight: '60vh' }}>
                {messages.slice(0, visibleMessages).map((message, index) => <Message key={`${active.path}:${index}`} message={message} />)}
                {messages.length > visibleMessages && <Btn size="sm" onClick={() => setVisibleMessages(count => count + 50)}>继续显示消息（还剩 {messages.length - visibleMessages} 条）</Btn>}
                {messages.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{reading ? '读取中…' : '此文件中没有可显示的文本消息'}</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
