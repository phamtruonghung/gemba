#!/usr/bin/env node
// scripts/probe-db.mjs — which database is which?
//
// The app must open the file the configuration names (GEMBA_DB, or GEMBA_DATA_DIR/gemba.db). When
// two candidates exist — typically a stale one next to the source and the configured one — this
// says which holds the questions and bookings, so the operator migrates the right one:
//   node scripts/probe-db.mjs /opt/gemba/data/gemba.db /var/lib/gemba/gemba.db
// With no arguments it reports the configured database.
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/server.mjs';
import { openDb } from '../src/db.mjs';

const paths = process.argv.slice(2);
const targets = paths.length ? paths : [loadConfig().dbPath];

const count = (db, sql) => {
  try {
    return db.prepare(sql).get().c;
  } catch {
    return null;
  }
};

for (const p of targets) {
  const label = paths.length ? p : `${p}  (configured)`;
  if (!existsSync(p)) {
    console.log(`${label}\n  does not exist`);
    continue;
  }
  const db = openDb(p);
  console.log(
    `${label}\n  notes=${count(db, 'select count(*) c from notes')}` +
      ` questions=${count(db, 'select count(*) c from questions')}` +
      ` bookings=${count(db, 'select count(*) c from bookings')}` +
      ` experts=${count(db, 'select count(*) c from experts')}`
  );
  const last = db.prepare('select text, created_at from questions order by id desc limit 1').get();
  if (last) console.log(`  last question: ${last.created_at} — ${String(last.text).slice(0, 70)}`);
  db.close?.();
}
