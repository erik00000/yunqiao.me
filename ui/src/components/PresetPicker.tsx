import React, { useState } from 'react';
import { Preset } from '../lib/api';
import { Ico } from './ui';

export default function PresetPicker({ presets, value, onChange }: { presets: Preset[]; value?: string; onChange: (preset?: Preset) => void }) {
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('all');
  const list = presets.filter(p => p.region !== 'subscription' && (region === 'all' || p.region === region) && `${p.name} ${p.nameZh} ${p.vendor} ${p.models.map(m => m.id).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="vendor-picker">
    <div className="search-input"><Ico name="search" size={14} /><input aria-label="搜索供应商预设" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索厂商或模型，如 DeepSeek、Claude…" /></div>
    <div className="segments">{[['all', '全部'], ['cn', '国内'], ['global', '国际'], ['relay', '中转'], ['local', '本地']].map(([id, name]) => <button key={id} type="button" className={region === id ? 'selected' : ''} onClick={() => setRegion(id)}>{name}</button>)}</div>
    <div className="preset-grid"><button type="button" className={`preset-item ${!value ? 'on' : ''}`} onClick={() => onChange()}><Ico name="plus" size={14} />自定义供应商</button>{list.map(p => <button type="button" title={`${p.nameZh || p.name} · ${p.vendor}`} className={`preset-item ${value === p.id ? 'on' : ''}`} key={p.id} onClick={() => onChange(p)}><span className="vendor-initial" style={{ color: p.color }}>{(p.nameZh || p.name).charAt(0)}</span><span className="ellipsis">{p.nameZh || p.name}</span></button>)}</div>
    {!list.length && <p className="hint">没有匹配的预设，可以手动填写供应商地址。</p>}
  </div>;
}
