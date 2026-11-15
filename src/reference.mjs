// src/reference.mjs — the third-party reference shelf: load and read published lean material.
//
// What this is, and what it is not. The corpus (`seed/corpus/`, `notes` table) is the deployment's own
// publishable craft knowledge: every note passed the gate, and the answer engine cites it by name. This
// shelf is someone else's published prose — currently the artoflean.com library — kept so a reader can
// go and read the source. It is never cited as an answer and never merged into the corpus, because it
// did not pass the gate and cannot: it names plants, people and figures that are not ours to publish.
//
// Nothing copyrighted is committed to this repository. The manifest shipped in `seed/reference/` is
// metadata (section, URL, page title) and the page text lives outside git, in the deployment's data
// directory. `loadReference` reads the text files an operator put there and records which pages it saw.
//
// Manifest format (tab-separated, one page per line, a header line first):
//   section <TAB> url <TAB> file <TAB> title
// `file` is the name of the extracted-text file inside the source directory.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { upsertReferenceDoc, pruneReferenceDocs } from './db.mjs';

/** Section order for the shelf index: the site's own reading order, not alphabetical. */
export const SECTION_ORDER = ['learning', 'articles', 'reference', 'gemba-coach', 'a3-report', 'research', 'documents', 'topics', 'about', 'books', 'lean-ai', 'home', ''];

export const SECTION_LABELS = {
  learning: 'Learning guides',
  articles: 'Articles',
  reference: 'Definitions and reference',
  'gemba-coach': 'Ask Art (Gemba Coach)',
  'a3-report': 'A3 reports',
  research: 'Research',
  documents: 'Documents and forms',
  topics: 'Topic indexes',
  about: 'About',
  books: 'Books',
  'lean-ai': 'Lean and AI',
  home: 'The home page',
  '': 'Other pages'
};

export const sectionLabel = (slug) => SECTION_LABELS[slug] ?? slug;

/**
 * A page's address on the shelf, derived from where it lives on the source site: the path with its
 * slashes folded into dashes, so `/learning/kaizen/the-procedure/` is `learning-kaizen-the-procedure`.
 * The root page is `home`. Derived, never counted, so two loads of the same site agree.
 */
export function referenceSlug(sourceUrl) {
  const path = new URL(sourceUrl).pathname.replace(/^\/+|\/+$/g, '');
  const slug = path ? path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'home';
  return slug || 'home';
}

/**
 * The crawl wrote two header lines into each extracted file (`URL:` and `TITLE:`). They duplicate the
 * manifest and would render as a bare paragraph, so they are dropped here rather than in every view.
 */
export function stripCrawlHeader(text) {
  return String(text).replace(/^URL:.*\n?/m, '').replace(/^TITLE:.*\n?/m, '').replace(/^\s*\n/, '').trim();
}

/** Read the manifest into records. A malformed line is a hard error: a silently skipped page is a hole. */
export function readManifest(path) {
  if (!existsSync(path)) throw new Error(`no reference manifest at ${path}`);
  const rows = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const [section, url, file, ...rest] = line.split('\t');
    if (i === 0 && section === 'section') continue;
    if (!url || !file) throw new Error(`${path}:${i + 1} is not "section<TAB>url<TAB>file<TAB>title"`);
    rows.push({ section: section || 'home', url, file, title: (rest.join('\t') || file).trim() });
  }
  return rows;
}

/**
 * Load every page the manifest names from `dir` into the shelf. Two rules, both learned from the corpus
 * loader: a page whose text file is missing is reported and skipped rather than aborting the whole
 * load (one 404 must not leave the shelf empty), and pages the manifest no longer names are retired
 * only when this run actually loaded something — never wipe a shelf because the directory was wrong.
 */
export function loadReference(db, { dir, manifestPath, log = () => {} } = {}) {
  if (!dir) throw new Error('loadReference needs a directory of extracted pages');
  const rows = readManifest(manifestPath);
  const loaded = [];
  const missing = [];
  for (const row of rows) {
    const file = join(dir, row.file);
    if (!existsSync(file)) {
      missing.push(row.file);
      continue;
    }
    const body = stripCrawlHeader(readFileSync(file, 'utf8'));
    if (!body) {
      missing.push(row.file);
      continue;
    }
    const slug = referenceSlug(row.url);
    upsertReferenceDoc(db, { slug, section: row.section, title: row.title, source_url: row.url, body });
    loaded.push(slug);
  }
  const retired = loaded.length ? pruneReferenceDocs(db, loaded) : [];
  log(`reference: ${loaded.length} page(s) loaded, ${missing.length} missing, ${retired.length} retired`);
  if (missing.length) log(`  missing text files: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`);
  return { rows: rows.length, loaded: loaded.length, missing, retired };
}

/**
 * The first place a search word appears, with a little context either side, for a result list. Returns
 * the whole text when the word is not in it (a title-only match). Newlines are folded: the excerpt is
 * one line in a card, not a paragraph with its own line breaks.
 */
export function passageAround(text, word, span = 180) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!word) return flat.slice(0, span);
  const at = flat.toLowerCase().indexOf(String(word).toLowerCase());
  if (at === -1) return flat.slice(0, span);
  const start = Math.max(0, at - Math.floor(span / 3));
  return `${start > 0 ? '… ' : ''}${flat.slice(start, start + span)}${start + span < flat.length ? ' …' : ''}`;
}
