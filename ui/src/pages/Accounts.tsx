import React, { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Ico, useToast } from '../components/ui';
import { LocalAccount, call } from '../lib/api';
const ACCOUNTS = [
  { kind: 'claude', name: 'Claude', mark: '✳', hint: '在 Claude Code 中运行 /login 完成官方登录。', url: 'https://claude.ai/download' },
  { kind: 'chatgpt', name: 'ChatGPT / Codex', mark: '◎', hint: '在 Codex 中登录 ChatGPT，或运行 codex login。', url: 'https://chatgpt.com/codex' },
  { kind: 'copilot', name: 'GitHub Copilot', mark: '⌘', hint: '在你的编辑器中登录 GitHub Copilot。', url: 'https://github.com/features/copilot' },
];
export default function Accounts({ go }: PageProps) {
  const [accounts, setAccounts] = useState<LocalAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  async function scan() { setLoading(true); try { const r = await call('account.scan', {}); setAccounts(r.accounts || []); } catch (e: any) { toast.push(e.message, 'bad'); } finally { setLoading(false); } }
  useEffect(() => { scan(); }, []);
  return <>
    <div className="page-head"><div><div className="eyebrow">LOCAL ACCOUNTS</div><h1>本地账号</h1><p>查看当前电脑上的客户端登录记录。登录与续期由各官方客户端管理。</p></div><div className="actions"><Btn disabled={loading} onClick={scan}><Ico name="refresh" size={14} />{loading ? '检测中…' : '重新检测'}</Btn></div></div>
    <div className="grid cols-3">{ACCOUNTS.map(meta => {
      const found = accounts.find(a => a.kind === meta.kind && a.found);
      return <div className="card" key={meta.kind}><div className="row"><span className="client-mark" style={{ color: 'var(--accent)', background: 'var(--bg)' }}>{meta.mark}</span><div className="grow"><b>{meta.name}</b><div style={{ marginTop: 5 }}><span className={`chip ${found ? 'ok' : ''}`}>{found ? '发现登录记录' : '未检测到记录'}</span></div></div></div><p style={{ color: 'var(--text-2)', lineHeight: 1.9, minHeight: 50, marginTop: 20 }}>{found?.note || meta.hint}</p>{found?.email && <p className="muted">{found.email}</p>}<Btn size="sm" onClick={() => call('app.openExternal', { url: meta.url })}>打开官网 ↗</Btn></div>;
    })}</div>
    <div className="notice" style={{ marginTop: 24 }}><Ico name="shield" size={21} /><div><b>订阅账号与 API 服务分开管理</b><p>发现登录文件不代表订阅仍有效。使用官方订阅请在对应客户端登录；使用自定义模型请在「我的供应商」中填写 API Key。订阅登录令牌不会被转换成通用 API Key。</p></div></div>
    <div className="card"><div className="card-title">切换连接方式</div><p className="muted">如果客户端已经通过云桥连接了第三方服务，可以在客户端接入页恢复原配置，再回到官方客户端登录。</p><div className="row"><Btn variant="primary" onClick={() => go('agents')}>管理客户端连接</Btn><Btn onClick={() => go('providers')}>管理 API 供应商</Btn></div></div>
  </>;
}
