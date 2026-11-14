import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { call } from '../lib/api';

/* ---------------- 图标 ---------------- */

const P: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  cube: 'M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12v10M12 12L3 7',
  route: 'M4 6h6a4 4 0 0 1 4 4v0a4 4 0 0 0 4 4h2M4 18h6a4 4 0 0 0 4-4',
  robot: 'M9 3v3M15 3v3M5 8h14v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM9 13h.01M15 13h.01M9 17h6',
  puzzle: 'M10 3a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v1a2 2 0 1 1-4 0v-1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V5a1 1 0 0 1 1-1h3z',
  chat: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-5A8 8 0 1 1 21 12z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  play: 'M6 4l14 8-14 8z',
  stop: 'M6 6h12v12H6z',
  bolt: 'M13 2 3 14h7l-1 8 10-12h-7z',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
  ext: 'M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
  search: 'M21 21l-4.3-4.3M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z',
  cloud: 'M18 18a4 4 0 0 0 .6-8 6 6 0 0 0-11.4 1.6A3.2 3.2 0 0 0 7 18z M12 12v6M9.5 14.5 12 12l2.5 2.5',
  key: 'M15 7a4 4 0 1 1-3.5 6H9l-2 2-2-2 2-2v-2.5A4 4 0 0 1 15 7zM16.5 7.5h.01',
  shield: 'M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6z',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M4 19h16',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  git: 'M12 3v6M9 9h6v6H9zM12 15v6M6 6h.01M18 18h.01',
};

export function Ico({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={P[name] ?? P.cube} />
    </svg>
  );
}

/* ---------------- 标题栏 ---------------- */

export function WindowControls() {
  if (!window.aurora) return null;
  return (
    <div className="win-controls">
      <button title="最小化" onClick={() => call('window.minimize')}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      <button title="最大化" onClick={() => call('window.maximize')}>
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="2" y="2" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" /></svg>
      </button>
      <button className="close" title="关闭" onClick={() => call('window.close')}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
    </div>
  );
}

/* ---------------- 基础件 ---------------- */

export function Toggle({ on, onChange, title, disabled }: { on: boolean; onChange: (v: boolean) => void; title?: string; disabled?: boolean }) {
  return <button type="button" role="switch" disabled={disabled} aria-checked={on} aria-label={title || '切换开关'} className={`toggle ${on ? 'on' : ''}`} title={title} onClick={() => onChange(!on)} />;
}

export function Btn({
  children,
  onClick,
  variant = 'default',
  size,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm';
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`btn ${variant === 'default' ? '' : variant} ${size === 'sm' ? 'sm' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Modal({
  title,
  sub,
  onClose,
  children,
  foot,
  width,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: React.ReactNode;
  foot?: React.ReactNode;
  width?: number;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target = dialogRef.current?.querySelector<HTMLElement>('[autofocus], input, select, button, textarea');
    target?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') || []).filter(x => x.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-label={title} style={width ? { width } : undefined}>
        <h3>{title}</h3>
        {sub && <div className="sub">{sub}</div>}
        {children}
        {foot && <div className="foot">{foot}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon = '📦', title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ color: 'var(--text-2)' }}>{title}</div>
      {hint && <div style={{ fontSize: 11.5, maxWidth: 420 }}>{hint}</div>}
    </div>
  );
}

export function Stat({ k, v, unit }: { k: string; v: React.ReactNode; unit?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">
        {v}
        {unit && <small>{unit}</small>}
      </div>
    </div>
  );
}

export function Bars({ data, unit = '' }: { data: Array<{ day: string; v: number }>; unit?: string }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <div className="bars">
      {data.map((d) => (
        <div key={d.day} className="bar" style={{ height: `${Math.max(2, (d.v / max) * 100)}%` }}>
          <span>
            {d.day.slice(5)} · {d.v.toFixed(2)}
            {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

/* ---------------- Toast ---------------- */

type Toast = { id: number; text: string; kind: 'ok' | 'bad' | 'info' };
const ToastCtx = createContext<{ push: (t: string, k?: Toast['kind']) => void }>({ push: () => {} });

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, kind }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 3600);
  }, []);
  useEffect(() => {
    const handle = (event: PromiseRejectionEvent) => { event.preventDefault(); push(String(event.reason?.message || event.reason || '操作失败，请重试'), 'bad'); };
    window.addEventListener('unhandledrejection', handle);
    return () => window.removeEventListener('unhandledrejection', handle);
  }, [push]);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
