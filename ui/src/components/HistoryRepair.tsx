import React, { useEffect, useState } from 'react';
import { Btn, Empty, Field, Ico, Modal, useToast } from './ui';
import { call, fmtTime } from '../lib/api';

interface RepairItem {
  id: string; title?: string; path?: string; archived?: boolean;
  beforeProvider?: string; metadataProvider?: string; targetProvider?: string;
  changes?: string[]; status?: string; reason?: string;
}
interface RepairPreview {
  ok: boolean; message?: string; revision?: string; options?: any;
  summary?: Record<string, number>; items?: RepairItem[]; warnings?: string[];
  currentProvider?: string; dbPath?: string;
}
interface RepairBackup { id: string; createdAt: string; targetProvider?: string; sessions?: number; restoredAt?: string; path?: string; status?: string; }

export default function HistoryRepair({ onClose, onRepaired }: { onClose: () => void; onRepaired: () => void }) {
  const [kind, setKind] = useState<'provider' | 'index'>('provider');
  const [tab, setTab] = useState<'repair' | 'backups'>('repair');
  const [scope, setScope] = useState('all');
  const [targetProvider, setTargetProvider] = useState('');
  const [sourceProvider, setSourceProvider] = useState('');
  const [fixPaths, setFixPaths] = useState(true);
  const [preview, setPreview] = useState<RepairPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [backups, setBackups] = useState<RepairBackup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);
  const [query, setQuery] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [restore, setRestore] = useState<any>(null);
  const [restoreId, setRestoreId] = useState('');
  const toast = useToast();
  const prefix = kind === 'provider' ? 'codex.repair' : 'codex.indexRepair';
  const options = { scope, targetProvider: targetProvider.trim() || undefined, sourceProvider: sourceProvider.trim() || undefined, fixPaths };
  const items = preview?.items || [];
  const ready = items.filter(i => i.status === 'ready');
  const visible = items.filter(i => `${i.title || ''} ${i.id} ${i.beforeProvider || ''} ${i.path || ''}`.toLowerCase().includes(query.toLowerCase()));
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }
  function reset() { setPreview(null); setResult(null); setPicked(new Set()); setConfirmed(false); setRestore(null); setError(''); }
  useEffect(reset, [kind, scope, targetProvider, sourceProvider, fixPaths]);
  async function scan() {
    const r = await call<RepairPreview>(`${prefix}.preview`, options);
    if (!r.ok) throw new Error(r.message || '无法生成修复预览');
    setPreview(r); setPicked(new Set((r.items || []).filter(i => i.status === 'ready').map(i => i.id))); setResult(null); setConfirmed(false);
  }
  async function loadBackups() {
    const r = await call(`${prefix}.backups`, {});
    if (!r.ok) throw new Error(r.message || '无法读取备份');
    setBackups(r.backups || []);
  }
  async function apply() {
    const ids = [...picked];
    const current = await call<RepairPreview>(`${prefix}.preview`, options);
    if (!current.ok || current.revision !== preview?.revision) throw new Error('会话文件或索引已发生变化，请重新扫描并确认修复方案。');
    const selected = await call<RepairPreview>(`${prefix}.preview`, { ...options, ids });
    if (!selected?.ok || !selected.revision) throw new Error(selected?.message || '请重新扫描修复方案');
    const r = await call(`${prefix}.apply`, { ...options, ...selected.options, ids, revision: selected.revision });
    if (!r.ok) throw new Error(r.message || '批量修复未完成');
    setResult(r); setPreview(null); setPicked(new Set()); setConfirmed(false); onRepaired();
    toast.push(r.message || '批量修复完成，备份已保留', 'ok');
  }
  async function prepareRestore(id: string) {
    const r = await call(`${prefix}.restorePreview`, { backupId: id });
    if (!r.ok) throw new Error(r.message || '无法恢复此备份');
    setRestore(r); setRestoreId(id);
  }
  async function restoreBackup() {
    const r = await call(`${prefix}.restore`, { backupId: restoreId, revision: restore.revision });
    if (!r.ok) throw new Error(r.message || '恢复失败');
    setRestore(null); setResult(r); await loadBackups(); onRepaired(); toast.push(r.message || '已恢复本批次修改', 'ok');
  }
  const summary = preview?.summary || {};
  return <Modal title="历史会话 · 批量修复" sub="ChatGPT 桌面版 / 原 Codex 的本地会话修复，先预览，再备份与执行。" onClose={() => !busy && onClose()} width={1040} foot={<>
    <Btn disabled={busy} onClick={onClose}>关闭</Btn>
    {tab === 'repair' && <Btn disabled={busy} onClick={() => run(scan)}><Ico name="search" size={14} />{busy ? '处理中…' : preview ? '重新扫描' : '扫描并预览'}</Btn>}
    {tab === 'repair' && preview && <Btn variant="primary" disabled={busy || !picked.size || !confirmed} onClick={() => run(apply)}><Ico name="shield" size={14} />备份并修复所选 ({picked.size})</Btn>}
    {tab === 'backups' && restore && <Btn variant="primary" disabled={busy || !!restore.conflicts?.length} onClick={() => run(restoreBackup)}>恢复本批次修改</Btn>}
  </>}>
    <div className="repair-toolbar"><div className="segments"><button className={kind === 'provider' ? 'selected' : ''} disabled={busy} onClick={() => { setKind('provider'); setTab('repair'); }}>历史归属与路径</button><button className={kind === 'index' ? 'selected' : ''} disabled={busy} onClick={() => { setKind('index'); setTab('repair'); }}>原生会话索引</button></div><div className="grow" /><Btn size="sm" variant={tab === 'backups' ? 'primary' : 'default'} disabled={busy} onClick={() => { setTab(tab === 'backups' ? 'repair' : 'backups'); setRestore(null); if (tab !== 'backups') run(loadBackups); }}><Ico name="refresh" size={13} />{tab === 'backups' ? '返回修复' : '修复备份与恢复'}</Btn></div>
    {error && <div className="notice warning" role="alert">{error}</div>}
    {result && <div className="notice"><Ico name="check" size={18} /><div><b>{result.message || '操作已完成'}</b>{result.backup && <p className="mono">备份：{typeof result.backup === 'string' ? result.backup : result.backup.path || result.backup.id}</p>}</div></div>}
    {tab === 'repair' ? <>
      <div className="notice"><Ico name="chat" size={20} /><div><b>{kind === 'provider' ? '找回切换供应商后不显示的历史对话' : '补全原生桌面会话的消息索引'}</b><p>{kind === 'provider' ? '同步会话文件与数据库中的供应商归属，检查移动后失效的路径。保留原始对话内容。' : '根据本地对话中的完成事件与轮次信息修复索引；证据不足、未完成或格式不兼容的会话会跳过。'}</p></div></div>
      <fieldset disabled={busy} className="repair-fields">
        <Field label="扫描范围"><select className="select" aria-label="修复扫描范围" value={scope} onChange={e => setScope(e.target.value)}><option value="all">全部历史（含归档）</option><option value="active">仅未归档</option><option value="archived">仅已归档</option></select></Field>
        {kind === 'provider' && <><Field label="目标供应商标识" hint="留空使用当前客户端配置中的 model_provider。"><input aria-label="目标供应商标识" className="input mono" placeholder="自动读取当前配置，例如 aurora" value={targetProvider} onChange={e => setTargetProvider(e.target.value)} /></Field><Field label="原供应商筛选" hint="留空扫描所有来源。"><input aria-label="原供应商筛选" className="input mono" placeholder="全部供应商" value={sourceProvider} onChange={e => setSourceProvider(e.target.value)} /></Field><label className="checkbox-label"><input type="checkbox" checked={fixPaths} onChange={e => setFixPaths(e.target.checked)} />检查并修复失效的会话路径</label></>}
      </fieldset>
      {preview && <>
        <div className="repair-stats">{[['scanned', '已扫描'], ['repairable', '可修复'], ['metadataChanges', '会话文件'], ['indexChanges', '索引记录'], ['pathChanges', '路径修复'], ['blocked', '需检查']].filter(([key]) => summary[key] !== undefined).map(([key, label]) => <div key={key}><strong>{summary[key]}</strong><small>{label}</small></div>)}</div>
        {preview.warnings?.map((w, i) => <div className="notice warning" key={i}>{w}</div>)}
        <div className="repair-toolbar"><label className="checkbox-label"><input type="checkbox" checked={ready.length > 0 && picked.size === ready.length} disabled={!ready.length || busy} onChange={e => setPicked(e.target.checked ? new Set(ready.map(i => i.id)) : new Set())} />选择全部可修复会话</label><span className="muted">已选 {picked.size} / {ready.length}</span><div className="grow" /><input className="input" style={{ width: 250 }} aria-label="搜索修复会话" placeholder="搜索标题、ID、路径…" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="repair-table"><table className="tbl"><thead><tr><th style={{ width: 32 }} /><th>会话</th><th>当前归属</th><th>计划修改</th><th>状态</th></tr></thead><tbody>{visible.map((item, index) => <tr key={item.id + index}><td><input type="checkbox" aria-label={`修复 ${item.title || item.id}`} checked={picked.has(item.id)} disabled={item.status !== 'ready' || busy} onChange={e => setPicked(v => { const n = new Set(v); e.target.checked ? n.add(item.id) : n.delete(item.id); return n; })} /></td><td><b>{item.title || item.id}</b><small className="repair-path" title={item.path}>{item.path || item.id}</small>{item.archived && <span className="chip">归档</span>}</td><td className="mono">{item.beforeProvider || item.metadataProvider || '—'}</td><td>{item.changes?.join(' · ') || '无需修改'}{item.reason && <small className="repair-path">{item.reason}</small>}</td><td><span className={`chip ${item.status === 'ready' ? 'ok' : item.status === 'blocked' ? 'warn' : ''}`}>{item.status === 'ready' ? '可修复' : item.status === 'blocked' ? '跳过' : '正常'}</span></td></tr>)}</tbody></table>{!visible.length && <Empty icon="✓" title="没有需要修复的会话" hint="可以调整扫描范围，或检查客户端的本地数据目录。" />}</div>
        <label className="checkbox-label repair-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已保存工作并退出 ChatGPT 桌面版及使用此会话库的命令行客户端。</label>
      </>}
      {!preview && !result && <div className="repair-start"><Ico name="shield" size={29} /><h3>先看看哪些会话需要修复</h3><p>扫描只读。你可以勾选会话；执行前自动备份，修复后可按批次恢复。</p><span className="hint">此功能不解密其他账号的上下文，也不补回已经丢失的对话文件。</span></div>}
    </> : <>
      <div className="notice">只回退所选批次的修改。修复之后又被其他程序改动的文件会列为冲突，保留现状。</div>
      {!backups.length ? <Empty icon="↶" title="还没有修复备份" hint="每次批量修复前会自动创建一个备份批次。" /> : <div className="list">{backups.map(b => <div className="list-row" key={b.id}><div className="grow"><b>{fmtTime(b.createdAt)}</b><div className="hint">{b.sessions ?? '—'} 个会话 · {b.targetProvider || '会话索引'} · {b.id}</div></div><span className={`chip ${b.status === 'restored' ? 'ok' : ''}`}>{b.status === 'restored' || b.restoredAt ? '已恢复' : b.status === 'interrupted' ? '中断批次' : '已备份'}</span><Btn size="sm" disabled={busy || !!b.restoredAt || b.status === 'restored'} onClick={() => run(() => prepareRestore(b.id))}>预览恢复</Btn></div>)}</div>}
      {restore && <div className="card" style={{ marginTop: 18 }}><div className="card-title">恢复预览</div><p>{restore.message || `将撤回备份 ${restoreId} 对应的修改。`}</p>{restore.conflicts?.length ? <div className="notice warning">检测到冲突：{restore.conflicts.map((v: any) => typeof v === 'string' ? v : v.path || v.reason || v.id).join('；')}</div> : <div className="notice">没有检测到冲突，可以恢复本批次。</div>}</div>}
    </>}
  </Modal>;
}
