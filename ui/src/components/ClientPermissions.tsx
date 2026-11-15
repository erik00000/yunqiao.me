import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PermissionPreview } from '../../../src/core/agents/permissions';
import { call, type AgentCatalogItem } from '../lib/api';
import { Btn, Modal } from './ui';

export default function ClientPermissions({ agent, onRestored, onActiveChange }: {
  agent: AgentCatalogItem; onRestored?: () => void | Promise<void>; onActiveChange?: (active: boolean) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState<'preview' | 'restore' | null>(null);
  const [preview, setPreview] = useState<PermissionPreview | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const generation = useRef(0), working = useRef<'preview' | 'restore' | null>(null);
  const callbacks = useRef({ onRestored, onActiveChange }); callbacks.current = { onRestored, onActiveChange };
  useEffect(() => {
    generation.current++; working.current = null;
    setOpen(false); setBusy(null); setPreview(null); setError(''); setMessage('');
    return () => { generation.current++; working.current = null; callbacks.current.onActiveChange?.(false); };
  }, [agent.id]);
  useEffect(() => { callbacks.current.onActiveChange?.(open); }, [open]);
  if (!window.aurora || !['codex-cli', 'chatgpt-desktop', 'codex-desktop', 'claude-code'].includes(agent.id)) return null;

  function close() {
    if (working.current === 'restore') return;
    generation.current++; working.current = null;
    setOpen(false); setBusy(null); setPreview(null); setError(''); setMessage('');
  }
  async function inspect() {
    if (working.current) return;
    const request = ++generation.current;
    working.current = 'preview'; setOpen(true); setBusy('preview'); setPreview(null); setError(''); setMessage('');
    try {
      const response = await call<PermissionPreview & { message?: string }>('agent.permissions.preview', { agentId: agent.id });
      if (request !== generation.current) return;
      if (!response?.ok) throw new Error(response?.message || '无法预览原执行权限');
      if (response.agentId !== agent.id || !/^[a-f0-9]{64}$/.test(response.revision) || !Array.isArray(response.changes) || !Array.isArray(response.warnings)) throw new Error('权限预览结果无效，请重新预览');
      setPreview(response);
    } catch (e: any) { if (request === generation.current) setError(e.message || '无法预览原执行权限'); }
    finally { if (request === generation.current) { working.current = null; setBusy(null); } }
  }
  async function restore() {
    if (working.current || !preview) return;
    const request = ++generation.current;
    working.current = 'restore'; setBusy('restore'); setError('');
    try {
      const response = await call('agent.permissions.restore', { agentId: agent.id, revision: preview.revision, confirmed: true });
      if (request !== generation.current) return;
      setPreview(null);
      if (!response?.ok || response.agentId !== agent.id) throw new Error(response?.message || '权限恢复未完成，请重新预览');
      setMessage(response.message || '已恢复原执行权限，供应商连接保留。请重新启动客户端。');
      try { await callbacks.current.onRestored?.(); }
      catch { if (request === generation.current) setError('权限已恢复，但页面刷新失败，请关闭窗口后刷新客户端列表。'); }
    } catch (e: any) { if (request === generation.current) { setPreview(null); setError(e.message || '权限恢复未完成，请重新预览'); } }
    finally { if (request === generation.current) { working.current = null; setBusy(null); } }
  }
  return <div className="client-permissions">
    <Btn size="sm" variant="ghost" disabled={open || !!busy} onClick={() => { void inspect(); }}>恢复原执行权限</Btn>
    {open && createPortal(<Modal title={`${agent.name} · 恢复原执行权限`} sub="保留当前供应商和模型连接。" width={680} onClose={close} foot={<>
      <Btn disabled={busy === 'restore'} onClick={close}>{message ? '完成' : '取消'}</Btn>
      {!message && !preview && <Btn disabled={!!busy} onClick={() => { void inspect(); }}>{busy === 'preview' ? '正在核验…' : '重新预览'}</Btn>}
      {preview && <Btn variant="primary" disabled={!!busy} onClick={() => { void restore(); }}>{busy === 'restore' ? '正在恢复…' : '确认恢复原执行权限'}</Btn>}
    </>}>
      {busy === 'preview' && <p role="status">正在核验原始备份与当前权限…</p>}
      {error && <div className="notice warning" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {preview && <>
        <p>{preview.message}</p>
        {preview.alreadyOriginal && <p className="notice warning">当前权限与接入前相同，此操作不会降低原有权限。</p>}
        <div className="repair-table"><table className="tbl"><thead><tr><th>配置范围</th><th>权限设置</th><th>当前</th><th>恢复后</th></tr></thead><tbody>{preview.changes.map(change => <tr key={`${change.scope}:${change.field}`}><td>{change.scope}</td><td><code>{change.field}</code></td><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody></table></div>
        {preview.warnings.map((warning, index) => <p className="notice warning" key={index}>{warning}</p>)}
      </>}
    </Modal>, document.body)}
  </div>;
}
