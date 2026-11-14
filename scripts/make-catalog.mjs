/**
 * 把桌面端内置的预设库转换成云端目录的 catalog.json 初始数据。
 * 用法：node scripts/make-catalog.mjs > server/seed-catalog.json
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'src/core/presets/providers.ts'), 'utf8');

// 直接跑 ts 太重，这里用正则粗解析（预设文件结构是固定的）
const blocks = [];
const re = /\{\s*id:\s*'([^']+)',[\s\S]*?models:\s*\[([\s\S]*?)\],\s*\},/g;
let m;
while ((m = re.exec(src))) {
  const [, id, modelsRaw] = m;
  const head = src.slice(m.index, m.index + 1200);
  const get = (k) => {
    const mm = new RegExp(`${k}:\\s*'([^']*)'`).exec(head);
    return mm ? mm[1] : '';
  };
  const models = [];
  const mre = /m\('([^']+)',\s*(\d+),\s*([\d.]+),\s*([\d.]+)/g;
  let mm2;
  while ((mm2 = mre.exec(modelsRaw))) {
    models.push({
      id: mm2[1],
      contextWindow: Number(mm2[2]),
      inputPrice: Number(mm2[3]),
      outputPrice: Number(mm2[4]),
      capabilities: { tools: true, vision: false, thinking: false },
    });
  }
  if (!models.length) continue;
  blocks.push({
    key: id,
    name: get('nameZh') || get('name'),
    vendor: get('vendor'),
    format: get('format') || 'openai-chat',
    baseUrl: get('baseUrl'),
    region: get('region') || 'relay',
    color: get('color') || '#6d8cff',
    icon: get('icon') || '◆',
    docs: get('docs'),
    note: get('note'),
    tags: [],
    official: /official:\s*true/.test(head),
    enabled: true,
    sort: 100 + blocks.length,
    models,
  });
}

const catalog = {
  version: 1,
  updatedAt: new Date().toISOString(),
  providers: blocks,
};
process.stdout.write(JSON.stringify(catalog, null, 2));
