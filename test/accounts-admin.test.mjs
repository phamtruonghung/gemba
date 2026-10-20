// The accounts an operator can see and stop, and the bookings they reconcile.
//
// Two powers that are easy to hand out and hard to take back: disabling a person, and moving money.
// Both are here, both are audited, and the two that would lock the operator out of their own console
// are refused rather than merely discouraged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';

let app;
let base;

const ADMIN_EMAIL = 'operator@gemba.test';
const ADMIN_PASSWORD = 'a-long-enough-operator-password';
const PW = 'a-long-enough-password';

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data',
      adminToken: 'admin-token', bankBin: '', bankAccount: '',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  upsertExpert(app.db, {
    slug: 'hung-qa', name: 'Hung', headline: 'Production supervisor', topics: ['shift-management'],
    years: 20, rate_vnd: 800000, token: 'tok-hung'
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

async function post(path, data = {}, cookie = '') {
  return fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(data).toString()
  });
}
const get = (path, cookie = '') => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });

const asOperator = async () => cookieOf(await post('/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }));
const userBy = (email) => app.db.prepare('select * from users where email = ?').get(email);
const idOf = (email) => userBy(email).id;
const signUp = (name, email) => post('/signup', { name, email, password: PW });

// Each booking takes its own day: one practitioner cannot be in two open bookings at the same time.
let nextDay = 1;
/** Book a session the way a client does, and return its ref. */
async function bookSession(minutes = 45) {
  const day = String(nextDay++).padStart(2, '0');
  const res = await post('/book', {
    expert: 'hung-qa', minutes: String(minutes), asker: 'A Client', contact: 'client@example.com',
    agenda: 'Line stops at shift change', starts_at: `2030-11-${day} 09:00`, topic: 'shift-management'
  });
  assert.equal(res.status, 303, 'the booking form posts');
  return res.headers.get('location').replace('/b/', '');
}

/** A booking the client has said they paid: the state the operator reconciles from. */
async function bookAndTransfer(minutes = 45) {
  const ref = await bookSession(minutes);
  assert.equal((await post(`/b/${ref}/transferred`)).status, 303);
  return ref;
}

test('the operator sees every account, with what it is and whether it is on', async () => {
  const cookie = await asOperator();
  await signUp('An Asker', 'asker1@gemba.test');
  await signUp('Another Asker', 'asker2@gemba.test');

  const page = await get('/admin/accounts', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /asker1@gemba\.test/);
  assert.match(html, /asker2@gemba\.test/);
  assert.match(html, /operator@gemba\.test/);
  const total = app.db.prepare('select count(*) as n from users').get().n;
  assert.match(html, new RegExp(`${total} account`), `expected ${total} accounts on the page`);
});

test('locking an account stops it signing in — and unlocks again', async () => {
  const cookie = await asOperator();
  const id = idOf('asker1@gemba.test');

  assert.equal((await post(`/admin/accounts/${id}/lock`, {}, cookie)).status, 303);
  assert.equal(userBy('asker1@gemba.test').status, 'locked');

  const refused = await post('/signin', { email: 'asker1@gemba.test', password: PW });
  assert.equal(refused.status, 403, 'a locked account cannot sign in even with the right password');
  assert.match(await refused.text(), /locked|disabled/i, 'and is told why');

  assert.equal((await post(`/admin/accounts/${id}/unlock`, {}, cookie)).status, 303);
  assert.equal((await post('/signin', { email: 'asker1@gemba.test', password: PW })).status, 303, 'unlocking restores the sign-in');
});

test('locking an account ends the sessions it is already holding', async () => {
  const cookie = await asOperator();
  await signUp('Session Asker', 'session@gemba.test');
  const session = cookieOf(await post('/signin', { email: 'session@gemba.test', password: PW }));
  assert.equal((await get('/account', session)).status, 200, 'they are signed in to begin with');

  await post(`/admin/accounts/${idOf('session@gemba.test')}/lock`, {}, cookie);
  // Locking without revoking would leave the person working for as long as their cookie lives — the
  // lock would then be a claim about the future rather than about now.
  const after = await get('/account', session);
  assert.equal(after.status, 303, 'the session they were holding is gone');
  assert.match(after.headers.get('location') ?? '', /signin/);
});

test('the operator cannot lock or demote themselves out of the console', async () => {
  const cookie = await asOperator();
  const me = idOf(ADMIN_EMAIL);

  assert.equal((await post(`/admin/accounts/${me}/lock`, {}, cookie)).status, 400, 'locking the account you are signed in as is refused');
  assert.equal(userBy(ADMIN_EMAIL).status, 'active');
  assert.equal((await post(`/admin/accounts/${me}/role`, { role: 'asker' }, cookie)).status, 400, 'and so is demoting yourself');
  assert.equal(userBy(ADMIN_EMAIL).role, 'admin');

  // A second operator is invited (never handed a password the first one chose), and the invitation
  // carries the role — the form cannot.
  const invite = await post('/admin/accounts', { email: 'second-op@gemba.test', name: 'Second Operator', role: 'admin' }, cookie);
  assert.equal(invite.status, 303, 'the operator is invited, not created with a password someone else picked');
  const row = app.db.prepare("select * from invites where email = 'second-op@gemba.test'").get();
  assert.ok(row, 'an invitation exists');
  assert.equal(row.role, 'admin', 'carrying the role the operator chose');
  assert.equal(row.expert_id, null, 'and no practitioner row');
  assert.equal(userBy('second-op@gemba.test'), undefined, 'no account exists until they accept it');

  const accepted = await post(`/invite/${row.token}`, { name: 'Second Operator', password: PW, password2: PW, role: 'asker' });
  assert.equal(accepted.status, 303);
  assert.equal(userBy('second-op@gemba.test').role, 'admin', 'the invitation decides the role, not the form');
  assert.equal(accepted.headers.get('location'), '/admin', 'an operator invitation lands on the console, not a desk');

  // with two operators, demoting one is allowed — the rule protects the last one
  assert.equal((await post(`/admin/accounts/${idOf('second-op@gemba.test')}/role`, { role: 'asker' }, cookie)).status, 303);
  assert.equal(userBy('second-op@gemba.test').role, 'asker');
  assert.equal((await post(`/admin/accounts/${me}/lock`, {}, cookie)).status, 400, 'and it is refused again once they are the only one left');
});

test('an account cannot be made an expert without a practitioner row behind it', async () => {
  const cookie = await asOperator();
  await signUp('Wants To Teach', 'wants@gemba.test');
  const res = await post(`/admin/accounts/${idOf('wants@gemba.test')}/role`, { role: 'expert' }, cookie);
  assert.equal(res.status, 400, 'role=expert with no roster row would hand them a desk that does not exist');
  assert.equal(userBy('wants@gemba.test').role, 'asker');
});

test('signing an account out everywhere', async () => {
  const cookie = await asOperator();
  await signUp('Everywhere', 'everywhere@gemba.test');
  const one = cookieOf(await post('/signin', { email: 'everywhere@gemba.test', password: PW }));
  const two = cookieOf(await post('/signin', { email: 'everywhere@gemba.test', password: PW }));
  assert.equal((await get('/account', one)).status, 200);

  assert.equal((await post(`/admin/accounts/${idOf('everywhere@gemba.test')}/signout`, {}, cookie)).status, 303);
  assert.equal((await get('/account', one)).status, 303, 'the first session is gone');
  assert.equal((await get('/account', two)).status, 303, 'and so is the second');
  const events = app.db.prepare("select detail from events where kind = 'account' order by id desc").all();
  assert.match(events[0].detail, /operator@gemba\.test/);
});

test('every account action is audited, with the operator named', async () => {
  const rows = app.db.prepare("select ref, detail from events where kind = 'account'").all();
  assert.ok(rows.length >= 4, `expected several account events, got ${rows.length}`);
  for (const row of rows) assert.match(row.detail, /operator@gemba\.test/, 'each one names who did it');
});

test('the operator reconciles a booking, and cancelling one says what happens to the money', async () => {
  const cookie = await asOperator();
  const ref = await bookAndTransfer(45);
  const original = app.db.prepare('select * from bookings where ref = ?').get(ref);
  assert.equal(original.price_vnd, 600000, '45 minutes at 800,000/h');

  const list = await get('/admin/bookings', cookie);
  assert.equal(list.status, 200);
  const html = await list.text();
  assert.match(html, new RegExp(ref), 'the booking is listed');
  assert.match(html, /Hung/, 'with the practitioner on it');

  assert.equal((await post(`/admin/bookings/${ref}/paid`, {}, cookie)).status, 303);
  assert.equal(app.db.prepare('select status from bookings where ref = ?').get(ref).status, 'paid');

  // The client paid 600,000 for 45 minutes. Moving the session to a longer length would rewrite the
  // price after the money moved, so it is refused and nothing changes.
  const longer = await post(`/admin/bookings/${ref}/reschedule`, { starts_at: '2030-12-03 14:00', minutes: '60' }, cookie);
  assert.equal(longer.status, 303);
  assert.match(longer.headers.get('location'), /err=.*Cancel%20and%20rebook/);
  const same = app.db.prepare('select * from bookings where ref = ?').get(ref);
  assert.equal(same.price_vnd, 600000, 'the price the client paid is unchanged');
  assert.equal(same.starts_at, original.starts_at, 'and so is the time');

  const reschedule = await post(`/admin/bookings/${ref}/reschedule`, { starts_at: '2030-12-03 14:00', minutes: '45' }, cookie);
  assert.equal(reschedule.status, 303, 'the session can be moved without cancelling it');
  const moved = app.db.prepare('select * from bookings where ref = ?').get(ref);
  assert.equal(moved.minutes, 45);
  assert.equal(moved.starts_at, '2030-12-03T07:00:00.000Z', '14:00 Vietnam time is 07:00 UTC');
  assert.equal(moved.price_vnd, 600000, 'the price is untouched');
  assert.equal(moved.fee_vnd, 120000, '20% to the platform');
  assert.equal(moved.payout_vnd, 480000, 'the rest to the practitioner');
  assert.equal(moved.status, 'paid', 'a reschedule does not lose the payment');

  // The booking list is a page of forms, so a refused action redirects back with the reason rather than
  // replacing the page with an error — and a failed reschedule must not move anything.
  const badMove = await post(`/admin/bookings/${ref}/reschedule`, { starts_at: 'not-a-date', minutes: '45' }, cookie);
  assert.equal(badMove.status, 303, 'a reschedule with no valid time is refused');
  assert.match(badMove.headers.get('location'), /err=/);
  assert.equal(app.db.prepare('select starts_at from bookings where ref = ?').get(ref).starts_at, '2030-12-03T07:00:00.000Z',
    'and the booking stayed where it was');

  assert.equal((await post(`/admin/bookings/${ref}/cancel`, { reason: 'the client cannot make it' }, cookie)).status, 303);
  assert.equal(app.db.prepare('select status from bookings where ref = ?').get(ref).status, 'cancelled');
  // The platform instructs payment and never holds it (ADR-0008), so a cancelled paid booking owes the
  // client a refund *instruction*. The page has to say so rather than imply the platform reverses a
  // transfer it never made.
  const page = await (await get('/admin/bookings', cookie)).text();
  assert.match(page, /refund/i, 'a cancelled paid booking says a refund is owed, not that it was made');

  const events = app.db.prepare("select detail from events where kind in ('booking', 'booking_status') order by id desc").all();
  assert.ok(events.length >= 3, 'paid, rescheduled and cancelled are each recorded');
  assert.match(events[0].detail, /cancel/);
  assert.match(events[0].detail, /operator@gemba\.test/);
});

test('revenue per practitioner is on the page an operator looks at', async () => {
  const cookie = await asOperator();
  const ref = await bookAndTransfer(30);
  await post(`/admin/bookings/${ref}/paid`, {}, cookie);
  await post(`/admin/bookings/${ref}/completed`, {}, cookie);

  const html = await (await get('/admin/bookings', cookie)).text();
  assert.match(html, /Hung/);
  // 30 minutes at 800,000/h completed: 80,000 to the platform, 320,000 to the practitioner.
  assert.match(html, /320,000/, 'the completed booking shows what the practitioner is owed');
  assert.match(html, /80,000/, 'and what the platform keeps');
});

test('a booking that cannot move is refused politely, and the server survives it', async () => {
  const cookie = await asOperator();
  const ref = await bookSession(45);

  // requested -> completed skips the payment step; the guard says no. The important part of this test
  // is what happens *next*: the error handler used to call a `fail` that was not in scope, which threw
  // while handling the first error and took the process down. Every later request then hung on a socket
  // nobody was listening to, and the original error was never printed anywhere.
  const bad = await post(`/admin/bookings/${ref}/completed`, {}, cookie);
  assert.equal(bad.status, 303, 'it redirects back with an explanation rather than crashing');
  assert.match(bad.headers.get('location'), /err=/, 'carrying the reason');

  const after = await get('/admin/bookings', cookie);
  assert.equal(after.status, 200, 'and the next request is answered normally');
  assert.equal(app.db.prepare('select status from bookings where ref = ?').get(ref).status, 'requested', 'nothing moved');
});
