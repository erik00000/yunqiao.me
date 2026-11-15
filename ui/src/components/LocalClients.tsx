import React, { useState } from 'react';
import { Btn, Ico, useToast } from './ui';
import { call, type LocalAccount, type LocalClientSource, type LocalClientsSnapshot } from '../lib/api';

export const LOCAL_ACCOUNT_META: Record<LocalAccount['kind'], { name: string; mark: string; hint: string; url: string }> = {
  claude: { name: 'Claude', mark: '✳', hint: '登录与凭据续期由 Claude 官方客户端管理。', url: 'https://claude.ai/download' },
  chatgpt: { name: 'ChatGPT / Codex', mark: '◎', hint: '在 ChatGPT 桌面版或 Codex CLI 中管理官方登录。', url: 'https://chatgpt.com/codex' },
  copilot: { name: 'GitHub Copilot', mark: '⌘', hint: '在编辑器中管理 GitHub Copilot 登录。', url: 'https://github.com/features/copilot' },
  gemini: { name: 'Gemini', mark: '✦', hint: '在 Gemini CLI 中管理 Google 官方登录。', url: 'https://geminicli.com/docs/get-started/authentication/' },
};

const CREDENTIAL_STATUS = {
  present: { label: '已检测到凭据', tone: '', hint: '仅检查本地凭据，未在线验证账号或订阅。' },
  expired: { label: '凭据已过期', tone: 'warn', hint: '本地凭据已超过记录的到期时间，请在官方客户端续期或重新登录。' },
  'record-only': { label: '仅有登录记录', tone: '', hint: '发现账号记录，尚未读取到可判断状态的登录凭据。' },
  unknown: { label: '状态待确认', tone: '', hint: '本地信息不足，实际登录与订阅状态以官方客户端为准。' },
};

export function localTime(value?: string): string {
  if (!value) return '尚未扫描';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function LocalIdentityCard({ kind, account, scanned = true, compact = false, onManage }: {
  kind: LocalAccount['kind']; account?: LocalAccount; scanned?: boolean; compact?: boolean; onManage: () => void;
}) {
  const meta = LOCAL_ACCOUNT_META[kind];
  const status = CREDENTIAL_STATUS[account?.credentialStatus || (account?.found ? 'record-only' : 'unknown')];
  return <article className={`card local-identity-card ${compact ? 'compact' : ''}`}>
    <div className="row"><span className="client-mark">{meta.mark}</span><div className="grow"><b>{meta.name}</b><div className="tag-list"><span className="chip">官方账号</span><span className={`chip ${account ? status.tone : ''}`}>{account ? status.label : scanned ? '未发现登录记录' : '尚未扫描'}</span></div></div></div>
    {account?.email && <p className="identity-account" title={account.email}>{account.email}</p>}
    <p className="identity-explanation">{account ? status.hint : meta.hint}</p>
    {account?.note && !compact && <p className="hint">{account.note}</p>}
    {account?.plan && <p className="hint">本地方案记录：{account.plan} · 未在线验证</p>}
    {account?.expiresAt && <p className="hint">凭据到期时间：{localTime(account.expiresAt)}</p>}
    {account?.source && <div className="identity-source"><span>本地来源</span><code title={account.source}>{account.source}</code></div>}
    <div className="row wrap identity-actions"><Btn size="sm" onClick={onManage}>管理客户端连接 <Ico name="ext" size={12} /></Btn>{!compact && <button className="text-button" onClick={() => call('app.openExternal', { url: meta.url })}>官方登录入口 ↗</button>}</div>
  </article>;
}

const SOURCE_STATUS: Record<LocalClientSource['status'], string> = {
  imported: '已自动添加', updated: '已同步更新', unchanged: '与已保存配置一致', linked: '已关联供应商', modified: '保留手动修改',
  ignored: '已忽略此来源', 'missing-key': '未读取到 API Key', unsupported: '暂未识别此配置', 'missing-file': '未发现配置文件',
};

export function LocalScanDetails({ snapshot, busy, onRestore }: {
  snapshot?: LocalClientsSnapshot; busy: string; onRestore: (sourceId: string) => void;
}) {
  if (!snapshot) return null;
  return <details className="local-scan-details" open={!snapshot.ok || undefined}>
    <summary><Ico name="search" size={14} />本机扫描详情<span className="hint">{snapshot.sources.length} 个来源 · {localTime(snapshot.checkedAt)}</span></summary>
    {!!snapshot.warnings?.length && <div className="notice warning">{snapshot.warnings.join('；')}</div>}
    <div className="list">{snapshot.sources.map(source => <div className="list-row local-source-row" key={source.id}>
      <div className="grow"><div className="row wrap"><b>{source.label}</b><span className={`chip ${['missing-key', 'unsupported'].includes(source.status) ? 'warn' : ''}`}>{SOURCE_STATUS[source.status] || '状态待确认'}</span></div><code className="local-source-path" title={source.path}>{source.path}</code>{source.message && <p className="hint">{source.message}</p>}</div>
      {source.status === 'ignored' && source.canRestore === true && <Btn size="sm" disabled={!window.aurora || !!busy} onClick={() => onRestore(source.id)}>{busy === source.id ? '重新导入中…' : '重新导入此来源'}</Btn>}
    </div>)}</div>
  </details>;
}

export function useLocalClientScan(reload: () => Promise<void>) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  async function run(sourceId?: string) {
    if (busy || !window.aurora) return;
    setBusy(sourceId || 'scan'); setError('');
    try {
      const result = await call<LocalClientsSnapshot>(sourceId ? 'localClients.restore' : 'localClients.scan', sourceId ? { sourceId } : {});
      await reload();
      if (!result.ok) throw new Error(result.warnings?.join('；') || '本机配置扫描未完成，请重试');
      toast.push(`${sourceId ? '已重新扫描此来源' : '扫描完成'}：新增 ${result.added} 家，更新 ${result.updated} 家供应商`, 'ok');
    } catch (e: any) {
      setError(e.message || '扫描失败，已保留当前列表');
      try { await reload(); } catch { /* Keep the last visible list if state cannot be read. */ }
    }
    finally { setBusy(''); }
  }
  return { busy, error, scan: () => run(), restore: (sourceId: string) => run(sourceId) };
}
