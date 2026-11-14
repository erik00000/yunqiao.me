import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

/**
 * 注入式增强（CDP）。
 *
 * 做法：用 --remote-debugging-port 启动官方 Codex 桌面版，
 * 通过 Chrome DevTools Protocol 往页面里塞脚本 / 改样式。
 *
 * 为什么官方一更新就可能失效：注入依赖官方前端的 DOM 结构与类名，
 * 它们不是稳定 API，版本一变选择器就可能落空。所以这里额外做版本监测，
 * 版本变化时明确提示"需要重新适配"，而不是静默失灵。
 */

const CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Codex', 'Codex.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'codex', 'Codex.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'Codex.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'app', 'Codex.exe'),
  path.join(process.env.PROGRAMFILES ?? '', 'Codex', 'Codex.exe'),
];

export interface CodexDesktopInfo {
  installed: boolean;
  exePath?: string;
  version?: string;
  running: boolean;
  debugPortOpen: boolean;
  /** 与上次记录的版本不同 → 注入可能需要重新适配 */
  versionChanged: boolean;
  lastVersion?: string;
  message?: string;
}

function findExe(): string | undefined {
  if (process.platform !== 'win32') {
    const candidate = process.platform === 'darwin' ? '/Applications/Codex.app/Contents/MacOS/Codex' : '';
    return candidate && fs.existsSync(candidate) ? candidate : undefined;
  }
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略 */
    }
  }
  // 商店版 / 非标准安装：查一下开始菜单快捷方式指向
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-ChildItem -Path $env:APPDATA\\Microsoft\\Windows\\Start Menu,$env:ProgramData\\Microsoft\\Windows\\Start Menu -Recurse -Filter 'Codex*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName",
      ],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (out) {
      const target = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).CreateShortcut('${out.replace(/'/g, "''")}').TargetPath`],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (target && fs.existsSync(target)) return target;
    }
  } catch {
    /* 没有就算了 */
  }
  return undefined;
}

function fileVersion(exe: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function isCodexRunning(): boolean {
  try {
    if (process.platform !== 'win32') {
      const out = execFileSync('pgrep', ['-x', 'Codex'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
      return !!out.trim();
    }
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Codex.exe'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /Codex\.exe/i.test(out);
  } catch {
    return false;
  }
}

async function portOpen(port = 9222): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function desktopInfo(lastVersion?: string): Promise<CodexDesktopInfo> {
  const exe = findExe();
  const running = isCodexRunning();
  const open = await portOpen();
  const version = exe ? fileVersion(exe) : undefined;
  return {
    installed: !!exe,
    exePath: exe,
    version,
    running,
    debugPortOpen: open,
    lastVersion,
    versionChanged: !!(version && lastVersion && version !== lastVersion),
    message: !exe
      ? '没有找到 Codex 桌面版。注入式增强只对桌面版有效，CLI 不需要注入。'
      : running && !open
        ? 'Codex 已经在你手动启动的进程里运行，没有开调试端口。请先完全退出，再用下面的按钮启动。'
        : undefined,
  };
}

/* ------------------------------ CDP ------------------------------ */

interface Cdp {
  send(method: string, params?: any): Promise<any>;
  close(): void;
}

async function connect(port = 9222): Promise<Cdp> {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) })).json()) as any[];
  const page = list.find((t) => t.type === 'page' && /codex/i.test(`${t.title || ''} ${t.url || ''}`));
  if (!isCodexRunning() || !page?.webSocketDebuggerUrl) throw new Error('未能确认调试目标属于 Codex，已停止注入');
  const target = new URL(page.webSocketDebuggerUrl);
  if (target.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || Number(target.port) !== port) throw new Error('调试目标地址无效');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let seq = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 连接超时')); }, 4000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
  });
  ws.addEventListener('message', (ev: any) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const request = pending.get(msg.id)!;
        clearTimeout(request.timer);
        if (msg.error) request.reject(new Error(msg.error.message || 'CDP 请求失败'));
        else request.resolve(msg.result);
        pending.delete(msg.id);
      }
    } catch {
      /* 忽略非 JSON */
    }
  });
  ws.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP 连接已关闭')); } pending.clear(); });
  return {
    send: (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 请求超时')); }, 5000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

export interface InjectResult {
  ok: boolean;
  message: string;
  launched?: boolean;
  injected?: number;
}

/** 启动 Codex（带调试端口）；已启动则直接注入 */
export async function launchAndInject(
  scripts: Array<{ id: string; name: string; code: string; enabled: boolean }>,
  port = 9222,
): Promise<InjectResult> {
  const exe = findExe();
  const active = scripts.filter((s) => s.enabled && s.code.trim());
  if (!exe) return { ok: false, message: '没有找到 Codex 桌面版' };

  let launched = false;
  if (!(await portOpen(port))) {
    if (isCodexRunning()) {
      return {
        ok: false,
        message: 'Codex 正在运行但没开调试端口。请完全退出 Codex（托盘也要退出）后再点一次。',
      };
    }
    spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' }).unref();
    launched = true;
    // 等页面起来
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await portOpen(port)) break;
    }
    if (!(await portOpen(port))) {
      return { ok: false, launched, message: 'Codex 启动了，但调试端口没有打开（可能被安全软件拦截）' };
    }
    // 再等前端渲染
    await new Promise((r) => setTimeout(r, 2500));
  }

  let cdp: Cdp | null = null;
  let injected = 0;
  try {
    cdp = await connect(port);
    for (const s of active) {
      // 立即执行一次
      const evaluated = await cdp.send('Runtime.evaluate', { expression: s.code, awaitPromise: false });
      if (evaluated?.exceptionDetails) throw new Error(`脚本「${s.name}」执行失败：${evaluated.exceptionDetails.text || '未知错误'}`);
      // 后续每次页面加载都自动执行
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: s.code });
      injected++;
    }
    await cdp.send('Page.reload', { ignoreCache: false }).catch(() => {});
    return {
      ok: true,
      launched,
      injected,
      message: injected
        ? `已注入 ${injected} 个脚本${launched ? '（Codex 由云桥AI 启动）' : ''}`
        : '没有启用的脚本，只启动了调试端口',
    };
  } catch (e: any) {
    return { ok: false, launched, message: String(e?.message ?? e) };
  } finally {
    cdp?.close();
  }
}

/** 只检测端口是否可用（UI 轮询用） */
export async function injectorStatus(): Promise<{ portOpen: boolean; running: boolean; installed: boolean }> {
  return { portOpen: await portOpen(), running: isCodexRunning(), installed: !!findExe() };
}

export const BUILTIN_INJECT_SCRIPTS = [
  {
    id: 'inject:statusbar',
    name: '底部状态条',
    enabled: true,
    code: `(function(){
  if (document.getElementById('yq-statusbar')) return;
  var bar = document.createElement('div');
  bar.id = 'yq-statusbar';
  bar.textContent = '云桥AI · 已注入 · ' + new Date().toLocaleTimeString();
  Object.assign(bar.style, {position:'fixed',left:'50%',bottom:'10px',transform:'translateX(-50%)',
    zIndex:99999,padding:'4px 12px',borderRadius:'999px',fontSize:'12px',
    background:'rgba(109,140,255,.18)',border:'1px solid rgba(109,140,255,.45)',color:'#c3ceff',
    backdropFilter:'blur(8px)',pointerEvents:'none'});
  document.body.appendChild(bar);
})();`,
  },
  {
    id: 'inject:wide',
    name: '加宽对话区',
    enabled: true,
    code: `(function(){
  var st = document.getElementById('yq-wide');
  if (st) return;
  st = document.createElement('style');
  st.id = 'yq-wide';
  st.textContent = '[class*="composer"]{max-width:1100px!important} [class*="message"]{max-width:1100px!important}';
  document.head.appendChild(st);
})();`,
  },
  {
    id: 'inject:watermark',
    name: '隐藏 AI 生成水印',
    enabled: false,
    code: `(function(){
  var st = document.getElementById('yq-wm');
  if (st) return;
  st = document.createElement('style');
  st.id = 'yq-wm';
  st.textContent = '[class*="attribution"],[class*="watermark"],[data-testid*="attribution"]{display:none!important}';
  document.head.appendChild(st);
})();`,
  },
];
