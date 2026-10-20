// src/seed-corpus.mjs — load the demo experts and the seed corpus into a database.
//
// Every note is run through the real publishability gate, exactly as an expert's submitted note is.
// Notes that need attestation say so in the output: the seed declares them general craft knowledge.
// Importable so scripts (seed, eval) build the corpus the same way; paths resolve from the repo root,
// never from the working directory.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertExpert, upsertNote, pruneSeedNotes, logEvent } from './db.mjs';
import { decidePublication } from './gate.mjs';
import { slugify } from './interview.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function seedDatabase(
  db,
  { rules, corpusDir = join(ROOT, 'seed', 'corpus'), expertsPath = join(ROOT, 'seed', 'experts.json'), log = () => {} } = {}
) {
  const experts = JSON.parse(readFileSync(expertsPath, 'utf8'));
  for (const e of experts) upsertExpert(db, e);
  log(`experts: ${experts.length}`);

  const files = readdirSync(corpusDir).filter((f) => f.endsWith('.md')).sort();
  // Who authored which note comes from the expert profiles: an expert declares the topics they cover.
  // A hardcoded topic->slug map here drifted from the corpus frontmatter once the topics were renamed,
  // and because the lookup had a fallback, every note quietly ended up under one author.
  const byAuthor = new Map();
  for (const e of experts) for (const top of e.topics ?? []) if (!byAuthor.has(top)) byAuthor.set(top, e.slug);
  log(`authors: ${[...byAuthor].map(([top, slug]) => `${top}->${slug}`).join(', ')}`);

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
      log(`  BLOCKED ${slug} — ${decision.reason} ${why.join(' ')}`);
    }
  }

  // A note whose slug has left the seed set is a ghost: after a rename the corpus would hold both the
  // old and the new copy and the app could answer from the retired one. Only seed-owned origins are
  // pruned, and only when this run actually produced notes (never wipe a corpus on an empty seed dir).
  let retired = [];
  if (seededSlugs.length) retired = pruneSeedNotes(db, seededSlugs);
  if (retired.length) {
    log(`retired ${retired.length} note(s) this deployment no longer ships: ${retired.map((n) => n.slug).join(', ')}`);
  }
  return { experts: experts.length, files: files.length, published, blocked, retired, seededSlugs };
}

/** Record the seed run in the event log (kept separate so callers can order it after other seed steps). */
export function logSeed(db, r) {
  logEvent(db, 'seed', '', `experts=${r.experts} notes=${r.files} published=${r.published} blocked=${r.blocked} retired=${r.retired.length}`);
}
