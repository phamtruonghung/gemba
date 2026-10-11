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
    topic: 'tpm', body: 'The press stops because the guard sensor drifts.\n\nCheck it first.',
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
