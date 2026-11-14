import React, { useEffect, useMemo, useState } from 'react';
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

export default function Providers({ state, reload }: PageProps) {
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<Provider> | null>(null);
  const [query, setQuery] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, any>>({});
  const [presetQuery, setPresetQuery] = useState('');
  const [cloud, setCloud] = useState<{ open: boolean; loading: boolean; data: any; picked: Set<string> }>({
    open: false,
    loading: false,
    data: null,
    picked: new Set(),
  });

  useEffect(() => { if (window.location.hash.includes('cloud')) openCloud(); }, []);

  async function openCloud() {
    setCloud((c) => ({ ...c, open: true, loading: true }));
    try {
      const r = await call('cloud.catalog', {});
      if (!r.ok) throw new Error(r.message ?? '拉取失败');
      setCloud({ open: true, loading: false, data: r, picked: new Set() });
    } catch (e: any) {
      toast.push('云端目录拉取失败：' + e.message, 'bad');
      setCloud((c) => ({ ...c, loading: false }));
    }
  }

  async function importPicked() {
    const data = cloud.data;
    if (!data) return;
    const items = data.providers.filter((p: any) => cloud.picked.has(p.key));
    if (!items.length) return toast.push('先选几个供应商', 'bad');
    const r = await call('cloud.import', { providers: items });
    await reload();
    setCloud((c) => ({ ...c, open: false }));
    toast.push(`导入完成：新增 ${r.added} 家，合并 ${r.merged} 家`, 'ok');
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
    await reload();
    const r = await call('provider.models', { providerId: saved.id });
    await reload();
    return { ...r, providerId: saved.id };
  }

  async function save(p: Partial<Provider>) {
    try {
    const saved = await call('provider.save', p);
    await reload();
    toast.push('供应商已保存', 'ok');
    setEditing(null);
    // 有 Key 就顺手把模型列表拉回来，省得手动点
    const hasKey = (saved.apiKeys ?? []).some((k: any) => k.key);
    if (saved?.id && hasKey && state.settings.autoSyncModels) {
      try {
        const r = await call('provider.models', { providerId: saved.id });
        if (r.ok && r.added > 0) {
          await reload();
          toast.push(`已自动同步 ${r.added} 个模型`, 'ok');
        }
      } catch {
        /* 拉不到就算了，不影响保存 */
      }
    }
    } catch (e: any) { toast.push(e.message || '保存失败', 'bad'); }
  }

  async function test(p: Provider) {
    setTesting(p.id);
    try {
      const r = await call('provider.test', { providerId: p.id });
      setTestResult((s) => ({ ...s, [p.id]: r }));
      toast.push(r.ok ? `连通正常 ${r.latencyMs}ms` : `失败：${r.message}`, r.ok ? 'ok' : 'bad');
    } finally {
      setTesting(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>我的供应商</h1>
          <p>管理 API 地址、密钥与可用模型。同一家厂商可以添加多个供应商配置。</p>
        </div>
        <div className="actions">
          <input
            className="input"
            style={{ width: 190 }}
            placeholder="搜索名称 / 模型 / 地址"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Btn disabled={!window.aurora} onClick={openCloud}>
            <Ico name="cloud" size={13} /> 云端目录
          </Btn>
          <Btn variant="primary" disabled={!window.aurora} onClick={() => setEditing(EMPTY_PROVIDER())}>
            <Ico name="plus" size={13} /> 添加供应商
          </Btn>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="card">
          <Empty
            icon="🔌"
            title="还没有供应商"
            hint="点右上角「添加供应商」，从预设里挑一家（DeepSeek、Kimi、GLM、OpenAI、Claude、Gemini…），填 Key 就能用。"
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
                  onChange={async (v) => {
                    await call('provider.save', { id: p.id, enabled: v });
                    await reload();
                  }}
                />
              </div>

              <div className="row wrap" style={{ gap: 6 }}>
                <span className="chip">{PROTOCOL_TEXT[p.format]}</span>
                <span className="chip">{p.models.length} 个模型</span>
                <span className="chip">{p.apiKeys.filter((k) => k.key || (k as any).hasKey).length} 个 Key</span>
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

              <div className="row" style={{ marginTop: 'auto' }}>
                <Btn size="sm" disabled={testing === p.id} onClick={() => test(p)}>
                  <Ico name="bolt" size={12} />
                  {testing === p.id ? '测试中…' : '测试'}
                </Btn>
                <Btn
                  size="sm"
                  onClick={async () => {
                    const r = await call('provider.models', { providerId: p.id });
                    await reload();
                    toast.push(
                      r.ok ? `已同步模型，新增 ${r.added ?? 0} 个` : r.message ?? '同步失败',
                      r.ok ? 'ok' : 'bad',
                    );
                  }}
                >
                  <Ico name="refresh" size={12} /> 同步模型
                </Btn>
                <div style={{ flex: 1 }} />
                <Btn size="sm" variant="ghost" disabled={!window.aurora} onClick={() => setEditing(p)}>
                  编辑
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  disabled={!window.aurora}
                  onClick={async () => {
                    if (!confirm(`删除供应商「${p.name}」？`)) return;
                    await call('provider.delete', { id: p.id });
                    await reload();
                  }}
                >
                  <Ico name="trash" size={12} />
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}

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
              ? `版本 v${cloud.data.version} · 更新于 ${cloud.data.updatedAt?.slice(0, 16).replace('T', ' ')} · 共 ${cloud.data.providers.length} 家`
              : '正在从云端拉取供应商列表…'
          }
          onClose={() => setCloud((c) => ({ ...c, open: false }))}
          width={880}
          foot={
            <>
              <Btn
                variant="ghost"
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
              <Btn variant="ghost" onClick={() => setCloud((c) => ({ ...c, open: false }))}>
                关闭
              </Btn>
              <Btn variant="primary" disabled={cloud.loading || !cloud.picked.size} onClick={importPicked}>
                导入选中的 {cloud.picked.size} 家
              </Btn>
            </>
          }
        >
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
  onSave: (v: Partial<Provider>) => void;
}) {
  const set = (patch: Partial<Provider>) => onChange({ ...value, ...patch });
  const [fetching, setFetching] = useState(false);
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
      onClose={onClose}
      width={860}
      foot={
        <>
          <Btn variant="ghost" onClick={onClose}>
            取消
          </Btn>
          <Btn variant="primary" onClick={() => onSave(value)}>
            保存
          </Btn>
        </>
      }
    >
      <Field label="预设库">
        <input
          className="input"
          placeholder="搜索：deepseek / kimi / glm / openai / claude / 中转…"
          value={presetQuery}
          onChange={(e) => setPresetQuery(e.target.value)}
          style={{ marginBottom: 8 }}
        />
        <div className="preset-grid">
          {presets.map((p) => (
            <div
              key={p.id}
              className={`preset-item ${value.presetId === p.id ? 'on' : ''}`}
              onClick={() => applyPreset(p)}
            >
              <span style={{ color: p.color }}>{p.icon}</span>
              <span className="ellipsis">{p.nameZh || p.name}</span>
            </div>
          ))}
        </div>
      </Field>

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
                placeholder="deepseek-chat"
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
                placeholder="128000"
                title="上下文窗口（tokens）。超出这个长度会被自动裁剪，或直接报错"
                value={m.contextWindow ?? 0}
                onChange={(e) => {
                  const next = [...(value.models ?? [])];
                  next[i] = { ...m, contextWindow: Number(e.target.value) };
                  set({ models: next });
                }}
              />
              <input
                className="input"
                type="number"
                step="0.01"
                placeholder="0.27"
                title="输入价：每百万 token 多少美元"
                value={m.inputPrice ?? 0}
                onChange={(e) => {
                  const next = [...(value.models ?? [])];
                  next[i] = { ...m, inputPrice: Number(e.target.value) };
                  set({ models: next });
                }}
              />
              <input
                className="input"
                type="number"
                step="0.01"
                placeholder="1.10"
                title="输出价：每百万 token 多少美元"
                value={m.outputPrice ?? 0}
                onChange={(e) => {
                  const next = [...(value.models ?? [])];
                  next[i] = { ...m, outputPrice: Number(e.target.value) };
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
                setFetching(true);
                try {
                  const r = await onFetchModels({ ...value, models: value.models ?? [] });
                  if (r?.providerId) set({ id: r.providerId, models: r.models || value.models });
                  onToast(r?.ok ? `已拉取 ${r.models.length} 个模型` : (r?.message ?? "这家没有公开模型列表"), r?.ok ? "ok" : "bad");
                } catch (e: any) { onToast(e.message || '拉取失败', 'bad'); } finally {
                  setFetching(false);
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
                    { id: '', contextWindow: 128000, inputPrice: 0, outputPrice: 0, capabilities: { tools: true } } as ProviderModel,
                  ],
                })
              }
            >
              <Ico name="plus" size={12} /> 添加模型
            </Btn>
            <span className="hint">
              拉取前会先保存供应商。模型上下文与价格是本地元数据，实际能力以上游服务为准。
            </span>
          </div>
        </div>
      </Field>

      {value.notes && <div className="chip warn" style={{ height: 'auto', padding: '6px 10px' }}>{value.notes}</div>}
    </Modal>
  );
}





