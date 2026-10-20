// Accounts: the password/session primitives, and the two routes that use them, over real HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, upsertNote } from '../src/db.mjs';
import {
  hashPassword, verifyPassword, checkEmail, checkPassword, checkName,
  parseCookies, isSecureRequest, sessionCookie, clearedSessionCookie, sessionExpiry, SESSION_COOKIE
} from '../src/auth.mjs';

// Not under test here: the limiter has its own tests (test/hardening.test.mjs); this fixture signs in many times from one address.
const R = { capacity: 10_000, perMs: 60_000 };
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
      adminToken: 'admin-token',
      limits: { askIp: R, askIdentity: R, signinIp: R, signinEmail: R, signupIp: R },
      bankBin: '',
      bankAccount: '',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  const id = upsertExpert(app.db, {
    slug: 'hung-qa', name: 'Hung', headline: 'Production supervisor', topics: ['shift-management'],
    years: 20, rate_vnd: 800000, token: 'tok'
  });
  const raw = readFileSync(join('seed/corpus', 'demo-machine-stops-mid-shift.md'), 'utf8');
  upsertNote(app.db, {
    expert_id: id,
    slug: 'seed-1',
    title: /^title:\s*(.+)$/m.exec(raw)[1].trim(),
    topic: /^topic:\s*(.+)$/m.exec(raw)[1].trim(),
    body: raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim(),
    status: 'published',
    gate: { verdict: 'clean', findings: [] },
    origin: 'demo'
  });
  app.rebuildIndex();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.server.close());

const cookieOf = (res) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''])
  .map((c) => c.split(';')[0])
  .filter(Boolean)
  .join('; ');

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
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(data)
  });
}

// --- the primitives --------------------------------------------------------

test('auth: a password verifies against its own hash, and only its own', async () => {
  const hash = await hashPassword('a long enough sentence');
  assert.match(hash, /^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/, 'the parameters travel with the hash');
  assert.equal(await verifyPassword('a long enough sentence', hash), true);
  assert.equal(await verifyPassword('a longer enough sentence', hash), false);
});

test('auth: the same password hashes differently every time (per-user salt)', async () => {
  const a = await hashPassword('same password here');
  const b = await hashPassword('same password here');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same password here', a), true);
  assert.equal(await verifyPassword('same password here', b), true);
});

test('auth: a corrupt or foreign hash fails closed instead of throwing', async () => {
  for (const stored of ['', 'nonsense', 'bcrypt$whatever', 'scrypt$1$2$3$4$5', null, undefined]) {
    assert.equal(await verifyPassword('anything at all', stored), false, `stored=${stored}`);
  }
});

test('auth: validation asks for length, not for symbols', () => {
  assert.equal(checkEmail('Hung@Example.COM').value, 'hung@example.com', 'emails are normalised');
  assert.equal(checkEmail('not-an-email').ok, false);
  assert.equal(checkPassword('short').ok, false);
  assert.equal(checkPassword('a sentence I can remember').ok, true);
  assert.equal(checkName('  Hung   Nguyen ').value, 'Hung Nguyen', 'names are collapsed, not rejected');
  assert.equal(checkName('x').ok, false);
});

test('auth: cookies are HttpOnly and SameSite, and Secure only when the request was HTTPS', () => {
  const plain = sessionCookie('abc', { secure: false });
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.match(plain, /Path=\//);
  assert.doesNotMatch(plain, /Secure/, 'a Secure cookie on a plain-HTTP LAN instance would never come back');
  assert.match(sessionCookie('abc', { secure: true }), /Secure/);
  assert.match(clearedSessionCookie(), /Max-Age=0/);
  assert.ok(new Date(sessionExpiry()) > new Date());
});

test('auth: cookie parsing survives the header shapes a browser actually sends', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' }, 'cookie values are strings, as the header gives them');
  assert.deepEqual(parseCookies('junk; a=1'), { a: '1' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(parseCookies(`${SESSION_COOKIE}=xyz`)[SESSION_COOKIE], 'xyz');
});

test('auth: the forwarded protocol is what decides "secure", not the socket', () => {
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https, http' } }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(isSecureRequest({ headers: {} }), false);
});

// --- over HTTP -------------------------------------------------------------

test('accounts: sign up sets a session, and the account page is that person’s page', async () => {
  const res = await post('/signup', { name: 'Lan', email: 'lan@example.com', password: 'a sentence of ten' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/account');
  const cookie = cookieOf(res);
  assert.match(cookie, /gemba_session=/);

  const page = await fetch(`${base}/account`, { headers: { cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /Signed in as Lan/);
  assert.doesNotMatch(html, /scrypt\$/, 'the password hash must never reach a page');
});

test('accounts: the same email cannot be registered twice', async () => {
  await post('/signup', { name: 'First', email: 'dup@example.com', password: 'a sentence of ten' });
  const res = await post('/signup', { name: 'Second', email: 'DUP@example.com', password: 'a sentence of ten' });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /already an account with that email/i);
});

test('accounts: a bad password and an unknown email give the same answer', async () => {
  await post('/signup', { name: 'Third', email: 'third@example.com', password: 'a sentence of ten' });
  const wrongPassword = await post('/signin', { email: 'third@example.com', password: 'definitely not it' });
  const noSuchUser = await post('/signin', { email: 'nobody@example.com', password: 'definitely not it' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchUser.status, 401);
  const [a, b] = [await wrongPassword.text(), await noSuchUser.text()];
  const message = /That email and password do not match an account\./;
  assert.match(a, message);
  assert.match(b, message);
});

test('accounts: a short password is refused at sign-up with the error next to the field', async () => {
  const res = await post('/signup', { name: 'Shorty', email: 'shorty@example.com', password: 'short' });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /at least 10 characters/);
  assert.match(html, /aria-invalid="true"/, 'the field itself is marked invalid, not just the page');
});

test('accounts: signing in keeps the guest question that was open', async () => {
  const asked = await post('/ask', { q: 'the machine stops mid-shift, what do I check and in what order', asker: 'Guest' });
  const ref = asked.headers.get('location').split('/').pop();

  // the browser that asked holds the claim cookie the /ask answer set, and sends it on the way to /signin
  const signin = await post('/signin', { email: 'third@example.com', password: 'a sentence of ten', keep: ref }, cookieOf(asked));
  assert.equal(signin.status, 303);
  assert.equal(signin.headers.get('location'), `/q/${ref}`);
  const cookie = cookieOf(signin);

  const account = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
  assert.match(account, new RegExp(ref), 'the claimed question is listed on the account');

  const page = await (await fetch(`${base}/q/${ref}`, { headers: { cookie } })).text();
  assert.match(page, /saved to your account/);
});

test('accounts: a guest is offered the sign-in, a signed-in person is told it is kept', async () => {
  const asked = await post('/ask', { q: 'how do I start 5S on the floor?', asker: 'Guest' });
  const ref = asked.headers.get('location').split('/').pop();
  const asGuest = await (await fetch(`${base}/q/${ref}`)).text();
  assert.match(asGuest, /Keep this question/);
  assert.match(asGuest, new RegExp(`/signin\\?keep=${ref}`));
});

test('accounts: asking while signed in files the question under the account', async () => {
  const signup = await post('/signup', { name: 'Owner', email: 'owner@example.com', password: 'a sentence of ten' });
  const cookie = cookieOf(signup);
  const asked = await post('/ask', { q: 'what should an andon agreement say?', asker: '' }, cookie);
  const ref = asked.headers.get('location').split('/').pop();
  const account = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
  assert.match(account, new RegExp(ref));
  assert.match(account, /Owner/, 'the signed-in name is used when the form left it blank');
});

test('accounts: sign out revokes the session server-side, not just the cookie', async () => {
  const signup = await post('/signup', { name: 'Going', email: 'going@example.com', password: 'a sentence of ten' });
  const cookie = cookieOf(signup);
  assert.equal((await fetch(`${base}/account`, { headers: { cookie } })).status, 200);

  const out = await post('/signout', {}, cookie);
  assert.equal(out.status, 303);
  assert.match(cookieOf(out), /gemba_session=;?$|gemba_session=$/, 'the cookie is cleared');

  const after = await fetch(`${base}/account`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(after.status, 303, 'the revoked cookie is worth nothing');
  assert.equal(after.headers.get('location'), '/signin?next=/account');
});

test('accounts: the account page is not reachable without a session', async () => {
  const res = await fetch(`${base}/account`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin?next=/account');
});

test('accounts: a forged session cookie is not a session', async () => {
  const res = await fetch(`${base}/account`, { headers: { cookie: 'gemba_session=not-a-real-session-id' }, redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/signin?next=/account');
});
