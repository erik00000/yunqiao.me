import React, { useEffect, useMemo, useRef, useState } from 'react';
import PresetPicker from '../components/PresetPicker';
import { LocalIdentityCard, LocalScanDetails, localTime, useLocalClientScan } from '../components/LocalClients';
import type { PageProps } from '../App';
import { Btn, Empty, Field, Ico, Modal, Toggle, useToast } from '../components/ui';
import {
  ApiKey,
  Provider,
  ProviderModel,
  PROTOCOL_TEXT,
  Preset,
  call,
  fmtCtx,
  fmtCost,
  maskKey,
} from '../lib/api';

const EMPTY_PROVIDER = (): Partial<Provider> => ({
  name: '',
  format: 'openai-chat',
  baseUrl: '',
  apiKeys: [{ id: 'k' + Date.now(), label: '默认', key: '', enabled: true, weight: 1 }],
  models: [],
  enabled: true,
  priority: 10,
  rateMultiplier: 1,
});

export default function Providers({ state, reload, go }: PageProps) {
  const toast = useToast();
  const scan = useLocalClientScan(reload);
  const snapshot = state.localClients;
  const [editing, setEditing] = useState<Partial<Provider> | null>(null);
  const [query, setQuery] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, any>>({});
  const [modelSyncErrors, setModelSyncErrors] = useState<Record<string, string>>({});
  const [operationError, setOperationError] = useState('');
  const [mutating, setMutating] = useState<string | null>(null);
  const mutation = useRef(false);
  const [presetQuery, setPresetQuery] = useState('');
  const cloudRequest = useRef(0);
  const [cloud, setCloud] = useState<{ open: boolean; loading: boolean; importing: boolean; error: string; data: any; picked: Set<string> }>({
    open: false,
    loading: false,
    importing: false,
    error: '',
    data: null,
    picked: new Set(),
  });

  useEffect(() => { if (window.location.hash.includes('cloud')) openCloud(); }, []);

  function openCloud() { setCloud(c => ({ ...c, open: true, error: '', picked: new Set() })); }
  function closeCloud() {
    if (cloud.importing) return;
    cloudRequest.current++;
    setCloud(c => ({ ...c, open: false, loading: false }));
  }
  async function loadCloud(refresh = false) {
    const request = ++cloudRequest.current;
    setCloud((c) => ({ ...c, loading: true, error: '' }));
    try {
      const r = await call('cloud.catalog', { refresh });
      if (request !== cloudRequest.current) return;
      if (!r.ok) throw new Error(r.message ?? '拉取失败');
      setCloud(c => ({ ...c, loading: false, data: r, picked: new Set([...c.picked].filter(key => r.providers.some((p: any) => p.key === key))) }));
      if (refresh) await reload();
    } catch (e: any) {
      if (request === cloudRequest.current) setCloud((c) => ({ ...c, loading: false, error: '云端目录拉取失败：' + e.message }));
    }
  }
  useEffect(() => {
    if (cloud.open) void loadCloud();
    return () => { cloudRequest.current++; };
  }, [cloud.open, state.catalog?.version, state.catalog?.fetchedAt, state.catalog?.source, state.catalog?.syncing, state.catalog?.warning]);

  async function importPicked() {
    if (cloud.importing || cloud.loading) return;
    const data = cloud.data;
    if (!data) return;
    const items = data.providers.filter((p: any) => cloud.picked.has(p.key));
    if (!items.length) return toast.push('先选几个供应商', 'bad');
    setCloud(c => ({ ...c, importing: true, error: '' }));
    try {
      const r = await call('cloud.import', { providers: items });
      if (!r.ok) throw new Error(r.message || '导入失败，请重试');
      await reload();
      cloudRequest.current++;
      setCloud((c) => ({ ...c, open: false }));
      toast.push(`导入完成：新增 ${r.added} 家，合并 ${r.merged} 家`, 'ok');
    } catch (e: any) { setCloud(c => ({ ...c, error: e.message || '导入失败，请重试' })); }
    finally { setCloud(c => ({ ...c, importing: false })); }
  }

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.providers;
    return state.providers.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.baseUrl.toLowerCase().includes(q) ||
        p.models.some((m) => m.id.toLowerCase().includes(q)),
    );
  }, [state.providers, query]);

  const identities = (snapshot?.accounts || []).filter(account => account.authKind === 'oauth' && (!query.trim() || `${account.label} ${account.kind} ${account.email || ''}`.toLowerCase().includes(query.trim().toLowerCase())));

  const presets = useMemo(() => {
    const q = presetQuery.trim().toLowerCase();
    const apiPresets = state.presets.filter(p => p.region !== 'subscription');
    if (!q) return apiPresets;
    return apiPresets.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.nameZh.includes(presetQuery) ||
        p.vendor.includes(presetQuery),
    );
  }, [state.presets, presetQuery]);

  async function fetchModelsFromUpstream(p: Partial<Provider>) {
    const saved = await call('provider.save', p);
    setEditing(current => current ? { ...current, id: saved.id } : current);
    let r: any;
    try { r = await call('provider.models', { providerId: saved.id }); }
    catch (e: any) { r = { ok: false, message: e.message || '模型同步失败' }; }
    await reload();
    return { ...r, providerId: saved.id };
  }

  async function save(p: Partial<Provider>) {
    const saved = await call('provider.save', p);
    setEditing(current => current ? { ...current, id: saved.id } : current);
    await reload();
    toast.push('供应商已保存', 'ok');
    setEditing(null);
    setModelSyncErrors(errors => ({ ...errors, [saved.id]: '' }));
    // 有 Key 就顺手把模型列表拉回来，省得手动点
    const hasKey = (saved.apiKeys ?? []).some((k: ApiKey) => k.enabled !== false && (k.key || k.hasKey));
    if (saved?.id && hasKey) {
      try {
        const r = await call('provider.models', { providerId: saved.id });
        if (!r.ok) throw new Error(r.message || '无法读取模型列表，请稍后重试');
        if (r.added > 0) {
          await reload();
          toast.push(`已自动同步 ${r.added} 个模型`, 'ok');
        }
      } catch (e: any) {
        setModelSyncErrors(errors => ({ ...errors, [saved.id]: `供应商已保存，但模型同步失败：${e.message || '请稍后重试'}` }));
      }
    }
  }

  async function mutate(id: string, task: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; setMutating(id); setOperationError('');
    try { await task(); } catch (e: any) { setOperationError(e.message || '操作未完成，请重试'); }
    finally { mutation.current = false; setMutating(null); }
  }

  async function test(p: Provider) {
    setTesting(p.id);
    try {
      const r = await call('provider.test', { providerId: p.id });
      setTestResult((s) => ({ ...s, [p.id]: r }));
      toast.push(r.ok ? `连通正常 ${r.latencyMs}ms` : `失败：${r.message}`, r.ok ? 'ok' : 'bad');
    } catch (e: any) {
      setTestResult(s => ({ ...s, [p.id]: { ok: false, message: e.message || '测试连接失败' } }));
      toast.push(e.message || '测试连接失败', 'bad');
    } finally {
      setTesting(null);
    }
  }

  return (
    <>
      {operationError && <div className="notice warning" role="alert">{operationError}</div>}
      <div className="page-head provider-page-head">
        <div>
          <h1>我的供应商</h1>
          <p>已有客户端的 API 配置会自动发现。官方登录单独保留，供应商可继续编辑与切换。</p>
        </div>
        <div className="actions">
          <input
            className="input"
            style={{ width: 190 }}
            placeholder="搜索供应商 / 模型 / 账号"
            aria-label="搜索供应商或本地账号"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Btn disabled={!window.aurora || !!scan.busy} onClick={scan.scan}><Ico name="refresh" size={13} />{scan.busy ? '扫描中…' : '重新扫描本机'}</Btn>
          <Btn disabled={!window.aurora || !!mutating} onClick={openCloud}>
            <Ico name="cloud" size={13} /> 云端目录
          </Btn>
          <Btn variant="primary" disabled={!window.aurora || !!mutating} onClick={() => setEditing(EMPTY_PROVIDER())}>
            <Ico name="plus" size={13} /> 添加供应商
          </Btn>
        </div>
      </div>

      {scan.error && <div className="notice warning" role="alert">{scan.error}</div>}
      {identities.length > 0 && <section className="local-identities"><div className="section-heading"><h2>本机官方账号</h2><span>由对应客户端保管登录凭据</span></div><div className="grid cols-3">{identities.map(account => <LocalIdentityCard key={account.id} kind={account.kind} account={account} compact onManage={() => go('agents')} />)}</div></section>}
      <div className="section-heading"><h2>API 供应商 <span className="chip">{list.length}</span></h2><span>最近扫描：{localTime(snapshot?.checkedAt)}</span></div>
      {list.length === 0 ? (
        <div className="card">
          <Empty
            icon="🔌"
            title={query ? '没有匹配的供应商' : '还没有 API 供应商'}
            hint={query ? '试试供应商名称、模型 ID 或接口地址。' : '重新扫描已有客户端配置，或从右上角添加供应商。官方账号会独立保留在本地账号中。'}
          />
        </div>
      ) : (
        <div className="grid cols-3">
          {list.map((p) => (
            <div
              key={p.id}
              className="card provider-card"
              style={{ ['--pc' as any]: `linear-gradient(90deg, ${p.color ?? '#6d8cff'}, transparent)` }}
            >
              <div className="top">
                <div className="avatar" style={{ color: p.color }}>
                  {p.icon ?? '◆'}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="name">
                    <span className="ellipsis">{p.name}</span>
                    {p.official && <span className="chip">官方渠道</span>}
                    {!p.enabled && <span className="chip">已停用</span>}
                  </div>
                  <div className="meta mono">{p.baseUrl.replace(/^https?:\/\//, '')}</div>
                </div>
                <Toggle
                  on={p.enabled}
                  title={`启用供应商 ${p.name}`}
                  disabled={!!mutating}
                  onChange={(v) => mutate(p.id, async () => {
                    const result = await call('provider.save', { id: p.id, enabled: v });
                    if (result?.ok === false) throw new Error(result.message || '供应商状态保存失败');
                    await reload();
                  })}
                />
              </div>

              {!!snapshot?.sources.some(source => source.providerId === p.id) && <div className="provider-origin"><Ico name="download" size={13} /><span>自动发现</span>{snapshot.sources.filter(source => source.providerId === p.id).map(source => <span key={source.id} className="chip" title={`${source.label}\n${source.path}`}>{source.label}</span>)}</div>}
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="chip">{PROTOCOL_TEXT[p.format]}</span>
                <span className="chip">{p.models.length} 个模型</span>
                <span className="chip">{p.apiKeys.filter((k) => k.key || k.hasKey).length} 个 Key</span>
                {p.rateMultiplier && p.rateMultiplier !== 1 && <span className="chip">×{p.rateMultiplier}</span>}
              </div>

              <div className="tag-list">
                {p.models.slice(0, 3).map((m) => (
                  <span key={m.id} className="chip" title={m.id}>
                    {m.id.length > 22 ? m.id.slice(0, 20) + '…' : m.id}
                    <span style={{ opacity: 0.55 }}>{fmtCtx(m.contextWindow)}</span>
                  </span>
                ))}
                {p.models.length > 3 && <span className="chip">+{p.models.length - 3}</span>}
              </div>

              {testResult[p.id] && (
                <div className="mono" style={{ fontSize: 10.5, color: testResult[p.id].ok ? 'var(--ok)' : 'var(--danger)' }}>
                  {testResult[p.id].message}
                </div>
              )}
              {modelSyncErrors[p.id] && <div className="notice warning" role="alert" style={{ display: 'block', overflowWrap: 'anywhere' }}>
                <p>{modelSyncErrors[p.id]}</p>
                {window.aurora ? <button className="text-button" onClick={() => setEditing(p)}>手动添加模型</button> : <p>可在电脑桌面端编辑供应商，手动添加模型。</p>}
              </div>}

              <div className="row" style={{ marginTop: 'auto' }}>
                <Btn size="sm" disabled={testing === p.id} onClick={() => test(p)}>
                  <Ico name="bolt" size={12} />
                  {testing === p.id ? '测试中…' : '测试'}
                </Btn>
                <Btn
                  size="sm"
                  onClick={async () => {
                    try {
                      const r = await call('provider.models', { providerId: p.id });
                      if (!r.ok) throw new Error(r.message || '同步失败，请稍后重试');
                      await reload();
                      setModelSyncErrors(errors => ({ ...errors, [p.id]: '' }));
                      toast.push(`已同步模型，新增 ${r.added ?? 0} 个`, 'ok');
                    } catch (e: any) {
                      setModelSyncErrors(errors => ({ ...errors, [p.id]: `模型同步失败：${e.message || '请稍后重试'}` }));
                    }
                  }}
                >
                  <Ico name="refresh" size={12} /> 同步模型
                </Btn>
                <div style={{ flex: 1 }} />
                <Btn size="sm" variant="ghost" disabled={!window.aurora || !!mutating} onClick={() => setEditing(p)}>
                  编辑
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  disabled={!window.aurora || !!mutating}
                  title={`删除供应商 ${p.name}`}
                  onClick={() => {
                    if (!confirm(`删除供应商「${p.name}」？`)) return;
                    void mutate(p.id, async () => { const result = await call('provider.delete', { id: p.id }); if (result?.ok === false) throw new Error(result.message || '删除失败'); await reload(); });
                  }}
                >
                  <Ico name="trash" size={12} />
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      <LocalScanDetails snapshot={snapshot} busy={scan.busy} onRestore={scan.restore} />
      {editing && (
        <ProviderEditor
          value={editing}
          presets={presets}
          presetQuery={presetQuery}
          setPresetQuery={setPresetQuery}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={save}
          onFetchModels={fetchModelsFromUpstream}
        />
      )}

      {cloud.open && (
        <Modal
          title="云端目录"
          sub={
            cloud.data
              ? `${cloud.data.source === 'remote' ? '官方目录' : cloud.data.source === 'cache' ? '本地缓存' : '离线预设'} · 版本 v${cloud.data.version} · 共 ${cloud.data.providers.length} 家`
              : '正在从云端拉取供应商列表…'
          }
          onClose={closeCloud}
          width={880}
          foot={
            <>
              <Btn
                variant="ghost"
                disabled={cloud.loading || cloud.importing}
                onClick={() =>
                  setCloud((c) => ({
                    ...c,
                    picked: new Set(
                      c.picked.size === (c.data?.providers?.length ?? 0)
                        ? []
                        : (c.data?.providers ?? []).map((p: any) => p.key),
                    ),
                  }))
                }
              >
                {cloud.picked.size === (cloud.data?.providers?.length ?? 0) ? '取消全选' : '全选'}
              </Btn>
              <div style={{ flex: 1 }} />
              <Btn disabled={cloud.loading || cloud.importing} onClick={() => loadCloud(true)}><Ico name="refresh" size={13} />刷新目录</Btn>
              <Btn variant="ghost" disabled={cloud.importing} onClick={closeCloud}>
                关闭
              </Btn>
              <Btn variant="primary" disabled={cloud.loading || cloud.importing || !cloud.picked.size} onClick={importPicked}>
                {cloud.importing ? '正在导入…' : `导入选中的 ${cloud.picked.size} 家`}
              </Btn>
            </>
          }
        >
          {cloud.error && <div className="notice warning" role="alert">{cloud.error}</div>}
          {cloud.data?.warning && <div className="notice warning">{cloud.data.warning}</div>}
          {cloud.data?.syncing && <p className="hint">正在后台更新官方目录…</p>}
          {cloud.loading && <div style={{ color: 'var(--muted)', padding: 24 }}>正在连接云端…</div>}
          {cloud.data && (
            <div className="cloud-grid">
              {cloud.data.providers.map((p: any) => {
                const on = cloud.picked.has(p.key);
                return (
                  <div
                    key={p.key}
                    className={`cloud-item ${on ? 'on' : ''}`}
                    onClick={() => {
                      if (cloud.loading || cloud.importing) return;
                      const next = new Set(cloud.picked);
                      on ? next.delete(p.key) : next.add(p.key);
                      setCloud((c) => ({ ...c, picked: next }));
                    }}
                  >
                    <div className="av" style={{ color: p.color }}>
                      {p.icon ?? '◆'}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="ellipsis" style={{ fontWeight: 600 }}>
                        {p.name}
                      </div>
                      <div className="ellipsis" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                        {p.vendor} · {(p.models ?? []).length} 个模型
                      </div>
                    </div>
                    {on && <span className="chip ok">已选</span>}
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function ProviderEditor({
  value,
  presets,
  presetQuery,
  setPresetQuery,
  onChange,
  onClose,
  onSave,
  onFetchModels,
}: {
  value: Partial<Provider>;
  presets: Preset[];
  presetQuery: string;
  setPresetQuery: (s: string) => void;
  onChange: (v: Partial<Provider>) => void;
  onClose: () => void;
  onFetchModels: (v: Partial<Provider>) => Promise<any>;
  onSave: (v: Partial<Provider>) => Promise<void>;
}) {
  const set = (patch: Partial<Provider>) => onChange({ ...value, ...patch });
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const busy = fetching || saving;
  const onToast = useToast().push;
  const keys = value.apiKeys ?? [];

  function applyPreset(p: Preset) {
    onChange({
      ...value,
      presetId: p.id,
      name: p.nameZh || p.name,
      format: p.format,
      baseUrl: p.baseUrl,
      color: p.color,
      icon: p.icon,
      models: p.models,
      official: p.official,
      notes: p.note,
    });
  }

  return (
    <Modal
      title={value.id ? '编辑供应商' : '添加供应商'}
      sub="先选预设（自动填好协议、地址、模型与价格），再填 Key。"
      onClose={() => !running.current && onClose()}
      width={860}
      foot={
        <>
          <Btn variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Btn>
          <Btn variant="primary" disabled={busy} onClick={async () => {
            if (running.current) return;
            running.current = true; setSaving(true); setError('');
            try { await onSave(value); } catch (e: any) { setError(e.message || '保存失败，请重试'); }
            finally { running.current = false; setSaving(false); }
          }}>
            {saving ? '保存中…' : '保存'}
          </Btn>
        </>
      }
    >
      {error && <div className="notice warning" role="alert">{error}</div>}
      <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <Field label="官方厂商目录" hint="启动时自动同步并缓存，与客户端接入共用同一份目录。"><PresetPicker presets={presets} value={value.presetId} onChange={p => p ? applyPreset(p) : onChange({ ...EMPTY_PROVIDER(), id: value.id })} /></Field>

      <div className="grid cols-2">
        <Field label="显示名称">
          <input className="input" value={value.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="上游协议" hint="决定网关用什么格式和它说话；选错一般报 404/405">
          <select className="select" value={value.format} onChange={(e) => set({ format: e.target.value as any })}>
            <option value="openai-chat">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic">Anthropic Messages</option>
            <option value="gemini">Gemini Native</option>
          </select>
        </Field>
      </div>

      <Field label="Base URL" hint="填写服务商文档中的 API 基础地址，不要填写完整的聊天请求路径。">
        <input
          className="input mono"
          value={value.baseUrl ?? ''}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="https://api.deepseek.com"
        />
      </Field>

      <div className="grid cols-2">
        <Field label="优先级" hint="数字越大越优先；同名模型会先走高的">
          <input
            className="input"
            type="number"
            value={value.priority ?? 10}
            onChange={(e) => set({ priority: Number(e.target.value) })}
          />
        </Field>
        <Field label="计费倍率" hint="中转站常见 0.1 ~ 1，用于费用估算">
          <input
            className="input"
            type="number"
            step="0.01"
            value={value.rateMultiplier ?? 1}
            onChange={(e) => set({ rateMultiplier: Number(e.target.value) })}
          />
        </Field>
      </div>

      <Field label="API 密钥" hint="支持多 Key 轮换，某个 Key 限流会自动冷却并切下一个">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {keys.map((k, i) => (
            <div className="row" key={k.id}>
              <input
                className="input"
                style={{ width: 120 }}
                value={k.label}
                onChange={(e) => {
                  const next = [...keys];
                  next[i] = { ...k, label: e.target.value };
                  set({ apiKeys: next });
                }}
              />
              <input
                className="input mono"
                placeholder="sk-..."
                type="password"
                autoComplete="off"
                value={k.key}
                onChange={(e) => {
                  const next = [...keys];
                  next[i] = { ...k, key: e.target.value };
                  set({ apiKeys: next });
                }}
              />
              <Toggle
                on={k.enabled}
                onChange={(v) => {
                  const next = [...keys];
                  next[i] = { ...k, enabled: v };
                  set({ apiKeys: next });
                }}
              />
              <Btn
                size="sm"
                variant="ghost"
                onClick={() => set({ apiKeys: keys.filter((_, j) => j !== i) })}
              >
                <Ico name="x" size={12} />
              </Btn>
            </div>
          ))}
          <Btn
            size="sm"
            onClick={() =>
              set({
                apiKeys: [
                  ...keys,
                  { id: 'k' + Date.now(), label: `Key ${keys.length + 1}`, key: '', enabled: true, weight: 1 } as ApiKey,
                ],
              })
            }
          >
            <Ico name="plus" size={12} /> 再加一个 Key
          </Btn>
        </div>
      </Field>

      <div className="grid cols-2">
        <Field label="单独代理（可选）" hint="只对这家供应商生效，例如 http://127.0.0.1:7890">
          <input className="input mono" value={value.proxy ?? ''} onChange={(e) => set({ proxy: e.target.value })} />
        </Field>
        <Field label="备注">
          <input className="input" value={value.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>

      <Field label={`模型列表（${(value.models ?? []).length}）`}>
        <div className="model-table">
          <div className="model-head">
            <span>模型 ID（发给上游的名字）</span>
            <span>
              上下文窗口
              <a
                style={{ cursor: "pointer", color: "var(--accent)", marginLeft: 6, fontWeight: 400 }}
                onClick={() => {
                  const v = prompt("把全部模型的上下文窗口统一改成多少？", "272000");
                  if (!v) return;
                  const n = Number(v);
                  if (!n || n < 1000) return alert("请输入合理数字，例如 272000");
                  set({ models: (value.models ?? []).map((m) => ({ ...m, contextWindow: n })) });
                }}
              >
                批量
              </a>
            </span>
            <span>输入价 $/M</span>
            <span>输出价 $/M</span>
            <span />
          </div>
          {(value.models ?? []).map((m, i) => (
            <div className="model-row" key={i}>
              <input
                className="input mono"
                placeholder="模型 API ID"
                value={m.id}
                onChange={(e) => {
                  const next = [...(value.models ?? [])];
                  next[i] = { ...m, id: e.target.value };
                  set({ models: next });
                }}
              />
              <input
                className="input"
                type="number"
                placeholder="待确认"
                title="上下文窗口（tokens）。超出这个长度会被自动裁剪，或直接报错"
                value={m.contextWindow ?? ''}
                onChange={(e) => {
                  const next = [...(value.models ?? [])];
                  next[i] = { ...m, contextWindow: e.target.value.trim() ? Number(e.target.value) : undefined };
                  set({ models: next });
                }}
              />
              <input
                className="input"
                type="number"
                step="0.01"
                placeholder="待确认"
                title="输入价：每百万 token 多少美元"
                value={m.inputPrice ?? ''}
                onChange={(e) => {
                  const next = [...(value.models ?? [])];
                  next[i] = { ...m, inputPrice: e.target.value.trim() ? Number(e.target.value) : undefined };
                  set({ models: next });
                }}
              />
              <input
                className="input"
                type="number"
                step="0.01"
                placeholder="待确认"
                title="输出价：每百万 token 多少美元"
                value={m.outputPrice ?? ''}
                onChange={(e) => {
                  const next = [...(value.models ?? [])];
                  next[i] = { ...m, outputPrice: e.target.value.trim() ? Number(e.target.value) : undefined };
                  set({ models: next });
                }}
              />
              <Btn
                size="sm"
                variant="ghost"
                title="删除这一行"
                onClick={() => set({ models: (value.models ?? []).filter((_, j) => j !== i) })}
              >
                <Ico name="x" size={12} />
              </Btn>
            </div>
          ))}
          <div className="model-actions">
            <Btn
              size="sm"
              variant="danger"
              onClick={() => {
                const n = (value.models ?? []).length;
                if (!n) return;
                if (confirm(`清空 ${n} 个模型？清空后可以点「从上游拉取」重新获取`)) set({ models: [] });
              }}
            >
              清空
            </Btn>
            <Btn
              size="sm"
              onClick={async () => {
                if (running.current) return;
                running.current = true; setFetching(true); setError('');
                try {
                  const r = await onFetchModels({ ...value, models: value.models ?? [] });
                  if (r?.providerId) set({ id: r.providerId, models: r.models || value.models });
                  if (!r?.ok) setError(`供应商已保存，但模型同步失败：${r?.message || '请稍后重试'}`);
                  onToast(r?.ok ? `已拉取 ${r.models.length} 个模型` : (r?.message ?? "这家没有公开模型列表"), r?.ok ? "ok" : "bad");
                } catch (e: any) { setError(e.message || '拉取失败'); } finally {
                  running.current = false; setFetching(false);
                }
              }}
            >
              <Ico name="refresh" size={12} /> {fetching ? "拉取中…" : "从上游拉取"}
            </Btn>
            <Btn
              size="sm"
              onClick={() =>
                set({
                  models: [
                    ...(value.models ?? []),
                    { id: '' } as ProviderModel,
                  ],
                })
              }
            >
              <Ico name="plus" size={12} /> 添加模型
            </Btn>
            <span className="hint">
              拉取前会先保存供应商。上下文和价格留空表示待确认，0 表示已确认免费；实际能力与计费以上游服务为准。
            </span>
          </div>
        </div>
      </Field>

      </fieldset>
      {value.notes && <div className="chip warn" style={{ height: 'auto', padding: '6px 10px' }}>{value.notes}</div>}
    </Modal>
  );
}





