import React, { useEffect, useMemo, useRef, useState } from 'react';
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

export default function Sessions({}: PageProps) {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<SessionSummary | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [reading, setReading] = useState(false);
  const [agentFilter, setAgentFilter] = useState('all');
  const [visible, setVisible] = useState(100);
  const readingPath = useRef('');

  async function scan() {
    setLoading(true);
    try {
      setSessions(await call<SessionSummary[]>('sessions.scan'));
    } catch (e: any) {
      toast.push(String(e?.message ?? e), 'bad');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = useMemo(() => {
    const key = q.trim().toLowerCase();
    return sessions.filter(
      (s) => (agentFilter === 'all' || s.agent === agentFilter) && (!key ||
        s.title.toLowerCase().includes(key) ||
        (s.cwd ?? '').toLowerCase().includes(key) ||
        s.agent.toLowerCase().includes(key) ||
        s.id.toLowerCase().includes(key)),
    );
  }, [sessions, q, agentFilter]);
  useEffect(() => setVisible(100), [q, agentFilter]);

  async function open(s: SessionSummary) {
    setActive(s);
    setMessages([]);
    setReading(true);
    readingPath.current = s.path;
    try {
      const next = await call<Msg[]>('sessions.read', { path: s.path });
      if (readingPath.current === s.path) setMessages(next);
    } catch (e: any) {
      toast.push('读取失败：' + e.message, 'bad');
    } finally {
      if (readingPath.current === s.path) setReading(false);
    }
  }

  const byAgent = sessions.reduce<Record<string, number>>((a, s) => {
    a[s.agent] = (a[s.agent] ?? 0) + 1;
    return a;
  }, {});

  return (
    <>
      <div className="page-head">
        <div>
          <h1>历史会话</h1>
          <p>
            统一检索本地客户端会话，阅读内容、导出 Markdown，或复制对应客户端的恢复命令。
          </p>
        </div>
        <div className="actions">
          <Btn variant="primary" disabled={!window.aurora} onClick={() => setRepairing(true)}><Ico name="shield" size={13} />批量修复历史</Btn>
          <input className="input" style={{ width: 220 }} placeholder="搜索标题 / 目录 / 会话 ID" value={q} onChange={(e) => setQ(e.target.value)} />
          <Btn onClick={scan} disabled={loading}>
            <Ico name="refresh" size={13} /> {loading ? '扫描中…' : '重新扫描'}
          </Btn>
        </div>
      </div>
      {repairing && <HistoryRepair onClose={() => setRepairing(false)} onRepaired={scan} />}

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <button className={`chip ${agentFilter === 'all' ? 'accent' : ''}`} onClick={() => setAgentFilter('all')}>全部 {sessions.length}</button>
        {Object.entries(byAgent).map(([k, v]) => (
          <button key={k} className={`chip ${agentFilter === k ? 'accent' : ''}`} onClick={() => setAgentFilter(k)}>
            {k} · {v}
          </button>
        ))}
      </div>

      <div className="split">
        <div className="card" style={{ padding: 8 }}>
          <div className="scroll-y" style={{ maxHeight: '68vh' }}>
            {list.length === 0 && !loading && (
              <Empty icon="🗂️" title="没有找到会话" hint="先在客户端里聊几句，再回来重新扫描。" />
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
              <div className="row wrap" style={{ marginBottom: 10 }}>
                <span className="chip">{fmtBytes(active.sizeBytes)}</span>
                {active.model && <span className="chip">{active.model}</span>}
                {active.cwd && <span className="chip mono ellipsis" style={{ maxWidth: 320 }}>{active.cwd}</span>}
                <div style={{ flex: 1 }} />
                <Btn
                  size="sm"
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
                {messages.map((m, i) => (
                  <div key={i} className={`chat-msg ${m.role}`}>
                    <div className="who">
                      {m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role}
                      {m.ts ? ' · ' + fmtTime(m.ts) : ''}
                    </div>
                    {m.text}
                  </div>
                ))}
                {messages.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{reading ? '读取中…' : '此文件中没有可显示的文本消息'}</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
