// Security and data integrity: what a stranger can do to an instance, and what the instance now refuses.
// Each test below fails on the commit before the one that introduced it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createApp, basicAuthOk, loadConfig } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, createUser } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';

const baseConfig = (extra = {}) => ({
  port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data',
  adminToken: 'hard-token', bankBin: '', bankAccount: '',
  llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 },
  ...extra
});

async function start(extra = {}) {
  const app = createApp({ dbPath: ':memory:', rules: loadRules(), config: baseConfig(extra) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, port: app.server.address().port, stop: () => app.server.close() };
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const enc = (o) => new URLSearchParams(o).toString();

/** A raw request through node:http, for the cases fetch cannot express (no content-length, a hung header). */
function rawRequest({ port, method = 'POST', path = '/', headers = {}, chunks = [] }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    (async () => {
      for (const c of chunks) {
        if (!req.write(c)) await new Promise((r) => req.once('drain', r));
      }
      req.end();
    })().catch(() => {});
  });
}

// --- #33: the body cap -------------------------------------------------------

test('a 1 MiB POST is refused with 413 and the server keeps answering', async () => {
  const s = await start();
  try {
    const big = enc({ q: 'x'.repeat(1024 * 1024) });
    for (const path of ['/ask', '/signup']) {
      const res = await fetch(s.base + path, { method: 'POST', headers: FORM, body: big, redirect: 'manual' }).catch((e) => ({ status: `fetch: ${e.cause?.code ?? e.message}` }));
      // the server may hang up while the client still uploads; either way no 2xx/3xx came back
      assert.ok(res.status === 413 || String(res.status).startsWith('fetch'), `${path} -> ${res.status}`);
    }
    const viaHttp = await rawRequest({ port: s.port, path: '/ask', headers: { ...FORM, 'content-length': Buffer.byteLength(big) }, chunks: [big] }).catch(() => ({ status: 'closed' }));
    assert.ok(viaHttp.status === 413 || viaHttp.status === 'closed', `declared length: ${viaHttp.status}`);
    const declaredOnly = await rawRequest({ port: s.port, path: '/ask', headers: { ...FORM, 'content-length': String(1024 * 1024) }, chunks: ['q=a'] });
    assert.equal(declaredOnly.status, 413, 'a declared length over the cap is refused before the body is read');
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
  } finally {
    s.stop();
  }
});

test('a chunked 1 MiB POST with no content-length is cut off at the cap with 413', async () => {
  const s = await start();
  try {
    const chunk = 'q=' + 'x'.repeat(16 * 1024);
    const res = await rawRequest({ port: s.port, path: '/ask', headers: { ...FORM, 'transfer-encoding': 'chunked' }, chunks: Array(64).fill(chunk) });
    assert.equal(res.status, 413);
  } finally {
    s.stop();
  }
});

test('a practitioner can still post a 100 KiB note', async () => {
  const s = await start();
  try {
    upsertExpert(s.app.db, { slug: 'big-note', name: 'Big', headline: 'h', topics: ['tpm'], years: 5, rate_vnd: 500000, token: 'tok-big' });
    const res = await fetch(`${s.base}/c/tok-big/note`, {
      method: 'POST', headers: FORM, redirect: 'manual',
      body: enc({ title: 'A long note', topic: 'tpm', body: 'Dừng máy rồi kiểm tra từng bước. '.repeat(3000) })
    });
    assert.notEqual(res.status, 413);
    assert.ok([303, 422].includes(res.status), `status ${res.status}`);
  } finally {
    s.stop();
  }
});

test('a question over 2,000 characters is a 400, not a stored 20 MB row', async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/ask`, { method: 'POST', headers: FORM, body: enc({ q: 'a'.repeat(2001) }), redirect: 'manual' });
    assert.equal(res.status, 400);
    assert.equal(s.app.db.prepare('select count(*) n from questions').get().n, 0);
  } finally {
    s.stop();
  }
});

// --- #33: rate limits --------------------------------------------------------

test('the eleventh ask in a minute from one address is 429 with Retry-After', async () => {
  const s = await start();
  try {
    const statuses = [];
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await fetch(`${s.base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: `why does the line stop number ${i}?` }) });
      statuses.push(last.status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.equal(statuses[10], 429);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    assert.deepEqual(await last.json(), { error: 'rate limited' });
  } finally {
    s.stop();
  }
});

test('the sixth failed sign-in in a minute is 429, and it cost no scrypt', async () => {
  const s = await start();
  try {
    const attempt = () => fetch(`${s.base}/signin`, { method: 'POST', headers: FORM, body: enc({ email: 'nobody@plant.vn', password: 'wrong-password-1' }), redirect: 'manual' });
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt()).status, 401);
    const started = performance.now();
    const res = await attempt();
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    assert.match(await res.text(), /href=/, 'the page offers a way back');
    // no account exists, so a refused attempt could never have run scrypt; the next one proves it for a real one
    assert.ok(performance.now() - started < 200);
  } finally {
    s.stop();
  }
});

test('a refused sign-in attempt runs no password hashing at all', async () => {
  const s = await start();
  try {
    createUser(s.app.db, { email: 'real@plant.vn', name: 'Real', password_hash: await hashPassword('the-right-password') });
    const attempt = () => fetch(`${s.base}/signin`, { method: 'POST', headers: FORM, body: enc({ email: 'real@plant.vn', password: 'not-the-password' }), redirect: 'manual' });
    for (let i = 0; i < 5; i += 1) await attempt();
    const t0 = performance.now();
    assert.equal((await attempt()).status, 429);
    const refused = performance.now() - t0;
    const t1 = performance.now();
    await hashPassword('timing probe');
    const oneHash = performance.now() - t1;
    assert.ok(refused < oneHash / 2, `refused in ${refused.toFixed(1)} ms, one hash takes ${oneHash.toFixed(1)} ms`);
  } finally {
    s.stop();
  }
});

test('behind the tunnel the limiter keys on the address the proxy reports, only when told to trust it', async () => {
  const ask = (base, ip) => fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ question: 'why does the line stop?' }) });
  const direct = await start();
  try {
    for (let i = 0; i < 10; i += 1) await ask(direct.base, `203.0.113.${i}`);
    assert.equal((await ask(direct.base, '203.0.113.99')).status, 429, 'a forged header does not buy a fresh bucket');
  } finally {
    direct.stop();
  }
  const proxied = await start({ trustProxy: true });
  try {
    for (let i = 0; i < 10; i += 1) assert.equal((await ask(proxied.base, '203.0.113.7')).status, 200);
    assert.equal((await ask(proxied.base, '203.0.113.7')).status, 429);
    assert.equal((await ask(proxied.base, '203.0.113.8')).status, 200, 'another visitor behind the same proxy has their own budget');
  } finally {
    proxied.stop();
  }
});

// --- #33: methods, errors, the gate, timeouts --------------------------------

test('PUT, DELETE, TRACE and OPTIONS are 405 with an Allow header', async () => {
  const s = await start();
  try {
    for (const method of ['PUT', 'DELETE', 'TRACE', 'OPTIONS']) {
      const res = await rawRequest({ port: s.port, method, path: '/' });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, 'GET, HEAD, POST');
    }
  } finally {
    s.stop();
  }
});

test('a bad escape is a 400, a bad type is a 400, and a crash shows the visitor no code', async () => {
  const s = await start();
  try {
    assert.equal((await fetch(`${s.base}/notes/%E0%A4%A`)).status, 400);
    const num = await fetch(`${s.base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 12345 }) });
    assert.equal(num.status, 200, 'a number is read as its text, not a crash');
    const empty = await fetch(`${s.base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '' }) });
    assert.equal(empty.status, 400);

    const real = s.app.db.prepare.bind(s.app.db);
    s.app.db.prepare = () => { throw new Error('boom at /src/server.mjs file:///x.mjs'); };
    const origError = console.error;
    console.error = () => {};
    const res = await fetch(`${s.base}/library`);
    s.app.db.prepare = real;
    console.error = origError;
    assert.equal(res.status, 500);
    const text = await res.text();
    for (const leak of ['at ', '/src/', 'file://', '.mjs', 'boom']) assert.ok(!text.includes(leak), `500 body leaked ${JSON.stringify(leak)}`);
    assert.match(text, /reference [0-9a-f]{8}/);
  } finally {
    s.stop();
  }
});

test('a half-configured gate fails closed, and refuses to start', () => {
  assert.equal(basicAuthOk(undefined, { user: 'u', pass: '' }), false);
  assert.equal(basicAuthOk(undefined, { user: '', pass: 'p' }), false);
  assert.equal(basicAuthOk(undefined, { user: '', pass: '' }), true, 'no gate at all is open');
  const cwd = process.cwd();
  const tmp = mkdtempSync(join(tmpdir(), 'gemba-cfg-'));
  process.chdir(tmp);
  const saved = process.env.GEMBA_ENV_FILE;
  process.env.GEMBA_ENV_FILE = '/dev/null';
  try {
    assert.throws(() => loadConfig({ GEMBA_USER: 'u', GEMBA_DATA_DIR: tmp }), /set both GEMBA_USER and GEMBA_PASS/);
    assert.throws(() => loadConfig({ GEMBA_PASS: 'p', GEMBA_DATA_DIR: tmp }), /set both/);
    assert.doesNotThrow(() => loadConfig({ GEMBA_USER: 'u', GEMBA_PASS: 'p', GEMBA_DATA_DIR: tmp }));
  } finally {
    process.chdir(cwd);
    if (saved === undefined) delete process.env.GEMBA_ENV_FILE; else process.env.GEMBA_ENV_FILE = saved;
  }
});

test('a gated instance answers /signup anonymously with 401, GET and POST', async () => {
  const s = await start({ user: 'u', pass: 'p-long-enough' });
  try {
    assert.equal((await fetch(`${s.base}/signup`)).status, 401);
    const post = await fetch(`${s.base}/signup`, { method: 'POST', headers: FORM, body: enc({ name: 'Stranger', email: 'stranger@x.vn', password: 'a-long-enough-password' }), redirect: 'manual' });
    assert.equal(post.status, 401);
    assert.equal(s.app.db.prepare('select count(*) n from users').get().n, 0);
  } finally {
    s.stop();
  }
});

test('a client that never finishes its headers is hung up on', async () => {
  const s = await start({ timeouts: { headersTimeout: 300, requestTimeout: 600, connectionsCheckingInterval: 100 } });
  try {
    const t0 = Date.now();
    const closed = await new Promise((resolve) => {
      const sock = net.connect(s.port, '127.0.0.1', () => sock.write('GET / HTTP/1.1\r\nHost: x\r\n'));
      sock.on('data', () => {});
      sock.on('close', () => resolve(true));
      sock.on('error', () => resolve(true));
      setTimeout(() => { sock.destroy(); resolve(false); }, 4000);
    });
    assert.ok(closed, 'the server closed the connection');
    assert.ok(Date.now() - t0 < 2500, `closed after ${Date.now() - t0} ms`);
  } finally {
    s.stop();
    s.app.server.closeAllConnections?.();
  }
});
