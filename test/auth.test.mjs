// The front gate: what a publicly reachable instance exposes, and what it does not.
// Publishing this app to a hostname means the ask form calls a paid model, so the gate
// has to be the thing that stands between the internet and the API key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp, basicAuthOk } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertNote } from '../src/db.mjs';

const USER = 'gemba';
const PASS = 'mat-khau-thu-nghiem';
const CREDS = 'Basic ' + Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64');

let app;
let base;

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0,
      host: '127.0.0.1',
      dbPath: ':memory:',
      dataDir: 'data',
      adminToken: 'tok',
      user: USER,
      pass: PASS,
      bankBin: '',
      bankAccount: '',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  upsertNote(app.db, {
    title: 'The machine stops mid-shift — what to check, in what order',
    slug: 'may-dung',
    topic: 'quan-ly-chuyen',
    body: 'Check in this order: safety, supply, material, equipment, people.',
    origin: 'demo',
    status: 'published',
    gate_decision: 'ok'
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.server.close());

test('the gate refuses an unauthenticated request with a 401 and a challenge', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /^Basic realm="gemba"/);
  const html = await res.text();
  assert.match(html, /Sign-in required/);
  assert.doesNotMatch(html, /The machine stops mid-shift/, 'a refused page must not leak corpus content');
});

test('the gate covers the API and the tokenised surfaces, not just the home page', async () => {
  for (const path of ['/library', '/api/ask', '/c/tok-hung', '/qt/tok']) {
    const res = await fetch(`${base}${path}`, { method: path.startsWith('/api') ? 'POST' : 'GET' });
    assert.equal(res.status, 401, `${path} must require the gate`);
  }
});

test('healthz answers without credentials and keeps the database path to itself', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, undefined);
});

test('the right credentials get in', async () => {
  const res = await fetch(`${base}/`, { headers: { authorization: CREDS } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Gemba|Ask/);
});

test('a wrong password, a missing colon and a foreign scheme are all refused', () => {
  const wrongPass = 'Basic ' + Buffer.from(`${USER}:sai-mat-khau`, 'utf8').toString('base64');
  const noColon = 'Basic ' + Buffer.from(`${USER}`, 'utf8').toString('base64');
  assert.equal(basicAuthOk(wrongPass, { user: USER, pass: PASS }), false);
  assert.equal(basicAuthOk(noColon, { user: USER, pass: PASS }), false);
  assert.equal(basicAuthOk(`Bearer ${PASS}`, { user: USER, pass: PASS }), false);
  assert.equal(basicAuthOk(undefined, { user: USER, pass: PASS }), false);
  assert.equal(basicAuthOk(CREDS, { user: USER, pass: PASS }), true);
});

test('with no credentials configured the app stays open (local development)', () => {
  assert.equal(basicAuthOk(undefined, { user: '', pass: '' }), true);
});
