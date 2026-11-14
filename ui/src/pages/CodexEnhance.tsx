import React, { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Field, Ico, Modal, Stat, Toggle, useToast } from '../components/ui';
import { call, isWebMode } from '../lib/api';

interface Diagnosis {
  ok: boolean; message?: string; dbPath: string; dbExists: boolean; total: number;
  currentProvider?: string; byProvider: Array<{ provider: string; count: number }>;
  mismatch: number; missingRollouts: number;
  samples: Array<{ id: string; title: string; provider: string; updatedAt: string; missing: boolean }>;
}
interface Asset { id: string; kind: 'plugin' | 'skill' | 'prompt' | 'mcp'; name: string; path?: string; description?: string; enabled: boolean; mutable?: boolean; }
interface Flag { key: string; label: string; type: string; hint: string; options?: string[]; }
const kinds = { skill: { label: 'Skills 技能', icon: 'bolt', hint: '发现本机已安装的 Codex 技能。', docs: 'https://github.com/openai/skills' }, mcp: { label: 'MCP 服务器', icon: 'plug', hint: '查看 Codex 已配置的工具服务。', docs: 'https://developers.openai.com/codex/mcp/' }, prompt: { label: '全局提示词', icon: 'chat', hint: '维护 AGENTS.md 中的工作约定。', docs: 'https://developers.openai.com/codex/guides/agents-md/' }, plugin: { label: '客户端插件', icon: 'puzzle', hint: '查看本机 Codex 插件目录。', docs: 'https://developers.openai.com/codex/' } };

export default function CodexEnhance({ go }: PageProps) {
  const toast = useToast();
  const remote = isWebMode();
  const [tab, setTab] = useState<'assets' | 'diagnosis' | 'advanced'>('assets');
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [flags, setFlags] = useState<{ flags: Record<string, string | undefined>; schema: Flag[] } | null>(null);
  const [flagDrafts, setFlagDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const [editAgents, setEditAgents] = useState<string | null>(null);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [repairResult, setRepairResult] = useState<{ message: string; backup?: string } | null>(null);
  const [inj, setInj] = useState<any>(null);
  const [scripts, setScripts] = useState<any[]>([]);
  const [confirmInject, setConfirmInject] = useState(false);

  async function load() {
    if (remote) return;
    setLoading(true);
    const tasks = ['codex.assets', 'codex.diagnose', 'codex.flags'];
    const results = await Promise.allSettled(tasks.map(action => call(action)));
    const failures: Record<string, string> = {};
    results.forEach((r, i) => {
      if (r.status === 'rejected') { failures[tasks[i]] = String(r.reason?.message || r.reason); return; }
      if (i === 0) setAssets(r.value.assets || []);
      if (i === 1) setDiag(r.value);
      if (i === 2) { setFlags({ flags: r.value.flags || {}, schema: r.value.schema || [] }); setFlagDrafts(Object.fromEntries(Object.entries(r.value.flags || {}).map(([k, v]) => [k, String(v ?? '')]))); }
    });
    setErrors(failures); setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  async function perform(key: string, action: string, payload: unknown = {}, reload = true) {
    if (remote || busy) return;
    setBusy(key);
    try {
      const result = await call(action, payload);
      if (result?.ok === false) throw new Error(result.message || '操作未完成');
      if (result?.message) toast.push(result.message, 'ok');
      if (reload) await load();
      return result;
    } catch (e: any) { toast.push(e.message || '操作未完成', 'bad'); return null; }
    finally { setBusy(''); }
  }
  async function editPrompt() { const r = await perform('prompt-read', 'codex.readAgents', {}, false); if (r) setEditAgents(r.text || ''); }
  async function saveFlag(f: Flag) {
    const value = (flagDrafts[f.key] || '').trim();
    if (value && f.type === 'number' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) { toast.push('请输入大于 0 的整数，留空可恢复默认', 'bad'); return; }
    await perform(f.key, 'codex.setFlag', { key: f.key, value });
  }
  async function inspectDesktop() {
    const r = await perform('inspect', 'inject.info', {}, false);
    if (r) { setInj(r.info); setScripts(r.scripts || []); }
  }

  return <>
    <div className="page-head"><div><div className="eyebrow">CODEX WORKSPACE</div><h1>Codex 工作台</h1><p>管理本机扩展与工作约定，查看会话状态和客户端配置。</p></div><div className="actions"><Btn onClick={() => go('sessions')}><Ico name="chat" size={14} /> 历史会话</Btn><Btn disabled={remote || loading || !!busy} onClick={load}><Ico name="refresh" size={14} /> {loading ? '检测中…' : '重新检测'}</Btn></div></div>
    {remote ? <div className="card"><Empty icon="⌘" title="在电脑客户端管理本地资源" hint="远程控制台不开放本机插件、提示词和数据库写入。请在电脑上的云桥 AI 打开此页；远程查看会话可使用「历史会话」。" /></div> : <>
      <div className="row" style={{ marginBottom: 20, gap: 8 }}>{([['assets', '资源库', 'puzzle'], ['diagnosis', '会话诊断', 'chat'], ['advanced', '高级设置', 'gear']] as const).map(([id, title, icon]) => <Btn key={id} variant={tab === id ? 'primary' : 'default'} onClick={() => setTab(id)}><Ico name={icon} size={14} /> {title}</Btn>)}</div>
      {tab === 'assets' && <>
        <div className="row" style={{ gap: 12, marginBottom: 18 }}><input className="input grow" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索本机资源名称或说明" aria-label="搜索 Codex 资源" style={{ maxWidth: 390 }} /><div className="grow" /><Btn disabled={!!busy} onClick={editPrompt}><Ico name="plus" size={14} /> 编辑全局提示词</Btn></div>
        {errors['codex.assets'] && <div className="notice warning">资源读取失败：{errors['codex.assets']}</div>}
        <div className="grid cols-2">{(Object.entries(kinds) as Array<[Asset['kind'], typeof kinds.skill]>).map(([kind, meta]) => {
          const items = assets.filter(a => a.kind === kind && `${a.name} ${a.description || ''}`.toLowerCase().includes(search.toLowerCase()));
          return <div className="card" key={kind}>
            <div className="card-title"><Ico name={meta.icon} /><span>{meta.label}</span><span className="sub">{items.length} 个</span></div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>{meta.hint}</p>
            {!items.length ? <div style={{ padding: '14px 0 22px', color: 'var(--muted)', fontSize: 12 }}>{loading ? '正在发现本地资源…' : search ? '没有匹配的资源。' : kind === 'prompt' ? '尚未创建全局提示词，可从右上角开始。' : '尚未发现已安装资源，可查看官方文档了解安装方式。'}</div> : <div className="list">{items.map(a => <div className="list-row" key={a.id}>
              <div className="grow"><strong className="ellipsis" title={a.name}>{a.name}</strong><div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, overflowWrap: 'anywhere' }}>{a.description || a.path}</div></div>
              {a.kind === 'prompt' ? <Btn size="sm" disabled={!!busy} onClick={editPrompt}>编辑</Btn> : a.mutable ? <fieldset disabled={!!busy} style={{ padding: 0, margin: 0, border: 0 }}><Toggle title={`启用${a.name}`} on={a.enabled} onChange={v => { void perform(a.id, 'codex.toggleAsset', { id: a.id, enabled: v }); }} /></fieldset> : <span className="chip">已发现</span>}
              {a.path && <Btn size="sm" variant="ghost" title="打开本地位置" disabled={!!busy} onClick={() => { void perform(a.id, 'app.openPath', { path: a.path }, false); }}><Ico name="ext" size={12} /></Btn>}
            </div>)}</div>}
            <div className="row" style={{ marginTop: 15 }}><Btn size="sm" variant="ghost" disabled={!!busy} onClick={() => { void perform('docs', 'app.openExternal', { url: meta.docs }, false); }}><Ico name="ext" size={12} /> {kind === 'skill' ? '发现官方技能' : '官方使用文档'}</Btn>{kind === 'plugin' && <span className="hint">启停请在对应客户端完成</span>}</div>
          </div>;
        })}</div>
      </>}
      {tab === 'diagnosis' && <div className="card">
        <div className="card-title">会话可见性诊断<span className="sub">只读检测，不自动迁移历史</span></div>
        {errors['codex.diagnose'] ? <div className="notice warning">{errors['codex.diagnose']}</div> : !diag ? <Empty icon="⌕" title={loading ? '正在检测会话库…' : '尚无诊断结果'} hint="点击重新检测读取本地状态。" /> : !diag.ok ? <Empty icon="⌕" title={diag.dbExists ? '暂时无法读取会话库' : '没有找到当前支持的会话库'} hint={diag.message} /> : <>
          <div className="grid cols-4" style={{ marginBottom: 20 }}><Stat k="会话总数" v={diag.total} /><Stat k="当前供应商标识" v={<span style={{ fontSize: 16 }}>{diag.currentProvider || '官方 / 未设置'}</span>} /><Stat k="标识不同的会话" v={diag.mismatch} /><Stat k="抽样文件缺失" v={diag.missingRollouts} /></div>
          <div className="notice"><Ico name="shield" /><span>供应商标识不同可能影响历史列表。调整可见性不会修复缺失文件，也不能保证加密上下文跨账号继续对话。</span></div>
          <div className="row wrap" style={{ marginBottom: 16, gap: 9 }}><Btn disabled={!!busy || !diag.mismatch || !diag.currentProvider} onClick={() => setConfirmRepair(true)}>查看可见性调整方案</Btn>{diag.byProvider.map(p => <span key={p.provider} className={`chip ${p.provider === diag.currentProvider ? 'ok' : ''}`}>{p.provider || '未设置'} · {p.count}</span>)}</div>
          <div className="scroll-y" style={{ maxHeight: 380 }}><table className="tbl"><thead><tr><th>会话标题</th><th>供应商标识</th><th>更新时间</th><th>检查结果</th></tr></thead><tbody>{diag.samples.map(s => <tr key={s.id}><td className="ellipsis" style={{ maxWidth: 380 }} title={s.title}>{s.title}</td><td className="mono">{s.provider || '未设置'}</td><td>{s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '—'}</td><td><span className={`chip ${s.missing ? 'bad' : s.provider === diag.currentProvider ? 'ok' : 'warn'}`}>{s.missing ? '文件缺失' : s.provider === diag.currentProvider ? '标识一致' : '标识不同'}</span></td></tr>)}</tbody></table></div>
          <p className="hint" style={{ marginTop: 14, overflowWrap: 'anywhere' }}>数据库：{diag.dbPath}</p>
        </>}
        {repairResult && <div className="notice" style={{ marginTop: 14 }}><div>{repairResult.message}{repairResult.backup && <p style={{ overflowWrap: 'anywhere' }}>备份位置：{repairResult.backup}</p>}</div></div>}
      </div>}
      {tab === 'advanced' && <>
        <div className="card" style={{ marginBottom: 18 }}><div className="card-title">Codex 配置<span className="sub">显式保存 · 备份原文件 · 重启后生效</span></div>
          <div className="notice">参数是否支持取决于 Codex 版本和当前模型。留空表示移除覆盖值，使用客户端默认设置。</div>
          {errors['codex.flags'] && <div className="notice warning">{errors['codex.flags']}</div>}
          <div className="grid cols-2">{flags?.schema.map(f => <Field key={f.key} label={f.label} hint={f.hint}><div className="row" style={{ gap: 8 }}>{f.type === 'enum' || f.type === 'bool' ? <select className="select grow" value={flagDrafts[f.key] || ''} onChange={e => setFlagDrafts({ ...flagDrafts, [f.key]: e.target.value })}><option value="">使用默认设置</option>{(f.type === 'bool' ? ['true', 'false'] : f.options || []).map(o => <option key={o} value={o}>{o}</option>)}</select> : <input className="input mono grow" inputMode="numeric" value={flagDrafts[f.key] || ''} onChange={e => setFlagDrafts({ ...flagDrafts, [f.key]: e.target.value })} placeholder="使用默认设置" />}<Btn size="sm" disabled={!!busy || (flagDrafts[f.key] || '') === (flags.flags[f.key] || '')} onClick={() => saveFlag(f)}>保存</Btn></div></Field>)}</div>
        </div>
        <details className="card"><summary style={{ cursor: 'pointer', fontWeight: 600 }}>实验性桌面增强</summary><p className="hint" style={{ margin: '13px 0' }}>依赖 Codex 桌面的调试接口与页面结构。官方更新后可能失效；此功能与供应商配置、会话阅读互相独立。</p>
          <Btn disabled={!!busy} onClick={inspectDesktop}><Ico name="search" size={13} /> 检测桌面兼容性</Btn>
          {inj && <><div className="row wrap" style={{ margin: '16px 0', gap: 8 }}><span className={`chip ${inj.installed ? 'ok' : 'warn'}`}>{inj.installed ? `已安装 ${inj.version || ''}` : '未检测到桌面版'}</span><span className="chip">{inj.running ? '运行中' : '未运行'}</span><span className="chip">{inj.debugPortOpen ? '调试接口可连接' : '调试接口未连接'}</span></div>{inj.message && <div className="notice warning">{inj.message}</div>}{inj.versionChanged && <div className="notice warning">检测到 Codex 版本变化，已有增强脚本需要重新验证。</div>}<div className="list">{scripts.map(s => <div className="list-row" key={s.id}><div className="grow"><strong>{s.name}</strong><div className="hint">{s.enabled ? '将在下次挂载时执行' : '当前停用'}</div></div><fieldset disabled={!!busy} style={{ border: 0, margin: 0, padding: 0 }}><Toggle title={`启用${s.name}`} on={!!s.enabled} onChange={async v => { const r = await perform(s.id, 'inject.saveScript', { script: { ...s, enabled: v } }, false); if (r) setScripts(r.scripts || []); }} /></fieldset></div>)}</div><div style={{ marginTop: 16 }}><Btn disabled={!!busy || !inj.installed || !scripts.some(s => s.enabled)} onClick={() => setConfirmInject(true)}>查看启动与挂载方式</Btn></div></>}
        </details>
      </>}
    </>}
    {editAgents !== null && <Modal title="AGENTS.md · 全局提示词" sub="写下团队约定、输出语言和常用命令。已有文件会先备份，作用范围由 Codex 的指令规则决定。" onClose={() => !busy && setEditAgents(null)} width={760} foot={<><Btn disabled={!!busy} onClick={() => setEditAgents(null)}>取消</Btn><Btn variant="primary" disabled={!!busy} onClick={async () => { if (await perform('prompt-save', 'codex.writeAgents', { text: editAgents })) setEditAgents(null); }}>保存提示词</Btn></>}><textarea className="textarea mono" style={{ minHeight: 320 }} value={editAgents} onChange={e => setEditAgents(e.target.value)} placeholder={'# 工作约定\n- 使用简体中文回答\n- 修改代码前先了解项目规范'} /></Modal>}
    {confirmRepair && diag && <Modal title="调整会话的供应商标识" sub="请先完全退出 Codex。将先备份数据库，再调整索引中的供应商标识。" onClose={() => !busy && setConfirmRepair(false)} foot={<><Btn disabled={!!busy} onClick={() => setConfirmRepair(false)}>取消</Btn><Btn variant="primary" disabled={!!busy} onClick={async () => { const r = await perform('repair', 'codex.repairSessions', {}); if (r) { setRepairResult(r); setConfirmRepair(false); } }}>{busy === 'repair' ? '正在备份与调整…' : '备份并调整标识'}</Btn></>}><p>预计将 {diag.mismatch} 条会话记录的供应商标识调整为 <strong>{diag.currentProvider}</strong>。</p><div className="notice warning" style={{ marginTop: 16 }}>这会修改会话数据库。它只针对列表可见性，不迁移加密摘要、不补回丢失文件，也不保证跨供应商续聊成功。</div></Modal>}
    {confirmInject && <Modal title="启动并挂载桌面增强" sub="将使用远程调试参数启动 Codex，然后运行当前已启用的本地增强脚本。" onClose={() => !busy && setConfirmInject(false)} foot={<><Btn disabled={!!busy} onClick={() => setConfirmInject(false)}>取消</Btn><Btn disabled={!!busy} onClick={async () => { if (await perform('inject', 'inject.run', {}, false)) { setConfirmInject(false); await inspectDesktop(); } }}>启动并挂载</Btn></>}><p style={{ color: 'var(--text-2)' }}>请保存当前工作。是否可以连接和挂载取决于已安装的 Codex 版本；失败时可继续使用客户端接入和历史会话功能。</p></Modal>}
  </>;
}
