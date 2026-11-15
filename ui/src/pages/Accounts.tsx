import React from 'react';
import type { PageProps } from '../App';
import { Btn, Ico } from '../components/ui';
import { LocalIdentityCard, LocalScanDetails, LOCAL_ACCOUNT_META, localTime, useLocalClientScan } from '../components/LocalClients';
import type { LocalAccount } from '../lib/api';

export default function Accounts({ state, reload, go }: PageProps) {
  const snapshot = state.localClients;
  const accounts = (snapshot?.accounts || []).filter(account => account.authKind === 'oauth');
  const scan = useLocalClientScan(reload);
  return <>
    <div className="page-head"><div><div className="eyebrow">LOCAL ACCOUNTS</div><h1>本地账号</h1><p>保留客户端中的官方登录。这里显示本地记录，实际账号与订阅状态以官方客户端为准。</p></div><div className="actions"><Btn disabled={!window.aurora || !!scan.busy} onClick={scan.scan}><Ico name="refresh" size={14} />{scan.busy ? '扫描中…' : '重新扫描本机'}</Btn></div></div>
    {scan.error && <div className="notice warning" role="alert">{scan.error}</div>}
    {!window.aurora && <div className="notice">当前显示电脑最近一次扫描结果。重新扫描和配置管理请在电脑端完成。</div>}
    <div className="section-heading"><h2>官方客户端身份</h2><span>最近扫描：{localTime(snapshot?.checkedAt)}</span></div>
    <div className="grid cols-3">{(Object.keys(LOCAL_ACCOUNT_META) as LocalAccount['kind'][]).flatMap(kind => {
      const found = accounts.filter(account => account.kind === kind);
      return found.length ? found.map(account => <LocalIdentityCard key={account.id} kind={kind} account={account} onManage={() => go('agents')} />) : [<LocalIdentityCard key={kind} kind={kind} scanned={!!snapshot} onManage={() => go('agents')} />];
    })}</div>
    <div className="notice" style={{ marginTop: 22 }}><Ico name="shield" size={21} /><div><b>官方账号与 API 供应商可以分别保留</b><p>官方登录凭据由客户端管理，不转换成网关 API Key。在客户端接入页管理官方连接和已配置的 API 服务，切换方式由该客户端的实际能力决定。</p></div></div>
    <div className="card"><div className="card-title">管理客户端连接方式</div><p className="muted">在同一处查看官方连接、第三方供应商及当前生效配置，预览后再应用。</p><div className="row wrap"><Btn variant="primary" onClick={() => go('agents')}>管理官方与 API 连接</Btn><Btn onClick={() => go('providers')}>查看 API 供应商</Btn></div></div>
    <LocalScanDetails snapshot={snapshot} busy={scan.busy} onRestore={scan.restore} />
  </>;
}
