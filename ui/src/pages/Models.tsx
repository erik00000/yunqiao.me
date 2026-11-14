import React, { useEffect, useMemo, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Field, Ico, Modal, useToast } from '../components/ui';
import { call, fmtCtx, fmtCost } from '../lib/api';

export default function Models({ state, reload, go }: PageProps) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<'delete' | 'update' | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const desktop = !!window.aurora;
  const all = useMemo(() => state.providers.flatMap(p => p.models.map(model => ({ providerId: p.id, providerName: p.name, model, key: JSON.stringify([p.id, model.id]) }))), [state.providers]);
  const rows = all.filter(r => (!provider || r.providerId === provider) && `${r.model.id} ${r.model.displayName || ''} ${r.providerName}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { const keys = new Set(all.map(r => r.key)); setPicked(p => new Set([...p].filter(k => keys.has(k)))); }, [all]);
  const items = all.filter(r => picked.has(r.key)).map(r => ({ providerId: r.providerId, modelId: r.model.id }));
  const patch: any = {};
  for (const field of ['contextWindow', 'maxOutput', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice']) if (draft[field]?.trim()) patch[field] = Number(draft[field]);
  for (const field of ['tools', 'vision', 'thinking']) if (draft[field]) { patch.capabilities ||= {}; patch.capabilities[field] = draft[field] === 'true'; }
  const payload = { operation, items, patch };
  const allVisible = rows.length > 0 && rows.every(r => picked.has(r.key));
  async function review() {
    setBusy(true); setError('');
    try { const r = await call('model.batch.preview', payload); if (!r.ok) throw new Error(r.message); setPreview(r); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError('');
    try { const r = await call('model.batch.apply', { ...payload, revision: preview.revision }); if (!r.ok) throw new Error(r.message); await reload(); setPicked(new Set()); setOperation(null); setPreview(null); toast.push(r.message, 'ok'); }
    catch (e: any) { setPreview(null); setError(e.message); } finally { setBusy(false); }
  }
  function open(op: 'delete' | 'update') { setOperation(op); setPreview(null); setError(''); setDraft({}); }
  return <>
    <div className="page-head"><div><div className="eyebrow">MODELS</div><h1>模型管理</h1><p>{all.length} 条记录 · {new Set(all.map(r => r.model.id)).size} 个模型。批量修改能力与价格，清理不需要的模型。</p></div><Btn onClick={() => go('providers')}>从供应商同步模型</Btn></div>
    {!desktop && <div className="notice">远程控制台可查看模型；批量编辑请在电脑客户端完成。</div>}
    <div className="repair-toolbar"><div className="search-input"><Ico name="search" size={14} /><input aria-label="搜索模型" placeholder="搜索模型或供应商…" value={query} onChange={e => setQuery(e.target.value)} /></div><select className="select" style={{ width: 200 }} aria-label="按供应商筛选模型" value={provider} onChange={e => setProvider(e.target.value)}><option value="">全部供应商</option>{state.providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.models.length}</option>)}</select><div className="grow" /><span className="hint">已选 {picked.size} 条</span><Btn disabled={!desktop || !picked.size} onClick={() => open('update')}>批量编辑</Btn><Btn variant="danger" disabled={!desktop || !picked.size} onClick={() => open('delete')}>删除所选</Btn></div>
    {picked.size > 0 && <div className="notice"><span>选择跨筛选条件保留，共 {picked.size} 条。</span><button className="text-button" onClick={() => setPicked(new Set())}>清空选择</button></div>}
    <div className="card" style={{ padding: 0, overflowX: 'auto' }}>{!rows.length ? <Empty icon="◇" title={all.length ? '没有匹配的模型' : '还没有模型'} hint="到我的供应商同步模型，或手动添加。" /> : <table className="tbl"><thead><tr><th><input aria-label="全选当前模型" type="checkbox" disabled={!desktop} checked={allVisible} onChange={e => setPicked(p => { const n = new Set(p); for (const r of rows) e.target.checked ? n.add(r.key) : n.delete(r.key); return n; })} /></th><th>供应商</th><th>模型 ID</th><th>上下文</th><th>输入 / 输出价</th><th>能力</th><th /></tr></thead><tbody>{rows.map(r => <tr key={r.key}><td><input type="checkbox" aria-label={`选择模型 ${r.providerName} ${r.model.id}`} disabled={!desktop} checked={picked.has(r.key)} onChange={e => setPicked(p => { const n = new Set(p); e.target.checked ? n.add(r.key) : n.delete(r.key); return n; })} /></td><td>{r.providerName}</td><td className="mono">{r.model.id}</td><td>{fmtCtx(r.model.contextWindow)}</td><td>{fmtCost(r.model.inputPrice)} / {fmtCost(r.model.outputPrice)}</td><td><div className="tag-list">{(['tools', 'vision', 'thinking'] as const).filter(c => r.model.capabilities?.[c]).map(c => <span className="chip accent" key={c}>{c === 'tools' ? '工具' : c === 'vision' ? '视觉' : '思考'}</span>)}</div></td><td><Btn size="sm" disabled={!desktop} onClick={() => { setPicked(new Set([r.key])); open('update'); }}>编辑</Btn></td></tr>)}</tbody></table>}</div>
    <p className="hint" style={{ marginTop: 16 }}>价格为每百万 Token 的美元估算值。上下文与能力标记不改变服务商的实际限制；批量修改前保存本地备份。</p>
    {operation && <Modal title={operation === 'delete' ? '批量删除模型' : '批量编辑模型'} sub={`已选择 ${items.length} 条记录，先检查影响，再应用。`} width={760} onClose={() => !busy && setOperation(null)} foot={<><Btn disabled={busy} onClick={() => setOperation(null)}>取消</Btn>{preview ? <Btn variant={operation === 'delete' ? 'danger' : 'primary'} disabled={busy || !!preview.conflicts?.length} onClick={apply}>确认{operation === 'delete' ? '删除' : '更新'} {preview.count} 条</Btn> : <Btn variant="primary" disabled={busy} onClick={review}>{busy ? '检查中…' : '预览修改'}</Btn>}</>}>
      {error && <div className="notice warning" role="alert">{error}</div>}
      {operation === 'update' && <><div className="notice">留空保持原值，只更新填写的字段。</div><fieldset disabled={busy} style={{ border: 0, padding: 0 }}><div className="grid cols-2">{[['contextWindow', '上下文窗口'], ['maxOutput', '最大输出'], ['inputPrice', '输入价格'], ['outputPrice', '输出价格'], ['cacheReadPrice', '缓存读取价格'], ['cacheWritePrice', '缓存写入价格']].map(([key, label]) => <Field label={label} key={key}><input className="input" type="number" min={0} step="any" aria-label={`批量${label}`} placeholder="保持原值" value={draft[key] || ''} onChange={e => { setDraft(d => ({ ...d, [key]: e.target.value })); setPreview(null); }} /></Field>)}{[['tools', '工具调用'], ['vision', '视觉'], ['thinking', '思考']].map(([key, label]) => <Field label={label} key={key}><select className="select" value={draft[key] || ''} onChange={e => { setDraft(d => ({ ...d, [key]: e.target.value })); setPreview(null); }}><option value="">保持原值</option><option value="true">支持</option><option value="false">不支持</option></select></Field>)}</div></fieldset></>}
      {operation === 'delete' && <p>正在使用的客户端或路由分组会列出，完成调整后才能删除。删空的供应商会自动停用。</p>}
      {preview?.conflicts?.map((c: string) => <div key={c} className="notice warning">{c}</div>)}{preview && !preview.conflicts?.length && <div className="notice">检查完成，可以应用。{preview.emptied?.length ? `以下供应商将停用：${preview.emptied.join('、')}` : ''}</div>}
      <div className="scroll-y" style={{ maxHeight: 160 }}>{all.filter(r => picked.has(r.key)).map(r => <div className="list-row" key={r.key}><span>{r.providerName}</span><code>{r.model.id}</code></div>)}</div>
    </Modal>}
  </>;
}
