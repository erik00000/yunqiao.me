import fs from 'node:fs';
import path from 'node:path';
import type { AuroraStore } from './store/index.js';
import type { AgentState } from './store/types.js';
import { atomicWrite, readText, digest, type PlannedFile } from './agents/configFiles.js';
import { detectReset } from './agents/adapters.js';
import { createHistoryRepairService } from './historyRepair.js';
import { historyContext, historyLocation, normalizeHistoryContext, type HistoryContext } from './historyRepairIO.js';
import { recoverClientHistorySwitches, runClientHistorySwitch, type ClientHistorySwitchSnapshot, type ClientHistoryBackup } from './clientHistorySwitch.js';

export const CODEX_STATE_IDS = ['codex-cli', 'chatgpt-desktop', 'codex-desktop'] as const;
interface Deps { store: AuroraStore; dataDir: string; historyContext?: HistoryContext }
type StateSlice = Record<string, AgentState | null>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const identity = (value: unknown) => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.keys(entry).filter(key => key !== 'lastSyncAt').sort().map(key => [key, entry[key]]));
});
const slice = (states: Record<string, AgentState>): StateSlice => Object.fromEntries(CODEX_STATE_IDS.map(id => [id, states[id] ?? null]));
function validateSlice(value: unknown): asserts value is StateSlice {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...CODEX_STATE_IDS].sort().join()
    || CODEX_STATE_IDS.some(id => (value as StateSlice)[id] !== null && (!(value as StateSlice)[id] || (value as StateSlice)[id]?.id !== id)))
    throw new Error('客户端连接记录无法校验');
}
export const clientHistoryContext = (deps: Deps) => normalizeHistoryContext(deps.historyContext ?? historyContext());
export function clientConnectionRevision(deps: Deps): string {
  return digest(JSON.stringify([deps.store.providers.revision(deps.store.providers.read()), deps.store.settings.revision(deps.store.settings.read()), identity(slice(deps.store.readAgentSnapshot().states))]));
}
const trusted = (configurationText?: string, onPrepared?: (info: ClientHistoryBackup) => Promise<void>, reservation?: ClientHistoryBackup) => ({
  ...(configurationText === undefined ? {} : { configurationText }), backupAll: true, includeSubagents: true, requireAll: true,
  ...(reservation ? { backupId: reservation.backupId } : {}),
  ...(onPrepared ? { lockHeld: true, onPrepared } : {}),
});

/** Only the action layer supplies the unredacted adapter plan. No renderer options are trusted. */
export async function prepareClientHistory(deps: Deps, configurationText: string) {
  const ctx = clientHistoryContext(deps);
  const plan = await createHistoryRepairService(ctx, trusted(configurationText)).preview({ scope: 'all', fixPaths: true });
  if (!plan.ok || !('summary' in plan)) return { ok: false as const, message: plan.message || '无法核验历史对话，未修改客户端配置' };
  const summary = plan.summary;
  const backupRequired = summary.scanned > 0 || plan.dbPaths.length > 0;
  return { ok: true as const, ctx, revision: plan.revision, configurationText, history: {
    total: summary.scanned, repairable: summary.repairable, unchanged: summary.unchanged, blocked: summary.blocked,
    backupRequired, requiresClientExit: true,
    message: summary.blocked ? `有 ${summary.blocked} 个历史会话需要检查，尚未更改配置。`
      : backupRequired ? `将自动备份全部 ${summary.scanned} 个历史会话及索引，并修复 ${summary.repairable} 个会话的归属。`
        : '未发现已有历史会话，可直接应用配置。',
    warnings: [...plan.warnings, ...plan.items.filter(item => item.status === 'blocked').slice(0, 5).map(item => `${item.id}：${item.reason}`)],
  } };
}
export type PreparedClientHistory = Extract<Awaited<ReturnType<typeof prepareClientHistory>>, { ok: true }>;

function recoveryOptions(deps: Deps) {
  const ctx = clientHistoryContext(deps);
  const validate = (snapshot: ClientHistorySwitchSnapshot) => {
    validateSlice(snapshot.stateBefore); validateSlice(snapshot.stateAfter);
    const key = (file: string) => { const canonical = historyLocation(file); return process.platform === 'win32' ? canonical.toLowerCase() : canonical; };
    const allowed = new Set([key(path.join(ctx.home, 'config.toml')), key(path.join(deps.dataDir, 'codex-model-catalog.json'))]);
    if (snapshot.files.some(file => !allowed.has(key(file.path)))) throw new Error('配置恢复路径无法校验');
    const fresh = deps.store.readAgentSnapshot(), current = slice(fresh.states);
    for (const id of CODEX_STATE_IDS) {
      if (identity(current[id]) !== identity(snapshot.stateBefore[id]) && identity(current[id]) !== identity(snapshot.stateAfter[id]))
        throw new Error('客户端连接记录已经变化，已保留外部修改');
    }
    return fresh;
  };
  return {
    ctx, dataDir: deps.dataDir,
    createHistoryService: (onPrepared: (info: ClientHistoryBackup) => Promise<void>) => createHistoryRepairService(ctx, trusted(undefined, onPrepared)),
    revalidateRecovery: (snapshot: ClientHistorySwitchSnapshot) => { validate(snapshot); },
    rollbackConfig: async (snapshot: ClientHistorySwitchSnapshot) => {
      validate(snapshot);
      for (const file of [...snapshot.files].reverse()) {
        const exists = fs.existsSync(file.path), content = readText(file.path);
        if (exists === file.existed && content === file.before) continue;
        if (exists !== (file.afterExisted !== false) || content !== file.after) throw new Error('配置已经变化，已保留外部修改');
        if (file.existed) atomicWrite(file.path, file.before, { existed: exists, content });
        else if (exists) fs.unlinkSync(file.path);
      }
      const fresh = validate(snapshot), before = snapshot.stateBefore as StateSlice;
      if (identity(slice(fresh.states)) !== identity(before)) {
        const restored = { ...fresh.states };
        for (const id of CODEX_STATE_IDS) { if (before[id] === null) delete restored[id]; else restored[id] = before[id]!; }
        deps.store.agents.writeIfUnchanged(restored, fresh.revision);
      }
      return { ok: true };
    },
  };
}

export async function recoverClientHistory(deps: Deps) {
  return recoverClientHistorySwitches(recoveryOptions(deps));
}

/** History, client configuration, model catalog and shared connection state commit together. */
export async function applyClientHistory<T extends { ok: boolean; message: string; backup?: string }>(deps: Deps, options: {
  prepared: PreparedClientHistory;
  files: Array<PlannedFile & { afterExisted?: boolean }>;
  commit: () => T;
  states: (result: T) => AgentState[];
  revalidate: () => void;
}) {
  const { prepared } = options, initial = deps.store.readAgentSnapshot(), stateBefore = clone(slice(initial.states));
  const recovery = recoveryOptions(deps);
  let committed: T | undefined;
  const switched = await runClientHistorySwitch({
    ...recovery, ctx: prepared.ctx,
    snapshot: { files: options.files, stateBefore, stateAfter: stateBefore },
    historyRevision: prepared.revision, historyInput: { scope: 'all', fixPaths: true },
    createHistoryService: (onPrepared, reservation) => createHistoryRepairService(prepared.ctx, trusted(prepared.configurationText, onPrepared, reservation)),
    revalidate: () => {
      if (identity(slice(deps.store.readAgentSnapshot().states)) !== identity(stateBefore)) throw new Error('连接状态在处理期间发生变化');
      options.revalidate();
    },
    commit: async control => {
      committed = options.commit();
      if (!committed.ok) return committed;
      const fresh = deps.store.readAgentSnapshot();
      if (identity(slice(fresh.states)) !== identity(stateBefore)) throw new Error('连接状态在处理期间发生变化');
      const states = options.states(committed), after = { ...fresh.states };
      for (const state of states) after[state.id] = { ...after[state.id], ...state };
      control.setStateAfter(clone(slice(after)));
      deps.store.saveAgentsIfUnchanged(states, fresh);
      return committed;
    },
  });
  detectReset();
  if (!switched.ok) return { ok: false, code: switched.code, message: switched.message,
    ...(committed?.backup ? { backup: committed.backup } : {}), rolledBack: switched.rolledBack,
    recoveryRequired: switched.recoveryRequired, ...(switched.journalPath ? { recoveryPath: switched.journalPath } : {}) };
  return { ...switched.result!, history: {
    backedUp: prepared.history.total, repaired: prepared.history.repairable, unchanged: prepared.history.unchanged,
    backupId: switched.history?.backupId, backupPath: switched.history?.backup,
    message: switched.history?.message || '历史备份与修复已完成。',
  } };
}

export function historyPreviewRevision(clientRevision: string | undefined, prepared: PreparedClientHistory, connectionRevision: string): string {
  return digest(JSON.stringify({ clientRevision, historyRevision: prepared.revision, connectionRevision }));
}
