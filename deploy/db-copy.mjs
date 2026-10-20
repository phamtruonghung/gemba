#!/usr/bin/env node
// deploy/db-copy.mjs — copy or verify a SQLite database with node:sqlite only (no sqlite3 CLI).
//
//   node deploy/db-copy.mjs copy   SRC DEST   # transactionally consistent copy of a live database
//   node deploy/db-copy.mjs verify FILE       # integrity check + row counts; exit 1 if unusable
//
// `VACUUM INTO` is the point: copying the file (or tarring the directory) can capture a torn
// write-ahead log, which restores into a database that never existed.
import { DatabaseSync } from 'node:sqlite';

const [mode, a, b] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (mode === 'copy') {
  if (!a || !b) fail('usage: db-copy.mjs copy SRC DEST');
  try {
    const db = new DatabaseSync(a, { readOnly: true });
    try {
      // The target is an SQL expression, so it can be bound — no string splicing into SQL.
      db.prepare('VACUUM INTO ?').run(b);
    } finally {
      db.close();
    }
  } catch (err) {
    fail(`copy failed: ${err.message}`);
  }
  console.log(`copied ${a} -> ${b}`);
  process.exit(0);
}

if (mode === 'verify') {
  if (!a) fail('usage: db-copy.mjs verify FILE');
  const db = new DatabaseSync(a, { readOnly: true });
  try {
    const integrity = db.prepare('pragma integrity_check').get();
    const ok = String(Object.values(integrity ?? {})[0] ?? '') === 'ok';
    const count = (table) => {
      try {
        return db.prepare(`select count(*) as n from ${table}`).get()?.n ?? 0;
      } catch {
        return 'missing';
      }
    };
    console.log(`integrity=${ok ? 'ok' : JSON.stringify(integrity)} notes=${count('notes')} questions=${count('questions')} bookings=${count('bookings')}`);
    if (!ok) process.exit(1);
  } finally {
    db.close();
  }
  process.exit(0);
}

fail('usage: db-copy.mjs copy SRC DEST | verify FILE');
