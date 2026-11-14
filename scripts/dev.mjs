import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const vite = spawn(npx, ['vite'], { cwd: root, stdio: 'inherit', shell: true });

async function main() {
  await new Promise((r) => setTimeout(r, 2500));
  const { build } = await import('esbuild');
  const entries = [
    { in: 'src/main/index.ts', out: 'dist/main/main.cjs' },
    { in: 'src/preload/index.ts', out: 'dist/main/preload.cjs' },
    { in: 'src/main/gateway-cli.ts', out: 'dist/main/gateway-cli.cjs' },
  ];
  for (const e of entries) {
    await build({
      entryPoints: [path.resolve(root, e.in)],
      outfile: path.resolve(root, e.out),
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['electron'],
      logLevel: 'warning',
    });
  }
  const electron = spawn(npx, ['electron', '.'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, AURORA_DEV: '1', AURORA_UI_URL: 'http://localhost:5199' },
  });
  electron.on('exit', () => {
    vite.kill();
    process.exit(0);
  });
}

main();
