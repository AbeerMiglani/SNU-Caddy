// index.html and driver.html preload their modules in parallel. These tests fail
// when a list no longer matches the real static imports of its entry module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function staticImports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = read(file);
  for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gm)) {
    staticImports(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])), seen);
  }
  return seen;
}

test('modulepreload list in index.html matches the imports of js/main.js', () => {
  const html = read('index.html');
  const block = html.match(/var modules =\s*((?:'[^']*'\s*\+?\s*)+);/);
  assert.ok(block, 'index.html has no "var modules = ..." list');
  const list = [...block[1].matchAll(/'([^']*)'/g)]
    .map((m) => m[1])
    .join('')
    .trim()
    .split(/\s+/)
    .map((m) => `js/${m}.js`);
  const actual = [...staticImports('js/main.js')];
  assert.deepEqual([...list].sort(), [...actual].sort());
});

test('modulepreload links in driver.html match the imports of js/driver-screen.js', () => {
  const html = read('driver.html');
  const list = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
  const actual = [...staticImports('js/driver-screen.js')];
  assert.deepEqual([...list].sort(), [...actual].sort());
});
