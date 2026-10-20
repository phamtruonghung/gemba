// The installable app: manifest, static files, the service worker, and the one rule about what the
// worker may keep. The browser behaviour itself is checked by hand (see the commit); this pins the
// server side and the policy function the worker embeds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, upsertNote } from '../src/db.mjs';
import { cachePolicy, purgesOnLogout, SHELL_URLS, MANIFEST } from '../src/pwa.mjs';
import { resolvePublicFile, serveStatic } from '../src/static.mjs';

let app, base;

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data', adminToken: 'tok', bankBin: '', bankAccount: '', llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 } }
  });
  const id = upsertExpert(app.db, { slug: 'hung-qa', name: 'Hung', headline: 'x', topics: ['tpm'], years: 5, rate_vnd: 800000, token: 'tok-h' });
  upsertNote(app.db, { expert_id: id, slug: 'seed-1-a', title: 'A note', topic: 'tpm', body: 'Check the filter first.', status: 'published', gate: { verdict: 'clean', ok: true, needs_attestation: false, findings: [] }, origin: 'demo' });
  app.rebuildIndex();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

// Raw request so odd paths reach the server exactly as written (fetch normalises them).
function raw(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + path, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('the manifest names the app, the colours and the icons', async () => {
  const res = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/manifest\+json/);
  const m = await res.json();
  assert.equal(m.name, 'Gemba');
  assert.ok(m.short_name && m.description);
  assert.equal(m.lang, 'en');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#ea580c');
  assert.equal(m.background_color, '#f7f4f1');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  assert.ok(m.icons.some((i) => i.type === 'image/svg+xml'));
  for (const icon of m.icons) {
    const r = await fetch(base + icon.src);
    assert.equal(r.status, 200, icon.src);
    assert.equal(r.headers.get('content-type'), icon.type);
  }
  assert.deepEqual(m, MANIFEST);
});

test('the static handler refuses every way out of the public directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemba-pub-'));
  const outside = mkdtempSync(join(tmpdir(), 'gemba-out-'));
  mkdirSync(join(root, 'icons'));
  writeFileSync(join(root, 'icons', 'a.png'), 'png');
  writeFileSync(join(root, 'icons', 'a.php'), 'x');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'icons', 'leak.txt'));
  symlinkSync(outside, join(root, 'icons', 'dir'));
  assert.ok(resolvePublicFile(root, '/icons/a.png'));
  for (const bad of [
    '/%2e%2e/%2e%2e/etc/passwd', '/icons/..%2f..%2fa.png', '/icons/../a.png', '/icons/%2e%2e/a.png',
    '/icons/..%5ca.png', '/icons/..\\a.png', '/icons/a.png%00.txt', '/icons/%252e%252e/a.png',
    '//etc/passwd', '/etc/passwd', 'icons/a.png', '/icons/a.php', '/icons/', '/icons', '/icons/missing.png',
    '/icons/leak.txt', '/icons/dir/secret.txt', '/icons/%zz'
  ]) assert.equal(resolvePublicFile(root, bad), null, bad);
});

test('static files carry type, validators and answer If-None-Match with 304', async () => {
  const head = await raw('/icons/icon-192.png');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], 'image/png');
  assert.equal(head.headers['cache-control'], 'public, max-age=86400');
  assert.ok(head.headers.etag && head.headers['last-modified']);
  assert.deepEqual(head.body, readFileSync('public/icons/icon-192.png'));
  const again = await raw('/icons/icon-192.png', { 'if-none-match': head.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal((await raw('/icons/nope.png')).status, 404);
  assert.equal((await raw('/icons/..%2f..%2fpackage.json')).status, 404);
  assert.equal((await raw('/%2e%2e/%2e%2e/etc/passwd')).status, 404);
  const post = await fetch(`${base}/icons/icon-192.png`, { method: 'POST' });
  assert.equal(post.status, 404);
  // serveStatic falls through (false) rather than answering for non-GET.
  assert.equal(serveStatic({ method: 'DELETE', headers: {} }, {}, { root: 'public', rawPath: '/icons/icon.svg' }), false);
});

const NEVER = ['/account', '/admin', '/admin/login', '/admin/accounts', '/desk', '/desk/some-token', '/c/abc', '/q/Q-1', '/b/B-1', '/signin', '/signup', '/signout', '/invite/xyz', '/book', '/booking/1', '/ask', '/qt/tok'];
test('cachePolicy: private surfaces and anything unknown are never stored', () => {
  for (const p of NEVER) {
    assert.equal(cachePolicy(p, 'GET'), 'none', p);
    assert.equal(cachePolicy(p + '/', 'GET'), 'none', p + '/');
  }
  for (const p of ['/Admin', '/ADMIN/', '//admin', '/%61dmin', '/%41dmin/x', '/%2561dmin', '/admin%2f', '/a/../admin', '/./admin', '/x/..//admin/accounts', '/\\admin', '/notes/../admin', '/%2e%2e/admin', '/Account', '/DESK', '//c/x', '/notes/%2e%2e%2fadmin', '/%00', '/%zz', '/random', '/sw.js']) {
    assert.equal(cachePolicy(p, 'GET'), 'none', p);
  }
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(cachePolicy('/library', m), 'none');
    assert.equal(cachePolicy('/notes/a', m), 'none');
  }
});

test('cachePolicy: api is network-first, notes revalidate, the shell is the shell', () => {
  assert.equal(cachePolicy('/api/ask', 'GET'), 'network-first');
  assert.equal(cachePolicy('/API/experts/', 'GET'), 'network-first');
  assert.equal(cachePolicy('/api/question/Q-1', 'POST'), 'none');
  assert.equal(cachePolicy('/notes/seed-1-a', 'GET'), 'swr');
  assert.equal(cachePolicy('/notes/seed-1-a/', 'GET'), 'swr');
  assert.equal(cachePolicy('/notes', 'GET'), 'none');
  for (const p of ['/', '/library', '/how-it-works', '/experts', '/offline', '/manifest.webmanifest', '/icons/icon-192.png']) {
    assert.equal(cachePolicy(p, 'GET'), 'shell', p);
  }
  for (const u of SHELL_URLS) assert.equal(cachePolicy(u, 'GET'), 'shell', u);
  assert.ok(SHELL_URLS.includes('/offline'));
  assert.equal(purgesOnLogout('/signout', 'POST'), true);
  assert.equal(purgesOnLogout('/admin/logout/', 'POST'), true);
  assert.equal(purgesOnLogout('/signout', 'GET'), false);
  assert.equal(purgesOnLogout('/library', 'POST'), false);
});

test('sw.js is served with the exact policy source, a version, and scope headers', async () => {
  const res = await fetch(`${base}/sw.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(res.headers.get('service-worker-allowed'), '/');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const src = await res.text();
  assert.ok(src.includes(String(cachePolicy)), 'the served worker embeds cachePolicy verbatim');
  assert.ok(src.includes(String(purgesOnLogout)));
  assert.match(app.sw.version, /^[0-9a-f]{10}$/);
  assert.ok(src.includes(`'gemba-shell-' + VERSION`) && src.includes(`var VERSION = '${app.sw.version}'`));
  assert.ok(src.includes('/offline'));
  assert.ok(!src.includes('__'), 'no unreplaced placeholder');
  // and it is valid JavaScript
  new Function(src);
});

test('the front gate does not block the PWA files, but still blocks pages', async () => {
  const gated = createApp({ dbPath: ':memory:', rules: loadRules(), config: { ...app.config, user: 'u', pass: 'p' } });
  await new Promise((r) => gated.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${gated.server.address().port}`;
  try {
    for (const p of ['/manifest.webmanifest', '/sw.js', '/offline', '/icons/icon-192.png']) {
      assert.equal((await fetch(b + p)).status, 200, p);
    }
    assert.equal((await fetch(b + '/library')).status, 401);
  } finally {
    gated.server.close();
  }
});

test('cookie-setting and private responses say private, no-store', async () => {
  const signup = await fetch(`${base}/signup`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Pat', email: 'pat@example.com', password: 'a sentence of ten' })
  });
  assert.equal(signup.status, 303);
  assert.ok(signup.headers.get('set-cookie'));
  assert.equal(signup.headers.get('cache-control'), 'private, no-store');
  const cookie = signup.headers.get('set-cookie').split(';')[0];

  const account = await fetch(`${base}/account`, { headers: { cookie } });
  assert.equal(account.status, 200);
  assert.equal(account.headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(`${base}/admin/login`)).headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(`${base}/admin`, { redirect: 'manual' })).headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(`${base}/api/experts`)).headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(`${base}/signin`)).headers.get('cache-control'), 'private, no-store');

  // A signed-in person's other pages are not storable; a note stays cacheable for them and for guests.
  assert.equal((await fetch(`${base}/library`, { headers: { cookie } })).headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(`${base}/notes/seed-1-a`, { headers: { cookie } })).headers.get('cache-control'), null);
  assert.equal((await fetch(`${base}/notes/seed-1-a`)).headers.get('cache-control'), null);

  const out = await fetch(`${base}/signout`, { method: 'POST', redirect: 'manual', headers: { cookie } });
  assert.equal(out.headers.get('cache-control'), 'private, no-store');
});

test('the landing page links the manifest, themes the browser, and offers a hidden install button', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color" content="#ea580c" media="\(prefers-color-scheme: light\)">/);
  assert.match(html, /<meta name="theme-color" content="#141110" media="\(prefers-color-scheme: dark\)">/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-mobile-web-app-status-bar-style/);
  assert.match(html, /apple-mobile-web-app-title/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png">/);
  assert.match(html, /<button class="btn alt" type="button" data-install hidden>/);
  assert.match(html, /serviceWorker\.register\('\/sw\.js'/);
  assert.ok(!(await (await fetch(`${base}/library`)).text()).includes('data-install hidden'));
});

test('private surfaces do not emit the worker registration at all', async () => {
  for (const p of ['/admin/login', '/invite/nothing']) {
    const html = await (await fetch(base + p)).text();
    assert.ok(!html.includes('serviceWorker'), p);
    assert.ok(!html.includes('data-install hidden'), p);
  }
  // the expert desk is a tokenised page
  const desk = await (await fetch(`${base}/c/tok-h`)).text();
  assert.ok(desk.includes('Desk') && !desk.includes('serviceWorker'));
});

test('/offline is honest and links the library', async () => {
  const html = await (await fetch(`${base}/offline`)).text();
  assert.match(html, /You are offline/);
  assert.match(html, /href="\/library"/);
});
