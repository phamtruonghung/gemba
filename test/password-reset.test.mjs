// A forgotten password is reset by a one-time link the operator issues.
//
// There is no mail path on this deployment, so "send a reset email" cannot be built: the operator
// generates the link on the Accounts screen and hands it over the way they already reach the person.
// What the link proves is that the change was asked for, which is why it dies on first use and why a
// locked account's link is refused instead of quietly accepting a password nobody can sign in with.
//
// The assertions are HTTP-level: a real client, a real server, the same door a browser uses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { hashPassword, secretHash } from '../src/auth.mjs';

// Not under test here: the limiter has its own tests (test/hardening.test.mjs); this fixture signs up
// and signs in many times from one address.
const R = { capacity: 10_000, perMs: 60_000 };
let app;
let base;

const ADMIN_EMAIL = 'operator@gemba.test';
const ADMIN_PASSWORD = 'a-long-enough-operator-password';
const OLD = 'the-password-before-the-reset';
const NEW = 'the-password-after-the-reset';

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data',
      adminToken: 'admin-token',
      limits: { askIp: R, askIdentity: R, signinIp: R, signinEmail: R, signupIp: R }, bankBin: '', bankAccount: '',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  app.rebuildIndex();
  app.db.prepare('insert into users (email, name, password_hash, role, status, created_at) values (?, ?, ?, ?, ?, ?)')
    .run(ADMIN_EMAIL, 'Operator', await hashPassword(ADMIN_PASSWORD), 'admin', 'active', new Date().toISOString());
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.server.close());

const cookieOf = (res) =>
  (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');

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
    body: new URLSearchParams(data).toString()
  });
}
const get = (path, cookie = '') => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const text = (res) => res.text();

const asOperator = async () => cookieOf(await post('/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }));
const userBy = (email) => app.db.prepare('select * from users where email = ?').get(email);
const resetRowsFor = (userId) => app.db.prepare('select * from password_resets where user_id = ? order by created_at').all(userId);

let n = 0;
/** A fresh asker, created the way a stranger creates one, signed in. */
async function newAsker() {
  const email = `asker${++n}@gemba.test`;
  const res = await post('/signup', { name: `Asker ${n}`, email, password: OLD });
  assert.equal(res.status, 303, 'the signup form posts');
  return { email, cookie: cookieOf(res), id: userBy(email).id };
}

/** Issue a reset link the way the operator does, and return the token from the page they land on. */
async function issueLink(adminCookie, userId) {
  const res = await post(`/admin/accounts/${userId}/reset`, {}, adminCookie);
  assert.equal(res.status, 303, 'the reset action redirects back to the accounts page');
  const location = res.headers.get('location');
  assert.match(location, /^\/admin\/accounts\?reset=/);
  const page = await text(await get(location, adminCookie));
  const link = /class="mono" href="\/reset\/([^"]+)"/.exec(page);
  assert.ok(link, 'the page the operator lands on shows the link once');
  return decodeURIComponent(link[1]);
}

test('a one-time link lets the person choose a new password, and works exactly once', async () => {
  const asker = await newAsker();
  const admin = await asOperator();
  const token = await issueLink(admin, asker.id);

  // The link opens without a session — the whole point is that the person cannot sign in.
  const form = await get(`/reset/${token}`);
  assert.equal(form.status, 200);
  const page = await text(form);
  assert.match(page, /Choose a new password/);
  assert.match(page, new RegExp(asker.email), 'the page names the account the link is for');

  // Two different passwords change nothing: this is the one screen where a typo locks the person out
  // and there is no email to recover from.
  const mismatch = await post(`/reset/${token}`, { password: NEW, password2: 'something-else-entirely' });
  assert.equal(mismatch.status, 400);
  assert.match(await text(mismatch), /The two passwords do not match/);
  assert.equal(resetRowsFor(asker.id).filter((r) => r.used_at).length, 0, 'a refused form does not spend the link');

  const tooShort = await post(`/reset/${token}`, { password: 'short', password2: 'short' });
  assert.equal(tooShort.status, 400);
  assert.match(await text(tooShort), /at least 10 characters/);

  const done = await post(`/reset/${token}`, { password: NEW, password2: NEW });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), '/account');
  const fresh = cookieOf(done);
  assert.ok(fresh, 'setting the password signs the person in');

  // The new password works and the old one does not.
  assert.equal((await post('/signin', { email: asker.email, password: OLD })).status, 401);
  const signedIn = await post('/signin', { email: asker.email, password: NEW });
  assert.equal(signedIn.status, 303);

  // Every session minted with the old password is gone, including the one signup created.
  const stale = await get('/account', asker.cookie);
  assert.equal(stale.status, 303, 'the pre-reset session no longer reaches /account');
  assert.match(stale.headers.get('location'), /^\/signin/);
  assert.equal((await get('/account', fresh)).status, 200, 'the session minted by the reset works');

  // Second use of the same link is refused, and the row says it was used.
  const again = await post(`/reset/${token}`, { password: 'another-password-entirely', password2: 'another-password-entirely' });
  assert.equal(again.status, 410);
  assert.match(await text(again), /already been used/);
  assert.equal(resetRowsFor(asker.id).filter((r) => r.used_at).length, 1);
});

test('a link that is unknown, expired, or superseded says which it is', async () => {
  const asker = await newAsker();
  const admin = await asOperator();

  assert.equal((await get('/reset/not-a-token-we-issued')).status, 404);

  // Expiry is computed from the row, so a row created a day in the past is a link that has lapsed.
  app.db.prepare('insert into password_resets (token, user_id, created_at, expires_at) values (?, ?, ?, ?)')
    .run(secretHash('expired-token'), asker.id, new Date(Date.now() - 8 * 86400_000).toISOString(), new Date(Date.now() - 86400_000).toISOString());
  const expired = await get('/reset/expired-token');
  assert.equal(expired.status, 410);
  assert.match(await text(expired), /expired/);

  // Issuing a second link retires the first: an operator cannot leave two ways in.
  const first = await issueLink(admin, asker.id);
  const second = await issueLink(admin, asker.id);
  assert.notEqual(first, second);
  assert.equal((await get(`/reset/${first}`)).status, 404, 'the superseded link is gone, not merely refused');
  assert.equal((await get(`/reset/${second}`)).status, 200);
});

test('only an operator issues a link, and never for a locked account', async () => {
  const asker = await newAsker();
  const victim = await newAsker();

  // An ordinary account posting the action is not the operator: the console sends it to sign-in.
  const refused = await post(`/admin/accounts/${victim.id}/reset`, {}, asker.cookie);
  assert.equal(refused.status, 303);
  assert.match(refused.headers.get('location'), /^\/admin\/login/);
  assert.equal(resetRowsFor(victim.id).length, 0, 'no link was issued');

  // A locked account can never sign in, so its link would be a dead address handed over as a fix.
  const admin = await asOperator();
  const lock = await post(`/admin/accounts/${victim.id}/lock`, {}, admin);
  assert.equal(lock.status, 303);
  const refusedLocked = await post(`/admin/accounts/${victim.id}/reset`, {}, admin);
  assert.equal(refusedLocked.status, 303);
  assert.equal(refusedLocked.headers.get('location'), '/admin/accounts?reset_locked=1');
  assert.match(await text(await get('/admin/accounts?reset_locked=1', admin)), /Unlock it first/);
  assert.equal(resetRowsFor(victim.id).length, 0);

  // A link that existed before the lock is refused too, with the reason on the page.
  app.db.prepare('insert into password_resets (token, user_id, created_at, expires_at) values (?, ?, ?, ?)')
    .run(secretHash('locked-token'), victim.id, new Date().toISOString(), new Date(Date.now() + 86400_000).toISOString());
  const locked = await get('/reset/locked-token');
  assert.equal(locked.status, 403);
  assert.match(await text(locked), /locked/);
});

test('the sign-in page offers the way out, and the console offers the control', async () => {
  const page = await text(await get('/signin'));
  assert.match(page, /Forgot your password\?/);
  assert.match(page, /one-time link/, 'the page says what actually happens, not "contact support"');
  assert.match(page, /Accounts screen/);

  const asker = await newAsker();
  const admin = await asOperator();
  const console_ = await text(await get('/admin/accounts', admin));
  assert.match(console_, new RegExp(`action="/admin/accounts/${asker.id}/reset"`), 'each row carries the control');
  assert.match(console_, /nothing is emailed on this deployment/);
});
