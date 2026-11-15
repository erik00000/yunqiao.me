/** Run the existing independent core suites to completion, retaining every failure for native CI. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const commands = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test.split(' && ');
const failed = [];
for (const command of commands) {
  const match = /^node (scripts\/test-[\w-]+\.mjs)$/.exec(command);
  const args = command === 'npm run typecheck' ? [require.resolve('typescript/bin/tsc'), '--noEmit'] : match ? [match[1]] : null;
  if (!args) throw new Error(`Unsupported test entry: ${command}`);
  console.log(`\n::group::${command}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  console.log('::endgroup::');
  if (result.error || result.status !== 0) failed.push(command);
}
if (failed.length) { console.error('Failed suites:', failed.join('\n')); process.exitCode = 1; }
else console.log(`All ${commands.length} core checks/suites passed on ${process.platform} ${process.arch}`);
