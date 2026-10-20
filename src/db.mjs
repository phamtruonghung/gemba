// src/db.mjs — schema and queries. Zero dependency: node:sqlite (Node >= 22.13).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
create table if not exists experts (
  id integer primary key,
  slug text unique not null,
  name text not null,
  headline text not null default '',
  bio text not null default '',
  topics text not null default '[]',
  years integer not null default 0,
  rate_vnd integer not null default 600000,
  accept_questions integer not null default 1,
  token text unique not null,
  status text not null default 'active',
  created_at text not null
);
create table if not exists notes (
  id integer primary key,
  expert_id integer references experts(id),
  slug text unique not null,
  title text not null,
  topic text not null,
  body text not null,
  status text not null default 'draft',
  gate text not null default '{}',
  origin text not null default 'seed',
  created_at text not null,
  published_at text
);
create table if not exists questions (
  id integer primary key,
  ref text unique not null,
  asker text not null default '',
  contact text not null default '',
  plant_type text not null default '',
  topic text not null default 'other',
  text text not null,
  ai_answer text not null default '',
  ai_citations text not null default '[]',
  ai_coverage text not null default 'thin',
  ai_mode text not null default '',
  ai_missing text not null default '',
  status text not null default 'open',
  expert_id integer references experts(id),
  routed_at text,
  due_at text,
  created_at text not null
);
create table if not exists answers (
  id integer primary key,
  question_id integer not null references questions(id),
  expert_id integer references experts(id),
  body text not null,
  created_at text not null
);
create table if not exists bookings (
  id integer primary key,
  ref text unique not null,
  expert_id integer not null references experts(id),
  asker text not null,
  contact text not null,
  topic text not null default '',
  agenda text not null default '',
  starts_at text not null,
  minutes integer not null default 45,
  price_vnd integer not null,
  fee_vnd integer not null,
  payout_vnd integer not null,
  status text not null default 'requested',
  payment_ref text not null default '',
  cancelled_at text,
  -- What the client actually paid that the platform now owes them back. Non-zero only when a booking
  -- was cancelled after it was paid: the platform instructs payment and never holds it (ADR-0008), so
  -- this is the amount an operator has to send back, not money the platform is sitting on.
  refund_vnd integer not null default 0,
  cancel_reason text not null default '',
  created_at text not null
);
create table if not exists interviews (
  id integer primary key,
  expert_id integer not null references experts(id),
  topic text not null,
  step integer not null default 0,
  answers text not null default '[]',
  status text not null default 'in_progress',
  note_id integer,
  created_at text not null
);
create table if not exists events (
  id integer primary key,
  at text not null,
  kind text not null,
  ref text not null default '',
  detail text not null default ''
);
create table if not exists users (
  id integer primary key,
  email text unique not null,
  name text not null,
  password_hash text not null,
  created_at text not null,
  last_seen_at text
);
create table if not exists sessions (
  id text primary key,
  user_id integer not null references users(id) on delete cascade,
  created_at text not null,
  expires_at text not null,
  user_agent text not null default ''
);
create table if not exists invites (
  id integer primary key,
  token text unique not null,
  email text not null,
  name text not null default '',
  expert_id integer references experts(id),
  role text not null default 'expert',
  created_at text not null,
  expires_at text not null,
  accepted_at text,
  created_by text not null default ''
);
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at text not null
);
create index if not exists idx_notes_topic on notes(topic, status);
create index if not exists idx_questions_status on questions(status);
create index if not exists idx_bookings_status on bookings(status);
`;

export function openDb(path = 'data/gemba.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal;');
  db.exec('pragma foreign_keys = on;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Additive migrations, run on every open so an existing instance (and the SQLite file inside a
 * running container) picks them up without a manual step. `create table if not exists` above covers
 * new tables; these cover *columns added to a table that already exists*, which is the case
 * `create table if not exists` silently does nothing about.
 */
export function migrate(db) {
  const columns = (table) => db.prepare(`select name from pragma_table_info('${table}')`).all().map((r) => r.name);
  const addColumn = (table, column, ddl) => {
    if (!columns(table).includes(column)) db.exec(`alter table ${table} add column ${ddl};`);
  };
  // Accounts: a question or a booking can belong to a signed-in person. Nullable on purpose —
  // everything asked before accounts existed stays valid and keeps its display name.
  addColumn('questions', 'user_id', 'user_id integer references users(id)');
  addColumn('questions', 'ai_missing', "ai_missing text not null default ''");
  addColumn('bookings', 'user_id', 'user_id integer references users(id)');
  // Roles arrived after accounts did: everyone who signed up before this was an asker, and that is
  // exactly what the default says. A locked account keeps its history; it just cannot sign in.
  addColumn('users', 'role', "role text not null default 'asker'");
  addColumn('users', 'status', "status text not null default 'active'");
  // An expert may have an account (slice 2: invitation). Nullable: the demo experts have none, and
  // the desk token still works without one.
  addColumn('experts', 'user_id', 'user_id integer references users(id)')
  addColumn('invites', 'role', "role text not null default 'expert'")
  addColumn('bookings', 'cancelled_at', 'cancelled_at text')
  addColumn('bookings', 'refund_vnd', 'refund_vnd integer not null default 0')
  addColumn('bookings', 'cancel_reason', "cancel_reason text not null default ''");
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

let refSeq = 0;
export function makeRef(prefix) {
  refSeq += 1;
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${prefix}-${stamp}-${rand}${refSeq}`;
}

export function logEvent(db, kind, ref = '', detail = '') {
  db.prepare('insert into events (at, kind, ref, detail) values (?, ?, ?, ?)').run(nowIso(), kind, ref, String(detail).slice(0, 500));
}

// --- accounts --------------------------------------------------------------

/** The one shape a user is ever handed to the views: never the password hash. */
export const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.name, role: u.role ?? 'asker', status: u.status ?? 'active', created_at: u.created_at } : null);

export function createUser(db, { email, name, password_hash, role = 'asker', status = 'active' }) {
  const info = db
    .prepare('insert into users (email, name, password_hash, role, status, created_at) values (?, ?, ?, ?, ?, ?)')
    .run(String(email).trim().toLowerCase(), name, password_hash, role, status, nowIso());
  return userById(db, Number(info.lastInsertRowid));
}

/**
 * Create an operator account, or reset one that exists. Idempotent on purpose: the installer, the
 * seeder and `scripts/admin-create.mjs` all call it, and running any of them twice must not produce a
 * second operator — two accounts nobody can tell apart is how an operator loses access to their own
 * instance.
 */
export function upsertAdmin(db, { email, name = 'Operator', password_hash }) {
  const existing = userByEmail(db, email);
  if (existing) {
    db.prepare("update users set name = ?, password_hash = ?, role = 'admin', status = 'active' where id = ?")
      .run(name, password_hash, existing.id);
    return { user: userById(db, existing.id), created: false };
  }
  return { user: createUser(db, { email, name, password_hash, role: 'admin' }), created: true };
}

export function countAdmins(db) {
  return db.prepare("select count(*) c from users where role = 'admin'").get().c;
}

/** The audit trail, newest first — the operator's answer to "who changed this, and when". */
export function eventKinds(db) {
  return db.prepare('select kind, count(*) c from events group by kind order by c desc').all();
}

export function recentEvents(db, { limit = 40, kind = '' } = {}) {
  const rows = kind
    ? db.prepare('select * from events where kind = ? order by id desc limit ?').all(kind, limit)
    : db.prepare('select * from events order by id desc limit ?').all(limit);
  return rows;
}

export function userByEmail(db, email) {
  return db.prepare('select * from users where email = ?').get(String(email ?? '').trim().toLowerCase());
}

export function userById(db, id) {
  return db.prepare('select * from users where id = ?').get(id);
}

export function touchUser(db, id) {
  db.prepare('update users set last_seen_at = ? where id = ?').run(nowIso(), id);
}

export function countUsers(db) {
  return db.prepare('select count(*) c from users').get().c;
}

// --- sessions --------------------------------------------------------------
// The cookie carries an opaque id; this table is the whole of the session state, which is what makes
// sign-out (and "sign out everywhere") real rather than a client-side illusion.

/**
 * Every account, with what a person looking at the list actually needs: what it is, whether it is on,
 * how many sessions it is holding and when it last signed in. Ordered by power, not by id, because the
 * operator's own account and the practitioners are the ones being looked at; the askers are the tail.
 */
export function allUsers(db, { q = '', limit = 200 } = {}) {
  const search = String(q).trim().toLowerCase();
  const where = search ? 'where lower(u.email) like ? or lower(u.name) like ?' : '';
  const args = search ? [`%${search}%`, `%${search}%`] : [];
  return db
    .prepare(
      `select u.id, u.email, u.name, u.role, u.status, u.created_at,
        (select count(*) from sessions s where s.user_id = u.id and s.expires_at > ?) as live_sessions,
        (select max(s.created_at) from sessions s where s.user_id = u.id) as last_signin,
        (select e.id from experts e where e.user_id = u.id) as expert_id,
        (select e.name from experts e where e.user_id = u.id) as expert_name
       from users u ${where}
       order by case u.role when 'admin' then 0 when 'expert' then 1 else 2 end, u.id desc
       limit ?`
    )
    .all(nowIso(), ...args, limit);
}

export function setUserRole(db, id, role) {
  if (!['asker', 'expert', 'admin'].includes(role)) throw new Error(`refusing to set role ${role}`);
  return db.prepare('update users set role = ? where id = ?').run(role, id).changes;
}

export function setUserStatus(db, id, status) {
  if (!['active', 'locked'].includes(status)) throw new Error(`refusing to set status ${status}`);
  return db.prepare('update users set status = ? where id = ?').run(status, id).changes;
}

/**
 * How many operators could still get in. A lock or a demotion has to ask this first: refusing to lock
 * the last operator is the difference between a safeguard and a console nobody can open.
 */
export function countActiveAdmins(db) {
  return db.prepare("select count(*) as n from users where role = 'admin' and status = 'active'").get().n;
}

// --- bookings, for the operator -------------------------------------------

/**
 * A cancellation is not just a status. If the client had already paid, the platform owes them a refund
 * *instruction* — so the amount is recorded, and `refundsOwed` is what an operator works from. Losing
 * that on cancellation would mean a cancelled paid session quietly became free.
 */
export function cancelBooking(db, ref, { reason = '', refundVnd = 0 } = {}) {
  return db
    .prepare("update bookings set status = 'cancelled', cancelled_at = ?, cancel_reason = ?, refund_vnd = ? where ref = ?")
    .run(nowIso(), String(reason).slice(0, 300), Math.max(0, Math.round(refundVnd)), ref).changes;
}

export function rescheduleBooking(db, ref, { startsAt, minutes, priceVnd, feeVnd, payoutVnd }) {
  return db
    .prepare('update bookings set starts_at = ?, minutes = ?, price_vnd = ?, fee_vnd = ?, payout_vnd = ? where ref = ?')
    .run(startsAt, minutes, priceVnd, feeVnd, payoutVnd, ref).changes;
}

export function refundsOwed(db) {
  return db
    .prepare("select b.*, e.name as expert_name from bookings b left join experts e on e.id = b.expert_id where b.status = 'cancelled' and b.refund_vnd > 0 order by b.cancelled_at desc")
    .all();
}

export function allBookings(db, { status = '', limit = 200 } = {}) {
  const where = status ? 'where b.status = ?' : '';
  const args = status ? [status] : [];
  return db
    .prepare(
      `select b.*, e.name as expert_name, e.slug as expert_slug from bookings b
       left join experts e on e.id = b.expert_id ${where}
       order by case b.status when 'requested' then 0 when 'awaiting_payment' then 1 when 'paid' then 2 else 3 end,
         b.starts_at limit ?`
    )
    .all(...args, limit);
}

export function bookingStatusCounts(db) {
  return Object.fromEntries(
    db.prepare('select status, count(*) as n from bookings group by status').all().map((r) => [r.status, r.n])
  );
}

/** What each practitioner has earned, for the page where the operator decides about rates. */
export function revenueByExpert(db) {
  return db
    .prepare(
      `select e.id, e.name,
        coalesce(sum(case when b.status = 'completed' then b.payout_vnd else 0 end), 0) as paid_out_vnd,
        coalesce(sum(case when b.status = 'completed' then b.fee_vnd else 0 end), 0) as fee_vnd,
        coalesce(sum(case when b.status in ('completed','paid','awaiting_payment') then b.price_vnd else 0 end), 0) as pending_vnd,
        count(b.id) as bookings
       from experts e left join bookings b on b.expert_id = e.id
       group by e.id order by bookings desc, e.name`
    )
    .all();
}

export function createSession(db, { id, userId, expiresAt, userAgent = '' }) {
  db.prepare('insert into sessions (id, user_id, created_at, expires_at, user_agent) values (?, ?, ?, ?, ?)').run(
    id,
    userId,
    nowIso(),
    expiresAt,
    String(userAgent).slice(0, 200)
  );
  return id;
}

/** The user behind a session id, or null. Expired rows are deleted on sight, so the table cannot
 *  grow without bound on an instance nobody signs out of. */
export function sessionUser(db, id) {
  if (!id) return null;
  const row = db.prepare('select * from sessions where id = ?').get(String(id));
  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    db.prepare('delete from sessions where id = ?').run(row.id);
    return null;
  }
  return userById(db, row.user_id) ?? null;
}

export function deleteSession(db, id) {
  return db.prepare('delete from sessions where id = ?').run(String(id)).changes;
}

export function deleteSessionsForUser(db, userId) {
  return db.prepare('delete from sessions where user_id = ?').run(userId).changes;
}

export function countSessions(db, userId) {
  return db.prepare('select count(*) c from sessions where user_id = ? and expires_at > ?').get(userId, nowIso()).c;
}

// --- what an account owns --------------------------------------------------

export function questionsForUser(db, userId, limit = 50) {
  return db.prepare('select * from questions where user_id = ? order by id desc limit ?').all(userId, limit);
}

export function bookingsForUser(db, userId, limit = 50) {
  return db
    .prepare(
      `select b.*, e.name as expert_name from bookings b left join experts e on e.id = b.expert_id
       where b.user_id = ? order by b.id desc limit ?`
    )
    .all(userId, limit);
}

/**
 * Attach an already-asked question to the account that just signed in. Only an unclaimed question
 * is claimed, and only by the person holding its ref — a ref is a random 3-character suffix on top
 * of the date, but "who owns this row" is not something to decide optimistically.
 */
export function claimQuestion(db, ref, userId) {
  const q = questionByRef(db, ref);
  if (!q || q.user_id) return null;
  db.prepare('update questions set user_id = ? where id = ?').run(userId, q.id);
  return questionByRef(db, ref);
}

// --- experts ---------------------------------------------------------------

export function upsertExpert(db, e) {
  const row = db.prepare('select id from experts where slug = ?').get(e.slug);
  if (row) {
    db.prepare(
      `update experts set name=?, headline=?, bio=?, topics=?, years=?, rate_vnd=?, accept_questions=?, token=? where id=?`
    ).run(e.name, e.headline ?? '', e.bio ?? '', JSON.stringify(e.topics ?? []), e.years ?? 0, e.rate_vnd ?? 600000, e.accept_questions === false || e.accept_questions === 0 ? 0 : 1, e.token, row.id);
    return row.id;
  }
  const info = db
    .prepare(
      `insert into experts (slug, name, headline, bio, topics, years, rate_vnd, accept_questions, token, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.slug, e.name, e.headline ?? '', e.bio ?? '', JSON.stringify(e.topics ?? []), e.years ?? 0, e.rate_vnd ?? 600000, e.accept_questions === false || e.accept_questions === 0 ? 0 : 1, e.token, nowIso());
  return Number(info.lastInsertRowid);
}

/**
 * Every practitioner, paused ones included. `listExperts` is the *public* list and deliberately hides
 * a paused profile; an operator looking at their roster needs to see who is switched off.
 */
export function allExperts(db) {
  return db
    .prepare('select * from experts order by status, name collate nocase')
    .all()
    .map((r) => ({ ...r, topics: JSON.parse(r.topics || '[]') }));
}

export function expertById(db, id) {
  const row = db.prepare('select * from experts where id = ?').get(id);
  return row ? { ...row, topics: JSON.parse(row.topics || '[]') } : null;
}

export function updateExpert(db, id, e) {
  return db
    .prepare(
      `update experts set name = ?, headline = ?, bio = ?, topics = ?, years = ?, rate_vnd = ?,
        accept_questions = ?, status = ? where id = ?`
    )
    .run(
      e.name, e.headline ?? '', e.bio ?? '', JSON.stringify(e.topics ?? []), e.years ?? 0,
      e.rate_vnd ?? 600000, e.accept_questions ?? 1, e.status ?? 'active', id
    ).changes;
}

export function setExpertField(db, id, column, value) {
  const allowed = ['accept_questions', 'status', 'token', 'rate_vnd'];
  if (!allowed.includes(column)) throw new Error(`refusing to write experts.${column}`);
  return db.prepare(`update experts set ${column} = ? where id = ?`).run(value, id).changes;
}

export function linkExpertUser(db, expertId, userId) {
  return db.prepare('update experts set user_id = ? where id = ?').run(userId, expertId).changes;
}

export function expertByUser(db, userId) {
  const row = db.prepare('select * from experts where user_id = ?').get(userId);
  return row ? { ...row, topics: JSON.parse(row.topics || '[]') } : null;
}

// --- invitations -----------------------------------------------------------
// A single-use link that lets a practitioner set their own password. Vetting stays a human act: there
// is no open registration, because the value of the corpus is that it comes from people who ran the
// line, and an invitation is the operator saying "this one did".

export const INVITE_DAYS = 7;

export function createInvite(db, { token, email, name = '', expertId, role = 'expert', createdBy = '', days = INVITE_DAYS }) {
  const at = new Date();
  const info = db
    .prepare(
      `insert into invites (token, email, name, expert_id, role, created_at, expires_at, created_by)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      token, String(email).trim().toLowerCase(), name, expertId ?? null, role,
      at.toISOString(), new Date(at.getTime() + days * 86400_000).toISOString(), createdBy
    );
  return inviteById(db, Number(info.lastInsertRowid));
}

export function inviteById(db, id) {
  return db.prepare('select * from invites where id = ?').get(id);
}

export function inviteByToken(db, token) {
  return db.prepare('select * from invites where token = ?').get(String(token ?? ''));
}

/** Pending, accepted or expired — computed, not stored, so there is one source of truth for time. */
export function inviteState(invite, at = new Date()) {
  if (!invite) return 'unknown';
  if (invite.accepted_at) return 'accepted';
  if (invite.expires_at <= at.toISOString()) return 'expired';
  return 'pending';
}

export function acceptInvite(db, inviteId) {
  return db.prepare('update invites set accepted_at = ? where id = ? and accepted_at is null')
    .run(nowIso(), inviteId).changes;
}

export function listInvites(db, limit = 100) {
  return db
    .prepare(
      `select i.*, e.name as expert_name, e.slug as expert_slug from invites i
       left join experts e on e.id = i.expert_id order by i.id desc limit ?`
    )
    .all(limit);
}

export function pendingInviteForExpert(db, expertId) {
  return db
    .prepare('select * from invites where expert_id = ? and accepted_at is null order by id desc limit 1')
    .get(expertId);
}

/** What each practitioner is actually doing — the numbers an operator looks at before changing a rate. */
export function expertStats(db) {
  const rows = db
    .prepare(
      `select e.id,
        (select count(*) from notes n where n.expert_id = e.id and n.status = 'published') as notes,
        (select count(*) from questions q where q.expert_id = e.id) as questions,
        (select count(*) from answers a where a.expert_id = e.id) as answers,
        (select count(*) from bookings b where b.expert_id = e.id) as bookings,
        (select coalesce(sum(b.price_vnd), 0) from bookings b where b.expert_id = e.id and b.status = 'completed') as booked_vnd,
        (select coalesce(sum(b.payout_vnd), 0) from bookings b where b.expert_id = e.id and b.status = 'completed') as payout_vnd
       from experts e`
    )
    .all();
  return new Map(rows.map((r) => [r.id, r]));
}

export function expertByToken(db, token) {
  const row = db.prepare(`select * from experts where token = ? and status = 'active'`).get(token);
  // topics is a JSON string in the row; every caller wants the array. Returning the raw row
  // here once produced the interview topic "[" (the first character of '["tpm", …]').
  return row ? { ...row, topics: JSON.parse(row.topics || '[]') } : undefined;
}

export function expertsForTopic(db, topic) {
  // `accept_questions` is the switch for "stop sending me new questions". It existed as a column and
  // was written by the seeder, but routing never read it — an operator could switch a practitioner off
  // and questions would keep arriving, which is worse than having no switch at all.
  const rows = db.prepare(`select * from experts where status = 'active' and accept_questions = 1`).all();
  return rows
    .map((r) => ({ ...r, topics: JSON.parse(r.topics || '[]') }))
    .filter((r) => r.topics.includes(topic))
    .sort((a, b) => a.id - b.id);
}

export function listExperts(db) {
  return db
    .prepare(`select * from experts where status = 'active' order by years desc, id`)
    .all()
    .map((r) => ({ ...r, topics: JSON.parse(r.topics || '[]') }));
}

// --- notes -----------------------------------------------------------------

export function upsertNote(db, n) {
  const row = db.prepare('select id from notes where slug = ?').get(n.slug);
  const gate = JSON.stringify(n.gate ?? {});
  if (row) {
    db.prepare(`update notes set expert_id=?, title=?, topic=?, body=?, status=?, gate=?, origin=? where id=?`).run(
      n.expert_id ?? null, n.title, n.topic, n.body, n.status ?? 'draft', gate, n.origin ?? 'seed', row.id
    );
    return row.id;
  }
  const info = db
    .prepare(
      `insert into notes (expert_id, slug, title, topic, body, status, gate, origin, created_at, published_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(n.expert_id ?? null, n.slug, n.title, n.topic, n.body, n.status ?? 'draft', gate, n.origin ?? 'seed', nowIso(), n.status === 'published' ? nowIso() : null);
  return Number(info.lastInsertRowid);
}

/**
 * Retire seed notes the deployment no longer ships. The seed corpus is the deployment's content, so
 * a note whose slug has left the seed set should leave the corpus too — otherwise a re-seed after a
 * rename leaves both the old and the new note published, and the app answers from a ghost.
 * Notes written by a person ('expert', 'interview') are never touched: they are the operator's data,
 * not the deployment's.
 */
export function pruneSeedNotes(db, keepSlugs) {
  const keep = new Set(keepSlugs);
  const retired = db
    .prepare(`select id, slug, origin from notes where origin in ('demo', 'vault', 'seed')`)
    .all()
    .filter((n) => !keep.has(n.slug));
  const del = db.prepare('delete from notes where id = ?');
  for (const n of retired) del.run(n.id);
  return retired;
}

export function publishedNotes(db) {
  return db.prepare(`select * from notes where status = 'published' order by id`).all();
}

export function noteBySlug(db, slug) {
  return db.prepare('select * from notes where slug = ?').get(slug);
}

export function notesForExpert(db, expertId) {
  return db.prepare('select * from notes where expert_id = ? order by id desc').all(expertId);
}

// --- questions -------------------------------------------------------------

export function insertQuestion(db, q) {
  const ref = q.ref ?? makeRef('X');
  db.prepare(
    `insert into questions (ref, asker, contact, plant_type, topic, text, ai_answer, ai_citations, ai_coverage, ai_mode, ai_missing, status, user_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(ref, q.asker ?? '', q.contact ?? '', q.plant_type ?? '', q.topic ?? 'other', q.text, q.ai_answer ?? '', JSON.stringify(q.ai_citations ?? []), q.ai_coverage ?? 'thin', q.ai_mode ?? '', q.ai_missing ?? '', q.user_id ?? null, nowIso());
  return questionByRef(db, ref);
}

export function questionByRef(db, ref) {
  return db.prepare('select * from questions where ref = ?').get(ref);
}

export function routeQuestion(db, ref, expertIds, dueAt) {
  const q = questionByRef(db, ref);
  if (!q) return null;
  db.prepare(`update questions set status = 'routed', expert_id = ?, routed_at = ?, due_at = ? where id = ?`).run(expertIds[0] ?? null, nowIso(), dueAt, q.id);
  return questionByRef(db, ref);
}

/**
 * Questions routed to an expert that are not yet answered: any topic they accept, plus any question
 * routed to them by id. The second clause matters for a question retrieval found nothing for (topic
 * 'other'): escalation falls back to one practitioner, and without it that question reaches no desk.
 */
export function openQuestionsFor(db, expert) {
  const topics = Array.isArray(expert.topics) ? expert.topics : JSON.parse(expert.topics || '[]');
  const rows = db.prepare(`select * from questions where status = 'routed' order by routed_at`).all();
  const answered = new Set(db.prepare('select distinct question_id from answers').all().map((r) => r.question_id));
  return rows.filter((q) => (topics.includes(q.topic) || (expert.id != null && q.expert_id === expert.id)) && !answered.has(q.id));
}

export function addAnswer(db, { questionRef, expertId, body }) {
  const q = questionByRef(db, questionRef);
  if (!q) return null;
  db.prepare('insert into answers (question_id, expert_id, body, created_at) values (?, ?, ?, ?)').run(q.id, expertId ?? null, body, nowIso());
  db.prepare(`update questions set status = 'answered' where id = ?`).run(q.id);
  return questionByRef(db, questionRef);
}

export function answersFor(db, questionRef) {
  const q = questionByRef(db, questionRef);
  if (!q) return [];
  return db
    .prepare(
      `select a.*, e.name as expert_name, e.headline as expert_headline from answers a
       left join experts e on e.id = a.expert_id where a.question_id = ? order by a.id`
    )
    .all(q.id);
}

export function recentQuestions(db, limit = 20) {
  return db.prepare('select * from questions order by id desc limit ?').all(limit);
}

// --- bookings --------------------------------------------------------------

export function insertBooking(db, b) {
  const ref = b.ref ?? makeRef('B');
  db.prepare(
    `insert into bookings (ref, expert_id, asker, contact, topic, agenda, starts_at, minutes, price_vnd, fee_vnd, payout_vnd, status, user_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`
  ).run(ref, b.expert_id, b.asker, b.contact, b.topic ?? '', b.agenda ?? '', b.starts_at, b.minutes, b.price_vnd, b.fee_vnd, b.payout_vnd, b.user_id ?? null, nowIso());
  return bookingByRef(db, ref);
}

export function bookingByRef(db, ref) {
  return db
    .prepare(
      `select b.*, e.name as expert_name, e.headline as expert_headline from bookings b
       left join experts e on e.id = b.expert_id where b.ref = ?`
    )
    .get(ref);
}

const BOOKING_STATES = ['requested', 'awaiting_payment', 'paid', 'completed', 'cancelled'];

/** Allowed transitions. Anything else is a programming error, so it throws. */
export function setBookingStatus(db, ref, status) {
  const b = bookingByRef(db, ref);
  if (!b) return null;
  const from = b.status;
  const allowed = {
    requested: ['awaiting_payment', 'cancelled'],
    awaiting_payment: ['paid', 'cancelled'],
    paid: ['completed', 'cancelled'],
    completed: [],
    cancelled: []
  };
  if (!BOOKING_STATES.includes(status)) throw new Error(`unknown booking status: ${status}`);
  if (!allowed[from].includes(status)) throw new Error(`illegal transition ${from} -> ${status}`);
  db.prepare('update bookings set status = ? where ref = ?').run(status, ref);
  logEvent(db, 'booking_status', ref, `${from} -> ${status}`);
  return bookingByRef(db, ref);
}

export function bookingsFor(db, { expertId, status }) {
  if (expertId && status) return db.prepare('select * from bookings where expert_id = ? and status = ? order by starts_at').all(expertId, status);
  if (expertId) return db.prepare('select * from bookings where expert_id = ? order by starts_at').all(expertId);
  if (status) return db.prepare('select * from bookings where status = ? order by created_at').all(status);
  return db.prepare('select * from bookings order by id desc').all();
}

// --- interviews ------------------------------------------------------------

export function startInterview(db, { expertId, topic }) {
  const info = db.prepare('insert into interviews (expert_id, topic, step, answers, status, created_at) values (?, ?, 0, ?, \'in_progress\', ?)').run(expertId, topic, '[]', nowIso());
  return db.prepare('select * from interviews where id = ?').get(Number(info.lastInsertRowid));
}

export function interviewById(db, id) {
  return db.prepare('select * from interviews where id = ?').get(id);
}

export function advanceInterview(db, id, answer) {
  const it = interviewById(db, id);
  if (!it) return null;
  const answers = JSON.parse(it.answers || '[]');
  answers.push(answer);
  const step = it.step + 1;
  db.prepare('update interviews set step = ?, answers = ? where id = ?').run(step, JSON.stringify(answers), id);
  return interviewById(db, id);
}

export function finishInterview(db, id, noteId) {
  db.prepare(`update interviews set status = 'done', note_id = ? where id = ?`).run(noteId, id);
  return interviewById(db, id);
}

export function stats(db) {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    experts: one(`select count(*) n from experts where status = 'active'`),
    notes: one(`select count(*) n from notes where status = 'published'`),
    blocked: one(`select count(*) n from notes where status <> 'published' and origin = 'interview'`),
    questions: one('select count(*) n from questions'),
    routed: one(`select count(*) n from questions where status = 'routed'`),
    answered: one(`select count(*) n from questions where status = 'answered'`),
    thin: one(`select count(*) n from questions where ai_coverage = 'thin'`),
    bookings: one('select count(*) n from bookings'),
    paid: one(`select count(*) n from bookings where status in ('paid','completed')`)
  };
}
