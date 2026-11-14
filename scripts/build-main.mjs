import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(root, '..');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.AURORA_BUILD': '"production"' },
};

const entries = [
  { in: 'src/main/index.ts', out: 'dist/main/main.cjs', external: ['electron'] },
  { in: 'src/preload/index.ts', out: 'dist/main/preload.cjs', external: ['electron'] },
  { in: 'src/main/gateway-cli.ts', out: 'dist/main/gateway-cli.cjs', external: ['electron'] },
];

for (const e of entries) {
  await build({
    ...common,
    entryPoints: [path.resolve(base, e.in)],
    outfile: path.resolve(base, e.out),
    external: e.external,
  });
}

console.log('[yunqiao] main bundles built');

