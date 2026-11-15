/** Verify the full pinned source, then stage the reviewed distribution subset.
 * Upstream tests and Rust reference sources remain in third_party, not the app.
 * The CLI always writes this checkout's dist/extensions; projectRoot is injectable
 * only through the module API for isolated temporary-directory regression tests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'FILES.sha256.json';
export const resourcePolicy = JSON.parse(fs.readFileSync(new URL('./extension-resource-policy.json', import.meta.url), 'utf8'));
const digest = data => createHash('sha256').update(data).digest('hex');
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

function safeRelative(file) {
  assert(typeof file === 'string' && file.length > 0 && !file.includes('\\'), 'Invalid resource path');
  assert(file.split('/').every(part => part && !['.', '..'].includes(part) && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part)), `Unsafe resource path: ${file}`);
  return file;
}

// lstat every existing ancestor, including Windows junctions, before writing,
// renaming or deleting. realpath alone would silently follow those links.
function assertDirectoryPath(directory, allowMissing = false) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!exists(current)) { assert(allowMissing, `Directory is missing: ${current}`); continue; }
    const stat = fs.lstatSync(current);
    assert(!stat.isSymbolicLink() && stat.isDirectory(), `Refusing linked or non-directory path: ${current}`);
  }
  if (exists(absolute)) assert.equal(path.resolve(fs.realpathSync(absolute)).toLowerCase(), absolute.toLowerCase(), `Directory resolves elsewhere: ${absolute}`);
}

function filesIn(directory) {
  assertDirectoryPath(directory);
  const files = [];
  function walk(current) {
    for (const name of fs.readdirSync(current)) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), `Refusing linked resource: ${file}`);
      if (stat.isDirectory()) walk(file);
      else { assert(stat.isFile(), `Not a regular resource: ${file}`); files.push(path.relative(directory, file).split(path.sep).join('/')); }
    }
  }
  walk(directory);
  return files.sort();
}

export function releaseResourceManifest(manifest) {
  assert.equal(resourcePolicy.schemaVersion, 1, 'Unsupported resource policy');
  assert(Array.isArray(manifest) && manifest.length === resourcePolicy.sourceFiles, 'Pinned source asset count changed; review the resource policy');
  const names = new Set(), excluded = new Set(resourcePolicy.excluded);
  assert.equal(excluded.size, resourcePolicy.excluded.length, 'Duplicate resource exclusion');
  for (const record of manifest) {
    safeRelative(record.path);
    assert(record.path !== MANIFEST && !names.has(record.path.toLowerCase()), `Duplicate resource: ${record.path}`);
    names.add(record.path.toLowerCase());
    assert(Number.isSafeInteger(record.bytes) && record.bytes >= 0 && /^[a-f0-9]{64}$/.test(record.sha256), `Invalid resource hash record: ${record.path}`);
    if (record.path.endsWith('.test.cjs') || record.path.startsWith('source/')) assert(excluded.has(record.path), `Unreviewed source-only asset: ${record.path}`);
  }
  for (const file of excluded) assert(manifest.some(record => record.path === file), `Resource exclusion is missing from pinned source: ${file}`);
  return manifest.filter(record => !excluded.has(record.path));
}

// Delete only an owned stage/backup immediately beneath the already checked dist.
// Never recursively remove an arbitrary caller-supplied output path.
function removeOwnedDirectory(directory, dist) {
  assert.equal(path.dirname(path.resolve(directory)), dist, 'Cleanup escaped dist');
  assert(/^\.extensions-(stage|backup)-[0-9a-f-]{36}$/.test(path.basename(directory)), 'Unrecognized staging directory');
  assertDirectoryPath(dist);
  if (!exists(directory)) return;
  filesIn(directory); // Also reject symlinks inside the directory being removed.
  fs.rmSync(directory, { recursive: true });
}

export function prepareExtensionResources({ projectRoot = ROOT, output } = {}) {
  const root = path.resolve(projectRoot), dist = path.join(root, 'dist');
  const target = path.join(dist, 'extensions');
  assert(output === undefined || path.resolve(output) === target, 'Output must be the project dist/extensions directory');
  assertDirectoryPath(root);
  assertDirectoryPath(dist, true);
  assertDirectoryPath(target, true);
  if (exists(target)) filesIn(target);
  const source = path.join(root, 'third_party', 'codexplusplus');
  const sourceFiles = filesIn(source);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, MANIFEST), 'utf8'));
  const release = releaseResourceManifest(manifest);
  assert.deepEqual(sourceFiles, [...manifest.map(record => record.path), MANIFEST].sort(), 'Source contains unlisted or missing assets');
  // Keep verified bytes, so a source change during staging cannot silently make
  // the copied file differ from the record that was verified.
  const verified = new Map();
  for (const record of manifest) {
    const data = fs.readFileSync(path.join(source, record.path));
    assert(data.length === record.bytes && digest(data) === record.sha256, `Resource integrity mismatch: ${record.path}`);
    verified.set(record.path, data);
  }
  assert.equal(JSON.parse(verified.get('UPSTREAM.json').toString('utf8')).commit, resourcePolicy.upstreamCommit, 'Upstream revision changed; review the resource policy');

  // No output mutation occurs until every input (including excluded tests) passes.
  fs.mkdirSync(dist, { recursive: true });
  assertDirectoryPath(dist);
  const stage = path.join(dist, `.extensions-stage-${randomUUID()}`);
  const backup = path.join(dist, `.extensions-backup-${randomUUID()}`);
  fs.mkdirSync(stage);
  let backedUp = false, installed = false;
  try {
    for (const record of release) {
      const file = path.join(stage, record.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, verified.get(record.path), { flag: 'wx' });
    }
    fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify(release, null, 2) + '\n', { flag: 'wx' });
    assert.deepEqual(filesIn(stage), [...release.map(record => record.path), MANIFEST].sort());
    assertDirectoryPath(target, true);
    if (exists(target)) {
      filesIn(target);
      fs.renameSync(target, backup);
      backedUp = true;
    }
    try { fs.renameSync(stage, target); installed = true; }
    catch (error) {
      if (backedUp && !exists(target)) { assertDirectoryPath(dist); fs.renameSync(backup, target); backedUp = false; }
      throw error;
    }
    if (backedUp) { removeOwnedDirectory(backup, dist); backedUp = false; }
    return { sourceFiles: manifest.length, resourceFiles: release.length, excludedFiles: manifest.length - release.length,
      excludedBytes: manifest.filter(record => !release.includes(record)).reduce((sum, record) => sum + record.bytes, 0), output: target };
  } finally {
    if (!installed) removeOwnedDirectory(stage, dist);
    // A backup is deliberately retained if a failed swap cannot be rolled back.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'This build script accepts no output-path overrides');
  console.log(JSON.stringify(prepareExtensionResources()));
}
