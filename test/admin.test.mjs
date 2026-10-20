// The operator surface: roles, a real login, and prices that are settings rather than constants.
//
// The console at /qt/<token> can mark a booking paid and nothing else. Everything that creates people
// or changes money now lives behind a signed-in admin at /admin — and the tests below are the ones that
// decide whether that is true: an asker must not reach it, a locked account must not sign in, a price
// must be an integer in range, and every change must say who made it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, upsertNote, createUser } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';
import { loadSettings, SETTING_SPECS } from '../src/settings.mjs';

// Not under test here: the limiter has its own tests (test/hardening.test.mjs); this fixture signs in many times from one address.
const R = { capacity: 10_000, perMs: 60_000 };
let app;
let base;

const ADMIN_EMAIL = 'operator@gemba.test';
const ADMIN_PASSWORD = 'a-long-enough-operator-password';

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data',
      adminToken: 'admin-token',
      limits: { askIp: R, askIdentity: R, signinIp: R, signinEmail: R, signupIp: R }, bankBin: '', bankAccount: '',
      gate: { user: '', pass: '' },
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  const id = upsertExpert(app.db, {
    slug: 'hung-qa', name: 'Hung', headline: 'Production supervisor', topics: ['shift-management'],
    years: 20, rate_vnd: 800000, token: 'tok'
  });
  const raw = readFileSync(join('seed/corpus', 'demo-machine-stops-mid-shift.md'), 'utf8');
  upsertNote(app.db, {
    expert_id: id, slug: 'seed-1',
    title: /^title:\s*(.+)$/m.exec(raw)[1].trim(),
    topic: /^topic:\s*(.+)$/m.exec(raw)[1].trim(),
    body: raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim(),
    status: 'published', gate: { verdict: 'clean', findings: [] }, origin: 'demo'
  });
  app.rebuildIndex();
  // the operator account, created the way scripts/admin-create.mjs creates it
  app.db.prepare('insert into users (email, name, password_hash, role, status, created_at) values (?, ?, ?, ?, ?, ?)')
    .run(ADMIN_EMAIL, 'Operator', await hashPassword(ADMIN_PASSWORD), 'admin', 'active', new Date().toISOString());
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.server.close());

const cookieOf = (res) =>
  (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');

const form = (data) => new URLSearchParams(data).toString();

// A client following the protocol: a signed-in POST carries the session's CSRF token, read from the page
// the way a browser would (the hidden field the server injects into every post form).
const csrfCache = new Map();
async function csrfOf(cookie) {
  if (!csrfCache.has(cookie)) {
    const html = await (await fetch(`${base}/account`, { redirect: 'manual', headers: { cookie } })).text();
    csrfCache.set(cookie, /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '');
  }
  return csrfCache.get(cookie);
}

async function post(path, data = {}, cookie = '') {
  if (cookie && data.csrf === undefined) { const csrf = await csrfOf(cookie); if (csrf) data = { ...data, csrf }; }
  return fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: form(data)
  });
}
const get = (path, cookie = '') => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });

async function signUpAsAsker(email = 'asker@gemba.test') {
  const res = await post('/signup', { name: 'An Asker', email, password: 'a-long-enough-password' });
  return { res, cookie: cookieOf(res) };
}
async function signInAsOperator() {
  const res = await post('/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return { res, cookie: cookieOf(res) };
}

test('an asker cannot reach the operator pages', async () => {
  const { cookie } = await signUpAsAsker();
  const anon = await get('/admin');
  assert.equal(anon.status, 303, 'a visitor with no session is sent to the login');
  assert.match(anon.headers.get('location'), /\/admin\/login/);

  const asker = await get('/admin', cookie);
  assert.equal(asker.status, 303, 'and so is a signed-in asker — a role, not a session, decides this');
  assert.match(asker.headers.get('location'), /\/admin\/login/);
});

test('the operator signs in, and the pages open', async () => {
  const bad = await post('/admin/login', { email: ADMIN_EMAIL, password: 'wrong-password-entirely' });
  assert.equal(bad.status, 401, 'a wrong password is refused');
  assert.equal(cookieOf(bad), '', 'and sets no session');

  const { res, cookie } = await signInAsOperator();
  assert.equal(res.status, 303);
  assert.ok(cookie.includes('gemba_session='), 'a session cookie is set');
  assert.equal(res.headers.get('location'), '/admin', 'and it lands on the console, not on the marketing page');

  const page = await get('/admin', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Operator/);
  // What this slice ships. Experts, accounts, invites and bookings arrive in the next two slices and
  // are asserted there — a nav that links a page nobody built is worse than a short nav.
  for (const surface of ['Overview', 'Settings', 'Audit']) {
    assert.match(html, new RegExp(surface), `the operator nav links ${surface}`);
  }

  // and the audit trail names the person, not just the action
  const rows = app.db.prepare("select kind, detail from events where kind = 'admin_login' order by id desc").all();
  assert.ok(rows.length >= 1, 'the sign-in is recorded');
  assert.match(rows[0].detail, /operator@gemba\.test/, 'who did it is in the record');
});

test('a locked account cannot sign in, and signing in again does not resurrect it', async () => {
  const email = 'locked@gemba.test';
  await signUpAsAsker(email);
  app.db.prepare("update users set status = 'locked' where email = ?").run(email);

  const res = await post('/signin', { email, password: 'a-long-enough-password' });
  assert.equal(res.status, 403, 'a locked account is refused');
  assert.equal(cookieOf(res), '', 'and gets no session');
});

test('prices are settings: integers, in range, and they change what a booking costs', async () => {
  const { cookie } = await signInAsOperator();

  const before = loadSettings(app.db);
  assert.equal(before.platform_take_rate, SETTING_SPECS.platform_take_rate.fallback,
    'an instance with no settings row behaves exactly as it did before this existed');

  const notANumber = await post('/admin/settings', { platform_take_rate: 'twenty' }, cookie);
  assert.equal(notANumber.status, 400, 'a non-integer is refused');

  const outOfRange = await post('/admin/settings', { platform_take_rate: '90' }, cookie);
  assert.equal(outOfRange.status, 400, 'a share above the ceiling is refused');

  const ok = await post('/admin/settings', { platform_take_rate: '25', min_minutes: '30', default_minutes: '45', default_rate_vnd: '800000' }, cookie);
  assert.equal(ok.status, 303, 'a valid change is accepted');
  const after = loadSettings(app.db);
  assert.equal(after.platform_take_rate, 25);
  assert.equal(after.min_minutes, 30);

  // and it reaches the money: a 45-minute session at 800,000/h with a 25% share
  const booking = await post('/book', { expert: 'hung-qa', agenda: 'a session', starts_at: '2030-11-01 09:00', minutes: '45', contact: 'a@b.c' });
  assert.equal(booking.status, 303, 'the booking is created');
  const row = app.db.prepare("select price_vnd, fee_vnd, payout_vnd from bookings order by id desc limit 1").get();
  assert.equal(row.price_vnd, 600000, '45 minutes at 800,000/h');
  assert.equal(row.fee_vnd, 150000, '25% of it, not the old 20%');
  assert.equal(row.payout_vnd, row.price_vnd - row.fee_vnd, 'integer VND, no rounding drift');
});

test('a rejected setting is not written, and an accepted one is audited', async () => {
  const { cookie } = await signInAsOperator();
  await post('/admin/settings', { platform_take_rate: '30', min_minutes: '30', default_minutes: '45', default_rate_vnd: '800000' }, cookie);

  const bad = await post('/admin/settings', { platform_take_rate: '30', min_minutes: '0', default_minutes: '45', default_rate_vnd: '800000' }, cookie);
  assert.equal(bad.status, 400);
  assert.equal(loadSettings(app.db).min_minutes, 30, 'the rejected form left the stored value alone');

  const row = app.db.prepare("select ref, detail from events where kind = 'setting' order by id desc limit 1").get();
  assert.ok(row, 'the change is in the audit trail');
  assert.match(row.detail, /operator@gemba\.test/, 'with the actor named');
});

test('settings refuse a value that is not an integer even through the form', async () => {
  const { cookie } = await signInAsOperator();
  for (const value of ['1.5', '-10', '', '1e3', 'twenty']) {
    const res = await post('/admin/settings', { platform_take_rate: value, min_minutes: '30', default_minutes: '45', default_rate_vnd: '800000' }, cookie);
    assert.equal(res.status, 400, `"${value}" is refused as a platform share`);
  }
  // A copy-pasted value with a stray space is a person typing, not an attack: trim, then require digits.
  const padded = await post('/admin/settings', { platform_take_rate: ' 42 ', min_minutes: '30', default_minutes: '45', default_rate_vnd: '800000' }, cookie);
  assert.equal(padded.status, 303, 'a padded integer is read as the integer it is');
  assert.equal(loadSettings(app.db).platform_take_rate, 42);
});

test('the gate protects anonymous visitors, and steps aside for a session', async () => {
  // The whole point of the shared password is the anonymous surface. Once someone has an account, a
  // password every expert also has to hold is the weakest link in the chain — so a request carrying a
  // valid session passes, and the screens that exist *to* authenticate stay reachable, or nobody could
  // ever sign in to become authenticated.
  const gated = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data',
      adminToken: 'gated-token',
      limits: { askIp: R, askIdentity: R, signinIp: R, signinEmail: R, signupIp: R }, bankBin: '', bankAccount: '',
      user: 'gate-user', pass: 'gate-password',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  await new Promise((r) => gated.server.listen(0, '127.0.0.1', r));
  const gbase = `http://127.0.0.1:${gated.server.address().port}`;
  try {
    const anon = await fetch(`${gbase}/`, { redirect: 'manual' });
    assert.equal(anon.status, 401, 'an anonymous visitor meets the gate');

    for (const open of ['/admin/login', '/signin']) {
      const res = await fetch(gbase + open, { redirect: 'manual' });
      assert.equal(res.status, 200, `${open} must be reachable without the gate — it is how you sign in`);
    }
    // /signup is not one of them: it was a way to mint an account, and so a session, around the gate.
    assert.equal((await fetch(`${gbase}/signup`, { redirect: 'manual' })).status, 401, 'a gated instance does not offer /signup anonymously');
    const invite = await fetch(`${gbase}/invite/some-single-use-token`, { redirect: 'manual' });
    assert.notEqual(invite.status, 401, 'and so must an invitation link');

    // an account made by the operator signs in at the still-open door, then walks back with only the session
    createUser(gated.db, { email: 'walker@gemba.test', name: 'Gate Walker', password_hash: await hashPassword('a-long-enough-password') });
    const signin = await fetch(`${gbase}/signin`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ email: 'walker@gemba.test', password: 'a-long-enough-password' })
    });
    const cookie = cookieOf(signin);
    assert.ok(cookie.includes('gemba_session='), 'the account signed in through the open door');
    const withSession = await fetch(`${gbase}/`, { redirect: 'manual', headers: { cookie } });
    assert.equal(withSession.status, 200, 'a signed-in visitor does not need the shared password');
  } finally {
    gated.server.close();
  }
});
