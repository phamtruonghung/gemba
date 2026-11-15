#!/usr/bin/env node
// scripts/load-reference.mjs — put the third-party reference shelf into the database.
//
// The page text is not in this repository (it is someone else's published work and this repo is
// public); what is committed is `seed/reference/manifest.tsv`, the metadata of what the shelf should
// hold. The operator puts the extracted pages in <GEMBA_DATA_DIR>/reference/ and runs this. It is
// separate from `npm run seed` on purpose: the corpus is the deployment's content and is rebuilt on
// every seed, while the reference shelf is a reading collection an operator loads when they want it.
//
//   npm run reference                      # reads $GEMBA_DATA_DIR/reference, manifest in the repo
//   npm run reference -- --dir /path/to/text --manifest /path/to/manifest.tsv
//   npm run reference -- --dry-run         # say what would be loaded, write nothing (no db open)

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, referenceStats } from '../src/db.mjs';
import { loadConfig } from '../src/server.mjs';
import { loadReference, readManifest } from '../src/reference.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
};

const config = loadConfig();
const dir = resolve(String(flag('dir') ?? join(config.dataDir, 'reference')));
const manifestPath = resolve(String(flag('manifest') ?? 'seed/reference/manifest.tsv'));

const rows = readManifest(manifestPath);
const present = rows.filter((r) => existsSync(join(dir, r.file))).length;
console.log(`manifest: ${rows.length} page(s) from ${manifestPath}`);
console.log(`text dir: ${dir} — ${present} of ${rows.length} page file(s) present`);

if (flag('dry-run')) {
  if (!present) console.log('nothing to load. Copy the extracted pages into the text dir, or pass --dir.');
  process.exit(0);
}

if (!present) {
  // An empty shelf is not an error, but a load that would empty an existing shelf is: say so and stop,
  // the same rule the corpus loader follows (never prune on an empty read).
  console.log('no page files found — nothing written, and nothing retired.');
  process.exit(0);
}

const dbPath = flag('db') ? String(flag('db')) : config.dbPath;
const db = openDb(dbPath);
const result = loadReference(db, { dir, manifestPath, log: console.log });
const stats = referenceStats(db);
console.log(`db: ${dbPath}`);
console.log(`shelf: ${stats.docs} page(s), ${stats.chars} characters, ${stats.sections.length} section(s)`);
console.log(`sections: ${stats.sections.map((s) => `${s.section || '(other)'}=${s.n}`).join(', ')}`);
if (!result.loaded) process.exitCode = 1;
