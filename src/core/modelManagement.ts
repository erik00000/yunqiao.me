import { createHash } from 'node:crypto';
import type { AuroraStore, ProviderModel } from './store/index.js';
import { nowIso, newId } from './util.js';
import { isValidContextWindow } from './modelContext.js';

type Selection = { providerId: string; modelId: string };
const key = (p: string, m: string) => JSON.stringify([p, m]);

export function manageModels(store: AuroraStore, payload: any, apply = false) {
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 20000) throw new Error('请选择要管理的模型');
  if (!['delete', 'update'].includes(payload.operation)) throw new Error('不支持的批量操作');
  const items: Selection[] = payload.items;
  if (items.some(item => !item || typeof item.providerId !== 'string' || !item.providerId || typeof item.modelId !== 'string' || !item.modelId)) throw new Error('模型选择格式无效，请刷新列表后重试');
  const selected = new Set(items.map(i => key(i.providerId, i.modelId)));
  const providers = store.listProviders();
  const groups = store.listGroups();
  const agents = store.listAgents();
  const affected = providers.flatMap(p => p.models.filter(m => selected.has(key(p.id, m.id))).map(m => ({ providerId: p.id, providerName: p.name, model: m })));
  if (affected.length !== selected.size) throw new Error('所选模型已变化，请刷新列表后重试');
  const conflicts: string[] = [];
  const patch: Partial<ProviderModel> = {};
  if (payload.operation === 'delete') {
    const referencesSelection = (providerId: string, reference: string) => {
      const bound = providers.find(p => p.id === providerId);
      // An upstream ID may itself contain slashes. Exact bound-provider IDs come first.
      if (bound?.models.some(m => m.id === reference)) return selected.has(key(providerId, reference));
      const slash = reference.indexOf('/');
      if (slash > 0) {
        const prefix = reference.slice(0, slash), model = reference.slice(slash + 1);
        const resolved = providers.find(p => p.id === prefix || p.name.toLowerCase() === prefix.toLowerCase() || p.presetId?.toLowerCase() === prefix.toLowerCase());
        if (resolved) return selected.has(key(resolved.id, model));
      }
      return selected.has(key(providerId, reference));
    };
    for (const a of Object.values(agents)) {
      if ((!a.connected && !a.pendingReapply) || !a.providerId) continue;
      const references = [a.model || providers.find(p => p.id === a.providerId)?.models[0]?.id, ...Object.values(a.modelMap || {})];
      for (const model of references) if (model && referencesSelection(a.providerId, model)) conflicts.push(`客户端 ${a.id} 正在使用 ${model}，请先更换配置或角色映射`);
    }
    for (const g of groups) for (const member of g.members) {
      const p = providers.find(p => p.id === member.providerId);
      const model = member.model || p?.models[0]?.id;
      if (model && selected.has(key(member.providerId, model))) conflicts.push(`路由分组「${g.name}」引用了 ${model}，请先修改分组`);
    }
  } else {
    const input = payload.patch || {};
    for (const field of ['contextWindow', 'maxOutput', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice'] as const) {
      if (input[field] !== undefined) {
        if (field === 'contextWindow' && !isValidContextWindow(input[field])) throw new Error('上下文必须是正安全整数');
        if (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || input[field] < 0) throw new Error(`${field} 应为非负数字`);
        patch[field] = input[field];
      }
    }
    if (input.capabilities) {
      patch.capabilities = {};
      for (const cap of ['tools', 'vision', 'thinking'] as const) if (typeof input.capabilities[cap] === 'boolean') patch.capabilities[cap] = input.capabilities[cap];
    }
    if (!Object.keys(patch).length || (Object.keys(patch).length === 1 && patch.capabilities && !Object.keys(patch.capabilities).length)) throw new Error('请至少选择一项要更新的属性');
  }
  const revision = createHash('sha256').update(JSON.stringify({ affected, groups, agents, operation: payload.operation, patch })).digest('hex');
  const emptied = payload.operation === 'delete' ? providers.filter(p => p.models.length && p.models.every(m => selected.has(key(p.id, m.id)))).map(p => p.name) : [];
  if (!apply) return { ok: true, revision, count: affected.length, conflicts: [...new Set(conflicts)], emptied };
  if (payload.revision !== revision) return { ok: false, message: '模型或引用关系已变化，请重新预览' };
  if (conflicts.length) return { ok: false, message: [...new Set(conflicts)].join('；') };
  const backupId = newId('models_', 8);
  store.writeExtra(`${backupId}.json`, { createdAt: nowIso(), operation: payload.operation, models: affected });
  const next = providers.map(p => {
    if (!p.models.some(m => selected.has(key(p.id, m.id)))) return p;
    const models = payload.operation === 'delete' ? p.models.filter(m => !selected.has(key(p.id, m.id))) : p.models.map(m => selected.has(key(p.id, m.id)) ? { ...m, ...patch, capabilities: { ...m.capabilities, ...patch.capabilities } } : m);
    return { ...p, models, enabled: models.length ? p.enabled : false, updatedAt: nowIso() };
  });
  store.providers.write(next);
  return { ok: true, count: affected.length, backupId, message: `已${payload.operation === 'delete' ? '删除' : '更新'} ${affected.length} 条模型记录${emptied.length ? `，空供应商已停用：${emptied.join('、')}` : ''}` };
}
