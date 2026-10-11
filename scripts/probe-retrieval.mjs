#!/usr/bin/env node
// scripts/probe-retrieval.mjs — "why did this question retrieve nothing?"
//
// Prints the corpus the instance can see, the question's folded tokens, the scored hits and the
// coverage verdict. Run it inside the deployment (or a container) when a question that should be
// answered comes back thin:
//   node scripts/probe-retrieval.mjs "the machine stops mid-shift — what should I check, and in what order?"
import { openDb, publishedNotes } from '../src/db.mjs';
import { loadConfig } from '../src/server.mjs';
import { buildIndex, search, coverage, tokenize } from '../src/retrieval.mjs';

const q = process.argv.slice(2).join(' ') || 'the machine stops mid-shift — what should I check, and in what order?';
const dbPath = loadConfig().dbPath;
const db = openDb(dbPath);
const notes = publishedNotes(db);

console.log(`db: ${dbPath}`);
console.log(`published notes: ${notes.length}`);
for (const n of notes) console.log(`  ${n.slug}  ${n.body.length} chars  ${n.title}`);

const index = buildIndex(notes);
console.log(`index: docs=${index.n} terms=${index.df.size} avgdl=${Math.round(index.avgdl)}`);
console.log(`question: ${q}`);
console.log(`tokens: ${tokenize(q).join(' ')}`);

const hits = search(q, index, 5);
console.log(`hits: ${hits.length}`);
for (const h of hits) console.log(`  ${h.score}  ${h.note.slug}  ${h.note.title}`);

console.log(`coverage: ${JSON.stringify(coverage(q, hits, index))}`);
