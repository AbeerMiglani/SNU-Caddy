// The service worker saves the app shell for dead zones. These tests fail when
// sw.js no longer lists every module the student app and the driver screen
// load (also lazy ones), or when it lists a file that does not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** Static AND dynamic imports (import('./x.js')), recursively. */
function moduleGraph(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = read(file);
  const specs = [
    ...src.matchAll(/^\s*import\s+(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gm),
    ...src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  for (const spec of specs) {
    moduleGraph(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)), seen);
  }
  return seen;
}

const sw = read('sw.js');
const shell = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(
  (m) => m[1],
);

test('sw.js saves every module of the student app and the driver screen', () => {
  const needed = new Set([...moduleGraph('js/main.js'), ...moduleGraph('js/driver-screen.js')]);
  const missing = [...needed].filter((f) => !shell.includes(f));
  assert.deepEqual(missing, []);
});

test('sw.js saves the pages, styles and font, and every listed file exists', () => {
  for (const f of ['index.html', 'driver.html', 'css/app.css', 'css/driver.css']) {
    assert.ok(shell.includes(f), f);
  }
  for (const f of shell.filter((f) => f !== './')) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} does not exist`);
  }
});

test('sw.js never caches live data, sign-in or tiles', () => {
  // Only same-origin files (minus Firebase's /__/ pages) and pinned CDN versions.
  assert.match(sw, /url\.pathname\.startsWith\('\/__\/'\)/);
  for (const host of [
    'firebaseio',
    'firebasedatabase',
    'googleapis',
    'cartocdn',
    'openstreetmap',
  ]) {
    assert.ok(!sw.includes(host), `sw.js mentions ${host}`);
  }
  const prefixes = [...sw.match(/const LIB_PREFIXES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)];
  for (const [, p] of prefixes) assert.match(p, /@\d+\.\d+\.\d+\/$|\/\d+\.\d+\.\d+\/$/, p);
});
