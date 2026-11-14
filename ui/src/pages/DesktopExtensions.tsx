import React, { useEffect, useMemo, useState } from 'react';
import { Btn, Empty, Field, Ico, Modal, Toggle, useToast } from '../components/ui';
import { call } from '../lib/api';

interface ExtensionItem {
  id: string; name: string; description: string; version?: string;
  source: 'bundled' | 'builtin' | 'public' | 'full'; license?: string;
  installed: boolean; enabled: boolean; status: string; reason?: string;
  configSchema?: any; config?: any; requiresRestart?: boolean; requiresAuth?: boolean;
}
interface ExtensionState {
  ok: boolean; message?: string; upstream: { repository: string; version: string; revision: string; license: string };
  client: { installed: boolean; exePath?: string; version?: string; lastVersion?: string; versionChanged?: boolean; running: boolean; debugPortOpen?: boolean; connected?: boolean; compatible?: boolean; message?: string };
  items: ExtensionItem[]; connection: { port: number; exePath?: string; lastVersion?: string };
  runtime: { connected: boolean; targetTitle?: string; targetUrl?: string; applied?: number | string[]; errors?: any[] };
}
const SOURCES: Record<string, string> = { all: '全部插件', builtin: '内置增强', bundled: '官方拓展包', public: '公开市场', full: '完整索引', installed: '已安装' };
const STATUS: Record<string, string> = { available: '可安装', installed: '已安装', active: '已生效', 'needs-connection': '等待连接', unsupported: '暂不兼容', error: '运行异常' };

export default function DesktopExtensions() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [source, setSource] = useState('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [path, setPath] = useState('');
  const [port, setPort] = useState(9222);
  const [editing, setEditing] = useState<ExtensionItem | null>(null);
  const [config, setConfig] = useState('');
  const [detail, setDetail] = useState<ExtensionItem | null>(null);
  const [visibleCount, setVisibleCount] = useState(60);
  const [acknowledgeVersion, setAcknowledgeVersion] = useState(false);
  const desktop = !!window.aurora;
  const toast = useToast();
  async function load() {
    if (!desktop) { setLoading(false); return; }
    setLoading(true);
    try {
      const r = await call<ExtensionState>('extension.list');
      if (!r.ok) throw new Error(r.message || '无法读取插件库');
      setState(r); setError('');
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => setVisibleCount(60), [source, query]);
  async function action(name: string, payload: any = {}, id = name) {
    if (busy) return;
    setBusy(id); setError('');
    try {
      const r = await call(name, payload);
      if (r?.ok === false) throw new Error(r.message || '操作未完成');
      toast.push(r.message || '操作完成', 'ok');
      await load(); return r;
    } catch (e: any) { setError(e.message || String(e)); return null; }
    finally { setBusy(''); }
  }
  const list = useMemo(() => (state?.items || []).filter(i => (source === 'all' || source === 'installed' ? source !== 'installed' || i.installed : i.source === source) && `${i.name} ${i.description} ${i.id}`.toLowerCase().includes(query.toLowerCase())), [state, source, query]);
  const counts = (state?.items || []).reduce<Record<string, number>>((v, i) => { v[i.source] = (v[i.source] || 0) + 1; if (i.installed) v.installed = (v.installed || 0) + 1; return v; }, {});
  const connected = !!state?.runtime?.connected;
  const errors = state?.runtime?.errors || [];
  function editConfig(item: ExtensionItem) { setEditing(item); setConfig(JSON.stringify(item.config || {}, null, 2)); }
  function changeConfig(key: string, value: any) { try { setConfig(JSON.stringify({ ...JSON.parse(config), [key]: value }, null, 2)); } catch { toast.push('请先修正 JSON 配置格式', 'bad'); } }
  return <>
    {!desktop ? <div className="notice"><Ico name="puzzle" size={20} /><div><b>请在电脑上管理桌面插件</b><p>桌面插件会在 ChatGPT 桌面版运行，安装、启用与连接需要电脑端操作。</p></div></div> : <>
      <div className="desktop-connection">
        <div className="desktop-connection-icon"><Ico name="puzzle" size={28} /></div>
        <div className="grow"><div className="row"><h2>ChatGPT 桌面版插件</h2><span className={`chip ${connected ? 'ok' : ''}`}>{connected ? '已连接桌面' : state?.client?.installed ? '已发现客户端' : '等待检测'}</span></div><p>{state?.client?.message || (connected ? '已连接本机桌面客户端，可挂载扩展与解锁插件入口。' : '自动识别 ChatGPT、ChatGPT Beta 及原 Codex 桌面版。连接后启用插件。')}</p><div className="row wrap"><span className="hint">{state?.client?.version ? `客户端 ${state.client.version}` : '版本待检测'}</span>{state?.client?.exePath && <span className="mono ellipsis hint" style={{ maxWidth: 440 }} title={state.client.exePath}>{state.client.exePath}</span>}</div></div>
        <div className="connection-buttons"><Btn size="sm" disabled={!!busy} onClick={() => { setPath(state?.connection?.exePath || state?.client?.exePath || ''); setPort(state?.connection?.port || 9222); setSettingsOpen(true); }}><Ico name="gear" size={13} />连接设置</Btn><Btn variant="primary" disabled={!!busy || (!connected && !!state?.client?.versionChanged && !acknowledgeVersion)} onClick={() => action(connected ? 'extension.disconnect' : 'extension.connect', { launch: true, acknowledgeVersion })}><Ico name={connected ? 'stop' : 'plug'} size={14} />{busy === 'extension.connect' ? '连接中…' : connected ? '断开连接' : '启动并连接'}</Btn></div>
      </div>
      {state?.client?.versionChanged && !connected && <div className="notice warning"><label className="checkbox-label"><input type="checkbox" checked={acknowledgeVersion} onChange={e => setAcknowledgeVersion(e.target.checked)} />客户端已更新到 {state.client.version}。确认重新检测插件兼容性并连接此版本。</label></div>}
      {error && <div className="notice warning" role="alert">{error}<div className="grow" /><Btn size="sm" disabled={!!busy} onClick={load}>重新检测</Btn></div>}
      {errors.length > 0 && <details className="notice warning" style={{ display: 'block' }}><summary>有 {errors.length} 个扩展未能生效，查看原因</summary>{errors.map((e, i) => <p key={i}>{typeof e === 'string' ? e : `${e.id || e.name || ''}：${e.message || e.error || '运行失败'}`}</p>)}</details>}
      <div className="extension-banner"><div><div className="eyebrow">CODEX++ EXTENSIONS</div><h3>熟悉的增强，放进同一个工作空间</h3><p>收录上游内置增强、完整拓展包和官方插件索引。每项显示来源、兼容状态和实际运行结果。</p></div><div className="extension-totals"><div><strong>{counts.builtin || 0}</strong><small>内置增强</small></div><div><strong>{counts.bundled || 0}</strong><small>拓展包</small></div><div><strong>{counts.installed || 0}</strong><small>已安装</small></div></div></div>
      <div className="filter-bar"><div className="segments">{Object.entries(SOURCES).map(([id, label]) => <button key={id} className={source === id ? 'selected' : ''} onClick={() => setSource(id)}>{label}{id !== 'all' && counts[id] ? ` ${counts[id]}` : ''}</button>)}</div></div>
      <div className="repair-toolbar"><div className="search-input"><Ico name="search" size={14} /><input aria-label="搜索桌面插件" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索插件名称或功能…" style={{ width: 240 }} /></div><span className="muted">{list.length} 项</span><div className="grow" /><Btn size="sm" disabled={!!busy} onClick={() => action('extension.refresh', { source: source === 'full' ? 'full' : 'public' })}><Ico name="cloud" size={13} />同步市场索引</Btn><Btn size="sm" disabled={!!busy || loading} onClick={load}><Ico name="refresh" size={13} />刷新状态</Btn></div>
      {loading && !state ? <div className="client-grid">{[1, 2, 3].map(i => <div className="skeleton" style={{ height: 230 }} key={i} />)}</div> : <div className="client-grid extension-grid">{list.slice(0, visibleCount).map(item => <article className={`extension-card ${item.enabled ? 'enabled' : ''}`} key={item.id}>
        <div className="row"><span className={`extension-icon source-${item.source}`}><Ico name={item.source === 'builtin' ? 'bolt' : item.source === 'bundled' ? 'puzzle' : 'cube'} size={23} /></span><div className="grow" /><span className={`chip ${item.status === 'active' ? 'ok' : item.status === 'error' || item.status === 'unsupported' ? 'warn' : ''}`}>{STATUS[item.status] || item.status}</span></div>
        <h3>{item.name}</h3><p className="extension-description" title={item.description}>{item.description || '暂无插件描述'}</p>
        <div className="tag-list"><span className="chip">{SOURCES[item.source]}</span>{item.version && <span className="chip">v{item.version}</span>}{item.requiresAuth && <span className="chip">需服务授权</span>}{item.requiresRestart && <span className="chip">重启生效</span>}</div>
        {item.reason && <p className="extension-reason">{item.reason}</p>}
        <div className="extension-card-actions"><button className="text-button" onClick={() => setDetail(item)}>详情与来源 ↗</button><div className="grow" />{item.installed ? <><Btn size="sm" disabled={!!busy || item.status === 'unsupported'} onClick={() => item.source === 'public' || item.source === 'full' ? setDetail(item) : editConfig(item)}>{item.source === 'public' || item.source === 'full' ? '管理' : '设置'}</Btn><Toggle title={`启用 ${item.name}`} disabled={!!busy || item.status === 'unsupported'} on={item.enabled} onChange={enabled => action('extension.toggle', { id: item.id, enabled }, item.id)} /></> : <Btn variant="primary" size="sm" disabled={!!busy || item.status === 'unsupported'} onClick={() => action('extension.install', { id: item.id }, item.id)}><Ico name="plus" size={12} />{busy === item.id ? '安装中…' : '安装'}</Btn>}</div>
      </article>)}</div>}
      {!loading && !list.length && <Empty icon="⌕" title="没有匹配的插件" hint="试试功能名称，或同步市场索引。" />}
      {list.length > visibleCount && <div className="page-footnote"><Btn onClick={() => setVisibleCount(v => v + 60)}>加载更多（剩余 {list.length - visibleCount} 项）</Btn></div>}
      {state?.upstream && <div className="page-footnote"><span>Codex++ {state.upstream.version} · {state.upstream.revision?.slice(0, 8)} · 上游核心 {state.upstream.license}；市场插件采用各自许可。</span><button className="text-button" onClick={() => call('app.openExternal', { url: state.upstream.repository })}>上游源码 ↗</button></div>}
    </>}
    {settingsOpen && <Modal title="连接 ChatGPT 桌面版" sub="仅连接本机桌面客户端的调试接口。应用版本更新后会重新检测兼容性。" onClose={() => !busy && setSettingsOpen(false)} foot={<><Btn disabled={!!busy} onClick={() => setSettingsOpen(false)}>取消</Btn><Btn disabled={!!busy} variant="primary" onClick={async () => { if (await action('extension.configure', { exePath: path.trim(), port: Number(port) })) setSettingsOpen(false); }}>保存连接设置</Btn></>}><Field label="客户端可执行文件" hint="留空自动识别 ChatGPT、ChatGPT Beta 或原 Codex 安装路径。"><input className="input mono" aria-label="桌面客户端路径" value={path} onChange={e => setPath(e.target.value)} placeholder="自动检测" /></Field><Field label="本机调试端口"><input className="input" aria-label="桌面调试端口" type="number" min={1024} max={65535} value={port} onChange={e => setPort(Number(e.target.value))} /></Field><div className="notice">如果客户端正在以普通方式运行，请先保存工作并完全退出，再点击「启动并连接」。连接成功不代表所有版本都兼容每一项增强，具体状态会显示在插件卡片上。</div></Modal>}
    {editing && <Modal title={`${editing.name} · 插件设置`} sub="配置保存后会应用于该插件。可在这里停用并移除插件。" onClose={() => !busy && setEditing(null)} foot={<><Btn variant="danger" disabled={!!busy || editing.source === 'builtin'} onClick={async () => { if (!confirm(`移除插件「${editing.name}」？`)) return; if (await action('extension.remove', { id: editing.id }, editing.id)) setEditing(null); }}>移除插件</Btn><div className="grow" /><Btn disabled={!!busy} onClick={() => setEditing(null)}>取消</Btn><Btn variant="primary" disabled={!!busy} onClick={async () => { try { const value = JSON.parse(config); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象'); if (await action('extension.config', { id: editing.id, config: value }, editing.id)) setEditing(null); } catch (e: any) { toast.push(e.message, 'bad'); } }}>保存设置</Btn></>}>{editing.configSchema && Object.entries(editing.configSchema).map(([key, field]: [string, any]) => { let value: any; try { value = JSON.parse(config)[key] ?? field.default; } catch { value = field.default; } return <Field key={key} label={field.title || field.label || key} hint={field.description}>{field.type === 'boolean' || field.type === 'bool' ? <Toggle disabled={!!busy} title={field.title || key} on={!!value} onChange={v => changeConfig(key, v)} /> : field.type === 'select' ? <select className="select" disabled={!!busy} value={String(value ?? '')} onChange={e => changeConfig(key, e.target.value)}>{(field.options || []).map((o: any) => <option key={typeof o === 'string' ? o : o.value} value={typeof o === 'string' ? o : o.value}>{typeof o === 'string' ? o : o.label || o.value}</option>)}</select> : <div className="row"><input className="input grow" disabled={!!busy} type={field.type === 'number' ? 'number' : 'text'} min={field.min} max={field.max} value={value ?? ''} onChange={e => changeConfig(key, field.type === 'number' ? Number(e.target.value) : e.target.value)} />{field.type === 'file' && <Btn size="sm" disabled={!!busy} onClick={async () => { const r = await call('app.chooseImage'); if (r.ok) changeConfig(key, r.path); }}>选择图片</Btn>}</div>}</Field>; })}<details><summary>高级 JSON 配置</summary><Field label="插件配置（JSON）"><textarea className="textarea mono" aria-label="桌面插件配置" rows={10} value={config} onChange={e => setConfig(e.target.value)} /></Field></details>{editing.configSchema && <details><summary>查看插件配置说明</summary><pre className="extension-schema">{JSON.stringify(editing.configSchema, null, 2)}</pre></details>}</Modal>}
    {detail && <Modal title={detail.name} sub={detail.description} onClose={() => setDetail(null)} foot={<>{detail.installed && (detail.source === 'public' || detail.source === 'full') && <Btn variant="danger" disabled={!!busy} onClick={async () => { if (confirm(`移除插件「${detail.name}」？`) && await action('extension.remove', { id: detail.id }, detail.id)) setDetail(null); }}>移除插件</Btn>}<Btn disabled={!!busy} onClick={() => setDetail(null)}>关闭</Btn></>}><div className="kv"><span className="k">来源</span><span className="v">{SOURCES[detail.source]}</span><span className="k">标识</span><code className="v">{detail.id}</code><span className="k">版本</span><span className="v">{detail.version || '未标注'}</span><span className="k">许可证</span><span className="v">{detail.license || '请查看该插件源码中的许可声明'}</span><span className="k">状态</span><span className="v">{STATUS[detail.status] || detail.status}</span></div>{(detail.source === 'public' || detail.source === 'full') && <p className="muted">插件的服务授权和具体设置请在 ChatGPT 桌面版中完成；启停或移除后重启客户端生效。</p>}{detail.reason && <div className="notice warning" style={{ marginTop: 16 }}>{detail.reason}</div>}</Modal>}
  </>;
}
