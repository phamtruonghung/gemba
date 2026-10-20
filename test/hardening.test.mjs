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
import { upsertExpert, createUser, makeRef } from '../src/db.mjs';
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

// --- #32: refs, redaction, the homepage, claiming ----------------------------


const cookieOf = (res) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''])
  .map((c) => c.split(';')[0]).filter(Boolean).join('; ');
const post = (base, path, data, cookie = '') =>
  fetch(base + path, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...(cookie ? { cookie } : {}) }, body: enc(data) });
const refOf = (res) => res.headers.get('location').split('/').pop();
const ROOMY = { capacity: 10_000, perMs: 60_000 };
const roomy = { limits: { askIp: ROOMY, askIdentity: ROOMY, signinIp: ROOMY, signinEmail: ROOMY, signupIp: ROOMY } };

test('a ref is 80 random bits in a bank-safe alphabet, with no date and no shared prefix', () => {
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const seen = new Set();
  let longestShared = 0;
  let prev = '';
  for (let i = 0; i < 1000; i += 1) {
    const ref = makeRef('X');
    assert.match(ref, /^X-[0-9A-HJKMNP-TV-Z]{16}$/);
    assert.ok(!ref.includes(today));
    seen.add(ref);
    let k = 2;
    while (k < ref.length && ref[k] === prev[k]) k += 1;
    longestShared = Math.max(longestShared, k - 2);
    prev = ref;
  }
  assert.equal(seen.size, 1000);
  assert.ok(longestShared <= 3, `consecutive refs shared ${longestShared} characters`);
  assert.match(makeRef('B'), /^B-[0-9A-HJKMNP-TV-Z]{16}$/);
});

test('a stranger holding a ref does not get the asker, the contact or the account', async () => {
  const s = await start(roomy);
  try {
    const asked = await post(s.base, '/ask', { q: 'why does the sealing station jam every morning?', asker: 'Thu', contact: 'victim@plant.vn' });
    assert.equal(asked.status, 303);
    const ref = refOf(asked);
    const claimCookie = cookieOf(asked);
    assert.match(claimCookie, /^gemba_claims=/);
    assert.match(asked.headers.get('set-cookie'), /HttpOnly/);

    const stranger = await (await fetch(`${s.base}/api/question/${ref}`)).json();
    assert.equal(stranger.contact, undefined);
    assert.equal(stranger.asker, undefined);
    assert.equal(stranger.user_id, undefined);
    assert.equal(stranger.claim_hash, undefined);
    assert.ok(stranger.text.includes('sealing station'));
    assert.ok(Array.isArray(stranger.ai_citations));
    const page = await (await fetch(`${s.base}/q/${ref}`)).text();
    assert.ok(!page.includes('Thu') && !page.includes('victim@plant.vn'), 'the page shows a stranger neither the name nor the contact');

    const owner = await (await fetch(`${s.base}/api/question/${ref}`, { headers: { cookie: claimCookie } })).json();
    assert.equal(owner.contact, 'victim@plant.vn');
    assert.equal(owner.asker, 'Thu');
    assert.equal(owner.claim_hash, undefined);

    createUser(s.app.db, { email: 'ops@gemba.test', name: 'Ops', role: 'admin', password_hash: await hashPassword('operator-password-1') });
    const login = await post(s.base, '/admin/login', { email: 'ops@gemba.test', password: 'operator-password-1' });
    const asOperator = await (await fetch(`${s.base}/api/question/${ref}`, { headers: { cookie: cookieOf(login) } })).json();
    assert.equal(asOperator.contact, 'victim@plant.vn');
  } finally {
    s.stop();
  }
});

test('the homepage no longer lists what people asked', async () => {
  const s = await start(roomy);
  try {
    const sentence = 'zebra-crossing conveyor mislabel complaint in building nine';
    const asked = await post(s.base, '/ask', { q: sentence, asker: 'Someone' });
    assert.equal(asked.status, 303);
    const home = await (await fetch(`${s.base}/`)).text();
    assert.ok(!home.includes(sentence));
    assert.ok(!/href="\/q\//.test(home));
  } finally {
    s.stop();
  }
});

test('signing up with a stranger\'s ref claims nothing; the browser that asked, or the email it gave, does', async () => {
  const s = await start(roomy);
  try {
    const asked = await post(s.base, '/ask', { q: 'how do we stop the label printer skipping?', asker: 'Victim', contact: 'victim@plant.vn' });
    const ref = refOf(asked);
    const row = () => s.app.db.prepare('select user_id, claim_hash from questions where ref = ?').get(ref);
    assert.ok(row().claim_hash, 'a hash of the claim is stored, never the claim');
    assert.ok(!asked.headers.get('set-cookie').includes(row().claim_hash));

    const thief = await post(s.base, '/signup', { name: 'Thief', email: 'thief@evil.test', password: 'a-long-enough-password', keep: ref });
    assert.equal(thief.status, 303);
    assert.equal(thief.headers.get('location'), '/account', 'no cookie, no claim: the redirect is the account page');
    assert.equal(row().user_id, null);
    assert.ok(!(await (await fetch(`${s.base}/account`, { headers: { cookie: cookieOf(thief) } })).text()).includes(ref));

    const mine = await post(s.base, '/signup', { name: 'Victim', email: 'other@plant.vn', password: 'a-long-enough-password', keep: ref }, cookieOf(asked));
    assert.equal(mine.headers.get('location'), `/q/${ref}`);
    assert.ok(row().user_id);
    assert.equal(row().claim_hash, '', 'a claimed question has no claim left');

    const second = refOf(await post(s.base, '/ask', { q: 'what is the changeover order for the filler?', asker: 'Mai', contact: 'mai@plant.vn' }));
    const byEmail = await post(s.base, '/signup', { name: 'Mai', email: 'MAI@plant.vn', password: 'a-long-enough-password', keep: second });
    assert.equal(byEmail.headers.get('location'), `/q/${second}`);
    assert.ok(s.app.db.prepare('select user_id from questions where ref = ?').get(second).user_id);
  } finally {
    s.stop();
  }
});

test('a //evil next after sign-in goes nowhere off-site', async () => {
  const s = await start(roomy);
  try {
    createUser(s.app.db, { email: 'next@plant.vn', name: 'Next', password_hash: await hashPassword('a-long-enough-password') });
    const res = await post(s.base, '/signin', { email: 'next@plant.vn', password: 'a-long-enough-password', next: '//evil.example' });
    assert.equal(res.headers.get('location'), '/');
  } finally {
    s.stop();
  }
});

test('a stranger can send a question to a practitioner but cannot plant a contact on it', async () => {
  const s = await start(roomy);
  try {
    upsertExpert(s.app.db, { slug: 'e1', name: 'E', headline: 'h', topics: ['other', 'tpm'], years: 5, rate_vnd: 500000, token: 'tok-e1' });
    const ref = refOf(await post(s.base, '/ask', { q: 'unanswerable seasonal labour contracts outside the plant', asker: 'Anon' }));
    const row = () => s.app.db.prepare('select contact, asker, status from questions where ref = ?').get(ref);
    assert.equal(row().contact, '');
    const planted = await post(s.base, `/q/${ref}/ask-expert`, { asker: 'Mallory', contact: 'mallory@evil.test' });
    assert.equal(planted.status, 303);
    assert.equal(row().status, 'routed', 'the escalation itself still happens');
    assert.equal(row().contact, '');
    assert.equal(row().asker, 'Anon');
  } finally {
    s.stop();
  }
});

// --- #40: pragmas, indexes, a second writer, the library's pages, shutdown --------

import { spawn } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as dbm from '../src/db.mjs';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'gemba-db-')), 'gemba.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEW_INDEXES = {
  answers: 'idx_answers_question', bookings: 'idx_bookings_expert', sessions: 'idx_sessions_user',
  notes: 'idx_notes_expert', events: 'idx_events_kind', questions: 'idx_questions_user'
};

test('the database waits for a lock instead of failing at once', () => {
  const db = dbm.openDb(':memory:');
  assert.equal(db.prepare('pragma busy_timeout').get().timeout, 5000);
  assert.equal(db.prepare('pragma synchronous').get().synchronous, 1, 'normal');
});

test('a second process holding the write lock delays a write; it does not lose it', async () => {
  const path = tmpDb();
  const db = dbm.openDb(path);
  const child = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(process.argv[1]);
    d.exec('pragma busy_timeout = 5000');
    d.exec('begin immediate');
    d.prepare("insert into events (at, kind, ref, detail) values ('x', 'other-process', '', '')").run();
    console.log('locked');
    setTimeout(() => { d.exec('commit'); d.close(); }, 300);
  `, path], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (b) => String(b).includes('locked') && resolve());
      child.on('error', reject);
    });
    const t0 = performance.now();
    const q = dbm.insertQuestion(db, { text: 'written while another process held the lock', asker: '', contact: '' });
    const waited = Math.round(performance.now() - t0);
    assert.ok(q.ref);
    assert.ok(waited >= 150, `the write waited ${waited} ms for the other process`);
    console.log(`  two-writer: insert waited ${waited} ms for the other process's lock`);
  } finally {
    child.kill();
    db.close();
  }
});

test('50 parallel asks while another process takes the write lock in a loop: none is a 500', async () => {
  const path = tmpDb();
  const app = createApp({ dbPath: path, rules: loadRules(), config: baseConfig({ limits: { askIp: ROOMY, askIdentity: ROOMY, signinIp: ROOMY, signinEmail: ROOMY, signupIp: ROOMY } }) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const child = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(process.argv[1]);
    d.exec('pragma busy_timeout = 5000');
    const end = Date.now() + 3000;
    const spin = () => {
      if (Date.now() > end) { console.log('done'); return; }
      d.exec('begin immediate');
      d.prepare("insert into events (at, kind, ref, detail) values ('x', 'other-process', '', '')").run();
      setTimeout(() => { d.exec('commit'); setTimeout(spin, 20); }, 100);
    };
    console.log('started'); spin();
  `, path], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve) => child.stdout.on('data', (b) => String(b).includes('started') && resolve()));
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: `why does station ${i} stop?` }) }).then((r) => r.status)));
    const count = (code) => results.filter((c) => c === code).length;
    assert.equal(count(500), 0);
    assert.equal(count(200), 50, `statuses: 200×${count(200)}, 503×${count(503)}`);
  } finally {
    child.kill();
    await app.shutdown();
  }
});

test('an old database gets every index on next open, and the planner uses them', () => {
  const path = tmpDb();
  // The shape before accounts and money: no user_id, no claim_hash, none of the new indexes.
  const old = new DatabaseSync(path);
  old.exec(`
    create table notes (id integer primary key, expert_id integer, slug text unique not null, title text not null, topic text not null default 'other', body text not null, status text not null default 'draft', gate text not null default '{}', origin text not null default 'expert', created_at text not null default '', updated_at text not null default '');
    create table questions (id integer primary key, ref text unique not null, asker text not null default '', contact text not null default '', plant_type text not null default '', topic text not null default 'other', text text not null, ai_answer text not null default '', ai_citations text not null default '[]', ai_coverage text not null default 'thin', ai_mode text not null default '', status text not null default 'open', expert_id integer, routed_at text, due_at text, created_at text not null);
    create table answers (id integer primary key, question_id integer not null, expert_id integer, body text not null, created_at text not null);
    create table bookings (id integer primary key, ref text unique not null, expert_id integer not null, expert_name text not null default '', asker text not null default '', contact text not null default '', topic text not null default '', agenda text not null default '', starts_at text not null, minutes integer not null default 45, price_vnd integer not null default 0, fee_vnd integer not null default 0, payout_vnd integer not null default 0, status text not null default 'requested', payment_ref text not null default '', created_at text not null default '');
    create table experts (id integer primary key, slug text unique not null, name text not null, token text unique not null);
    insert into questions (ref, text, created_at) values ('X-OLD', 'old row', 'then');
  `);
  old.close();
  const db = dbm.openDb(path);
  const names = (table) => db.prepare(`pragma index_list(${table})`).all().map((i) => i.name);
  for (const [table, name] of Object.entries(NEW_INDEXES)) assert.ok(names(table).includes(name), `${table} has ${name}`);
  for (const [table, name] of [['bookings', 'idx_bookings_user'], ['bookings', 'idx_bookings_starts'], ['notes', 'idx_notes_expert'], ['questions', 'idx_questions_expert']]) {
    assert.ok(names(table).includes(name), `${table} has ${name}`);
  }
  const plan = db.prepare('explain query plan select * from answers where question_id = ?').all(1).map((r) => r.detail).join(' ');
  assert.match(plan, /idx_answers_question/);
  assert.equal(db.prepare("select ref from questions where ref = 'X-OLD'").get().ref, 'X-OLD', 'old rows survive');
  assert.doesNotThrow(() => dbm.openDb(path).close(), 'opening twice is harmless');
  console.log(`  indexes on questions: ${names('questions').join(', ')}`);
});

test('the practitioner queue is the same set as before: topic match, expert-id match, and not answered', () => {
  const db = dbm.openDb(':memory:');
  const exp = (slug, topics) => ({ id: dbm.upsertExpert(db, { slug, name: slug, headline: '', topics, years: 1, rate_vnd: 500000, token: `t-${slug}` }), topics });
  const a = exp('a', ['tpm']);
  const b = exp('b', ['quality']);
  const ask = (text, topic) => dbm.insertQuestion(db, { text, topic });
  const q1 = ask('by topic', 'tpm');
  const q2 = ask('by id', 'other');
  const q3 = ask('answered', 'tpm');
  const q4 = ask('someone else\'s', 'quality');
  const q5 = ask('not routed', 'tpm');
  for (const q of [q1, q3, q4]) dbm.routeQuestion(db, q.ref, [q.ref === q4.ref ? b.id : a.id], 'later');
  dbm.routeQuestion(db, q2.ref, [a.id], 'later');
  dbm.addAnswer(db, { questionRef: q3.ref, expertId: a.id, body: 'done' });
  assert.deepEqual(dbm.openQuestionsFor(db, { id: a.id, topics: ['tpm'] }).map((q) => q.text).sort(), ['by id', 'by topic']);
  assert.deepEqual(dbm.openQuestionsFor(db, { id: b.id, topics: ['quality'] }).map((q) => q.text), ["someone else's"]);
  assert.ok(q5);
});

test('/library shows 50 notes a page, page 2 is notes 51-100, and the links keep the topic', async () => {
  const s = await start(roomy);
  try {
    for (let i = 1; i <= 120; i += 1) {
      dbm.upsertNote(s.app.db, { expert_id: null, slug: `bulk-${String(i).padStart(3, '0')}`, title: `Bulk note number ${String(i).padStart(3, '0')}`, topic: i % 2 ? 'tpm' : 'quality', body: `Body ${i}`, status: 'published', gate: {}, origin: 'expert' });
    }
    const titles = (html) => [...html.matchAll(/Bulk note number (\d{3})/g)].map((m) => Number(m[1]));
    const uniq = (xs) => [...new Set(xs)];
    const one = await (await fetch(`${s.base}/library`)).text();
    assert.deepEqual(uniq(titles(one)), Array.from({ length: 50 }, (_, i) => i + 1));
    const two = await (await fetch(`${s.base}/library?page=2`)).text();
    assert.deepEqual(uniq(titles(two)), Array.from({ length: 50 }, (_, i) => i + 51));
    assert.match(two, /href="\/library\?page=3"/);
    assert.match(two, /href="\/library\?page=1"/);
    const topic = await (await fetch(`${s.base}/library?topic=tpm&page=2`)).text();
    assert.deepEqual(uniq(titles(topic)).map((n) => n % 2), Array(uniq(titles(topic)).length).fill(1), 'only tpm notes');
    assert.match(topic, /href="\/library\?topic=tpm&amp;page=1"/);
    assert.equal((await fetch(`${s.base}/library?page=-4`)).status, 200);
    assert.equal((await fetch(`${s.base}/library?page=999`)).status, 200);
  } finally {
    s.stop();
  }
});

test('a busy database is a 503 with Retry-After, not a stack trace', async () => {
  const s = await start();
  try {
    const real = s.app.db.prepare.bind(s.app.db);
    s.app.db.prepare = () => { throw Object.assign(new Error('database is locked'), { errcode: 5 }); };
    const res = await fetch(`${s.base}/library`);
    s.app.db.prepare = real;
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '2');
  } finally {
    s.stop();
  }
});

test('shutdown folds the WAL into the database file and closes it', async () => {
  const path = tmpDb();
  const app = createApp({ dbPath: path, rules: loadRules(), config: baseConfig() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const asked = await fetch(`${base}/ask`, { method: 'POST', headers: FORM, body: enc({ q: 'why does the line stop?' }), redirect: 'manual' });
  assert.equal(asked.status, 303);
  assert.ok(existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0, 'a write left a WAL behind');
  await app.shutdown();
  await app.shutdown(); // idempotent
  assert.ok(!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0);
  assert.equal(new DatabaseSync(path).prepare('select count(*) n from questions').get().n, 1);
});

test('SIGTERM stops the real process in under 3 s with the WAL checkpointed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemba-proc-'));
  const cwd = mkdtempSync(join(tmpdir(), 'gemba-cwd-'));
  const server = join(process.cwd(), 'src/server.mjs');
  const child = spawn(process.execPath, [server], {
    cwd,
    env: { PATH: process.env.PATH, GEMBA_DATA_DIR: dir, GEMBA_PORT: '0', GEMBA_HOST: '127.0.0.1', GEMBA_ENV_FILE: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`never listened:\n${out}`)), 8000);
      child.stdout.on('data', () => {
        const m = /listening on http:\/\/[^:]+:(\d+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
    });
    const asked = await fetch(`http://127.0.0.1:${port}/ask`, { method: 'POST', headers: FORM, body: enc({ q: 'why does the line stop?' }), redirect: 'manual' });
    assert.equal(asked.status, 303);
    const wal = join(dir, 'gemba.db-wal');
    assert.ok(existsSync(wal) && statSync(wal).size > 0, 'the ask left a WAL');
    const t0 = performance.now();
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.on('exit', resolve));
    const took = Math.round(performance.now() - t0);
    assert.equal(code, 0);
    assert.ok(took < 3000, `exited in ${took} ms`);
    assert.ok(!existsSync(wal) || statSync(wal).size === 0, 'the WAL is empty after shutdown');
    console.log(`  SIGTERM: exit ${code} in ${took} ms, WAL ${existsSync(wal) ? statSync(wal).size : 0} bytes`);
  } finally {
    child.kill('SIGKILL');
  }
});
