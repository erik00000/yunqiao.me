import React, { useState } from 'react';
import { UpdateInfo, call } from '../lib/api';
import { Btn } from './ui';

/** Downloads are always explicit; checking for a release never opens a browser. */
export default function UpdateActions({ update }: { update: UpdateInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download(website = false) {
    setBusy(true); setError('');
    try {
      const result = website
        ? await call<UpdateInfo>('update.check', { source: 'website', minimumVersion: update.version })
        : update;
      if (!result.ok || !result.hasUpdate || !result.url) throw new Error(result.message || '官网暂未提供此版本的安装包，请稍后重试或使用 GitHub 下载。');
      const opened = await call('app.openExternal', { url: result.url });
      if (!opened.ok) throw new Error(opened.message || '无法打开下载链接，请稍后重试。');
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }
  if (!update.hasUpdate || !update.url) return null;
  return <div>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <Btn size="sm" variant="primary" disabled={busy} onClick={() => download()}>{update.source === 'website' ? '官网下载' : 'GitHub 下载'}</Btn>
      {update.source === 'github' && <Btn size="sm" disabled={busy} onClick={() => download(true)}>{busy ? '处理中…' : '官网备用'}</Btn>}
    </div>
    {error && <div role="alert" className="muted" style={{ marginTop: 8, maxWidth: 460, whiteSpace: 'pre-wrap' }}>{error}</div>}
  </div>;
}
