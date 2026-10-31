// Session idle limits: a session nobody uses stops working well before its 30-day ceiling.
// Tests never sleep; they backdate last_seen_at with SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { createUser } from '../src/db.mjs';
import { hashPassword, SESSION_COOKIE } from '../src/auth.mjs';

const ROOMY = { capacity: 10_000, perMs: 60_000 };
const roomy = { limits: { askIp: ROOMY, askIdentity: ROOMY, signinIp: ROOMY, signinEmail: ROOMY, signupIp: ROOMY } };
const baseConfig = (extra = {}) => ({
  port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data',
  adminToken: 'hard-token', bankBin: '', bankAccount: '',
  llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 },
  ...extra
});

async function start(extra = {}, dbPath = ':memory:') {
  const app = createApp({ dbPath, rules: loadRules(), config: baseConfig({ dbPath, ...roomy, ...extra }) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, stop: () => app.server.close() };
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const post = (base, path, data, cookie = '') =>
  fetch(base + path, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(data).toString() });
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''])
  .map((c) => c.split(';')[0]).filter((c) => c.startsWith(`${SESSION_COOKIE}=`)).join('; ');

const PW = 'a-long-enough-password';
async function signedIn(s, { email = 'idle@plant.vn', role = 'asker' } = {}) {
  createUser(s.app.db, { email, name: 'Idle', role, password_hash: await hashPassword(PW) });
  const res = await post(s.base, role === 'admin' ? '/admin/login' : '/signin', { email, password: PW });
  assert.equal(res.status, 303);
  const cookie = cookieOf(res);
  assert.ok(cookie, 'a session cookie was set');
  return { cookie, id: cookie.split('=')[1] };
}
const account = (s, cookie) => fetch(`${s.base}/account`, { redirect: 'manual', headers: { cookie } });
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const H = 3600_000;
const seenAt = (s, id) => s.app.db.prepare('select last_seen_at from sessions where id = ?').get(id).last_seen_at;
const rows = (s, id) => s.app.db.prepare('select count(*) n from sessions where id = ?').get(id).n;

test('an idle session is refused and its row is deleted', async () => {
  const s = await start();
  try {
    const { cookie, id } = await signedIn(s);
    s.app.db.prepare('update sessions set last_seen_at = ? where id = ?').run(ago(13 * H), id);
    const res = await account(s, cookie);
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/signin/);
    assert.equal(rows(s, id), 0);
  } finally { s.stop(); }
});

test('a session touched inside the idle limit survives, and is stamped at most once a minute', async () => {
  const s = await start();
  try {
    const { cookie, id } = await signedIn(s);
    s.app.db.prepare('update sessions set last_seen_at = ? where id = ?').run(ago(5 * 60_000), id);
    const res = await account(s, cookie);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Signed in as/);
    const first = seenAt(s, id);
    assert.ok(Math.abs(Date.now() - Date.parse(first)) < 1000, 'stamped just now');
    await (await account(s, cookie)).text();
    await (await account(s, cookie)).text();
    assert.equal(seenAt(s, id), first, 'no further write inside the minute');
  } finally { s.stop(); }
});

test("an admin session expires sooner than an asker's at the same elapsed time", async () => {
  const s = await start();
  try {
    const admin = await signedIn(s, { email: 'op@plant.vn', role: 'admin' });
    const asker = await signedIn(s, { email: 'ask@plant.vn' });
    for (const x of [admin, asker]) s.app.db.prepare('update sessions set last_seen_at = ? where id = ?').run(ago(2 * H), x.id);
    const a = await account(s, admin.cookie);
    assert.equal(a.status, 303);
    assert.match(a.headers.get('location'), /^\/signin/);
    assert.equal(rows(s, admin.id), 0);
    const b = await account(s, asker.cookie);
    assert.equal(b.status, 200);
    assert.match(await b.text(), /Signed in as/);
    assert.equal(rows(s, asker.id), 1);
  } finally { s.stop(); }
});

test('a pre-migration database opens and its existing sessions still authenticate', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'gemba-legacy-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`
    create table users (id integer primary key, email text unique not null, name text not null,
      password_hash text not null, created_at text not null, last_seen_at text);
    create table sessions (id text primary key, user_id integer not null references users(id) on delete cascade,
      created_at text not null, expires_at text not null, user_agent text not null default '');
  `);
  const t = new Date().toISOString();
  old.prepare('insert into users (id, email, name, password_hash, created_at) values (1, ?, ?, ?, ?)').run('old@plant.vn', 'Old Timer', 'x', t);
  old.prepare('insert into sessions (id, user_id, created_at, expires_at) values (?, 1, ?, ?)').run('legacy-session-id', ago(40 * 24 * H), new Date(Date.now() + 5 * 24 * H).toISOString());
  old.close();
  const s = await start({}, path);
  try {
    const cols = s.app.db.prepare("select name from pragma_table_info('sessions')").all().map((r) => r.name);
    assert.ok(cols.includes('last_seen_at'), 'the column was added');
    const res = await account(s, `${SESSION_COOKIE}=legacy-session-id`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Signed in as/);
    assert.ok(seenAt(s, 'legacy-session-id'), 'the first request stamped it');
  } finally { s.stop(); }
});

test('the absolute ceiling still wins', async () => {
  const s = await start();
  try {
    const { cookie, id } = await signedIn(s);
    s.app.db.prepare('update sessions set last_seen_at = ?, expires_at = ? where id = ?').run(new Date().toISOString(), ago(1000), id);
    const res = await account(s, cookie);
    assert.equal(res.status, 303);
    assert.equal(rows(s, id), 0);
  } finally { s.stop(); }
});
