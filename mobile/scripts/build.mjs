import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'www'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/app.js')],
  outfile: path.join(root, 'www/app.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['safari16'],
  legalComments: 'eof',
});
await Promise.all(['index.html', 'app.css'].map(name => fs.copyFile(path.join(root, 'src', name), path.join(root, 'www', name))));
await Promise.all(['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(name => fs.copyFile(path.join(root, '..', name), path.join(root, 'www', name))));
console.log('Mobile web assets built → mobile/www');
