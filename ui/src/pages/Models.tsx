import React, { useMemo, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Ico, useToast } from '../components/ui';
import { ProviderModel, call, fmtCtx, fmtCost } from '../lib/api';

export default function Models({ state, reload, go }: PageProps) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(true);

  const rows = useMemo(() => {
    const out: Array<{ providerId: string; providerName: string; icon: string; color?: string; model: ProviderModel }> = [];
    for (const p of state.providers) {
      if (onlyEnabled && !p.enabled) continue;
      for (const m of p.models) out.push({ providerId: p.id, providerName: p.name, icon: p.icon ?? '◆', color: p.color, model: m });
    }
    const key = q.trim().toLowerCase();
    if (!key) return out;
    return out.filter((r) => r.model.id.toLowerCase().includes(key) || r.providerName.toLowerCase().includes(key));
  }, [state.providers, q, onlyEnabled]);

  async function patch(providerId: string, modelId: string, patchObj: Partial<ProviderModel>) {
    const p = state.providers.find((x) => x.id === providerId);
    if (!p) return;
    const models = p.models.map((m) => (m.id === modelId ? { ...m, ...patchObj } : m));
    await call('provider.save', { ...p, models });
    await reload();
  }

  const totalModels = state.providers.reduce((a, p) => a + p.models.length, 0);
  const uniqueModels = new Set(state.providers.flatMap((p) => p.models.map((m) => m.id))).size;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>模型管理</h1>
          <p>
            共 {totalModels} 条模型记录，去重后 {uniqueModels} 个模型。这里的能力与价格是可编辑的本地元数据。
          </p>
        </div>
        <div className="actions">
          <div className="seg">
            <button className={onlyEnabled ? 'on' : ''} onClick={() => setOnlyEnabled(true)}>
              只看已启用
            </button>
            <button className={!onlyEnabled ? 'on' : ''} onClick={() => setOnlyEnabled(false)}>
              全部
            </button>
          </div>
          <input
            className="input"
            style={{ width: 200 }}
            placeholder="搜索模型"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {!window.aurora && <div className="notice">远程控制台可查看模型。修改能力、价格和供应商配置请使用桌面端。</div>}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {rows.length === 0 ? (
          <Empty icon="🧊" title="还没有模型" hint="先到「供应商」页同步模型，或手动添加。" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 190 }}>供应商</th>
                <th>模型 ID</th>
                <th style={{ width: 96 }}>上下文</th>
                <th style={{ width: 84 }}>输入价</th>
                <th style={{ width: 84 }}>输出价</th>
                <th style={{ width: 180 }}>能力</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.providerId + r.model.id}>
                  <td>
                    <span style={{ color: r.color }}>{r.icon}</span> {r.providerName}
                  </td>
                  <td className="mono">{r.model.id}</td>
                  <td>{fmtCtx(r.model.contextWindow)}</td>
                  <td>{fmtCost(r.model.inputPrice)}</td>
                  <td>{fmtCost(r.model.outputPrice)}</td>
                  <td>
                    <div className="tag-list">
                      {(['tools', 'vision', 'thinking'] as const).map((cap) => {
                        const on = r.model.capabilities?.[cap];
                        const label = cap === 'tools' ? '工具' : cap === 'vision' ? '视觉' : '思考';
                        return (
                          <button
                            key={cap}
                            disabled={!window.aurora}
                            aria-pressed={!!on}
                            className={`chip ${on ? 'accent' : ''}`}
                            style={{ cursor: 'pointer' }}
                            onClick={() =>
                              patch(r.providerId, r.model.id, {
                                capabilities: { ...r.model.capabilities, [cap]: !on },
                              })
                            }
                          >
                            {label}
                          </button>
                        );
                      })}
                      {r.model.thinkingField && r.model.thinkingField !== 'none' && (
                        <span className="chip">{r.model.thinkingField}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <Btn size="sm" variant="ghost" disabled={!window.aurora} onClick={() => go('providers')} title="到供应商里编辑">
                      <Ico name="gear" size={12} />
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title">上下文窗口怎么填</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.85 }}>
          <p style={{ margin: '0 0 6px' }}>
            <b>上下文窗口</b>描述模型能够接收的输入规模；输出上限是另一个参数。修改本地数值不会扩大服务商的真实限制。
          </p>
          <p style={{ margin: 0 }}>
            价格以每百万 Token 的美元计价，用于估算费用。请根据服务商文档维护；需要裁剪上下文时可在插件中心配置对应规则。
          </p>
        </div>
      </div>
    </>
  );
}
