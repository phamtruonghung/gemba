// src/db.mjs — schema and queries. Zero dependency: node:sqlite (Node >= 22.13).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { checkEmail, SESSION_IDLE_MINUTES, SESSION_ADMIN_IDLE_MINUTES, SESSION_TOUCH_MS } from './auth.mjs';

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
  -- was cancelled after it was paid: the buyer paid the instance's account, so this is the amount the
  -- operator has to send back.
  refund_vnd integer not null default 0,
  cancel_reason text not null default '',
  -- Set when the operator marks the refund instruction as sent. The platform never reverses a transfer.
  refunded_at text,
  -- Set when the operator marks the practitioner's payout as sent.
  payout_paid_at text,
  -- Where the session happens. Shown to the client only once payment is received.
  meeting_url text not null default '',
  -- The client's "I have transferred": a claim to check against the statement, not a state change.
  transfer_reported_at text,
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
-- The one place a message leaves the system. A row is a promise: it says who was told what, and whether
-- the telling happened. dedupe makes enqueueing idempotent, so a retried POST or a second sweep never
-- sends twice; attempts and last_error are what the operator reads when something did not arrive.
create table if not exists outbox (
  id integer primary key,
  kind text not null,
  ref text not null default '',
  channel text not null default 'email' check (channel in ('email','none')),
  to_addr text not null default '',
  subject text not null default '',
  body text not null default '',
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts integer not null default 0,
  last_error text not null default '',
  claimed_at text,
  created_at text not null,
  sent_at text,
  dedupe text not null unique
);
create index if not exists idx_notes_topic on notes(topic, status);
create index if not exists idx_questions_status on questions(status);
create index if not exists idx_bookings_status on bookings(status);
`;

export function openDb(path = 'data/gemba.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout first: switching the journal mode takes a lock of its own, and a second process (the
  // seeder, a backup, a script) holding the file would otherwise fail every statement with
  // "database is locked" at once. It waits up to 5 s on a single thread; the 503 mapping catches the rest.
  db.exec('pragma busy_timeout = 5000;');
  db.exec('pragma journal_mode = wal;');
  db.exec('pragma synchronous = normal;'); // safe under WAL, and one fsync fewer per commit
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
  // The CSRF token a session's forms carry. '' on rows that predate it; csrfFor() fills them on first use.
  addColumn('sessions', 'csrf', "csrf text not null default ''");
  // When a session last made a request (idle limit). NULL on rows that predate it; stamped on their first request.
  addColumn('sessions', 'last_seen_at', 'last_seen_at text');
  addColumn('questions', 'ai_missing', "ai_missing text not null default ''");
  // sha256 of the one-time claim a guest's browser holds; '' once claimed, and for questions asked before it existed.
  addColumn('questions', 'claim_hash', "claim_hash text not null default ''");
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
  addColumn('bookings', 'refunded_at', 'refunded_at text');
  addColumn('bookings', 'payout_paid_at', 'payout_paid_at text');
  addColumn('bookings', 'meeting_url', "meeting_url text not null default ''");
  addColumn('bookings', 'transfer_reported_at', 'transfer_reported_at text');
  // The 48-hour promise: set once, by the sweep, when a routed question passed its due time unanswered.
  addColumn('questions', 'breach_at', 'breach_at text');
  addColumn('outbox', 'claimed_at', 'claimed_at text');
  // The language a question was asked in ('vi' | 'en'); a booking carries the language of the question it came from.
  addColumn('questions', 'lang', "lang text not null default 'en'");
  addColumn('bookings', 'lang', "lang text not null default 'en'");
  // A backstop for "one slot, one open booking". Old rows hold free-text starts_at and may collide, so
  // a failed build must not stop the app from booting: the check inside createBookingOnce is the guarantee.
  try {
    db.exec("create unique index if not exists idx_bookings_open_slot on bookings(expert_id, starts_at) where status in ('requested','awaiting_payment','paid')");
  } catch (err) {
    console.warn(`bookings: open-slot index not built (${err.message}); the booking check still holds`);
  }
  // Indexes last. Some of these are on columns migrate() has just added, so on an existing database they
  // cannot live in SCHEMA, which runs before any column exists.
  for (const ddl of [
    'create index if not exists idx_answers_question on answers(question_id)',
    'create index if not exists idx_bookings_expert on bookings(expert_id, starts_at)',
    'create index if not exists idx_bookings_user on bookings(user_id)',
    'create index if not exists idx_bookings_starts on bookings(starts_at)',
    'create index if not exists idx_sessions_user on sessions(user_id)',
    'create index if not exists idx_notes_expert on notes(expert_id)',
    'create index if not exists idx_events_kind on events(kind, id)',
    'create index if not exists idx_questions_expert on questions(expert_id)',
    'create index if not exists idx_questions_user on questions(user_id)',
    'create index if not exists idx_outbox_status on outbox(status, id)'
  ]) db.exec(ddl);
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

// Uppercase Crockford base32 (no I, L, O, U): a ref is printed on pages, typed into a bank transfer memo
// (which banks upper-case and strip), and read aloud. 16 characters from 10 random bytes is 80 bits, so a
// stranger cannot walk the space; the old date-stamped ref had about 10 bits of entropy a day.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function makeRef(prefix) {
  const bytes = randomBytes(10);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return `${prefix}-${out}`;
}

const txDepth = new WeakMap();

/**
 * Run `fn` in one transaction: begin immediate, commit, or roll back and rethrow. Re-entrant, so a
 * guarded helper called from inside a route's transaction joins it. node:sqlite is synchronous on one
 * shared connection, so `fn` must be synchronous too: an `await` inside would let another request run
 * its statements inside this transaction.
 */
export function tx(db, fn) {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) return fn();
  db.exec('begin immediate');
  txDepth.set(db, 1);
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      throw new TypeError('tx() body must be synchronous: an await inside a transaction lets other requests write into it');
    }
    db.exec('commit');
    return out;
  } catch (err) {
    try { db.exec('rollback'); } catch { /* nothing open */ }
    throw err;
  } finally {
    txDepth.set(db, 0);
  }
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
 * that on cancellation would mean a cancelled paid session quietly became free. Only a `paid` booking
 * has money to give back: a `completed` one cannot be cancelled at all.
 */
export function cancelBooking(db, ref, { reason = '', actor = '' } = {}) {
  return tx(db, () => {
    const b = bookingByRef(db, ref);
    if (!b) return { ok: false, error: 'No such booking.' };
    if (b.status === 'awaiting_payment' && b.transfer_reported_at) {
      return { ok: false, error: 'The client reported a transfer. Check the statement: mark payment received if it arrived, then cancel to record the refund.' };
    }
    return transitionBooking(db, ref, 'cancelled', {
      actor,
      note: `reason="${String(reason).slice(0, 80)}" refund_owed=${b.status === 'paid' ? b.price_vnd : 0}`,
      fields: { cancelled_at: nowIso(), cancel_reason: String(reason).slice(0, 300), refund_vnd: b.status === 'paid' ? b.price_vnd : 0 }
    });
  });
}

const RESCHEDULABLE = ['requested', 'awaiting_payment', 'paid'];

/**
 * Move a session. The length (and so the price) can change only while nothing has been asked of the
 * client: once payment was requested the amount is a promise, and rewriting it would charge someone
 * for minutes they did not agree to. `money` is the quote for the requested minutes, or null.
 */
export function rescheduleBooking(db, ref, { startsAt, minutes, money, actor = '' }) {
  return tx(db, () => {
    const b = bookingByRef(db, ref);
    if (!b) return { ok: false, error: 'No such booking.' };
    if (!RESCHEDULABLE.includes(b.status)) {
      return { ok: false, error: `Booking ${ref} is ${b.status}; it cannot be moved.` };
    }
    const changesLength = minutes !== b.minutes;
    if (changesLength && b.status !== 'requested') {
      return { ok: false, error: `Payment was requested for ${b.minutes} minutes. Cancel and rebook to change the length.` };
    }
    const clash = findOpenOverlap(db, b.expert_id, startsAt, minutes, ref);
    if (clash) return { ok: false, error: SLOT_TAKEN(b.expert_name) };
    const m = changesLength ? money : { price_vnd: b.price_vnd, fee_vnd: b.fee_vnd, payout_vnd: b.payout_vnd };
    try {
      db.prepare('update bookings set starts_at = ?, minutes = ?, price_vnd = ?, fee_vnd = ?, payout_vnd = ? where ref = ? and status = ?')
        .run(startsAt, minutes, m.price_vnd, m.fee_vnd, m.payout_vnd, ref, b.status);
    } catch (err) {
      if (/constraint/i.test(String(err.message))) return { ok: false, error: SLOT_TAKEN(b.expert_name) };
      throw err;
    }
    logEvent(db, 'booking', ref, `actor=${actor} rescheduled to ${startsAt} ${minutes}p price ${b.price_vnd}->${m.price_vnd}`);
    return { ok: true, booking: bookingByRef(db, ref), before: b };
  });
}

/** The client says they transferred. A claim to check against the bank statement; the status does not move. */
export function reportTransfer(db, ref) {
  return tx(db, () => {
    const b = bookingByRef(db, ref);
    if (!b) return { ok: false, error: 'No such booking.' };
    if (b.status !== 'awaiting_payment') {
      return { ok: false, error: b.status === 'requested'
        ? 'The practitioner has not confirmed the time yet; there is nothing to transfer.'
        : `Booking ${ref} is ${b.status}; there is no transfer to report.` };
    }
    const info = db.prepare("update bookings set transfer_reported_at = ? where ref = ? and status = 'awaiting_payment' and transfer_reported_at is null").run(nowIso(), ref);
    if (info.changes === 1) logEvent(db, 'booking_transfer_reported', ref, 'client');
    return { ok: true, booking: bookingByRef(db, ref) };
  });
}

/** The refund is an instruction. This records that the operator sent it, with the bank reference as the note. */
export function markRefunded(db, ref, { actor = '', note = '' } = {}) {
  return tx(db, () => {
    const info = db
      .prepare("update bookings set refunded_at = ? where ref = ? and status = 'cancelled' and refund_vnd > 0 and refunded_at is null")
      .run(nowIso(), ref);
    if (info.changes !== 1) return { ok: false, error: `Booking ${ref} has no refund outstanding.` };
    logEvent(db, 'booking_refunded', ref, `actor=${actor} ${String(note).slice(0, 100)}`.trim());
    return { ok: true, booking: bookingByRef(db, ref) };
  });
}

/** Records that the operator sent the practitioner's share of a completed session. */
export function markPayoutPaid(db, ref, { actor = '', note = '' } = {}) {
  return tx(db, () => {
    const info = db
      .prepare("update bookings set payout_paid_at = ? where ref = ? and status = 'completed' and payout_paid_at is null")
      .run(nowIso(), ref);
    if (info.changes !== 1) return { ok: false, error: `Booking ${ref} has no payout outstanding.` };
    logEvent(db, 'booking_payout_paid', ref, `actor=${actor} ${String(note).slice(0, 100)}`.trim());
    return { ok: true, booking: bookingByRef(db, ref) };
  });
}

export function refundsOwed(db) {
  return db
    .prepare("select b.*, e.name as expert_name from bookings b left join experts e on e.id = b.expert_id where b.status = 'cancelled' and b.refund_vnd > 0 and b.refunded_at is null order by b.cancelled_at desc")
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

const STATEMENT_COLUMNS = `
  coalesce(sum(case when b.status = 'completed' and b.payout_paid_at is not null then b.payout_vnd else 0 end), 0) as paid_out_vnd,
  coalesce(sum(case when b.status = 'completed' and b.payout_paid_at is null then b.payout_vnd else 0 end), 0) as owed_vnd,
  coalesce(sum(case when b.status in ('paid','awaiting_payment') then b.payout_vnd else 0 end), 0) as in_flight_vnd,
  coalesce(sum(case when b.status = 'completed' then b.fee_vnd else 0 end), 0) as fee_vnd,
  count(b.id) as bookings`;

/**
 * What each practitioner has been paid, is owed, and has in flight. "Paid out" means the operator marked
 * the payout as sent; a completed session whose payout is not marked is *owed*, not paid.
 */
export function revenueByExpert(db) {
  return db
    .prepare(
      `select e.id, e.name, ${STATEMENT_COLUMNS}
       from experts e left join bookings b on b.expert_id = e.id
       group by e.id order by bookings desc, e.name`
    )
    .all();
}

/** The same three numbers for one practitioner, for their own desk. */
export function expertStatement(db, expertId) {
  return db
    .prepare(`select ${STATEMENT_COLUMNS} from bookings b where b.expert_id = ?`)
    .get(expertId);
}

export function createSession(db, { id, userId, expiresAt, userAgent = '' }) {
  db.prepare('insert into sessions (id, user_id, created_at, expires_at, user_agent, csrf, last_seen_at) values (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    nowIso(),
    expiresAt,
    String(userAgent).slice(0, 200),
    randomBytes(24).toString('base64url'),
    nowIso() // signing in is presence
  );
  return id;
}

/** The CSRF token for a session, minted on first use for a row that predates the column. '' for no session. */
export function csrfFor(db, sessionId) {
  if (!sessionId) return '';
  const row = db.prepare('select csrf from sessions where id = ?').get(String(sessionId));
  if (!row) return '';
  if (row.csrf) return row.csrf;
  const token = randomBytes(24).toString('base64url');
  db.prepare('update sessions set csrf = ? where id = ?').run(token, String(sessionId));
  return token;
}

export function setPasswordHash(db, userId, hash) {
  return db.prepare('update users set password_hash = ? where id = ?').run(hash, userId).changes;
}

/** The user behind a session id, or null. Expired rows are deleted on sight, so the table cannot
 *  grow without bound on an instance nobody signs out of. */
export function sessionUser(db, id, { idleMs, adminIdleMs } = {}) {
  if (!id) return null;
  const row = db.prepare('select * from sessions where id = ?').get(String(id));
  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    db.prepare('delete from sessions where id = ?').run(row.id);
    return null;
  }
  const user = userById(db, row.user_id) ?? null;
  if (!user) return null;
  // The limit follows the user's role as it is now: someone promoted to admin inherits the shorter
  // limit on their next request, because the role is read here on every request.
  const limit = user.role === 'admin'
    ? (adminIdleMs ?? SESSION_ADMIN_IDLE_MINUTES * 60_000)
    : (idleMs ?? SESSION_IDLE_MINUTES * 60_000);
  const now = Date.now();
  // An unparseable last_seen_at counts as absent: a corrupt timestamp is not evidence of idleness.
  const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : NaN;
  if (Number.isFinite(seen) && now - seen > limit) {
    db.prepare('delete from sessions where id = ?').run(row.id);
    return null;
  }
  // Write rate: no per-request write. Every request already reads this row; one extra write per live
  // session per minute is the whole cost of presence.
  if (!Number.isFinite(seen) || now - seen >= SESSION_TOUCH_MS) {
    db.prepare('update sessions set last_seen_at = ? where id = ?').run(nowIso(), row.id);
  }
  return user;
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
 * is claimed. This function does not decide *whether the caller may*: the route proves ownership (the
 * guest's claim cookie, or a contact that is the account's email) before it calls here.
 */
export function claimQuestion(db, ref, userId) {
  const q = questionByRef(db, ref);
  if (!q || q.user_id) return null;
  db.prepare("update questions set user_id = ?, claim_hash = '' where id = ?").run(userId, q.id);
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

/** Claim an invitation: 1 if this call redeemed it, 0 if it was already used or has lapsed. */
export function acceptInvite(db, inviteId, now = new Date()) {
  return db.prepare('update invites set accepted_at = ? where id = ? and accepted_at is null and expires_at > ?')
    .run(now.toISOString(), inviteId, now.toISOString()).changes;
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

export const LIBRARY_PAGE_SIZE = 50;

/** One page of the library, with the topic filter in the query rather than applied to every note. */
export function publishedNotesPage(db, { topic = '', limit = LIBRARY_PAGE_SIZE, offset = 0 } = {}) {
  const where = topic ? `status = 'published' and topic = ?` : `status = 'published'`;
  const args = topic ? [topic] : [];
  const total = db.prepare(`select count(*) n from notes where ${where}`).get(...args).n;
  const notes = db.prepare(`select * from notes where ${where} order by id limit ? offset ?`).all(...args, limit, offset);
  return { notes, total };
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
    `insert into questions (ref, asker, contact, plant_type, topic, text, ai_answer, ai_citations, ai_coverage, ai_mode, ai_missing, status, user_id, claim_hash, lang, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(ref, q.asker ?? '', q.contact ?? '', q.plant_type ?? '', q.topic ?? 'other', q.text, q.ai_answer ?? '', JSON.stringify(q.ai_citations ?? []), q.ai_coverage ?? 'thin', q.ai_mode ?? '', q.ai_missing ?? '', q.user_id ?? null, q.claim_hash ?? '', q.lang === 'vi' ? 'vi' : 'en', nowIso());
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
  return db
    .prepare(
      `select q.* from questions q
       where q.status = 'routed'
         and (q.topic in (select value from json_each(?)) or q.expert_id = ?)
         and not exists (select 1 from answers a where a.question_id = q.id)
       order by q.routed_at`
    )
    .all(JSON.stringify(topics), expert.id ?? null);
}

/** Routed questions nobody has answered yet, whoever they were routed to (the operator's view). */
export function unansweredRouted(db) {
  return db
    .prepare(`select q.* from questions q where q.status = 'routed' and not exists (select 1 from answers a where a.question_id = q.id)`)
    .all();
}

export function addAnswer(db, { questionRef, expertId, body }) {
  const q = questionByRef(db, questionRef);
  if (!q) return null;
  tx(db, () => {
    db.prepare('insert into answers (question_id, expert_id, body, created_at) values (?, ?, ?, ?)').run(q.id, expertId ?? null, body, nowIso());
    db.prepare(`update questions set status = 'answered' where id = ?`).run(q.id);
  });
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


/** Routed, past its due time, unanswered, and not yet flagged: what the 48-hour sweep acts on. */
export function overdueRouted(db, nowIsoStr = nowIso()) {
  return db
    .prepare(
      `select q.* from questions q
       where q.status = 'routed' and q.due_at is not null and q.due_at < ? and q.breach_at is null
         and not exists (select 1 from answers a where a.question_id = q.id)
       order by q.due_at`
    )
    .all(nowIsoStr);
}

/** Flag a breach once. Returns false when it was already flagged (or the question moved on). */
export function setBreach(db, ref, at = nowIso()) {
  return db.prepare("update questions set breach_at = ? where ref = ? and status = 'routed' and breach_at is null").run(at, ref).changes === 1;
}

/** Questions the sweep has flagged and nobody has answered: the operator's breach table. */
export function breachedQuestions(db, limit = 100) {
  return db
    .prepare(
      `select q.* from questions q
       where q.breach_at is not null and q.status = 'routed' and not exists (select 1 from answers a where a.question_id = q.id)
       order by q.breach_at desc limit ?`
    )
    .all(limit);
}

// --- outbox ----------------------------------------------------------------

export const OUTBOX_MAX_ATTEMPTS = 5;

/**
 * Record a message that must leave the system. Idempotent on `dedupe`: the second insert is ignored, so
 * a retried POST or a repeated sweep promises once. An address that is not an email (a phone number
 * typed into the contact box, or something with a line break in it) is still recorded, as `failed`
 * with the reason, so the operator sees the promise and can phone the person; it never reaches a transport.
 */
export function enqueue(db, { kind, ref = '', to = '', subject = '', body = '', dedupe }) {
  const addr = checkEmail(to);
  const bad = !addr.ok || /[\r\n<>,;]/.test(String(to));
  const key = dedupe ?? `${kind}:${ref}:${String(to).trim().toLowerCase()}`;
  const info = db
    .prepare(
      `insert into outbox (kind, ref, channel, to_addr, subject, body, status, last_error, created_at, dedupe)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(dedupe) do nothing`
    )
    .run(
      kind, ref, bad ? 'none' : 'email', bad ? '' : addr.value, String(subject).replace(/[\r\n]+/g, ' ').slice(0, 300), String(body),
      bad ? 'failed' : 'pending', bad ? 'no email address on file' : '', nowIso(), key
    );
  return info.changes === 1;
}

/**
 * Take up to `limit` pending rows for sending. A row is claimed with one compare-and-set that bumps its
 * attempts and stamps a lease, so a second process (the CLI sweep alongside the server) that reads the same
 * row loses the claim and skips it. The lease runs out after `leaseMs`, which is how a row whose sender
 * died mid-send is tried again instead of staying claimed forever.
 */
export function claimPending(db, limit = 20, { leaseMs = 120_000 } = {}) {
  const now = nowIso();
  const expired = new Date(Date.now() - leaseMs).toISOString();
  const rows = db
    .prepare("select id from outbox where status = 'pending' and channel = 'email' and (claimed_at is null or claimed_at <= ?) order by id limit ?")
    .all(expired, limit);
  const take = db.prepare(
    "update outbox set attempts = attempts + 1, claimed_at = ? where id = ? and status = 'pending' and (claimed_at is null or claimed_at <= ?)"
  );
  return rows.filter(({ id }) => take.run(now, id, expired).changes === 1).map(({ id }) => db.prepare('select * from outbox where id = ?').get(id));
}

export function markSent(db, id) {
  db.prepare("update outbox set status = 'sent', sent_at = ?, last_error = '' where id = ?").run(nowIso(), id);
}

/** Back to `pending` for another try, until the attempts are used up; then `failed` for good. */
export function markFailed(db, id, err) {
  const row = db.prepare('select attempts from outbox where id = ?').get(id);
  const status = (row?.attempts ?? 0) >= OUTBOX_MAX_ATTEMPTS ? 'failed' : 'pending';
  db.prepare('update outbox set status = ?, last_error = ? where id = ?').run(status, String(err?.message ?? err).slice(0, 300), id);
}

export function outboxRows(db, { status = '', limit = 200 } = {}) {
  return status
    ? db.prepare('select * from outbox where status = ? order by id desc limit ?').all(status, limit)
    : db.prepare('select * from outbox order by id desc limit ?').all(limit);
}

export function outboxCounts(db) {
  const out = { pending: 0, sent: 0, failed: 0 };
  for (const r of db.prepare('select status, count(*) c from outbox group by status').all()) out[r.status] = r.c;
  return out;
}

/** The operator addresses to tell about a breach: the configured one, else every admin account. */
export function adminEmails(db) {
  return db.prepare("select email from users where role = 'admin' and status = 'active' order by id").all().map((r) => r.email);
}

/** The email on an expert's account, or '' (the demo experts have none). */
export function expertEmail(db, expertId) {
  return db.prepare('select u.email from experts e join users u on u.id = e.user_id where e.id = ?').get(expertId)?.email ?? '';
}

// --- bookings --------------------------------------------------------------

const SLOT_TAKEN = (name) => `That time is already booked with ${name || 'this practitioner'}. Choose another time.`;

/** An open booking of this expert whose interval overlaps [startsAt, +minutes). Legacy free-text times are skipped. */
function findOpenOverlap(db, expertId, startsAt, minutes, exceptRef = '') {
  const start = Date.parse(startsAt);
  if (Number.isNaN(start)) return null;
  const end = start + minutes * 60000;
  const rows = db
    .prepare(`select * from bookings where expert_id = ? and ref != ? and status in ('requested','awaiting_payment','paid')`)
    .all(expertId, exceptRef);
  return rows.find((r) => {
    const s = Date.parse(r.starts_at);
    return !Number.isNaN(s) && start < s + r.minutes * 60000 && s < end;
  }) ?? null;
}

/**
 * One form post, one booking. The same person asking again for the same slot gets the booking they
 * already have; anyone else asking for an overlapping slot is told it is taken.
 */
export function createBookingOnce(db, b) {
  return tx(db, () => {
    const clash = findOpenOverlap(db, b.expert_id, b.starts_at, b.minutes);
    if (clash) {
      const sameWho = (b.user_id != null && clash.user_id === b.user_id)
        || String(clash.contact).trim().toLowerCase() === String(b.contact).trim().toLowerCase();
      if (sameWho && clash.starts_at === b.starts_at && clash.minutes === b.minutes) {
        return { ok: true, booking: bookingByRef(db, clash.ref), duplicate: true };
      }
      return { ok: false, error: SLOT_TAKEN(b.expert_name) };
    }
    const ref = b.ref ?? makeRef('B');
    try {
      db.prepare(
        `insert into bookings (ref, expert_id, asker, contact, topic, agenda, starts_at, minutes, price_vnd, fee_vnd, payout_vnd, status, user_id, lang, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`
      ).run(ref, b.expert_id, b.asker, b.contact, b.topic ?? '', b.agenda ?? '', b.starts_at, b.minutes, b.price_vnd, b.fee_vnd, b.payout_vnd, b.user_id ?? null, b.lang === 'vi' ? 'vi' : 'en', nowIso());
    } catch (err) {
      if (/constraint/i.test(String(err.message))) return { ok: false, error: SLOT_TAKEN(b.expert_name) };
      throw err;
    }
    return { ok: true, booking: bookingByRef(db, ref) };
  });
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

/** The state machine. `awaiting_payment` means the practitioner confirmed the time and payment was asked for. */
const ALLOWED = {
  requested: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
};

/** Columns a caller may set along with a transition. A column name in SQL never comes from a caller. */
const TRANSITION_FIELDS = ['cancelled_at', 'cancel_reason', 'refund_vnd', 'payment_ref', 'meeting_url'];

/**
 * The one place a booking changes state. Never throws for an illegal or stale transition: it returns
 * a sentence for a page. The update is a compare-and-set on the status that was read, so two requests
 * racing for the same step cannot both win.
 */
export function transitionBooking(db, ref, to, { fields = {}, actor = '', note = '' } = {}) {
  if (!BOOKING_STATES.includes(to)) throw new Error(`unknown booking status: ${to}`);
  const keys = Object.keys(fields);
  for (const k of keys) if (!TRANSITION_FIELDS.includes(k)) throw new Error(`transitionBooking: field not allowed: ${k}`);
  return tx(db, () => {
    const b = bookingByRef(db, ref);
    if (!b) return { ok: false, error: 'No such booking.' };
    const from = b.status;
    if (!ALLOWED[from].includes(to)) {
      return { ok: false, error: `Booking ${ref} is ${from}; it cannot become ${to}.` };
    }
    const sets = ['status = ?', ...keys.map((k) => `${k} = ?`)].join(', ');
    const info = db.prepare(`update bookings set ${sets} where ref = ? and status = ?`).run(to, ...keys.map((k) => fields[k]), ref, from);
    if (info.changes !== 1) return { ok: false, error: `Booking ${ref} changed while you were working on it. Reload and try again.` };
    logEvent(db, 'booking_status', ref, `${from} -> ${to}${actor ? ` actor=${actor}` : ''}${note ? ` ${note}` : ''}`);
    return { ok: true, booking: bookingByRef(db, ref) };
  });
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
