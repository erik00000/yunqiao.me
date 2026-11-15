/** Preview is the default. Apply only targets historical usage files with Windows sharing locks. */
import { planLegacyUsageCleanup, applyLegacyUsageCleanup, summarizePlan } from './legacy-demo-usage.mjs';

const options = {};
try {
  for (let i = 2; i < process.argv.length; i++) {
    const argument = process.argv[i];
    if (argument === '--apply' && options.apply === undefined) options.apply = true;
    else if (['--data-dir', '--backup-dir'].includes(argument) && options[argument] === undefined && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[argument] = process.argv[++i];
    else throw new Error('Usage: node scripts/clean-legacy-demo-usage.mjs --data-dir <directory> [--apply] [--backup-dir <new external directory>]');
  }
  if (!options['--data-dir']) throw new Error('--data-dir is required; no default user directory is scanned');
  const plan = planLegacyUsageCleanup(options['--data-dir']);
  const report = options.apply ? applyLegacyUsageCleanup(plan, { backupDir: options['--backup-dir'] }) : { status: 'dry-run' };
  console.log(JSON.stringify({ ...report, ...summarizePlan(plan) }, null, 2));
} catch (error) { console.error(JSON.stringify({ ...error.report, status: 'refused', message: error.message })); process.exitCode = 1; }
