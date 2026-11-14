/** Build the cloud seed from the actual typed desktop preset module.
 * Usage: node scripts/make-catalog.mjs [--out server/seed-catalog.json]
 * Missing prices remain missing; empty account/local model lists are preserved.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const result = await build({
  entryPoints: [path.join(root, 'src/core/presets/providers.ts')],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
});
const { PROVIDER_PRESETS } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
if (!Array.isArray(PROVIDER_PRESETS) || !PROVIDER_PRESETS.length) throw new Error('Provider presets did not load');
const keys = new Set();
const providers = PROVIDER_PRESETS.map((preset, index) => {
  if (!preset.id || keys.has(preset.id) || !Array.isArray(preset.models)) throw new Error(`Invalid preset ${preset.id}`);
  keys.add(preset.id);
  const { id, nameZh, name, ...metadata } = preset;
  return { key: id, name: nameZh || name, ...metadata, tags: [], enabled: true, sort: 100 + index };
});
const catalog = { version: 2, updatedAt: new Date().toISOString(), providers };
const output = JSON.stringify(catalog, null, 2) + '\n';
const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1) {
  if (!process.argv[outIndex + 1]) throw new Error('--out requires a path');
  writeFileSync(path.resolve(root, process.argv[outIndex + 1]), output, 'utf8');
} else process.stdout.write(output);
