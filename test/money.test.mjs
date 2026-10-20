// The money loop: integer pricing, guarded transitions, one booking per post, one user per invite.
//
// Everything here is HTTP or a direct call on the same functions the routes use; no test waits on a
// timer, and every booking takes its own day so nothing depends on test order.
import { test, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { openDb, upsertExpert, tx, transitionBooking, refundsOwed, revenueByExpert, expertStatement } from '../src/db.mjs';
import { quote, priceFor, split, formatVnd, MIN_PRICE_VND, MAX_MINUTES } from '../src/pricing.mjs';
import { parseLocal, formatLocal } from '../src/when.mjs';
import { hashPassword } from '../src/auth.mjs';

const ADMIN_EMAIL = 'operator@gemba.test';
const ADMIN_PASSWORD = 'a-long-enough-operator-password';

let app;
let base;
let cookie;

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data',
      adminToken: 'admin-token', bankBin: '970436', bankAccount: '0123456789',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  upsertExpert(app.db, {
    slug: 'hung-qa', name: 'Hung', headline: 'Production supervisor', topics: ['shift-management'],
    years: 20, rate_vnd: 800000, token: 'tok-hung'
  });
  upsertExpert(app.db, {
    slug: 'lan-hr', name: 'Lan', headline: 'HR lead', topics: ['shift-management'],
    years: 8, rate_vnd: 500000, token: 'tok-lan'
  });
  app.rebuildIndex();
  app.db.prepare('insert into users (email, name, password_hash, role, status, created_at) values (?, ?, ?, ?, ?, ?)')
    .run(ADMIN_EMAIL, 'Operator', await hashPassword(ADMIN_PASSWORD), 'admin', 'active', new Date().toISOString());
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  cookie = cookieOf(await post('/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }));
});

after(() => app.server.close());

const cookieOf = (res) =>
  (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');

async function post(path, data = {}, ck = '') {
  return fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(ck ? { cookie: ck } : {}) },
    body: new URLSearchParams(data).toString()
  });
}
const get = (path, ck = '') => fetch(base + path, { redirect: 'manual', headers: ck ? { cookie: ck } : {} });
const row = (ref) => app.db.prepare('select * from bookings where ref = ?').get(ref);
const count = () => app.db.prepare('select count(*) as n from bookings').get().n;

let day = 1;
const book = (extra = {}) => post('/book', {
  expert: 'hung-qa', minutes: '45', asker: 'A Client', contact: 'client@example.com',
  agenda: 'Line stops at shift change', topic: 'shift-management',
  starts_at: `2031-01-${String(day++).padStart(2, '0')} 09:00`, ...extra
});
const refOf = (res) => res.headers.get('location').replace('/b/', '');
const confirm = (ref, meeting_url = 'https://meet.example.com/hung') => post('/c/tok-hung/booking', { ref, action: 'confirm', meeting_url });
/** Confirmed by the practitioner and reported transferred by the client: what the operator reconciles from. */
const payable = async (extra = {}) => {
  const ref = refOf(await book(extra));
  assert.equal((await confirm(ref)).status, 303);
  await post(`/b/${ref}/transferred`);
  return ref;
};

// --- tx ----------------------------------------------------------------------------------------

test('tx: a throw leaves no row, a nested tx joins the outer one, an async body is refused', () => {
  const db = openDb(':memory:');
  db.exec('create table t (n integer)');
  const n = () => db.prepare('select count(*) as n from t').get().n;

  assert.throws(() => tx(db, () => { db.exec('insert into t values (1)'); throw new Error('boom'); }), /boom/);
  assert.equal(n(), 0, 'rolled back');

  tx(db, () => {
    db.exec('insert into t values (1)');
    tx(db, () => db.exec('insert into t values (2)'));
  });
  assert.equal(n(), 2, 'both rows commit together');

  assert.throws(() => tx(db, () => { tx(db, () => db.exec('insert into t values (3)')); throw new Error('outer'); }), /outer/);
  assert.equal(n(), 2, 'an inner tx does not commit on its own');

  assert.throws(() => tx(db, async () => { db.exec('insert into t values (4)'); }), TypeError);
  assert.equal(n(), 2, 'an async body writes nothing');
  assert.equal(tx(db, () => 42), 42, 'and tx still works afterwards, returning the body value');
});

// --- pricing -----------------------------------------------------------------------------------

test('pricing: bounds are refused and every quote is integer with fee + payout === price', () => {
  assert.throws(() => quote(5000, 45), /too low/);
  assert.throws(() => quote(800000, 999999), /maximum/);
  assert.throws(() => quote(800000, 1e15), /maximum|whole/);
  assert.throws(() => quote(800000.5, 45), /whole/);
  assert.throws(() => quote(-1, 45));
  assert.deepEqual(quote(600000, 45), { minutes: 45, price_vnd: 450000, fee_vnd: 90000, payout_vnd: 360000 });
  assert.equal(quote(700000, 45).price_vnd, 530000, 'the measured anchor: 525,000 rounds to 530,000');
  assert.equal(MAX_MINUTES, 480);

  const rates = [350000, 500000, 600000, 700000, 800000, 900000];
  for (let r = 10_000; r <= 20_000_000; r += 70_001) rates.push(r);
  let checked = 0;
  for (const rate of rates) {
    for (const minutes of [30, 45, 60, 90, 120, 480]) {
      for (const pct of [0, 15, 20, 33, 50]) {
        let q;
        try { q = quote(rate, minutes, pct); } catch { continue; }
        checked += 1;
        for (const v of Object.values(q)) assert.ok(Number.isInteger(v), `${rate}/${minutes}/${pct}: ${JSON.stringify(q)}`);
        assert.equal(q.fee_vnd + q.payout_vnd, q.price_vnd, `${rate}/${minutes}/${pct}`);
        assert.ok(q.price_vnd >= MIN_PRICE_VND);
      }
    }
  }
  assert.ok(checked > 1000, `the property loop ran (${checked} quotes)`);
  assert.equal(priceFor(800000, 45), 600000);
  assert.deepEqual(split(530000, 20), { price_vnd: 530000, fee_vnd: 106000, payout_vnd: 424000 });
});

test('POST /book with 999999 minutes is a 400 and writes nothing', async () => {
  const before = count();
  const res = await book({ minutes: '999999' });
  assert.equal(res.status, 400);
  assert.equal(count(), before);
});

// --- time --------------------------------------------------------------------------------------

test('parseLocal: Vietnam time in, ISO UTC out, nothing else accepted, process timezone ignored', () => {
  assert.equal(parseLocal('2026-11-02 09:00').iso, '2026-11-02T02:00:00.000Z');
  assert.equal(parseLocal('2026-11-02T09:00').iso, '2026-11-02T02:00:00.000Z', 'the datetime-local form');
  for (const bad of ['2026-11-02T09:00:00.000Z', 'tomorrow', '2026-02-30 10:00', '', '2026-11-02 24:00', '2026-11-02 09:00:00', '2026-11-02 09:00+07:00', null]) {
    const r = parseLocal(bad);
    assert.equal(r.ok, false, `refused: ${bad}`);
    assert.match(r.error, /YYYY-MM-DD HH:MM/);
  }
  const was = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(parseLocal('2026-11-02 09:00').iso, '2026-11-02T02:00:00.000Z', 'same instant under another TZ');
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
  assert.equal(formatLocal(parseLocal('2026-11-02 09:00').iso), '2026-11-02 09:00');
  assert.equal(formatLocal('next week'), 'next week', 'a legacy free-text time still displays');
});

test('a booking with no readable time is refused, and the time is stored as UTC', async () => {
  const before = count();
  assert.equal((await book({ starts_at: 'whenever' })).status, 400);
  assert.equal(count(), before);
  const res = await book({ starts_at: '2031-02-01 20:00' });
  assert.equal(res.status, 303);
  assert.equal(row(refOf(res)).starts_at, '2031-02-01T13:00:00.000Z');
  assert.match(await (await get(res.headers.get('location'))).text(), /2031-02-01 20:00 \(Vietnam time/);
});

test('moving a booking with the prefilled time unchanged does not shift it', async () => {
  const ref = refOf(await book());
  const page = await (await get('/admin/bookings', cookie)).text();
  const m = new RegExp(`id="rs-${ref}" name="starts_at" value="([^"]*)"`).exec(page);
  assert.ok(m, 'the reschedule input is on the page');
  const before = row(ref).starts_at;
  assert.equal((await post(`/admin/bookings/${ref}/reschedule`, { starts_at: m[1], minutes: '45' }, cookie)).status, 303);
  assert.equal(row(ref).starts_at, before, 'pressing Move without editing moves nothing');
});

// --- the state machine --------------------------------------------------------------------------

test('a completed booking cannot be cancelled, and owes no refund', async () => {
  const ref = await payable();
  await post(`/admin/bookings/${ref}/paid`, {}, cookie);
  await post(`/admin/bookings/${ref}/completed`, {}, cookie);
  const res = await post(`/admin/bookings/${ref}/cancel`, { reason: 'changed my mind' }, cookie);
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /err=/);
  assert.equal(row(ref).status, 'completed');
  assert.equal(row(ref).refund_vnd, 0);
  assert.ok(!refundsOwed(app.db).some((r) => r.ref === ref), 'and it is not in refunds owed');
});

test('a cancelled booking cannot be rescheduled, and a paid one keeps its price', async () => {
  const cancelled = refOf(await book());
  await post(`/admin/bookings/${cancelled}/cancel`, { reason: 'no' }, cookie);
  const before = row(cancelled);
  const res = await post(`/admin/bookings/${cancelled}/reschedule`, { starts_at: '2031-03-01 10:00', minutes: '90' }, cookie);
  assert.match(res.headers.get('location'), /err=/);
  assert.equal(row(cancelled).price_vnd, before.price_vnd);
  assert.equal(row(cancelled).starts_at, before.starts_at);

  const paid = await payable();
  await post(`/admin/bookings/${paid}/paid`, {}, cookie);
  const p0 = row(paid);
  const longer = await post(`/admin/bookings/${paid}/reschedule`, { starts_at: '2031-03-02 10:00', minutes: '90' }, cookie);
  assert.match(longer.headers.get('location'), /err=/);
  assert.equal(row(paid).price_vnd, p0.price_vnd, 'the paid price is not rewritten');
  const sameLen = await post(`/admin/bookings/${paid}/reschedule`, { starts_at: '2031-03-02 10:00', minutes: '45' }, cookie);
  assert.match(sameLen.headers.get('location'), /moved=/);
  assert.equal(row(paid).starts_at, '2031-03-02T03:00:00.000Z', 'a paid booking can still move in time');
});

test('transitionBooking: an illegal step returns a message and writes nothing', async () => {
  const ref = refOf(await book());
  const events = () => app.db.prepare('select count(*) as n from events').get().n;
  const e0 = events();
  const r = transitionBooking(app.db, ref, 'completed', { actor: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.error, /requested.*completed/);
  assert.equal(row(ref).status, 'requested');
  assert.equal(events(), e0, 'no event for a refused step');
  assert.equal(transitionBooking(app.db, 'B-nope', 'paid').ok, false);
  assert.equal(transitionBooking(app.db, ref, 'requested').ok, false, 'a self-transition is refused too');
  assert.throws(() => transitionBooking(app.db, ref, 'teleported'), /unknown booking status/);
});

test('transitionBooking: only whitelisted columns can ride along', async () => {
  const ref = refOf(await book());
  assert.throws(() => transitionBooking(app.db, ref, 'cancelled', { fields: { 'status = status, price_vnd': 1 } }), /not allowed/);
  assert.throws(() => transitionBooking(app.db, ref, 'cancelled', { fields: { price_vnd: 1 } }), /not allowed/);
  assert.equal(row(ref).status, 'requested');
});

// --- one post, one booking -----------------------------------------------------------------------

test('five identical posts make one booking; the same Location comes back each time', async () => {
  const when = '2031-04-01 09:00';
  const before = count();
  const out = [];
  for (let i = 0; i < 5; i += 1) out.push(await book({ starts_at: when }));
  assert.deepEqual(out.map((r) => r.status), [303, 303, 303, 303, 303]);
  assert.equal(new Set(out.map((r) => r.headers.get('location'))).size, 1);
  assert.equal(count(), before + 1);
  assert.ok(app.db.prepare("select count(*) as n from events where kind = 'booking_duplicate'").get().n >= 4);
});

test('two simultaneous posts for one slot by different people: one booking, one 409', async () => {
  const when = '2031-04-02 09:00';
  const before = count();
  const [a, b] = await Promise.all([
    book({ starts_at: when, contact: 'a@example.com' }),
    book({ starts_at: when, contact: 'b@example.com' })
  ]);
  assert.deepEqual([a.status, b.status].sort(), [303, 409]);
  assert.equal(count(), before + 1);
});

test('an overlap is a 409, and a cancelled booking frees its slot', async () => {
  const first = await book({ starts_at: '2031-04-03 09:00', contact: 'a@example.com' });
  assert.equal(first.status, 303);
  const overlap = await book({ starts_at: '2031-04-03 09:30', contact: 'b@example.com' });
  assert.equal(overlap.status, 409);
  assert.match(await overlap.text(), /already booked/);
  await post(`/admin/bookings/${refOf(first)}/cancel`, { reason: 'freed' }, cookie);
  assert.equal((await book({ starts_at: '2031-04-03 09:30', contact: 'b@example.com' })).status, 303);
});

test('legacy rows that share a free-text time do not stop the app from opening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemba-legacy-'));
  const path = join(dir, 'gemba.db');
  try {
    const db = openDb(path);
    upsertExpert(db, { slug: 'x', name: 'X', headline: '', topics: [], years: 1, rate_vnd: 500000, token: 't' });
    db.exec('drop index idx_bookings_open_slot');
    const ins = db.prepare(`insert into bookings (ref, expert_id, asker, contact, starts_at, minutes, price_vnd, fee_vnd, payout_vnd, created_at)
      values (?, 1, 'a', 'a', ?, 45, 10000, 0, 10000, 'now')`);
    ins.run('L1', 'next tuesday');
    ins.run('L2', 'next tuesday');
    db.close();
    const warn = console.warn;
    const seen = [];
    console.warn = (m) => seen.push(m);
    try {
      const again = openDb(path);
      assert.equal(again.prepare('select count(*) as n from bookings').get().n, 2);
      again.close();
    } finally {
      console.warn = warn;
    }
    assert.match(seen.join(' '), /open-slot index not built/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- one invite, one user ------------------------------------------------------------------------

test('two simultaneous redemptions of one invitation: one user, one 303, one 410', async () => {
  await post('/admin/experts', { name: 'Dung', headline: 'Maintenance', topics: 'tpm', years: '15', rate_vnd: '700000' }, cookie);
  const expert = app.db.prepare("select * from experts where name = 'Dung'").get();
  await post(`/admin/experts/${expert.id}/invite`, { email: 'dung@gemba.test' }, cookie);
  const invite = app.db.prepare('select * from invites where expert_id = ?').get(expert.id);
  const form = { name: 'Dung', password: 'a-long-enough-password', password2: 'a-long-enough-password' };
  const [a, b] = await Promise.all([post(`/invite/${invite.token}`, form), post(`/invite/${invite.token}`, form)]);
  assert.deepEqual([a.status, b.status].sort(), [303, 410]);
  assert.equal(app.db.prepare("select count(*) as n from users where email = 'dung@gemba.test'").get().n, 1);
  const after = app.db.prepare('select * from invites where id = ?').get(invite.id);
  assert.ok(after.accepted_at);
  const user = app.db.prepare("select * from users where email = 'dung@gemba.test'").get();
  assert.equal(app.db.prepare('select user_id from experts where id = ?').get(expert.id).user_id, user.id);
});

// --- the practitioner confirms before payment is requested ----------------------------------------

test('confirm needs an https link, and a javascript: link is a 400 that changes nothing', async () => {
  const ref = refOf(await book());
  for (const bad of ['javascript:alert(1)', 'http://meet.example.com/x', 'not a url', '', `https://x.example.com/${'a'.repeat(300)}`]) {
    const res = await confirm(ref, bad);
    assert.equal(res.status, 400, `refused: ${bad.slice(0, 30)}`);
  }
  assert.equal(row(ref).status, 'requested');
  assert.equal(row(ref).meeting_url, '');
  assert.equal((await confirm(ref, 'https://meet.example.com/ok')).status, 303);
  assert.equal(row(ref).status, 'awaiting_payment');
  assert.equal(row(ref).meeting_url, 'https://meet.example.com/ok');
});

test("another practitioner's token cannot confirm or decline a booking", async () => {
  const ref = refOf(await book());
  const res = await post('/c/tok-lan/booking', { ref, action: 'confirm', meeting_url: 'https://meet.example.com/x' });
  assert.equal(res.status, 404);
  assert.equal((await post('/c/tok-lan/booking', { ref, action: 'decline' })).status, 404);
  assert.equal(row(ref).status, 'requested');
});

test('declining cancels the booking with no refund, and frees the slot', async () => {
  const when = '2031-05-01 09:00';
  const ref = refOf(await book({ starts_at: when }));
  assert.equal((await post('/c/tok-hung/booking', { ref, action: 'decline' })).status, 303);
  assert.equal(row(ref).status, 'cancelled');
  assert.equal(row(ref).refund_vnd, 0);
  assert.equal(row(ref).cancel_reason, 'declined by the practitioner');
  assert.equal((await book({ starts_at: when })).status, 303, 'the slot is free again');
});

test('the operator cannot mark a booking paid before the practitioner confirmed, and "transferred" is only a claim', async () => {
  const ref = refOf(await book());
  const res = await post(`/admin/bookings/${ref}/paid`, {}, cookie);
  assert.match(decodeURIComponent(res.headers.get('location')), /err=.*has not confirmed the time/);
  assert.equal(row(ref).status, 'requested');
  await post(`/b/${ref}/transferred`);
  assert.equal(row(ref).transfer_reported_at, null, 'nothing to report before the time is confirmed');

  await confirm(ref);
  await post(`/b/${ref}/transferred`);
  const reported = row(ref);
  assert.equal(reported.status, 'awaiting_payment');
  assert.ok(reported.transfer_reported_at);

  const cancel = await post(`/admin/bookings/${ref}/cancel`, { reason: 'x' }, cookie);
  assert.match(decodeURIComponent(cancel.headers.get('location')), /err=.*reported a transfer/);
  assert.equal(row(ref).status, 'awaiting_payment', 'money that may have arrived is not recorded as refund 0');

  assert.match((await post(`/admin/bookings/${ref}/paid`, { payment_ref: 'FT123456' }, cookie)).headers.get('location'), /paid=/);
  assert.equal(row(ref).payment_ref, 'FT123456', 'the bank reference is kept');
});

// --- refunds and payouts are instructions the operator marks sent ----------------------------------

test('a refund owed is listed, marked sent once, and then gone', async () => {
  const ref = await payable();
  await post(`/admin/bookings/${ref}/paid`, {}, cookie);
  await post(`/admin/bookings/${ref}/cancel`, { reason: 'client left' }, cookie);
  assert.equal(row(ref).refund_vnd, 600000);
  assert.ok(refundsOwed(app.db).some((r) => r.ref === ref));
  assert.match(await (await get('/admin/bookings', cookie)).text(), new RegExp(`/admin/bookings/${ref}/refunded`));

  const sent = await post(`/admin/bookings/${ref}/refunded`, { reference: 'FT-REFUND-9' }, cookie);
  assert.match(sent.headers.get('location'), /refunded=/);
  assert.ok(row(ref).refunded_at);
  assert.ok(!refundsOwed(app.db).some((r) => r.ref === ref));
  assert.match(app.db.prepare("select detail from events where kind = 'booking_refunded' and ref = ?").get(ref).detail, /FT-REFUND-9/);

  const again = await post(`/admin/bookings/${ref}/refunded`, {}, cookie);
  assert.match(again.headers.get('location'), /err=/, 'a second mark is refused');
  const never = await post(`/admin/bookings/${await payable()}/refunded`, {}, cookie);
  assert.match(never.headers.get('location'), /err=/, 'and so is a refund for a booking that was not cancelled');
});

test('a completed session is owed until the payout is marked sent', async () => {
  const before = app.db.prepare("select owed_vnd, paid_out_vnd from (select coalesce(sum(case when status='completed' and payout_paid_at is null then payout_vnd end),0) as owed_vnd, coalesce(sum(case when status='completed' and payout_paid_at is not null then payout_vnd end),0) as paid_out_vnd from bookings where expert_id = 1)").get();
  const ref = await payable({ minutes: '30' });
  assert.equal((await post(`/admin/bookings/${ref}/payout`, {}, cookie)).headers.get('location').includes('err='), true, 'not payable before it is complete');
  await post(`/admin/bookings/${ref}/paid`, {}, cookie);
  await post(`/admin/bookings/${ref}/completed`, {}, cookie);
  assert.equal(row(ref).payout_vnd, 320000);

  const stmt = () => revenueByExpert(app.db).find((r) => r.name === 'Hung');
  const owed0 = stmt().owed_vnd;
  assert.ok(owed0 >= 320000);
  assert.match(await (await get('/admin/bookings', cookie)).text(), new RegExp(`/admin/bookings/${ref}/payout`));

  const sent = await post(`/admin/bookings/${ref}/payout`, { reference: 'FT-PAYOUT-1' }, cookie);
  assert.match(sent.headers.get('location'), /payout=/);
  assert.ok(row(ref).payout_paid_at);
  assert.equal(stmt().owed_vnd, owed0 - 320000, 'owed drops by the payout');
  assert.equal(stmt().paid_out_vnd, before.paid_out_vnd + 320000, 'and paid out rises by it');
  assert.match((await post(`/admin/bookings/${ref}/payout`, {}, cookie)).headers.get('location'), /err=/, 'a second mark is refused');
  assert.ok(before.owed_vnd >= 0);
});

test("the desk shows what was paid to the practitioner, what is owed, and what is in flight", async () => {
  const html = await (await get('/c/tok-hung')).text();
  const stmt = expertStatement(app.db, 1);
  assert.ok(stmt.paid_out_vnd > 0 && stmt.in_flight_vnd > 0, 'the fixture has both');
  assert.match(html, /Your statement/);
  assert.ok(html.includes(`${formatVnd(stmt.paid_out_vnd)}</strong> paid to you`));
  assert.ok(html.includes(`${formatVnd(stmt.owed_vnd)}</strong> owed to you`));
  assert.ok(html.includes(`${formatVnd(stmt.in_flight_vnd)}</strong> in flight`));
  assert.match(html, /name="meeting_url" type="url" required/, 'a requested booking has the confirm form, with JavaScript off');
});

// --- the price is visible before commitment ---------------------------------------------------------

test('the practitioners page shows the total in every duration option', async () => {
  const html = await (await get('/experts')).text();
  assert.ok(html.includes('45 minutes — 600,000 VND'), 'hung-qa at 800k for 45 minutes');
  assert.ok(html.includes('45 minutes — 380,000 VND'), 'lan-hr at 500k for 45 minutes');
  assert.match(html, /name="starts_at" type="datetime-local" step="1800"/);
  assert.match(html, /Proposed time \(Vietnam time, UTC\+7\)/);
});

test('the question page lists every practitioner with every total, readable without JavaScript', async () => {
  const asked = await post('/ask', { q: 'the press keeps stopping at the last station', asker: 'Guest' });
  const html = await (await get(asked.headers.get('location'))).text();
  assert.match(html, /<table><caption[^>]*>What each session costs, in total/);
  assert.ok(html.includes('<td class="mono">600,000 VND</td>'));
  assert.ok(html.includes('<td class="mono">380,000 VND</td>'));
});

test('the booking page says who has to confirm, in Vietnam time', async () => {
  const ref = refOf(await book({ starts_at: '2031-06-01 14:30' }));
  const html = await (await get(`/b/${ref}`)).text();
  assert.match(html, /Waiting for Hung to confirm 2031-06-01 14:30 \(Vietnam time\)/);
  assert.ok(!html.includes('vietqr'));
});
