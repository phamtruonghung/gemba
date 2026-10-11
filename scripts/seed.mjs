#!/usr/bin/env node
// scripts/seed.mjs — build a fresh database: demo expert profiles + the seed corpus.
//
// Every note is run through the real publishability gate, exactly as an expert's submitted note is.
// Notes that need attestation say so in the output: the seed declares them general craft knowledge.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, upsertExpert, upsertNote, pruneSeedNotes, logEvent, stats, publishedNotes } from '../src/db.mjs';
import { decidePublication, loadRules } from '../src/gate.mjs';
import { loadConfig } from '../src/server.mjs';
import { slugify } from '../src/interview.mjs';

const rules = loadRules();
// The database the server will open, resolved the same way. Hardcoding a relative 'data/gemba.db'
// here meant the seed wrote to one file while the service read another (GEMBA_DB alone was honoured;
// GEMBA_DATA_DIR was not), so a fresh corpus never reached the running app.
const dbPath = loadConfig().dbPath;
const db = openDb(dbPath);

const experts = JSON.parse(readFileSync('seed/experts.json', 'utf8'));
for (const e of experts) upsertExpert(db, e);
console.log(`experts: ${experts.length}`);

const corpusDir = 'seed/corpus';
const files = readdirSync(corpusDir).filter((f) => f.endsWith('.md'));
// Who authored which note comes from the expert profiles: an expert declares the topics they cover.
// A hardcoded topic->slug map here drifted from the corpus frontmatter once the topics were renamed,
// and because the lookup had a fallback, every note quietly ended up under one author.
const byAuthor = new Map();
for (const e of experts) for (const top of e.topics ?? []) if (!byAuthor.has(top)) byAuthor.set(top, e.slug);
console.log(`authors: ${[...byAuthor].map(([top, slug]) => `${top}->${slug}`).join(', ')}`);

const seededSlugs = [];
let published = 0;
let blocked = 0;
for (const f of files) {
  const raw = readFileSync(join(corpusDir, f), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  const meta = {};
  for (const line of (fm?.[1] ?? '').split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2];
  }
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const title = meta.title ?? f.replace(/\.md$/, '');
  const topic = meta.topic ?? 'other';
  const origin = meta.origin ?? 'demo';
  const slug = slugify(`${meta.origin === 'vault' ? 'vault' : 'demo'}-${title}`);
  const authorSlug = byAuthor.get(topic);
  if (!authorSlug) {
    throw new Error(`no expert covers topic "${topic}" (${f}) — add it to an expert's topics in seed/experts.json`);
  }
  const author = db.prepare('select id from experts where slug = ?').get(authorSlug);
  if (!author) throw new Error(`expert "${authorSlug}" is not in the database — is it in seed/experts.json?`);

  // Seed notes carry the author's attestation (they are general craft knowledge by construction).
  const decision = decidePublication({ title, body }, { attested: true, rules });
  upsertNote(db, {
    expert_id: author?.id ?? null,
    slug,
    title,
    topic,
    body,
    status: decision.publish ? 'published' : 'blocked',
    gate: decision.report,
    origin: meta.origin ?? 'demo',
    source: meta.source ?? ''
  });
  seededSlugs.push(slug);
  if (decision.publish) published += 1;
  else {
    blocked += 1;
    const why = decision.report.findings.filter((x) => x.severity === 'block').map((x) => `${x.rule}:${x.match}`);
    console.log(`  BLOCKED ${slug} — ${decision.reason} ${why.join(' ')}`);
  }
}

// A note whose slug has left the seed set is a ghost: after a rename the corpus would hold both the
// old and the new copy and the app could answer from the retired one. Only seed-owned origins are
// pruned, and only when this run actually produced notes (never wipe a corpus on an empty seed dir).
let retired = [];
if (seededSlugs.length) retired = pruneSeedNotes(db, seededSlugs);
if (retired.length) {
  console.log(`retired ${retired.length} note(s) this deployment no longer ships: ${retired.map((n) => n.slug).join(', ')}`);
}

logEvent(db, 'seed', '', `experts=${experts.length} notes=${files.length} published=${published} blocked=${blocked} retired=${retired.length}`);
const s = stats(db);
console.log(`notes: ${published} published / ${blocked} blocked of ${files.length}`);
console.log(`db: ${dbPath}`);
console.log(`stats: ${JSON.stringify(s)}`);
console.log(`published slugs: ${publishedNotes(db).map((n) => n.slug).join(', ')}`);
