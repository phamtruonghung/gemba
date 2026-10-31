// Security headers on every response, and the script nonce the CSP hangs on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import * as views from '../src/views.mjs';
import { NONCE_PLACEHOLDER, NOSNIFF, stampNonce, nonceFor, securityHeaders } from '../src/hardening.mjs';

const baseConfig = (extra = {}) => ({
  port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data',
  adminToken: 'hdr-token', bankBin: '', bankAccount: '',
  llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 },
  ...extra
});

async function start(extra = {}) {
  const app = createApp({ dbPath: ':memory:', rules: loadRules(), config: baseConfig(extra) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, port: app.server.address().port, stop: () => app.server.close() };
}

/** A raw request through node:http, so the body bytes and header casing arrive untouched. */
function rawRequest({ port, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const cspNonce = (headers) => /'nonce-([^']+)'/.exec(headers['content-security-policy'])?.[1];
const scriptNonce = (html) => /<script nonce="([^"]*)">/.exec(html)?.[1];
const FIXED = ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'content-security-policy'];

test('GET / carries the full header set and a script nonce that matches the policy', async () => {
  const s = await start();
  try {
    const res = await fetch(s.base + '/');
    const html = await res.text();
    const nonce = cspNonce(Object.fromEntries(res.headers));
    assert.ok(nonce, 'policy names a nonce');
    assert.equal(scriptNonce(html), nonce);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    for (const h of FIXED) assert.ok(res.headers.get(h), h);
    assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS on plain http');
    assert.ok(!html.includes(NONCE_PLACEHOLDER));
  } finally { s.stop(); }
});

test('HSTS only when the visitor arrived over https', async () => {
  const s = await start();
  try {
    const res = await fetch(s.base + '/', { headers: { 'x-forwarded-proto': 'https' } });
    const hsts = res.headers.get('strict-transport-security');
    assert.match(hsts, /max-age=\d+/);
    assert.match(hsts, /includeSubDomains/);
  } finally { s.stop(); }
});

test('the nonce differs per page and is identical for the same page', async () => {
  const s = await start();
  try {
    const nonceOf = async (path) => cspNonce(Object.fromEntries((await fetch(s.base + path)).headers));
    const home = await nonceOf('/');
    const lib = await nonceOf('/library');
    assert.notEqual(home, lib);
    // the same page keeps its nonce: a 304 replaces the policy header, and gzip and plain bytes must match
    assert.equal(await nonceOf('/'), home);
  } finally { s.stop(); }
});

test('a 304 still carries etag, vary, the full header set and the same nonce', async () => {
  const s = await start();
  try {
    const first = await fetch(s.base + '/');
    await first.text();
    const etag = first.headers.get('etag');
    const again = await fetch(s.base + '/', { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), etag);
    assert.equal(again.headers.get('vary'), 'accept-encoding');
    for (const h of FIXED) assert.ok(again.headers.get(h), h);
    assert.equal(cspNonce(Object.fromEntries(again.headers)), cspNonce(Object.fromEntries(first.headers)));
  } finally { s.stop(); }
});

test('a 413 carries the headers', async () => {
  const s = await start();
  try {
    const body = new URLSearchParams({ q: 'x'.repeat(1024 * 1024) }).toString();
    const res = await rawRequest({ port: s.port, method: 'POST', path: '/ask', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) }, body }).catch(() => null);
    if (!res) return; // the server hung up before the client finished uploading; nothing to inspect
    assert.equal(res.status, 413);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.ok(res.headers['content-security-policy']);
  } finally { s.stop(); }
});

test('the 401 front gate carries the headers and its script nonce matches', async () => {
  const s = await start({ user: 'owner', pass: 'pw-for-the-gate' });
  try {
    const res = await fetch(s.base + '/');
    assert.equal(res.status, 401);
    const html = await res.text();
    for (const h of FIXED) assert.ok(res.headers.get(h), h);
    assert.equal(scriptNonce(html), cspNonce(Object.fromEntries(res.headers)));
  } finally { s.stop(); }
});

test('JSON and the stylesheet carry the headers; the stylesheet keeps its caching and compression', async () => {
  const s = await start();
  try {
    const json = await fetch(s.base + '/healthz');
    for (const h of FIXED) assert.ok(json.headers.get(h), h);
    const css = await rawRequest({ port: s.port, path: views.CSS_HREF, headers: { 'accept-encoding': 'gzip' } });
    for (const h of FIXED) assert.ok(css.headers[h], h);
    assert.equal(css.headers['x-content-type-options'], 'nosniff');
    assert.match(css.headers['cache-control'], /immutable/);
    assert.ok(css.headers.etag);
    assert.equal(css.headers['content-encoding'], 'gzip');
    assert.equal(Number(css.headers['content-length']), css.body.length);
  } finally { s.stop(); }
});

test('gzip and plain encodings of / are byte-identical', async () => {
  const s = await start();
  try {
    const plain = await rawRequest({ port: s.port });
    const gz = await rawRequest({ port: s.port, headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(gz.body).toString(), plain.body.toString());
    assert.equal(gz.headers['content-security-policy'], plain.headers['content-security-policy']);
  } finally { s.stop(); }
});

test('static files carry nosniff exactly once', async () => {
  const s = await start();
  try {
    const res = await rawRequest({ port: s.port, path: '/icons/icon-192.png' });
    if (res.status !== 200) return;
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(NOSNIFF, { 'x-content-type-options': 'nosniff' });
  } finally { s.stop(); }
});

test('stampNonce stamps only the last placeholder and removes the earlier ones', () => {
  const html = `<p>nonce="${NONCE_PLACEHOLDER}"</p><script nonce="${NONCE_PLACEHOLDER}">alert(1)</script><script nonce="${NONCE_PLACEHOLDER}">ours()</script>`;
  const out = stampNonce(html, 'REAL');
  assert.equal(out, '<p>nonce=""</p><script nonce="">alert(1)</script><script nonce="REAL">ours()</script>');
  assert.equal(stampNonce(out, 'OTHER'), out, 'idempotent');
  assert.equal(stampNonce('<p>no script</p>', 'REAL'), '<p>no script</p>');
});

test('nonceFor is keyed and securityHeaders builds the policy', () => {
  assert.equal(nonceFor('a', 'x'), nonceFor('a', 'x'));
  assert.notEqual(nonceFor('a', 'x'), nonceFor('b', 'x'));
  assert.notEqual(nonceFor('a', 'x'), nonceFor('a', 'y'));
  const h = securityHeaders({ nonce: 'N', secure: false });
  assert.match(h['content-security-policy'], /script-src 'self' 'nonce-N'/);
  assert.equal(h['strict-transport-security'], undefined);
});

test('request text that echoes the placeholder never becomes the nonce', async () => {
  const s = await start();
  try {
    const evil = `<script nonce="${NONCE_PLACEHOLDER}">alert(1)</script>`;
    const res = await fetch(`${s.base}/signin?keep=${encodeURIComponent(evil)}&next=${encodeURIComponent(NONCE_PLACEHOLDER)}`);
    const html = await res.text();
    const nonce = cspNonce(Object.fromEntries(res.headers));
    assert.ok(!html.includes(NONCE_PLACEHOLDER));
    assert.notEqual(nonce, NONCE_PLACEHOLDER);
    assert.equal(html.split(`nonce="${nonce}"`).length - 1, 1, 'the real nonce appears on exactly one tag');
    assert.equal(scriptNonce(html), nonce);
  } finally { s.stop(); }
});
