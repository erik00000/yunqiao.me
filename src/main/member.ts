import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AuroraStore } from '../core/store/index.js';

const endpoint = 'https://ai.haowucm.cn/member.php';
let sessionToken = '';
let restored = false;
let busy = false;
let installationIdentity: { id: string; proof: string } | undefined;

function installation() {
  if (installationIdentity) return installationIdentity;
  if (!protectedStorage()) throw new Error('系统安全存储暂不可用，无法安全绑定会员安装凭据。');
  const file = path.join(app.getPath('userData'), 'member-installation.enc');
  const legacy = path.join(app.getPath('userData'), 'member-installation.json');
  const validate = (saved: any): { id: string; proof: string } => {
    if (!/^[a-f\d-]{36}$/.test(saved?.id) || !/^[a-f\d]{64}$/.test(saved?.proof)) throw new Error('会员安装凭据损坏，请恢复本机备份。');
    return { id: saved.id, proof: saved.proof };
  };
  if (fs.existsSync(file)) {
    try { installationIdentity = validate(JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))); return installationIdentity; }
    catch { throw new Error('无法解密会员安装凭据，请使用原系统账户或恢复本机备份。'); }
  }
  // The ID and proof have the same lifetime. A lost proof must never strand a reused hardware ID.
  const record = fs.existsSync(legacy) ? validate(JSON.parse(fs.readFileSync(legacy, 'utf8'))) : { id: randomUUID(), proof: randomBytes(32).toString('hex') };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(record)), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  installationIdentity = record;
  return record;
}
function protectedStorage() { return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'); }
function sessionFile() { return path.join(app.getPath('userData'), 'member-session.enc'); }
function restoreSession() {
  if (restored) return;
  restored = true;
  try { if (protectedStorage()) sessionToken = safeStorage.decryptString(fs.readFileSync(sessionFile())); } catch { sessionToken = ''; }
}
function saveSession(token: string) {
  sessionToken = token;
  if (token && protectedStorage()) fs.writeFileSync(sessionFile(), safeStorage.encryptString(token), { mode: 0o600 });
  else if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile());
}
async function request(action: string, payload: any = {}) {
  restoreSession();
  const device = action === 'config' ? null : installation();
  const response = await fetch(`${endpoint}?a=${encodeURIComponent(action)}`, {
    method: action === 'config' || action === 'status' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(['claim', 'create-client-key'].includes(action) ? 120000 : 35000),
    headers: { 'content-type': 'application/json', ...(device ? { 'X-Aurora-Installation': device.id, 'X-Aurora-Installation-Proof': device.proof } : {}), ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}) },
    ...(['config', 'status'].includes(action) ? {} : { body: JSON.stringify(payload) }),
  });
  const body = await response.text();
  if (body.length > 1024 * 1024) throw new Error('会员服务响应异常');
  let data: any;
  try { data = JSON.parse(body); } catch { throw new Error(`会员服务暂不可用（HTTP ${response.status}）`); }
  if (!response.ok || data.ok === false || data.error) {
    if (response.status === 401 && ['status', 'groups', 'claim', 'create-client-key'].includes(action)) saveSession('');
    throw new Error(typeof data.error === 'string' ? data.error : data.message || `会员服务暂不可用（HTTP ${response.status}）`);
  }
  if (data.sessionToken) {
    if (typeof data.sessionToken !== 'string' || !/^[a-f\d]{64}$/.test(data.sessionToken)) throw new Error('会员服务返回的登录凭据无效');
    saveSession(data.sessionToken);
  }
  // The renderer never receives the membership session token.
  const { sessionToken: _token, accessToken: _access, refreshToken: _refresh, ...publicData } = data;
  return publicData;
}

export async function memberAction(store: AuroraStore, action: string, payload: any): Promise<any> {
  restoreSession();
  if (action === 'member.status') {
    const config = await request('config');
    if (!sessionToken || config.enabled === false) return { ok: true, loggedIn: false, config };
    try { return { ok: true, loggedIn: true, config, ...await request('status') }; }
    catch (error: any) { if (!sessionToken) return { ok: true, loggedIn: false, config, message: '登录已过期，请重新登录。' }; throw error; }
  }
  if (busy) throw new Error('会员操作正在处理，请稍候');
  busy = true;
  try {
    if (action === 'member.login') return await request('login', { email: String(payload.email || '').trim(), password: String(payload.password || ''), turnstile_token: payload.turnstileToken });
    if (action === 'member.login2fa') return await request('login2fa', { tempToken: payload.tempToken, totpCode: payload.code });
    if (action === 'member.bind') return await request('bind', { accessToken: String(payload.accessToken || '') });
    if (action === 'member.groups') return await request('groups');
    if (action === 'member.claim') return await request('claim');
    if (action === 'member.logout') {
      let revoked = true;
      try { if (sessionToken) await request('logout'); } catch { revoked = false; } finally { saveSession(''); }
      return { ok: true, ...(revoked ? {} : { message: '本机已退出登录；服务器暂不可用，远端会话将在到期后失效。' }) };
    }
    if (action === 'member.addProvider') {
      const result = await request('create-client-key', { groupId: payload.groupId });
      const key = result.apiKey || result.key;
      if (typeof key !== 'string' || !key) throw new Error('会员服务没有返回客户端 API Key');
      const baseUrl = new URL(result.baseUrl);
      const formats: Record<string, string> = { openai: 'openai-responses', anthropic: 'anthropic', gemini: 'gemini', deepseek: 'openai-chat', grok: 'openai-chat' };
      if (baseUrl.origin !== 'https://api.yunqiao.me' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
        || !formats[result.group?.platform] || formats[result.group.platform] !== result.format || !Number.isSafeInteger(result.memberId) || result.memberId < 1
        || !Number.isSafeInteger(result.group?.id) || result.group.id < 1
        || (payload.groupId !== undefined && result.group.id !== payload.groupId)) throw new Error('会员供应商地址、分组或协议无效');
      // Different members must never share a provider's key rotation pool.
      const presetId = `yunqiao-member-${result.memberId}-group-${result.group.id}`;
      const previous = store.listProviders().find(p => p.presetId === presetId);
      const apiKeys = (previous?.apiKeys || []).map(k => k.key === key ? { ...k, enabled: true } : { ...k });
      if (!apiKeys.some(k => k.key === key)) apiKeys.push({ id: randomUUID(), label: '会员客户端密钥', key, enabled: true, weight: 1 });
      const provider = store.saveProvider({ ...previous, name: `云桥 · ${result.group?.name || '会员服务'}`, presetId, format: result.format, baseUrl: result.baseUrl, models: previous?.models || [], enabled: true, apiKeys });
      return { ok: true, providerId: provider.id, message: '云桥供应商已添加。选择你的客户端即可继续配置。' };
    }
    throw new Error('未知会员操作');
  } finally { busy = false; }
}
