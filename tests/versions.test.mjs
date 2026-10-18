// Every pinned CDN version must be the same in every file that names it.
// A missed spot fails quietly in production: a Firebase SDK URL outside the
// service worker's LIB_PREFIXES is never cached (no app in a dead zone), and a
// CSP entry for the old version blocks the new script. (The SRI hashes of
// Leaflet and qrcode-generator cannot be checked offline: update them by hand.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const V = String.raw`(\d+\.\d+\.\d+)`;
const re = (s) => new RegExp(s, 'g');

/** For each library: file -> pattern whose first group is the version. */
const LIBS = {
  'Firebase JS SDK': {
    'firebase.json': re(`firebasejs/${V}/`),
    'sw.js': re(`firebasejs/${V}/`),
    'js/firebase.js': re(`firebasejs/${V}`),
    'package.json': re(`"firebase": "${V}"`),
    'README.md': re(String.raw`\[Firebase JS SDK\]\([^)]*\) ${V}`),
    'docs/ARCHITECTURE.md': re(`firebasejs/${V}/`),
    'CLAUDE.md': re(`Firebase ${V}`),
  },
  Leaflet: {
    'firebase.json': re(`leaflet@${V}/`),
    'sw.js': re(`leaflet@${V}/`),
    'index.html': re(`leaflet@${V}/`),
    'README.md': re(String.raw`\[Leaflet\]\([^)]*\) ${V}`),
    'docs/ARCHITECTURE.md': re(`leaflet@${V}/`),
    'CLAUDE.md': re(`Leaflet ${V}`),
  },
  jsQR: {
    'firebase.json': re(`jsqr@${V}/`),
    'sw.js': re(`jsqr@${V}/`),
    'js/enroll.js': re(`jsqr@${V}/`),
    'README.md': re(String.raw`\[jsQR\]\([^)]*\) ${V}`),
    'docs/ARCHITECTURE.md': re(`jsqr@${V}/`),
    'CLAUDE.md': re(`jsQR ${V}`),
  },
  'qrcode-generator': {
    'firebase.json': re(`qrcode-generator@${V}/`),
    'sw.js': re(`qrcode-generator@${V}/`),
    'admin.html': re(`qrcode-generator@${V}/`),
    'README.md': re(String.raw`\[qrcode-generator\]\([^)]*\) ${V}`),
    'docs/ARCHITECTURE.md': re(`qrcode-generator@${V}/`),
    'CLAUDE.md': re(`qrcode-generator ${V}`),
  },
};

for (const [lib, places] of Object.entries(LIBS)) {
  test(`${lib}: the same pinned version in every file`, () => {
    const found = [];
    for (const [file, pattern] of Object.entries(places)) {
      const versions = [...read(file).matchAll(pattern)].map((m) => m[1]);
      // A file that no longer names the version means the pin moved: update this list.
      assert.ok(versions.length > 0, `${file} no longer names a ${lib} version`);
      for (const v of versions) found.push(`${file}: ${v}`);
    }
    const distinct = new Set(found.map((f) => f.split(': ')[1]));
    assert.equal(distinct.size, 1, `${lib} versions differ:\n  ${found.join('\n  ')}`);
  });
}
