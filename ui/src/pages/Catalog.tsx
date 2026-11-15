import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Ico, useToast } from '../components/ui';
import { call, CloudCatalog, PROTOCOL_TEXT } from '../lib/api';

const REGIONS: Record<string, string> = { all: '全部厂商', cn: '国内服务', global: '国际服务', relay: '聚合与中转', local: '本地模型' };
export default function Catalog({ state, reload, go }: PageProps) {
  const [data, setData] = useState<CloudCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const catalogRequest = useRef(0);
  const toast = useToast();
  async function fetchCatalog(refresh = false) {
    const request = ++catalogRequest.current;
    setLoading(true); setError('');
    try {
      const r = await call<CloudCatalog & { message?: string }>('cloud.catalog', { refresh });
      if (request !== catalogRequest.current) return;
      if (!r.ok) throw new Error(r.message || '目录暂不可用');
      setData(r); setPicked(previous => new Set([...previous].filter(key => r.providers.some(p => p.key === key))));
      if (refresh) await reload();
    } catch (e: any) { if (request === catalogRequest.current) setError(e.message); }
    finally { if (request === catalogRequest.current) setLoading(false); }
  }
  useEffect(() => {
    void fetchCatalog();
    return () => { catalogRequest.current++; };
  }, [state.catalog?.version, state.catalog?.fetchedAt, state.catalog?.source, state.catalog?.syncing, state.catalog?.warning]);
  const list = useMemo(() => (data?.providers || []).filter(p => (region === 'all' || p.region === region) && `${p.name} ${p.vendor} ${p.tags?.join(' ')} ${p.models?.map(m => m.id).join(' ')}`.toLowerCase().includes(query.toLowerCase())), [data, region, query]);
  async function importItems() {
    setImporting(true);
    try {
      const r = await call('cloud.import', { providers: data?.providers.filter(p => picked.has(p.key)) });
      if (!r.ok) throw new Error(r.message || '导入失败');
      await reload(); setPicked(new Set()); toast.push(`已添加 ${r.added} 家、更新 ${r.merged} 家。请在「我的供应商」填写 API Key。`, 'ok');
    } catch (e: any) { toast.push(e.message, 'bad'); } finally { setImporting(false); }
  }
  return <>
    <div className="page-head"><div><div className="eyebrow">DISCOVER</div><h1>厂商目录</h1><p>发现国内外模型服务，按需加入你的供应商列表。</p></div><div className="actions"><Btn disabled={loading} onClick={() => fetchCatalog(true)}><Ico name="refresh" size={14} />{loading ? '正在同步…' : '刷新目录'}</Btn><Btn variant="primary" disabled={!picked.size || importing || !window.aurora} onClick={importItems}><Ico name="plus" size={14} />添加所选{picked.size ? ` (${picked.size})` : ''}</Btn></div></div>
    <div className="catalog-banner"><div className="catalog-symbol"><Ico name="cloud" size={27} /></div><div className="grow"><b>一份持续更新的 AI 服务目录</b><p>厂商提供模型，供应商提供访问端点。添加后填写你自己的密钥即可连接。</p></div><div className="catalog-count"><strong>{data?.providers.length ?? '—'}</strong><span>个服务预设</span></div><Btn onClick={() => go('providers')}>我的供应商 ↗</Btn></div>
    <div className="filter-bar"><div className="segments">{Object.entries(REGIONS).map(([id, label]) => <button key={id} className={region === id ? 'selected' : ''} onClick={() => setRegion(id)}>{label}</button>)}</div><div className="search-input"><Ico name="search" size={15} /><input aria-label="搜索厂商或模型" placeholder="搜索厂商、模型…" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
    {error && <div className="notice warning" role="alert">{error}<Btn size="sm" onClick={() => fetchCatalog(true)}>重试</Btn></div>}
    {data?.warning && <div className="notice warning">{data.warning}</div>}
    {loading && !data ? <div className="client-grid">{[1, 2, 3, 4, 5, 6].map(i => <div className="skeleton" key={i} style={{ height: 215 }} />)}</div> : <div className="client-grid">{list.map(p => {
      const exists = state.providers.some(x => x.presetId === p.key || x.baseUrl === p.baseUrl);
      const selected = picked.has(p.key);
      return <article className={`catalog-card ${selected ? 'selected' : ''}`} key={p.key}>
        <div className="row"><span className="vendor-avatar" style={{ color: p.color || 'var(--accent)' }}>{p.name.slice(0, 1)}</span><div className="grow"><h3>{p.name}</h3><small className="muted">{p.vendor || p.name}</small></div><input type="checkbox" aria-label={`选择 ${p.name}`} checked={selected} onChange={() => setPicked(v => { const n = new Set(v); selected ? n.delete(p.key) : n.add(p.key); return n; })} /></div>
        <p className="catalog-description">{p.note || `通过 ${PROTOCOL_TEXT[p.format]} 协议访问模型服务。`}</p>
        <div className="tag-list"><span className="chip">{REGIONS[p.region || ''] || '其他服务'}</span><span className="chip">{p.models?.length || 0} 个模型</span>{exists && <span className="chip ok">已添加</span>}</div>
        <div className="catalog-card-footer"><span className="ellipsis mono" title={p.baseUrl}>{p.baseUrl.replace(/^https?:\/\//, '') || '自定义端点'}</span>{p.docs && <button className="text-button" onClick={() => call('app.openExternal', { url: p.docs })}>文档 ↗</button>}</div>
      </article>;
    })}</div>}
    {!loading && !error && !list.length && <Empty icon="⌕" title="没有找到匹配的服务" hint="试试厂商中文名或模型名称，也可以在「我的供应商」中添加自定义端点。" />}
    <div className="page-footnote"><Ico name="shield" size={14} /><span>目录只包含公开的服务信息，不包含你的密钥。{data ? ` · 目录 v${data.version} · ${data.source === 'cache' ? '离线缓存' : data.source === 'builtin' ? '离线预设' : '远端已同步'}` : ''}</span></div>
  </>;
}
