// The third-party reference shelf, walked over real HTTP: what a load puts on it, how a reader finds a
// page, and the two things the shelf must never do — be presented as one of the deployment's own notes,
// or disappear because one source file was missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { loadReference, readManifest, referenceSlug, stripCrawlHeader, sectionLabel } from '../src/reference.mjs';

const ADMIN = 'test-admin-token';

let app;
let base;
let dir;
let manifestPath;

/** A page as the crawl wrote it: two header lines, then the text. */
const page = (url, title, body) => `URL: ${url}\nTITLE: ${title}\n\n${body}\n`;

const PAGES = [
  {
    section: 'learning',
    url: 'https://example.test/learning/kaizen/the-procedure/',
    file: 'p-kaizen.txt',
    title: 'The six-step kaizen procedure',
    body: 'A procedure channels observation into analysis.\n\n## The cycle\n\nThe steps repeat without end, anchored in PDCA.\n'
  },
  {
    section: 'gemba-coach',
    url: 'https://example.test/gemba-coach/takt-time/',
    file: 'p-takt.txt',
    title: 'What is takt time?',
    body: 'Takt time is available time divided by customer demand.\n\n## Why it is not cycle time\n\nCycle time is what a process actually takes.\n'
  },
  {
    section: 'articles',
    url: 'https://example.test/articles/andon/',
    file: 'p-andon.txt',
    title: 'Andon: surface the abnormal',
    body: 'An andon is a signal, not a report.\n\n## Levels\n\nA cord, a lamp and a board are three levels of the same call.\n'
  }
];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gemba-reference-'));
  const textDir = join(dir, 'text');
  mkdirSync(textDir);
  for (const p of PAGES) writeFileSync(join(textDir, p.file), page(p.url, p.title, p.body));
  manifestPath = join(dir, 'manifest.tsv');
  // The home page carries an empty section in the crawl; it is normalised to `home` on read.
  writeFileSync(
    manifestPath,
    [
      'section\turl\tfile\ttitle',
      ...PAGES.map((p) => [p.section, p.url, p.file, p.title].join('\t')),
      ['', 'https://example.test/', 'p-home.txt', 'The home page'].join('\t'),
      ['articles', 'https://example.test/articles/gone/', 'p-gone.txt', 'A page whose text is missing'].join('\t')
    ].join('\n') + '\n'
  );
  writeFileSync(join(textDir, 'p-home.txt'), page('https://example.test/', 'The home page', 'A site about lean thinking.\n'));

  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0,
      host: '127.0.0.1',
      dbPath: ':memory:',
      dataDir: dir,
      adminToken: ADMIN,
      bankBin: '970436',
      bankAccount: '0123456789',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  loadReference(app.db, { dir: textDir, manifestPath });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.server.close());

const text = async (path) => {
  const res = await fetch(`${base}${path}`);
  return { res, body: await res.text() };
};

test('a page address is derived from where the page lives, so two loads of a site agree', () => {
  assert.equal(referenceSlug('https://artoflean.com/learning/kaizen/the-procedure/'), 'learning-kaizen-the-procedure');
  assert.equal(referenceSlug('https://artoflean.com/'), 'home');
  assert.equal(referenceSlug('https://artoflean.com/reference/hassei-gata-settei-gata/'), 'reference-hassei-gata-settei-gata');
});

test('the crawl header is dropped, because the manifest already carries the same two facts', () => {
  assert.equal(stripCrawlHeader('URL: https://x.test/a/\nTITLE: A page\n\nThe body.\n'), 'The body.');
});

test('a manifest section may be empty and becomes the home section; a row without a url is refused', () => {
  const rows = readManifest(manifestPath);
  assert.equal(rows.find((r) => r.url === 'https://example.test/').section, 'home');
  assert.equal(sectionLabel('home'), 'The home page');
  const bad = join(dir, 'bad.tsv');
  writeFileSync(bad, 'section\turl\tfile\ttitle\narticles\t\tp.txt\tNo url\n');
  assert.throws(() => readManifest(bad), /is not "section/);
});

test('the shelf lists what was loaded, and says what it is for', async () => {
  const { res, body } = await text('/reference');
  assert.equal(res.status, 200);
  for (const p of PAGES) assert.ok(body.includes(p.title), `index is missing ${p.title}`);
  assert.ok(body.includes('is not part of the answer library') || body.includes('not for answers'), 'the index must say the shelf is not the answer corpus');
  assert.ok(body.includes('Learning guides'), 'section chips carry the readable section name');
});

test('a page opens with its own text, its attribution and a link to the original', async () => {
  const { res, body } = await text('/reference/learning-kaizen-the-procedure');
  assert.equal(res.status, 200);
  assert.ok(body.includes('The six-step kaizen procedure'));
  assert.ok(body.includes('anchored in PDCA'), 'the page body renders');
  assert.ok(body.includes('Third-party reference'), 'the page says whose words these are');
  assert.ok(body.includes('https://example.test/learning/kaizen/the-procedure/'), 'the page links the original');
  assert.ok(body.includes('<a class="plain" href="/reference">'), 'the page points back at the shelf');
});

test('an address that is not on the shelf is a 404, not an empty page', async () => {
  const { res } = await text('/reference/no-such-page');
  assert.equal(res.status, 404);
});

test('a search word narrows the shelf and shows the passage it matched', async () => {
  const { res, body } = await text('/reference?q=takt');
  assert.equal(res.status, 200);
  assert.ok(body.includes('What is takt time?'));
  assert.ok(!body.includes('The six-step kaizen procedure'), 'a page without the word is not a result');
  assert.ok(body.includes('available time divided by customer demand'), 'the matched passage is shown');
});

test('a section filter stays inside that section', async () => {
  const { body } = await text('/reference?section=articles');
  assert.ok(body.includes('Andon: surface the abnormal'));
  assert.ok(!body.includes('What is takt time?'));
});

test('LIKE metacharacters in a search are characters, not wildcards', async () => {
  const { res, body } = await text('/reference?q=%25');
  assert.equal(res.status, 200);
  assert.match(body, /Nothing on the shelf matches/, 'no page holds a literal %, so nothing matches');
});

test('the shelf is not the library: its pages are never listed as notes', async () => {
  const { body } = await text('/library');
  for (const p of PAGES) assert.ok(!body.includes(p.title), `${p.title} must not appear in the answer library`);
});

test('re-loading the same manifest updates pages instead of duplicating them', () => {
  const before = app.db.prepare('select count(*) n from reference_docs').get().n;
  loadReference(app.db, { dir: join(dir, 'text'), manifestPath });
  const after = app.db.prepare('select count(*) n from reference_docs').get().n;
  assert.equal(after, before);
});

test('a page whose text file is missing is reported, and the rest of the shelf still loads', () => {
  const textDir = join(dir, 'text');
  const sparse = join(dir, 'sparse.tsv');
  writeFileSync(
    sparse,
    ['section\turl\tfile\ttitle', ['articles', 'https://example.test/articles/andon/', 'p-andon.txt', 'Andon: surface the abnormal'].join('\t'), ['learning', 'https://example.test/learning/absent/', 'p-absent.txt', 'Not copied yet'].join('\t')].join('\n') + '\n'
  );
  const result = loadReference(app.db, { dir: textDir, manifestPath: sparse });
  assert.equal(result.loaded, 1);
  assert.deepEqual(result.missing, ['p-absent.txt']);
  assert.deepEqual(result.retired.sort(), ['gemba-coach-takt-time', 'home', 'learning-kaizen-the-procedure'].sort(), 'pages this manifest no longer names are retired');
});
