// The outbox: every message the product promises is a row first, sent through one transport, and counted.
//
// Delivery here is the `file` transport into a temp directory (the local sink), or a stub function, or a
// stub sendmail script; no test talks to a network and none waits on a timer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, createUser, enqueue, claimPending, outboxRows, OUTBOX_MAX_ATTEMPTS } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';
import { transportFrom, deliver, sweep, runOnce, icsFor, encodeHeader, buildMessage } from '../src/outbox.mjs';

const R = { capacity: 10_000, perMs: 60_000 };
const ADMIN_EMAIL = 'operator@gemba.test';
const ADMIN_PASSWORD = 'a-long-enough-operator-password';
const PUBLIC = 'https://gemba.example.vn';
const OFF_CORPUS = 'What is the best recipe for pho bo with a thirty-two-hour broth?';

let dir, app, base, adminCookie;

const cookieOf = (res) =>
  (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).filter(Boolean).join('; ');
const enc = (d) => new URLSearchParams(d).toString();
async function csrfOf(cookie) {
  const html = await (await fetch(`${base}/account`, { redirect: 'manual', headers: { cookie } })).text();
  return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
}
async function post(path, data = {}, cookie = '') {
  if (cookie && data.csrf === undefined) data = { ...data, csrf: await csrfOf(cookie) };
  return fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: enc(data)
  });
}
const get = (path, cookie = '') => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gemba-outbox-'));
  app = makeApp();
  const id = upsertExpert(app.db, { slug: 'hung-qa', name: 'Hung', headline: 'Production supervisor', topics: ['shift-management'], years: 20, rate_vnd: 800000, token: 'tok-hung' });
  const u = createUser(app.db, { email: 'hung@plant.vn', name: 'Hung', password_hash: 'x' });
  app.db.prepare('update experts set user_id = ? where id = ?').run(u.id, id);
  app.rebuildIndex();
  app.db.prepare('insert into users (email, name, password_hash, role, status, created_at) values (?, ?, ?, ?, ?, ?)')
    .run(ADMIN_EMAIL, 'Operator', await hashPassword(ADMIN_PASSWORD), 'admin', 'active', new Date().toISOString());
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  adminCookie = cookieOf(await post('/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }));
});
after(() => app.server.close());

function makeApp(extra = {}) {
  return createApp({
    dbPath: ':memory:', rules: loadRules(),
    config: {
      port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: dir, adminToken: 'admin-token',
      limits: { askIp: R, askIdentity: R, signinIp: R, signinEmail: R, signupIp: R }, bankBin: '970436', bankAccount: '0123456789',
      publicUrl: PUBLIC, mailTransport: 'file', mailFrom: 'Gemba <noreply@gemba.example.vn>',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    },
    ...extra
  });
}

/** Ask an off-corpus question as a guest; returns its ref and the claim cookie that proves it is theirs. */
async function askOffCorpus() {
  const res = await post('/ask', { q: OFF_CORPUS, asker: 'Lan' });
  assert.equal(res.status, 303);
  return { ref: res.headers.get('location').split('/').pop(), cookie: cookieOf(res) };
}
const sendOn = (ref, contact, cookie = '') => post(`/q/${ref}/ask-expert`, { contact, asker: 'Lan' }, cookie);
const row = (kind, ref) => app.db.prepare('select * from outbox where kind = ? and ref = ?').all(kind, ref);

test('a routed question writes a pending ack; one run sends it, and the file holds the link', async () => {
  const { ref, cookie } = await askOffCorpus();
  await sendOn(ref, 'lan@plant.vn', cookie);
  const [ack] = row('question_ack', ref);
  assert.equal(ack.status, 'pending');
  assert.equal(ack.to_addr, 'lan@plant.vn');
  assert.equal(row('question_routed', ref).length, 1, 'and the practitioner is told too');

  const out = await app.runOutbox();
  assert.ok(out.sent >= 2);
  const [sent] = row('question_ack', ref);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.attempts, 1);
  assert.ok(sent.sent_at);
  const eml = readFileSync(join(dir, 'mail-sink', `${sent.id}.eml`), 'utf8');
  assert.match(eml, /^To: lan@plant\.vn\r$/m);
  assert.match(eml, /^Content-Type: text\/plain; charset=utf-8\r$/m);
  assert.ok(eml.includes(`${PUBLIC}/q/${ref}`), 'the link is absolute');
  const [routed] = row('question_routed', ref);
  assert.equal(routed.to_addr, 'hung@plant.vn');
  assert.ok(readFileSync(join(dir, 'mail-sink', `${routed.id}.eml`), 'utf8').includes(`${PUBLIC}/c/tok-hung`), 'the desk link goes to the practitioner');
});

test('posting ask-expert again on a routed question does not move its due time', async () => {
  const { ref, cookie } = await askOffCorpus();
  await sendOn(ref, 'again@plant.vn', cookie);
  const first = app.db.prepare('select due_at, routed_at from questions where ref = ?').get(ref);
  assert.ok(first.due_at);
  await new Promise((r) => setTimeout(r, 15));
  await sendOn(ref, 'again@plant.vn'); // a stranger holding only the ref
  await sendOn(ref, 'again@plant.vn', cookie);
  assert.deepEqual(app.db.prepare('select due_at, routed_at from questions where ref = ?').get(ref), first);
  assert.equal(row('question_ack', ref).length, 1, 'and nothing is promised twice');
});

test('an overdue routed question is flagged once: one row to the buyer, one to the operator, none on a second sweep', async () => {
  const { ref, cookie } = await askOffCorpus();
  await sendOn(ref, 'late@plant.vn', cookie);
  app.db.prepare("update questions set due_at = '2020-01-01T00:00:00.000Z' where ref = ?").run(ref);

  const first = sweep(app.db, { publicUrl: PUBLIC });
  assert.ok(first.breached >= 1);
  assert.ok(app.db.prepare('select breach_at from questions where ref = ?').get(ref).breach_at);
  const buyer = row('question_overdue', ref);
  const operator = row('question_overdue_operator', ref);
  assert.equal(buyer.length, 1);
  assert.equal(buyer[0].to_addr, 'late@plant.vn');
  assert.equal(operator.length, 1);
  assert.equal(operator[0].to_addr, ADMIN_EMAIL, 'with no operator address configured, the admin accounts are told');
  assert.ok(app.db.prepare("select 1 from events where kind = 'breach' and ref = ?").get(ref));

  const before = app.db.prepare('select count(*) c from outbox').get().c;
  const second = sweep(app.db, { publicUrl: PUBLIC });
  assert.equal(second.breached, 0);
  assert.equal(app.db.prepare('select count(*) c from outbox').get().c, before, 'a second sweep adds no rows');

  const page = await (await get('/admin/outbox', adminCookie)).text();
  assert.ok(page.includes(ref), 'the breach is on the operator view');
  assert.match(page, /Questions past their 48 hours/);
  assert.ok(!page.includes('late@plant.vn'), 'an address is shown by its domain only');
  assert.ok(page.includes('…@plant.vn'));
  assert.equal((await get('/admin/outbox')).status, 303, 'and the view is for operators only');
});

test('a late question can be re-routed by its owner only, and only once it is late; the new due time is later', async () => {
  const { ref, cookie } = await askOffCorpus();
  await sendOn(ref, 'owner@plant.vn', cookie);
  const stranger = await post(`/q/${ref}/reroute`);
  assert.ok([403, 404].includes(stranger.status), `a stranger is refused (${stranger.status})`);
  await post(`/q/${ref}/reroute`, {}, cookie);
  const notLate = app.db.prepare('select due_at from questions where ref = ?').get(ref).due_at;
  const unchanged = app.db.prepare('select due_at from questions where ref = ?').get(ref).due_at;
  assert.equal(unchanged, notLate, 'before a breach it does nothing');

  app.db.prepare("update questions set due_at = '2020-01-01T00:00:00.000Z' where ref = ?").run(ref);
  sweep(app.db, { publicUrl: PUBLIC });
  const late = await (await get(`/q/${ref}`, cookie)).text();
  assert.match(late, /This answer is late/);
  assert.ok(late.includes(`/q/${ref}/reroute`), 'the owner is offered the re-route');
  assert.ok(!(await (await get(`/q/${ref}`)).text()).includes(`/q/${ref}/reroute`), 'a stranger is not');

  assert.ok([403, 404].includes((await post(`/q/${ref}/reroute`)).status));
  assert.equal(app.db.prepare('select breach_at from questions where ref = ?').get(ref).breach_at !== null, true, 'the stranger changed nothing');
  const res = await post(`/q/${ref}/reroute`, {}, cookie);
  assert.equal(res.status, 303);
  const q = app.db.prepare('select due_at, breach_at, status from questions where ref = ?').get(ref);
  assert.ok(q.due_at > '2020-01-02', 'a new due time, in the future');
  assert.equal(q.breach_at, null);
  assert.equal(q.status, 'routed');
  assert.equal(row('question_ack', ref).length, 2, 'the buyer is told about the new promise');
});

test('a contact that is a phone or carries a line break is recorded as failed and never reaches the transport', async () => {
  const sent = [];
  const t = async (msg) => { sent.push(msg); };
  const db = app.db;
  enqueue(db, { kind: 'question_ack', ref: 'T-1', to: '0912 345 678', subject: 's', body: 'b' });
  enqueue(db, { kind: 'question_ack', ref: 'T-2', to: 'a@b.co\r\nBcc: x@y.zz', subject: 's', body: 'b' });
  enqueue(db, { kind: 'question_ack', ref: 'T-3', to: 'ok@plant.vn', subject: 'line\r\nBcc: x@y.zz', body: 'b' });
  const rows = outboxRows(db, { limit: 500 });
  const phone = rows.find((r) => r.ref === 'T-1');
  assert.equal(phone.channel, 'none');
  assert.equal(phone.status, 'failed');
  assert.equal(phone.last_error, 'no email address on file');
  assert.ok(!phone.last_error.includes('0912') && !phone.to_addr.includes('0912'), 'the number is not copied into what the operator reads');
  const injected = rows.find((r) => r.ref === 'T-2');
  assert.equal(injected.status, 'failed');
  assert.equal(injected.to_addr, '');
  const subjectInjected = rows.find((r) => r.ref === 'T-3');
  assert.ok(!/[\r\n]/.test(subjectInjected.subject), 'a line break in a subject is flattened');

  await deliver(db, t, { limit: 500 });
  assert.ok(!sent.some((m) => /T-1|T-2/.test(m.ref ?? '') || m.to.includes('x@y')), 'neither reached the transport');
  assert.ok(sent.every((m) => !/\r\nBcc:/i.test(m.raw)), 'and no message carries an injected header');
  assert.throws(() => buildMessage({ id: 1, to: 'a@b.co\r\nBcc: x@y.zz', subject: 's', body: 'b', from: 'g@h.vn' }), /not a plain email/);
  assert.throws(() => buildMessage({ id: 1, to: 'a@b.co', subject: 's\r\nBcc: x@y.zz', body: 'b', from: 'g@h.vn' }), /line break/);
});

test('a transport that throws puts the row back to pending, then failed after the last attempt; a claimed row is not claimed twice', async () => {
  const db = app.db;
  enqueue(db, { kind: 'question_answered', ref: 'T-RETRY', to: 'retry@plant.vn', subject: 's', body: 'b' });
  const boom = async () => { throw new Error('smtp down'); };
  for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
    await deliver(db, boom, { leaseMs: 0, limit: 500 });
    const r = row('question_answered', 'T-RETRY')[0];
    assert.equal(r.status, 'pending', `attempt ${i}: still pending`);
    assert.equal(r.attempts, i);
    assert.equal(r.last_error, 'smtp down');
  }
  await deliver(db, boom, { leaseMs: 0, limit: 500 });
  const done = row('question_answered', 'T-RETRY')[0];
  assert.equal(done.status, 'failed');
  assert.equal(done.attempts, OUTBOX_MAX_ATTEMPTS);

  enqueue(db, { kind: 'question_answered', ref: 'T-ONCE', to: 'once@plant.vn', subject: 's', body: 'b' });
  const a = claimPending(db, 500).filter((r) => r.ref === 'T-ONCE');
  const b = claimPending(db, 500).filter((r) => r.ref === 'T-ONCE');
  assert.equal(a.length, 1);
  assert.equal(b.length, 0, 'the second claimant gets nothing');
  const sent = [];
  const t = async (m) => { sent.push(m.to); };
  await Promise.all([deliver(db, t), deliver(db, t)]);
  assert.equal(sent.filter((x) => x === 'once@plant.vn').length, 0, 'a row claimed and still leased is not sent by anyone else');
});

test('confirm then paid: one time_confirmed and one payment_confirmed, a Join button, and a calendar file that is valid', async () => {
  const when = '2031-05-04 09:00';
  const made = await post('/book', { expert: 'hung-qa', minutes: '45', starts_at: when, asker: 'Bình Nguyễn Thị', contact: 'buyer@plant.vn', topic: 'shift-management', agenda: 'Phân ca ba ngày một vòng, người mới hay bỏ ca đêm.' });
  assert.equal(made.status, 303);
  const location = made.headers.get('location');
  const ref = location.split('/').pop();
  assert.equal((await get(`${location}/session.ics`)).status, 404, 'no calendar file before the time is confirmed');
  assert.ok(!(await (await get(location)).text()).includes('Join the session'));

  await post('/c/tok-hung/booking', { ref, action: 'confirm', meeting_url: 'https://meet.example.com/abc-defg-hij' });
  assert.equal(row('time_confirmed', ref).length, 1);
  assert.equal(row('time_confirmed', ref)[0].to_addr, 'buyer@plant.vn');
  assert.equal(row('payment_confirmed', ref).length, 0);
  assert.equal((await get(`${location}/session.ics`)).status, 404, 'still 404 while awaiting payment');

  await post(`/admin/bookings/${ref}/paid`, {}, adminCookie);
  await post(`/admin/bookings/${ref}/paid`, {}, adminCookie); // a repeat changes nothing
  const paid = row('payment_confirmed', ref);
  assert.equal(paid.length, 2, 'one to the buyer, one to the practitioner');
  assert.deepEqual(paid.map((r) => r.to_addr).sort(), ['buyer@plant.vn', 'hung@plant.vn']);
  assert.ok(paid.find((r) => r.to_addr === 'buyer@plant.vn').body.includes(`${PUBLIC}/b/${ref}/session.ics`));

  const html = await (await get(location)).text();
  assert.match(html, /Join the session/);
  assert.ok(html.includes('href="https://meet.example.com/abc-defg-hij"'));
  assert.ok(html.includes(`/b/${ref}/session.ics`));

  const res = await get(`${location}/session.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/calendar; charset=utf-8/);
  const ics = await res.text();
  assert.ok(ics.includes('\r\n') && !/[^\r]\n/.test(ics), 'CRLF line endings throughout');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.ok(ics.includes('DTSTART:20310504T020000Z'), '09:00 at UTC+7 is 02:00Z');
  assert.ok(ics.includes('DURATION:PT45M'));
  assert.ok(ics.includes(`UID:${ref}@gemba`));
  assert.ok(ics.includes('LOCATION:https://meet.example.com/abc-defg-hij'));
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`);
});

test('icsFor escapes, folds on octets not characters, and refuses a legacy free-text time', () => {
  const b = { ref: 'B-1', starts_at: '2031-05-04T02:00:00.000Z', minutes: 30, expert_name: 'Nguyễn Thị Hồng; Phạm, Văn Đức Thịnh Vượng Phú Quý An Khang Hưng Thịnh', meeting_url: 'https://meet.example.com/x' };
  const ics = icsFor(b, { publicUrl: PUBLIC, now: new Date('2031-01-01T00:00:00Z') });
  assert.ok(ics.includes('DTSTAMP:20310101T000000Z'));
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('Nguyễn Thị Hồng\\; Phạm\\, Văn'), 'semicolon and comma are escaped');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.ok(ics.split('\r\n').some((l) => l.startsWith(' ')), 'the long summary was folded');
  assert.equal(icsFor({ ...b, starts_at: 'next Tuesday morning' }), null);
  assert.equal(icsFor({ ...b, meeting_url: '' }), null);
});

test('a subject with Vietnamese is an RFC 2047 encoded word, and the body is UTF-8', () => {
  const h = encodeHeader('Câu hỏi của bạn đã được gửi tới chuyên gia, hạn trả lời trong 48 giờ');
  for (const w of h.split('\r\n ')) {
    assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(w.length <= 75);
  }
  assert.equal(h.split('\r\n ').map((w) => Buffer.from(/\?B\?(.*)\?=/.exec(w)[1], 'base64').toString()).join(''), 'Câu hỏi của bạn đã được gửi tới chuyên gia, hạn trả lời trong 48 giờ');
  const raw = buildMessage({ id: 7, to: 'a@b.co', subject: 'Câu hỏi', body: 'Xin chào', from: 'Gemba <g@h.vn>' });
  assert.match(raw, /Content-Transfer-Encoding: 8bit/);
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
});

test('createApp starts no timer unless asked, and shutdown clears the one it started', async () => {
  const plain = makeApp();
  assert.equal(plain.sweepTimer(), null);
  await plain.shutdown();
  const timed = makeApp({ sweepEveryMs: 3_600_000 });
  const t = timed.sweepTimer();
  assert.ok(t, 'the timer exists when asked for');
  assert.equal(t.hasRef(), false, 'and it does not hold the process open');
  await timed.shutdown();
  assert.equal(timed.sweepTimer(), null, 'shutdown cleared it');
});

test('the runner survives a transport that throws, and says so in the row', async () => {
  const boomApp = makeApp({ transport: async () => { throw new Error('down'); } });
  enqueue(boomApp.db, { kind: 'question_answered', ref: 'T-BOOM', to: 'boom@plant.vn', subject: 's', body: 'b' });
  const result = await boomApp.runOutbox();
  assert.equal(result.delivery, 'configured');
  assert.equal(result.retry, 1);
  const r = boomApp.db.prepare("select * from outbox where ref = 'T-BOOM'").get();
  assert.equal(r.status, 'pending');
  assert.equal(r.last_error, 'down');
  await boomApp.shutdown();
});

test('the sendmail transport pipes the message to argv `-i -- <address>` and never uses -t', async () => {
  const script = join(dir, 'fake-sendmail.sh');
  const argvFile = join(dir, 'argv.txt');
  const stdinFile = join(dir, 'stdin.txt');
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\ncat > "${stdinFile}"\n`);
  chmodSync(script, 0o755);
  const t = transportFrom({ mailTransport: 'sendmail', sendmailPath: script });
  const db = app.db;
  enqueue(db, { kind: 'question_answered', ref: 'T-SM', to: 'sm@plant.vn', subject: 'Hello', body: 'Body' });
  await deliver(db, t, { limit: 500, from: 'Gemba <g@h.vn>' });
  assert.equal(readFileSync(argvFile, 'utf8'), '-i\n--\nsm@plant.vn\n');
  assert.ok(!readFileSync(argvFile, 'utf8').split('\n').includes('-t'));
  assert.match(readFileSync(stdinFile, 'utf8'), /^To: sm@plant\.vn\r$/m);
  assert.equal(row('question_answered', 'T-SM')[0].status, 'sent');

  const missing = transportFrom({ mailTransport: 'sendmail', sendmailPath: join(dir, 'does-not-exist') });
  enqueue(db, { kind: 'question_answered', ref: 'T-SM2', to: 'sm2@plant.vn', subject: 'Hello', body: 'Body' });
  await deliver(db, missing, { limit: 500 });
  assert.equal(row('question_answered', 'T-SM2')[0].status, 'pending');
  assert.match(row('question_answered', 'T-SM2')[0].last_error, /sendmail/);
});

test('with no transport configured, rows stay pending and the run says delivery is not configured', async () => {
  assert.equal(transportFrom({}), null);
  enqueue(app.db, { kind: 'question_answered', ref: 'T-NONE', to: 'none@plant.vn', subject: 's', body: 'b' });
  const out = await runOnce(app.db, { transport: null, publicUrl: PUBLIC });
  assert.match(out.delivery, /not configured/);
  assert.equal(app.db.prepare("select status, attempts from outbox where ref = 'T-NONE'").get().status, 'pending');
});

test('an answer from the practitioner tells the asker', async () => {
  const { ref, cookie } = await askOffCorpus();
  await sendOn(ref, 'answered@plant.vn', cookie);
  const res = await post('/c/tok-hung/answer', { ref, body: 'Check the guard sensor first, then the reset lever, then the feeder.' });
  assert.equal(res.status, 303);
  const [r] = row('question_answered', ref);
  assert.equal(r.to_addr, 'answered@plant.vn');
  assert.equal(r.status, 'pending');
});
