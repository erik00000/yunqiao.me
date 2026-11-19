import React, { useState } from 'react';
import { UpdateInfo, call } from '../lib/api';
import { Btn } from './ui';

/** Downloads are always explicit; checking for a release never opens a browser. */
export default function UpdateActions({ update }: { update: UpdateInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    setBusy(true); setError('');
    try {
      if (!update.ok || !update.hasUpdate || !update.url || update.source !== 'github') throw new Error(update.message || '维护仓库暂未提供此版本的安装包，请重新检查更新。');
      const opened = await call('app.openExternal', { url: update.url });
      if (!opened.ok) throw new Error(opened.message || '无法打开下载链接，请稍后重试。');
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }
  if (!update.hasUpdate || !update.url) return null;
  return <div>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <Btn size="sm" variant="primary" disabled={busy} onClick={() => download()}>{busy ? '处理中…' : 'GitHub 下载'}</Btn>
    </div>
    {error && <div role="alert" className="muted" style={{ marginTop: 8, maxWidth: 460, whiteSpace: 'pre-wrap' }}>{error}</div>}
  </div>;
}
