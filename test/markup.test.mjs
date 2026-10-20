// Markup invariants that a browser check cannot see and a unit test usually forgets.
//
// The bug this file exists for: `icon('chat')` was called in the landing page while the icon set had
// no `chat` entry. `icon()` renders the <svg> either way and puts an empty string inside it, so the
// page shipped a button with a hole in it — invisible in the test suite, invisible in the CSS, and
// only visible if you looked at the screen. Both halves are checked now: the call sites against the
// set, and the rendered pages for an empty glyph.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, upsertNote } from '../src/db.mjs';

const ADMIN = 'markup-admin-token';
const EXPERT_TOKEN = 'tok-hung-markup';

let app;
let base;

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data',
      adminToken: ADMIN, bankBin: '970436', bankAccount: '0123456789',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  const expertId = upsertExpert(app.db, {
    slug: 'hung-qa', name: 'Hung', headline: 'Production supervisor (sample profile)',
    years: 9, topics: ['tpm', 'quality'], bio: 'Ran the line, then the improvement plan.',
    rate_vnd: 800000, token: EXPERT_TOKEN
  });
  upsertNote(app.db, {
    expert_id: expertId, slug: 'markup-note', title: 'A note that exists so a page has something on it',
    topic: 'tpm',
    // A body with real markdown in it: the reading view is the thing under test.
    body: 'The press stops because the guard sensor drifts.\n\n## What to check first\n\n'
      + '- The guard sensor gap.\n- The *reset* lever.\n\nCheck the sensor before the lever, as [[markup-note]] says.',
    status: 'published', gate: { verdict: 'clean', ok: true, needs_attestation: false, findings: [] },
    origin: 'demo'
  });
  app.rebuildIndex();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => { try { app.server.close(); } catch { /* already down */ } });

const get = async (path, init) => {
  const res = await fetch(base + path, init);
  return { status: res.status, html: await res.text() };
};

test('every icon a page asks for exists in the icon set', () => {
  const src = readFileSync(new URL('../src/views.mjs', import.meta.url), 'utf8');
  const block = /const ICON = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'the icon set is where the views say it is');
  const defined = new Set([...block[1].matchAll(/^\s{2}([a-z][\w-]*):\s*'/gm)].map((m) => m[1]));
  assert.ok(defined.size > 10, `the icon set parsed (${defined.size} glyphs)`);

  const used = new Set([...src.matchAll(/icon\(\s*'([a-z][\w-]*)'/g)].map((m) => m[1]));
  const missing = [...used].filter((n) => !defined.has(n));
  assert.deepEqual(missing, [], `these icons are asked for but not defined: ${missing.join(', ')}`);
});

test('no page ships an empty glyph', async () => {
  // the routes a person can land on, including the ones behind a token
  const paths = ['/', '/library', '/experts', '/how-it-works', '/signin', '/signup',
    `/c/${EXPERT_TOKEN}`, `/x/${ADMIN}`];
  for (const path of paths) {
    const { status, html } = await get(path);
    assert.ok(status < 500, `${path} answers (${status})`);
    const empty = /<svg class="ico"[^>]*>\s*<\/svg>/.test(html);
    assert.equal(empty, false, `${path} renders a glyph with nothing inside it`);
  }
});

test('every page has one h1, a language, and a title', async () => {
  const paths = ['/', '/library', '/experts', '/how-it-works', '/signin', '/signup', '/account'];
  for (const path of paths) {
    const { html } = await get(path);
    assert.match(html, /<html lang="en"/, `${path} declares its language`);
    assert.match(html, /<title>[^<]+<\/title>/, `${path} has a title`);
    const h1s = [...html.matchAll(/<h1[\s>]/g)].length;
    assert.equal(h1s, 1, `${path} has exactly one h1 (found ${h1s})`);
  }
});

test('the theme is orange and it is a token, not a scattered literal', async () => {
  const src = readFileSync(new URL('../src/views.mjs', import.meta.url), 'utf8');
  assert.match(src, /--color-accent:\s*#ea580c;/i, 'the brand colour is the orange token');
  assert.match(src, /--color-background:\s*#f7f4f1;/i, 'and the page sits on warm paper');

  const { html } = await get('/');
  // the brand orange appears in the page through the token; the mark and the primary action use it
  assert.match(html, /--color-accent:#ea580c/i);
  assert.match(html, /class="brand"/);
  assert.match(html, /<svg class="ico"[^>]*>\s*<path/, 'a glyph with a path in it');
});

test('a note reads as prose, not as its own markdown source', async () => {
  // The bug this guards: the note page printed `esc(note.body)`, so a reader met "## What to check
  // first" with the hashes and the bullets as hyphens — the syntax of the note, not the note.
  const { html } = await get('/notes/markup-note');
  assert.match(html, /<div class="prose">/, 'the body renders in the reading view');
  assert.match(html, /<h2 id="what-to-check-first">What to check first<a class="sec-anchor"/, 'a section heading is a heading');
  assert.match(html, /<ul>\s*<li>The guard sensor gap\.<\/li>/, 'a bullet is a bullet');
  assert.match(html, /<em>reset<\/em>/, 'and emphasis is emphasis');

  const page = html.replace(/<style>[\s\S]*?<\/style>/, '');
  assert.ok(!/##\s/.test(page), 'no heading syntax survives on the page');
  assert.ok(!/<li>- /.test(page), 'and no bullet is printed as a hyphen');
});

test('a form that waits on a model says so instead of looking broken', async () => {
  const { html } = await get('/');
  assert.match(html, /data-pending="Thinking…"/, 'the ask form declares what to say while it waits');
  assert.match(html, /data-pending-note/, 'and carries a place to say it');
  assert.match(html, /addEventListener\('submit'/, 'the one script listens for the submit');
});

test('a note that names another note links to it', async () => {
  // The renderer resolves `[[name]]`; this proves the server hands it the library's own slugs, which is
  // the half a unit test on the renderer cannot see.
  const { html } = await get('/notes/markup-note');
  assert.match(html, /<a href="\/notes\/markup-note">/, 'the reference is a link to the note');
  assert.ok(!html.includes('[['), 'and the wiki brackets never reach the reader');
});

test('the booking page QR encodes the bank, the account, the amount and the reference', async () => {
  // The bug this guards: the image was built from the booking ref alone (`vietqr-B-…`), so the code
  // carried no account and no amount. The old assertion only looked for the host name.
  const res = await fetch(`${base}/book`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      expert: 'hung-qa', minutes: '45', starts_at: '2030-11-02 09:00', asker: 'QR client',
      contact: 'qr@example.com', topic: 'tpm', agenda: 'The press stops at the last station and I need an order of checks.'
    })
  });
  assert.equal(res.status, 303);
  const location = res.headers.get('location');
  const ref = location.split('/').pop();
  const { html } = await get(location);
  const tag = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]).find((t) => t.includes('vietqr'));
  assert.ok(tag, 'the page has a VietQR image');
  const src = /src="([^"]*)"/.exec(tag)[1].replace(/&amp;/g, '&');
  const price = app.db.prepare('select price_vnd from bookings where ref = ?').get(ref).price_vnd;
  assert.ok(price > 0);
  assert.ok(src.includes('/image/970436-0123456789-'), `bank BIN and account in the path: ${src}`);
  assert.ok(src.includes(`amount=${price}`), `the amount in the query: ${src}`);
  assert.ok(src.includes(`addInfo=${ref}`), `the reference in the query: ${src}`);
  assert.ok(!/vietqr-B-/.test(src), 'not built from the ref alone');
});
