// src/db.mjs — schema and queries. Zero dependency: node:sqlite (Node >= 22.5).
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
  topic text not null default 'khac',
  text text not null,
  ai_answer text not null default '',
  ai_citations text not null default '[]',
  ai_coverage text not null default 'thin',
  ai_mode text not null default '',
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
create index if not exists idx_notes_topic on notes(topic, status);
create index if not exists idx_questions_status on questions(status);
create index if not exists idx_bookings_status on bookings(status);
`;

export function openDb(path = 'data/xuong.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal;');
  db.exec('pragma foreign_keys = on;');
  db.exec(SCHEMA);
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

// --- experts ---------------------------------------------------------------

export function upsertExpert(db, e) {
  const row = db.prepare('select id from experts where slug = ?').get(e.slug);
  if (row) {
    db.prepare(
      `update experts set name=?, headline=?, bio=?, topics=?, years=?, rate_vnd=?, accept_questions=?, token=? where id=?`
    ).run(e.name, e.headline ?? '', e.bio ?? '', JSON.stringify(e.topics ?? []), e.years ?? 0, e.rate_vnd ?? 600000, e.accept_questions === false ? 0 : 1, e.token, row.id);
    return row.id;
  }
  const info = db
    .prepare(
      `insert into experts (slug, name, headline, bio, topics, years, rate_vnd, accept_questions, token, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.slug, e.name, e.headline ?? '', e.bio ?? '', JSON.stringify(e.topics ?? []), e.years ?? 0, e.rate_vnd ?? 600000, e.accept_questions === false ? 0 : 1, e.token, nowIso());
  return Number(info.lastInsertRowid);
}

export function expertByToken(db, token) {
  const row = db.prepare(`select * from experts where token = ? and status = 'active'`).get(token);
  // topics is a JSON string in the row; every caller wants the array. Returning the raw row
  // here once produced the interview topic "[" (the first character of '["tpm", …]').
  return row ? { ...row, topics: JSON.parse(row.topics || '[]') } : undefined;
}

export function expertsForTopic(db, topic) {
  const rows = db.prepare(`select * from experts where status = 'active'`).all();
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
    `insert into questions (ref, asker, contact, plant_type, topic, text, ai_answer, ai_citations, ai_coverage, ai_mode, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(ref, q.asker ?? '', q.contact ?? '', q.plant_type ?? '', q.topic ?? 'khac', q.text, q.ai_answer ?? '', JSON.stringify(q.ai_citations ?? []), q.ai_coverage ?? 'thin', q.ai_mode ?? '', nowIso());
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

/** Questions routed to an expert (any topic they accept) that are not yet answered. */
export function openQuestionsFor(db, expert) {
  const topics = Array.isArray(expert.topics) ? expert.topics : JSON.parse(expert.topics || '[]');
  const rows = db.prepare(`select * from questions where status = 'routed' order by routed_at`).all();
  const answered = new Set(db.prepare('select distinct question_id from answers').all().map((r) => r.question_id));
  return rows.filter((q) => topics.includes(q.topic) && !answered.has(q.id));
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
    `insert into bookings (ref, expert_id, asker, contact, topic, agenda, starts_at, minutes, price_vnd, fee_vnd, payout_vnd, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?)`
  ).run(ref, b.expert_id, b.asker, b.contact, b.topic ?? '', b.agenda ?? '', b.starts_at, b.minutes, b.price_vnd, b.fee_vnd, b.payout_vnd, nowIso());
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
