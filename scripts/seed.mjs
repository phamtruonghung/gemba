#!/usr/bin/env node
// scripts/seed.mjs — build a fresh database: demo expert profiles + the seed corpus.
//
// Every note is run through the real publishability gate, exactly as an expert's submitted note is.
// Nobody attests for the seed: a note that needs attestation or carries vault metadata stays unpublished.
// The loading logic lives in src/seed-corpus.mjs so the eval harness seeds the same way.

import { openDb, stats, publishedNotes } from '../src/db.mjs';
import { loadRules, readRulesFile } from '../src/gate.mjs';
import { loadConfig } from '../src/server.mjs';
import { seedDatabase, logSeed } from '../src/seed-corpus.mjs';

// The database the server will open, resolved the same way. Hardcoding a relative 'data/gemba.db'
// here meant the seed wrote to one file while the service read another (GEMBA_DB alone was honoured;
// GEMBA_DATA_DIR was not), so a fresh corpus never reached the running app.
const config = loadConfig();
const rules = loadRules(readRulesFile(config.gateRulesPath));
const dbPath = config.dbPath;
const db = openDb(dbPath);

const result = seedDatabase(db, { rules, log: console.log });
const { files, published, blocked } = result;

// An operator account, when the environment asks for one. The installer passes a generated password
// here rather than storing it anywhere the running app can read it back.
if (process.env.GEMBA_ADMIN_EMAIL && process.env.GEMBA_ADMIN_PASSWORD) {
  const { hashPassword } = await import('../src/auth.mjs');
  const { upsertAdmin } = await import('../src/db.mjs');
  const { user, created } = upsertAdmin(db, {
    email: process.env.GEMBA_ADMIN_EMAIL,
    name: process.env.GEMBA_ADMIN_NAME || 'Operator',
    password_hash: await hashPassword(process.env.GEMBA_ADMIN_PASSWORD)
  });
  console.log(`operator account ${created ? 'created' : 'reset'}: ${user.email}`);
}

logSeed(db, result);
const s = stats(db);
console.log(`notes: ${published} published / ${blocked} not published of ${files}`);
console.log(`db: ${dbPath}`);
console.log(`stats: ${JSON.stringify(s)}`);
console.log(`published slugs: ${publishedNotes(db).map((n) => n.slug).join(', ')}`);
