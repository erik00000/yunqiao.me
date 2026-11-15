import React, { useRef, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Field, Ico, Modal, Toggle, useToast } from '../components/ui';
import { MODE_TEXT, RouteMode, RoutingGroup, call } from '../lib/api';

export default function Groups({ state, reload }: PageProps) {
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<RoutingGroup> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);

  async function run(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { await task(); } catch (e: any) { setError(e.message || '操作未完成，请重试'); }
    finally { running.current = false; setBusy(false); }
  }

  async function save(g: Partial<RoutingGroup>) {
    const saved = await call('group.save', g);
    if (saved?.ok === false) throw new Error(saved.message || '分组保存失败');
    setEditing(current => current && saved?.id ? { ...current, id: saved.id } : current);
    await reload();
    setEditing(null);
    toast.push('分组已保存', 'ok');
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>路由分组</h1>
          <p>把几家供应商打包成一个模型名，客户端只认 group/分组名，网关按策略挑人。</p>
        </div>
        <div className="actions">
          <Btn
            variant="primary"
            disabled={!window.aurora || busy}
            onClick={() => { setError(''); setEditing({ name: '', mode: 'order', members: [], enabled: true, retries: 2 }); }}
          >
            <Ico name="plus" size={13} /> 新建分组
          </Btn>
        </div>
      </div>

      {!window.aurora && <div className="notice">当前为只读远程视图，路由分组请在桌面端管理。</div>}
      {error && !editing && <div className="notice warning" role="alert">{error}</div>}
      {state.groups.length === 0 ? (
        <div className="card">
          <Empty
            icon="🛣️"
            title="还没有路由分组"
            hint="把多家提供合适模型的 API 供应商放入同一组，按顺序或权重路由。需要在客户端使用 group/分组名 才会生效。"
          />
        </div>
      ) : (
        <div className="grid cols-2">
          {state.groups.map((g) => (
            <div className="card" key={g.id}>
              <div className="card-title">
                <span className="mono">group/{g.name}</span>
                <span className="chip accent">{MODE_TEXT[g.mode]}</span>
                <span className="sub">
                  {g.members.length} 个成员
                  <Toggle
                    title={`启用分组 ${g.name}`}
                    disabled={!window.aurora || busy}
                    on={g.enabled}
                    onChange={(v) => run(async () => {
                      const result = await call('group.save', { id: g.id, enabled: v });
                      if (result?.ok === false) throw new Error(result.message || '分组状态保存失败');
                      await reload();
                    })}
                  />
                </span>
              </div>
              <div className="list">
                {g.members.map((m, i) => {
                  const p = state.providers.find((x) => x.id === m.providerId);
                  return (
                    <div key={i} className="list-row">
                      <span className="chip">{i + 1}</span>
                      <div className="grow">
                        <div>{p ? `${p.icon} ${p.name}` : '（已删除的供应商）'}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                          {m.model ?? p?.models[0]?.id ?? '—'}
                        </div>
                      </div>
                      <span className="chip">权重 {m.weight}</span>
                    </div>
                  );
                })}
                {g.members.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>没有成员</div>}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <Btn size="sm" disabled={!window.aurora || busy} onClick={() => { setError(''); setEditing(g); }}>
                  编辑
                </Btn>
                <div style={{ flex: 1 }} />
                <Btn
                  size="sm"
                  variant="ghost"
                  title={`删除分组 ${g.name}`}
                  disabled={!window.aurora || busy}
                  onClick={() => {
                    if (!confirm(`删除分组「${g.name}」？`)) return;
                    void run(async () => { const result = await call('group.delete', { id: g.id }); if (result?.ok === false) throw new Error(result.message || '删除失败'); await reload(); });
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
        <Modal
          title={editing.id ? '编辑分组' : '新建分组'}
          sub="客户端把模型名写成 group/分组名 就会走这个组。"
          onClose={() => !running.current && setEditing(null)}
          foot={
            <>
              <Btn variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                取消
              </Btn>
              <Btn variant="primary" disabled={busy} onClick={() => run(() => save(editing))}>
                {busy ? '保存中…' : '保存'}
              </Btn>
            </>
          }
        >
          {error && <div className="notice warning" role="alert">{error}</div>}
          <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <div className="grid cols-2">
            <Field label="分组名" hint="只能英文/数字/短横线，客户端会拼成 group/名字">
              <input
                className="input mono"
                aria-label="分组名"
                value={editing.name ?? ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="coding"
              />
            </Field>
            <Field label="策略">
              <select
                className="select"
                value={editing.mode}
                onChange={(e) => setEditing({ ...editing, mode: e.target.value as RouteMode })}
              >
                {(Object.keys(MODE_TEXT) as RouteMode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_TEXT[m]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="成员（按顺序；权重越大被选中概率越高）">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(editing.members ?? []).map((m, i) => (
                <div className="row" key={i}>
                  <select
                    className="select"
                    style={{ width: 190 }}
                    value={m.providerId}
                    onChange={(e) => {
                      const next = [...(editing.members ?? [])];
                      next[i] = { ...m, providerId: e.target.value, model: null };
                      setEditing({ ...editing, members: next });
                    }}
                  >
                    <option value="">选择供应商</option>
                    {state.providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="select"
                    value={m.model ?? ''}
                    onChange={(e) => {
                      const next = [...(editing.members ?? [])];
                      next[i] = { ...m, model: e.target.value || null };
                      setEditing({ ...editing, members: next });
                    }}
                  >
                    <option value="">默认模型</option>
                    {(state.providers.find((p) => p.id === m.providerId)?.models ?? []).map((mm) => (
                      <option key={mm.id} value={mm.id}>
                        {mm.id}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    style={{ width: 70 }}
                    type="number"
                    value={m.weight}
                    onChange={(e) => {
                      const next = [...(editing.members ?? [])];
                      next[i] = { ...m, weight: Number(e.target.value) };
                      setEditing({ ...editing, members: next });
                    }}
                  />
                  <Btn
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditing({ ...editing, members: (editing.members ?? []).filter((_, j) => j !== i) })
                    }
                  >
                    <Ico name="x" size={12} />
                  </Btn>
                </div>
              ))}
              <Btn
                size="sm"
                onClick={() =>
                  setEditing({
                    ...editing,
                    members: [
                      ...(editing.members ?? []),
                      { providerId: state.providers[0]?.id ?? '', model: null, weight: 1 },
                    ],
                  })
                }
              >
                <Ico name="plus" size={12} /> 添加成员
              </Btn>
            </div>
          </Field>
          </fieldset>
        </Modal>
      )}
    </>
  );
}
