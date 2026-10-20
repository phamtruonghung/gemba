// Practitioners: how one arrives, and what the operator can change about them.
//
// An expert was a desk URL with a random token in it — a password that cannot be rotated, cannot be
// lost safely, and has to be pasted into a chat to be shared. Now the operator invites them: a
// single-use link, seven days, and the practitioner sets their own password. The URL token keeps
// working (bookmarks, and the fallback when someone loses a password) — two doors, one room.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, upsertNote, expertsForTopic } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';

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
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  const id = upsertExpert(app.db, {
    slug: 'hung-qa', name: 'Hung', headline: 'Production supervisor', topics: ['shift-management'],
    years: 20, rate_vnd: 800000, token: 'tok-hung'
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
  app.db.prepare('insert into users (email, name, password_hash, role, status, created_at) values (?, ?, ?, ?, ?, ?)')
    .run(ADMIN_EMAIL, 'Operator', await hashPassword(ADMIN_PASSWORD), 'admin', 'active', new Date().toISOString());
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.server.close());

const cookieOf = (res) =>
  (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');

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
    body: new URLSearchParams(data).toString()
  });
}
const get = (path, cookie = '') => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });

async function asOperator() {
  const res = await post('/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return cookieOf(res);
}

test('the operator adds a practitioner, and the invite is how they get in', async () => {
  const cookie = await asOperator();

  const add = await post('/admin/experts', {
    name: 'Mai', headline: 'Line supervisor, injection moulding', topics: 'shift-management, quality',
    years: '12', rate_vnd: '700000', bio: 'Twelve years on the floor.'
  }, cookie);
  assert.equal(add.status, 303, 'adding a practitioner redirects back to the list');

  const expert = app.db.prepare("select * from experts where name = 'Mai'").get();
  assert.ok(expert, 'the row exists');
  assert.ok(expert.slug && expert.token, 'with a slug and a desk token generated for it');
  assert.equal(expert.rate_vnd, 700000);
  assert.deepEqual(JSON.parse(expert.topics), ['shift-management', 'quality']);

  const invite = await post(`/admin/experts/${expert.id}/invite`, { email: 'mai@gemba.test', name: 'Mai' }, cookie);
  assert.equal(invite.status, 303);
  const row = app.db.prepare('select * from invites where expert_id = ?').get(expert.id);
  assert.ok(row, 'the invitation is stored');
  assert.equal(row.email, 'mai@gemba.test');
  assert.equal(row.accepted_at, null, 'and it is pending');
  const days = (new Date(row.expires_at) - new Date(row.created_at)) / 86400000;
  assert.ok(days > 6.5 && days < 7.5, `it expires in about a week (got ${days.toFixed(1)})`);

  const list = await get('/admin/invites', cookie);
  const html = await list.text();
  assert.match(html, /mai@gemba\.test/, 'and it is visible — an operator who cannot see whether an invite went through will invite twice');
  assert.match(html, /pending/i);
});

test('the invitation link sets a password and lands the practitioner on their desk', async () => {
  const cookie = await asOperator();
  await post('/admin/experts', { name: 'Lan', headline: 'Quality lead', topics: 'quality', years: '9', rate_vnd: '600000' }, cookie);
  const expert = app.db.prepare("select * from experts where name = 'Lan'").get();
  await post(`/admin/experts/${expert.id}/invite`, { email: 'lan@gemba.test', name: 'Lan' }, cookie);
  const invite = app.db.prepare('select * from invites where expert_id = ?').get(expert.id);

  const page = await get(`/invite/${invite.token}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /lan@gemba\.test/, 'the page knows who it is for');
  assert.match(html, /password/i);

  const weak = await post(`/invite/${invite.token}`, { name: 'Lan', password: 'short', password2: 'short' });
  assert.equal(weak.status, 400, 'a password below the floor is refused');

  const mismatch = await post(`/invite/${invite.token}`, { name: 'Lan', password: 'a-long-enough-password', password2: 'a-different-password' });
  assert.equal(mismatch.status, 400, 'and a confirmation that does not match is refused — this person cannot reset it by email yet');

  const ok = await post(`/invite/${invite.token}`, { name: 'Lan Nguyen', password: 'a-long-enough-password', password2: 'a-long-enough-password' });
  assert.equal(ok.status, 303, 'accepting redirects');
  assert.equal(ok.headers.get('location'), '/desk', 'straight to the desk');
  const session = cookieOf(ok);
  assert.ok(session.includes('gemba_session='), 'and signs them in');

  const user = app.db.prepare("select * from users where email = 'lan@gemba.test'").get();
  assert.equal(user.role, 'expert', 'the account is a practitioner');
  assert.equal(user.name, 'Lan Nguyen', 'with the name they typed');
  const linked = app.db.prepare('select user_id from experts where id = ?').get(expert.id);
  assert.equal(linked.user_id, user.id, 'and it is linked to the practitioner row');
  const after = app.db.prepare('select accepted_at from invites where id = ?').get(invite.id);
  assert.ok(after.accepted_at, 'the invitation is marked used');

  // the same door, signed in
  const desk = await get('/desk', session);
  assert.equal(desk.status, 200, 'the desk opens for the signed-in practitioner');
  const deskHtml = await desk.text();
  assert.match(deskHtml, /Lan/, 'and it is their desk');

  // and the URL token still works, unchanged
  const byToken = await get(`/c/${expert.token}`);
  assert.equal(byToken.status, 200, 'the tokenised desk still opens — two doors, one room');
});

test('an invitation works once, expires, and cannot mint an operator', async () => {
  const cookie = await asOperator();
  await post('/admin/experts', { name: 'Dung', headline: 'Maintenance', topics: 'tpm', years: '15', rate_vnd: '700000' }, cookie);
  const expert = app.db.prepare("select * from experts where name = 'Dung'").get();
  await post(`/admin/experts/${expert.id}/invite`, { email: 'dung@gemba.test' }, cookie);
  const invite = app.db.prepare('select * from invites where expert_id = ?').get(expert.id);

  const used = await post(`/invite/${invite.token}`, {
    name: 'Dung', password: 'a-long-enough-password', password2: 'a-long-enough-password',
    role: 'admin', status: 'active'
  });
  assert.equal(used.status, 303);
  const user = app.db.prepare("select * from users where email = 'dung@gemba.test'").get();
  assert.equal(user.role, 'expert', 'a form field cannot promote the account it creates');

  const again = await get(`/invite/${invite.token}`);
  assert.equal(again.status, 410, 'a used invitation is gone, not reusable');
  const againPost = await post(`/invite/${invite.token}`, { name: 'Someone Else', password: 'a-long-enough-password', password2: 'a-long-enough-password' });
  assert.equal(againPost.status, 410, 'and it cannot be replayed');

  // expiry: an invite that has run out is refused the same way
  await post('/admin/experts', { name: 'Old', headline: 'Retired', topics: 'tpm', years: '20', rate_vnd: '500000' }, cookie);
  const old = app.db.prepare("select * from experts where name = 'Old'").get();
  await post(`/admin/experts/${old.id}/invite`, { email: 'old@gemba.test' }, cookie);
  const stale = app.db.prepare('select * from invites where expert_id = ?').get(old.id);
  app.db.prepare("update invites set expires_at = '2020-01-01T00:00:00.000Z' where id = ?").run(stale.id);
  const expired = await get(`/invite/${stale.token}`);
  assert.equal(expired.status, 410, 'an expired invitation is refused');
});

test('only a practitioner account reaches the desk, and an asker does not', async () => {
  const asker = await post('/signup', { name: 'An Asker', email: 'asker@gemba.test', password: 'a-long-enough-password' });
  const desk = await get('/desk', cookieOf(asker));
  assert.equal(desk.status, 303, 'an asker has no desk to be sent to');
  assert.match(desk.headers.get('location'), /\/(signin|experts)/);
});

test('the operator can change what a practitioner is, and it is recorded', async () => {
  const cookie = await asOperator();
  const expert = app.db.prepare("select * from experts where name = 'Hung'").get();

  const edit = await post(`/admin/experts/${expert.id}`, {
    name: 'Hung', headline: 'Production supervisor (updated)', topics: 'shift-management, tpm',
    years: '21', rate_vnd: '900000', accept_questions: 'on', bio: 'Ran the line for twenty years.'
  }, cookie);
  assert.equal(edit.status, 303);
  const after = app.db.prepare('select * from experts where id = ?').get(expert.id);
  assert.equal(after.rate_vnd, 900000, 'the rate is editable without a deploy — the router reads it');
  assert.equal(after.years, 21);
  assert.deepEqual(JSON.parse(after.topics), ['shift-management', 'tpm']);

  const badRate = await post(`/admin/experts/${expert.id}`, { name: 'Hung', topics: 'tpm', years: '21', rate_vnd: 'nine hundred thousand' }, cookie);
  assert.equal(badRate.status, 400, 'a rate that is not a whole number of VND is refused');

  const events = app.db.prepare("select detail from events where kind = 'expert' order by id desc").all();
  assert.ok(events.length >= 1, 'the change is in the audit trail');
  assert.match(events[0].detail, /operator@gemba\.test/);
});

test('pausing a practitioner stops questions being routed to them', async () => {
  // accept_questions existed as a column and was written by the seeder, but routing never read it:
  // an operator could tick "paused" and questions would keep arriving. That is worse than no switch.
  const cookie = await asOperator();
  const expert = app.db.prepare("select * from experts where name = 'Hung'").get();
  assert.equal(expertsForTopic(app.db, 'shift-management').some((e) => e.id === expert.id), true, 'routing includes them to begin with');

  const pause = await post(`/admin/experts/${expert.id}/pause`, {}, cookie);
  assert.equal(pause.status, 303);
  assert.equal(expertsForTopic(app.db, 'shift-management').some((e) => e.id === expert.id), false,
    'a paused practitioner is not routed new questions');

  await post(`/admin/experts/${expert.id}/resume`, {}, cookie);
  assert.equal(expertsForTopic(app.db, 'shift-management').some((e) => e.id === expert.id), true, 'and resuming brings them back');
});

test('when every practitioner is paused, a question waits and says so — a paused practitioner is never the fallback', async () => {
  // The test above checks expertsForTopic. route() has its own fallback ("someone, rather than nobody")
  // and used to pick the most senior active practitioner whether or not they accepted questions.
  const accepting = app.db.prepare('select id from experts where accept_questions = 1').all().map((r) => r.id);
  app.db.prepare('update experts set accept_questions = 0').run();
  try {
    const asked = await (await fetch(base + '/api/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'rules for seasonal labour contracts outside the plant' })
    })).json();
    assert.equal(asked.coverage, 'thin');

    const esc = await post(`/q/${asked.ref}/ask-expert`, { asker: 'Thu', contact: 'thu@example.com' });
    assert.equal(esc.status, 303);
    assert.match(esc.headers.get('location'), /\?nobody=1$/);
    const stored = app.db.prepare('select * from questions where ref = ?').get(asked.ref);
    assert.notEqual(stored.status, 'routed', 'nobody is accepting, so the question is not routed to a paused practitioner');
    assert.equal(app.db.prepare('select count(*) n from outbox where ref = ?').get(asked.ref).n, 0, 'and nothing is promised to anyone');
    const page = await (await get(esc.headers.get('location'))).text();
    assert.match(page, /Hiện chưa có chuyên gia nào nhận câu hỏi mới về chủ đề này/, 'the page says so, in the language the question was asked in');

    // One practitioner resumes, on a topic that does not match: the fallback now has someone to use.
    const other = app.db.prepare("select * from experts where topics not like ?").all(`%${stored.topic}%`)[0];
    assert.ok(other, 'there is a practitioner who does not cover the question\'s topic');
    app.db.prepare('update experts set accept_questions = 1 where id = ?').run(other.id);
    await post(`/q/${asked.ref}/ask-expert`, { asker: 'Thu', contact: 'thu@example.com' });
    const routed = app.db.prepare('select * from questions where ref = ?').get(asked.ref);
    assert.equal(routed.status, 'routed');
    assert.equal(routed.expert_id, other.id, 'routed to the one practitioner who is accepting');
  } finally {
    app.db.prepare('update experts set accept_questions = 0').run();
    for (const id of accepting) app.db.prepare('update experts set accept_questions = 1 where id = ?').run(id);
  }
});

test('the operator can rotate a desk token that leaked', async () => {
  const cookie = await asOperator();
  const expert = app.db.prepare("select * from experts where name = 'Hung'").get();
  const before = expert.token;
  await post(`/admin/experts/${expert.id}/rotate`, {}, cookie);
  const after = app.db.prepare('select token from experts where id = ?').get(expert.id).token;
  assert.notEqual(after, before, 'the old link stops working');
  assert.equal((await get(`/c/${before}`)).status, 404, 'and the leaked one is dead');
  assert.equal((await get(`/c/${after}`)).status, 200, 'while the new one opens the desk');
});
