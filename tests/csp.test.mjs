// The Content-Security-Policy in firebase.json allows exactly the inline scripts
// of the HTML pages (by SHA-256 hash). An edit to one of them changes its hash:
// this test then fails and prints the new value to paste into firebase.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const PAGES = ['index.html', 'driver.html', 'admin.html'];

const hosting = JSON.parse(read('firebase.json')).hosting;
const csp = hosting.headers
  .flatMap((h) => h.headers)
  .find((h) => h.key === 'Content-Security-Policy').value;
const directive = (name) =>
  csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1) ?? [];

test('every inline script is allowed by its hash, and nothing else is inline', () => {
  const wanted = [];
  for (const page of PAGES) {
    const html = read(page);
    for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      wanted.push(`'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`);
    }
    assert.doesNotMatch(html, /\son[a-z]+="/, `${page}: inline event handler`);
    assert.doesNotMatch(html, /\sstyle="/, `${page}: inline style attribute`);
  }
  const allowed = directive('script-src').filter((s) => s.startsWith("'sha256-"));
  assert.deepEqual([...allowed].sort(), [...wanted].sort());
});

test('the policy is strict', () => {
  assert.deepEqual(directive('default-src'), ["'self'"]);
  assert.deepEqual(directive('object-src'), ["'none'"]);
  assert.deepEqual(directive('frame-ancestors'), ["'none'"]);
  for (const name of ['script-src', 'style-src']) {
    const values = directive(name);
    assert.ok(!values.includes("'unsafe-inline'"), `${name} allows unsafe-inline`);
    assert.ok(!values.includes("'unsafe-eval'"), `${name} allows unsafe-eval`);
  }
});

test('Google sign-in can open its frame from the project auth domain', async () => {
  const { FIREBASE_CONFIG } = await import('../js/firebase-config.js');
  if (!FIREBASE_CONFIG) return; // no project yet
  assert.ok(
    directive('frame-src').includes(`https://${FIREBASE_CONFIG.authDomain}`),
    `frame-src needs https://${FIREBASE_CONFIG.authDomain}`,
  );
});
