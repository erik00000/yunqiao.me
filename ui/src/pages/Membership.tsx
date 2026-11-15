import React, { useEffect, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Field, Ico, useToast } from '../components/ui';
import { call, fmtCost } from '../lib/api';

export default function Membership({ reload, go }: PageProps) {
  const [status, setStatus] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [code, setCode] = useState('');
  const [twoFactor, setTwoFactor] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const [groups, setGroups] = useState<any[]>([]);
  const [groupId, setGroupId] = useState<number | ''>('');
  const [loading, setLoading] = useState(false);
  const [statusKnown, setStatusKnown] = useState(false);
  const [groupError, setGroupError] = useState('');
  const loadSequence = useRef(0);
  const running = useRef(false);
  const toast = useToast();
  const desktop = !!window.aurora;
  function clearLogin(config = status?.config) {
    setStatus({ ok: true, loggedIn: false, config }); setGroups([]); setGroupId(''); setReceipt(null); setTwoFactor(null);
    setPassword(''); setAccessToken(''); setCode('');
  }
  async function load(options: { preserveError?: string } = {}) {
    const sequence = ++loadSequence.current;
    const preferredGroup = groupId;
    setLoading(true);
    try {
      const r = await call('member.status');
      if (sequence !== loadSequence.current) return;
      if (r?.loggedIn === false) clearLogin(r.config || status?.config);
      if (r?.ok === false) throw new Error(r.message || '会员状态暂不可读');
      setStatus(r); setStatusKnown(true); setError(options.preserveError || r.message || ''); setGroupError(''); setGroups([]); setGroupId('');
      if (r.loggedIn) {
        try {
          const g = await call('member.groups');
          if (sequence !== loadSequence.current) return;
          if (g?.authExpired || g?.loggedIn === false) { clearLogin(r.config); setError(g.message || '登录已过期，请重新登录。'); return; }
          if (!g.ok) throw new Error(g.message || '会员服务分组暂不可读');
          setGroups(g.groups || []); setGroupId(g.groups?.some((v: any) => v.id === preferredGroup && v.supported !== false) ? preferredGroup : g.groups?.find((v: any) => v.supported !== false)?.id ?? '');
        } catch (e: any) { if (sequence === loadSequence.current) setGroupError(e.message || '会员服务分组暂不可读'); }
      }
    } catch (e: any) { if (sequence === loadSequence.current) { setStatusKnown(false); setGroups([]); setGroupId(''); setError([options.preserveError, `状态确认失败：${e.message || '请稍后重试'}`].filter(Boolean).join('；')); } }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => { if (desktop) void load(); return () => { loadSequence.current++; }; }, []);
  async function perform(action: string, payload: any = {}) {
    if (running.current || loading) return;
    running.current = true; loadSequence.current++;
    setBusy(action); setError('');
    let expired = false;
    try {
      const result = await call(action, payload);
      if (result?.authExpired || result?.loggedIn === false) { expired = true; clearLogin(); setStatusKnown(true); }
      if (!result.ok) throw new Error(result.message || result.error || '操作未完成');
      if (result.requires2fa) { setTwoFactor(result); return; }
      if (action === 'member.login' || action === 'member.login2fa' || action === 'member.bind') { setPassword(''); setAccessToken(''); setCode(''); setTwoFactor(null); }
      if (action === 'member.claim') {
        setReceipt(result);
        // A confirmed receipt remains visible even if the following status or
        // group read fails. No inferred credit amount is written into state.
        setStatus((previous: any) => ({ ...previous, ...(result.member ? { member: result.member } : {}), ...(result.gift ? { gift: result.gift } : {}) }));
      }
      if (action === 'member.logout') { clearLogin(); setStatusKnown(true); setGroupError(''); }
      if (action === 'member.addProvider') {
        let models: any;
        try { models = await call('provider.models', { providerId: result.providerId }); }
        catch (e: any) { models = { ok: false, message: e.message }; }
        await reload(); toast.push(models.ok ? result.message : '供应商已添加，模型同步暂未成功，可在配置时手动填写。', models.ok ? 'ok' : 'bad'); go('agents'); return;
      }
      await load();
      if (result.message) toast.push(result.message, 'ok');
    } catch (e: any) {
      const message = e.message || '操作未完成'; setError(message);
      if (action === 'member.claim' || expired) {
        setStatusKnown(false);
        // A failed claim may already have reached the service. Only read its
        // status here; a further claim always requires another explicit click.
        await load({ preserveError: message });
      }
    }
    finally { running.current = false; setBusy(''); }
  }
  const gift = status?.gift || status?.data?.gift || {};
  const member = status?.member || status?.data?.member || {};
  const claimed = gift.status === 'claimed' || gift.status === 'completed' || gift.claimed || !!gift.claimedAt;
  const pending = gift.status === 'pending';
  return <>
    <div className="page-head"><div><div className="eyebrow">YUNQIAO.ME</div><h1>云桥会员</h1><p>绑定平台会员，在客户端领取新客额度，快速开始第一次对话。</p></div><Btn onClick={() => call('app.openExternal', { url: 'https://api.yunqiao.me' })}>打开平台网站 ↗</Btn></div>
    <div className="member-hero"><div className="member-gift-icon"><Ico name="bolt" size={30} /></div><div className="grow"><span className="eyebrow">WELCOME GIFT</span><h2>第一份灵感，我们请客。</h2><p>首次使用云桥客户端的会员，完成绑定后可领取平台额度。</p></div><div className="member-gift-value"><strong>$10</strong><span>新客平台额度</span></div></div>
    {!desktop ? <div className="notice">请在 Windows 桌面客户端登录并绑定本机，领取额度。</div> : <>
      {error && <div className="notice warning" role="alert">{error}<div className="grow" /><Btn size="sm" disabled={loading || !!busy} onClick={() => { void load(); }}>重试</Btn></div>}
      {status?.config?.enabled === false && <div className="notice">{status.config.message || '新客活动尚未开放，开放后可在此领取。'}</div>}
      <div className="grid cols-2">
        <div className="card"><div className="card-title">{status?.loggedIn ? '我的平台会员' : '登录并绑定本机'}</div>{status?.loggedIn ? <><h2>{member.email || member.username || '已登录会员'}</h2><p className="muted">平台余额 {fmtCost(typeof member.balance === 'number' ? member.balance : undefined)}</p><div className="notice"><Ico name="shield" /><span>已绑定当前客户端。登录凭据由操作系统加密保存，不进入配置导出。</span></div><Field label="选择平台服务分组" hint="不同分组提供不同模型与倍率，添加后自动读取该分组可用模型。"><select className="select" aria-label="会员服务分组" disabled={loading || !!busy} value={groupId} onChange={e => setGroupId(Number(e.target.value))}><option value="">选择服务分组</option>{groups.map(g => <option key={g.id} value={g.id} disabled={g.supported === false}>{g.name} · {g.platform}{g.supported === false ? ' · 暂需手动配置' : ''}{g.rateMultiplier ? ` · ${g.rateMultiplier} 倍` : ''}</option>)}</select></Field>{groupError && <div className="notice warning" role="alert">{groupError}<Btn size="sm" disabled={loading || !!busy} onClick={() => { void load({ preserveError: error }); }}>重试</Btn></div>}<div className="row"><Btn disabled={loading || !!busy} onClick={() => perform('member.logout')}>退出会员登录</Btn><Btn disabled={loading || !!busy || !groupId} variant="primary" onClick={() => perform('member.addProvider', { groupId })}>添加云桥供应商 →</Btn></div></> : <form onSubmit={e => { e.preventDefault(); void perform(twoFactor ? 'member.login2fa' : 'member.login', twoFactor ? { tempToken: twoFactor.tempToken, code } : { email, password }); }}>
          {twoFactor ? <><p>请输入 {twoFactor.emailMasked || '账号'} 的验证器动态码。</p><Field label="两步验证码"><input className="input" aria-label="会员两步验证码" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} /></Field></> : <><Field label="平台邮箱"><input className="input" type="email" aria-label="平台会员邮箱" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></Field><Field label="平台密码"><input className="input" type="password" aria-label="平台会员密码" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field></>}
          <button className="btn primary" type="submit" disabled={loading || !!busy || !status || status.config?.enabled === false}>{busy ? '处理中…' : twoFactor ? '验证并绑定' : '登录并绑定本机'}</button><p className="hint" style={{ marginTop: 16 }}>还没有账号？<button className="text-button" type="button" onClick={() => call('app.openExternal', { url: 'https://api.yunqiao.me/register' })}>前往平台注册 ↗</button></p>
          <details style={{ marginTop: 16 }}><summary>通过平台访问令牌绑定</summary><p className="hint">适用于已在平台登录、使用单点登录或需要网页验证的会员。使用平台账号访问令牌，不能使用模型 API Key。</p><Field label="账号访问令牌"><input className="input" type="password" aria-label="会员访问令牌" autoComplete="off" value={accessToken} onChange={e => setAccessToken(e.target.value)} /></Field><Btn disabled={loading || !!busy || !accessToken} onClick={() => perform('member.bind', { accessToken })}>验证并绑定</Btn></details>
        </form>}</div>
        <div className="card"><div className="card-title">新客额度<span className={`chip ${claimed ? 'ok' : ''}`}>{claimed ? '已到账' : !statusKnown ? '资格待确认' : pending ? '到账确认中' : gift.status === 'ineligible' ? '本机已领取' : gift.status === 'review' ? '需人工核对' : '等待领取'}</span></div><div className="member-steps"><p><span>1</span><b>登录平台会员</b><small>用现有平台账号登录，或先注册。</small></p><p><span>2</span><b>绑定并领取 $10</b><small>服务器确认资格后，将额度直接充值到会员账户。</small></p><p><span>3</span><b>选择客户端开始使用</b><small>添加云桥供应商，选择模型，预览后应用配置。</small></p></div><Btn variant="primary" disabled={loading || !!busy || !statusKnown || !status?.loggedIn || claimed || (!pending && gift.eligible === false) || gift.status === 'ineligible' || gift.status === 'review' || status?.config?.enabled === false} onClick={() => perform('member.claim')}>{busy === 'member.claim' ? '正在确认到账…' : claimed ? '新客额度已到账' : pending ? '重新确认到账' : !statusKnown ? '请先刷新领取状态' : '领取 $10 平台额度'}</Btn>{(gift.reason || gift.message) && <p className="hint">{gift.reason || gift.message}</p>}{receipt && <div className="notice" style={{ marginTop: 16 }}>{receipt.message || '领取请求已处理，可刷新查看平台余额。'}</div>}<p className="hint" style={{ marginTop: 20 }}>每个会员、每个客户端安装限领一次；切换账号或重复点击不会重复发放。赠送额度仅用于 yunqiao.me 平台模型服务。</p></div>
      </div>
    </>}
  </>;
}
