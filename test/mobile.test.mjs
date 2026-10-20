// Phone-facing behaviour that is server-side: the privacy of a shared question link, the share block,
// the reader preferences (text size, place), and the markdown that keeps a wide table inside the page.
import { test, before, after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';

import { createApp, safeNext } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, upsertNote, insertQuestion } from '../src/db.mjs';
import { renderMarkdown, headingId } from '../src/markdown.mjs';

let app, base, ref;
const CONTACT = '0912 345 678';
const NOTE_BODY = '## Bảo trì tự quản\n\nOperators clean.\n\n## Bảo trì tự quản\n\nAgain.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data', adminToken: 'tok', bankBin: '', bankAccount: '', llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 } }
  });
  const id = upsertExpert(app.db, { slug: 'hung-qa', name: 'Hung', headline: 'x', topics: ['tpm'], years: 5, rate_vnd: 800000, token: 'tok-h' });
  upsertNote(app.db, { expert_id: id, slug: 'seed-1-a', title: 'A note', topic: 'tpm', body: NOTE_BODY, status: 'published', gate: { verdict: 'clean', ok: true, needs_attestation: false, findings: [] }, origin: 'demo' });
  app.rebuildIndex();
  // A refused (thin) question with a contact on it: the page that offers "ask a practitioner".
  ref = insertQuestion(app.db, { asker: 'Lan', contact: CONTACT, plant_type: '', topic: 'tpm', text: 'Something off-corpus', ai_answer: 'INSUFFICIENT_DATA', ai_citations: [], ai_coverage: 'thin', ai_mode: 'extractive', user_id: null }).ref;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

// fetch() will not let a test set Host; node:http will.
const rawGet = (path, headers) => new Promise((resolve, reject) => {
  http.get(base + path, { headers }, (r) => {
    const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve(Buffer.concat(c).toString()));
  }).on('error', reject);
});

const form = (path, data, headers = {}) =>
  fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data) });

test('a question link does not hand the asker contact to a stranger', async () => {
  const html = await (await fetch(`${base}/q/${ref}`)).text();
  assert.ok(html.includes('Ask a practitioner'), 'the refusal page with its form is what was fetched');
  assert.ok(!html.includes(CONTACT), 'the stored contact must not appear in the page');
  assert.ok(!html.includes('0912'));
});

test('a signed-in stranger is prefilled with their own email, never the asker contact', async () => {
  const signup = await form('/signup', { name: 'Pat', email: 'pat@example.com', password: 'a sentence of ten' });
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(`${base}/q/${ref}`, { headers: { cookie } })).text();
  assert.ok(!html.includes(CONTACT));
  assert.ok(html.includes('value="pat@example.com"'));
});

test('the share block has an encoded mailto, a copy field with the absolute URL, and a hidden native button', async () => {
  const html = await rawGet(`/q/${ref}`, { 'x-forwarded-proto': 'https', host: 'gemba.example.vn' });
  const url = `https://gemba.example.vn/q/${ref}`;
  assert.ok(html.includes(`<input id="share-url" type="text" readonly value="${url}"`));
  assert.ok(html.includes('<label for="share-url">'));
  const mail = /href="(mailto:[^"]+)"/.exec(html)[1].replaceAll('&amp;', '&');
  assert.match(mail, /^mailto:\?subject=[^ ]+&body=/);
  assert.ok(mail.includes(encodeURIComponent(url)));
  assert.match(html, /<button class="btn alt" type="button" data-share [^>]*hidden>/);
  assert.ok(html.includes('class="actionbar"'));
  const note = await (await fetch(`${base}/notes/seed-1-a`)).text();
  assert.ok(note.includes('http://127.0.0.1:') && note.includes('/notes/seed-1-a'));
  assert.ok(note.includes('data-share'));
});

test('a hostile Host header cannot put markup in the share URL', async () => {
  const res = await rawGet('/notes/seed-1-a', { host: '"><script>x</script>' });
  assert.ok(!res.includes('<script>x</script>'));
});

test('safeNext keeps redirects on this origin', () => {
  assert.equal(safeNext('/notes/a'), '/notes/a');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'evil', '', undefined, '/a\r\nset-cookie: x=1']) {
    assert.equal(safeNext(bad), '/', String(bad));
  }
});

test('POST /prefs/text sets the cookie and redirects; GET with the cookie renders data-text', async () => {
  const res = await form('/prefs/text', { size: 'large', next: '/notes/seed-1-a' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/notes/seed-1-a');
  const set = res.headers.get('set-cookie');
  assert.match(set, /^gemba_text=large;/);
  assert.match(set, /Max-Age=31536000/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Path=\//);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const evil = await form('/prefs/text', { size: 'xl', next: '//evil.example' });
  assert.equal(evil.headers.get('location'), '/');
  const junk = await form('/prefs/text', { size: '999px', next: '/' });
  assert.match(junk.headers.get('set-cookie'), /^gemba_text=normal;/);
  const html = await (await fetch(`${base}/notes/seed-1-a`, { headers: { cookie: 'gemba_text=large' } })).text();
  assert.match(html, /<html lang="en" data-text="large">/);
  assert.match(html, /name="size" value="large" aria-label="Large text" aria-pressed="true"/);
  const plain = await (await fetch(`${base}/notes/seed-1-a`, { headers: { cookie: 'gemba_text=bogus' } })).text();
  assert.ok(plain.includes('<html lang="en">'));
});

test('headings get stable, deduplicated ids and a visible section link', () => {
  assert.equal(headingId('Bảo trì tự quản'), 'bao-tri-tu-quan');
  assert.equal(headingId('Đo lường'), 'do-luong');
  const outline = [];
  const html = renderMarkdown(NOTE_BODY, { outline });
  assert.deepEqual(outline.map((h) => h.id), ['bao-tri-tu-quan', 'bao-tri-tu-quan-2']);
  assert.ok(html.includes('<a class="sec-anchor" href="#bao-tri-tu-quan-2"'));
});

test('a table is wrapped so it scrolls inside itself, reachable by keyboard', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n');
  assert.match(html, /^<div class="table-scroll" tabindex="0" role="region" aria-label="[^"]+"><table>/);
  assert.ok(html.endsWith('</table></div>'));
});

test('keeping a place sets the cookie, validates the section, and the library offers to continue', async () => {
  const res = await form('/notes/seed-1-a/place', { section: 'bao-tri-tu-quan-2' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/notes/seed-1-a#bao-tri-tu-quan-2');
  const set = res.headers.get('set-cookie');
  assert.match(set, /^gemba_place=seed-1-a#bao-tri-tu-quan-2;/);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const bad = await form('/notes/seed-1-a/place', { section: 'not-a-heading' });
  assert.equal(bad.headers.get('location'), '/notes/seed-1-a');
  assert.equal(bad.headers.get('set-cookie'), null);
  assert.equal((await form('/notes/nope/place', { section: 'x' })).status, 404);
  const cookie = 'gemba_place=seed-1-a#bao-tri-tu-quan-2';
  for (const p of ['/library', '/']) {
    const html = await (await fetch(base + p, { headers: { cookie } })).text();
    assert.ok(html.includes('Continue reading:') && html.includes('href="/notes/seed-1-a#bao-tri-tu-quan-2"'), p);
    const none = await (await fetch(base + p)).text();
    assert.ok(!none.includes('Continue reading:'), p);
  }
  const forged = await (await fetch(`${base}/library`, { headers: { cookie: 'gemba_place=seed-1-a#injected' } })).text();
  assert.ok(!forged.includes('Continue reading:'));
});

test('a note page stays cacheable, and the note carries the place form', async () => {
  const res = await fetch(`${base}/notes/seed-1-a`);
  assert.equal(res.headers.get('cache-control'), null);
  assert.ok((await res.text()).includes('action="/notes/seed-1-a/place"'));
});

// --- page weight: one cached stylesheet, and guests get gzip + ETag -----------------------------------
import { gunzipSync } from 'node:zlib';
import { CSS_HREF } from '../src/views.mjs';
import { SHELL_URLS, cachePolicy } from '../src/pwa.mjs';

const raw = (path, headers = {}) => new Promise((resolve, reject) => {
  http.get(base + path, { headers }, (r) => {
    const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) }));
  }).on('error', reject);
});

test('the stylesheet is a hashed file, not 27 KB repeated in every page', async () => {
  const home = (await raw('/')).body.toString();
  assert.ok(!/<style>/.test(home), 'no inline <style> in the page');
  assert.ok(home.includes(`<link rel="stylesheet" href="${CSS_HREF}">`));
  assert.ok(Buffer.byteLength(home) < 30000, `the page is ${Buffer.byteLength(home)} bytes`);
  assert.match(CSS_HREF, /^\/app\.[0-9a-f]{12}\.css$/);

  const css = await raw(CSS_HREF);
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.match(css.headers['cache-control'], /immutable/);
  assert.match(css.headers['cache-control'], /max-age=31536000/);
  assert.ok(css.headers.etag);
  assert.ok(css.body.toString().includes('header.site'));
  const gz = await raw(CSS_HREF, { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(gz.body).toString(), css.body.toString());
  assert.equal((await raw('/app.000000000000.css')).status, 404, 'a wrong hash is not the stylesheet');
  assert.equal((await raw(CSS_HREF, { 'if-none-match': css.headers.etag })).status, 304);
});

test('the worker precaches the stylesheet, so /offline is styled with no signal', () => {
  assert.ok(SHELL_URLS.includes(CSS_HREF));
  assert.equal(cachePolicy(CSS_HREF, 'GET'), 'shell');
});

test('a guest page is gzipped and revalidates with an ETag; the bytes are the same page', async () => {
  const plain = await raw('/');
  const gz = await raw('/', { 'accept-encoding': 'gzip' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers.vary, 'accept-encoding');
  assert.equal(gunzipSync(gz.body).toString(), plain.body.toString());
  assert.ok(gz.body.length < plain.body.length / 2, `${gz.body.length} vs ${plain.body.length}`);
  assert.equal(gz.headers['cache-control'], 'no-cache');

  const again = await raw('/', { 'accept-encoding': 'gzip', 'if-none-match': gz.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  const head = await new Promise((resolve) => http.request(base + '/', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } }, (r) => { r.resume(); r.on('end', () => resolve(r)); }).end());
  assert.equal(head.statusCode, 200);
});

test('a page that knows who you are is never compressed or tagged (BREACH: token beside typed text)', async () => {
  const signup = await form('/signup', { name: 'Gz', email: 'gz@example.com', password: 'a sentence of ten' });
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const res = await raw('/account', { cookie, 'accept-encoding': 'gzip' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(res.headers.etag, undefined);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.ok(res.body.toString().includes('name="csrf"'));
});

test('a tokenised guest page keeps `private, no-store`: an ETag does not make it cacheable', async () => {
  const res = await raw(`/q/${ref}`, { 'accept-encoding': 'gzip' });
  assert.equal(res.headers['cache-control'], 'private, no-store');
});

test('a gated instance serves the stylesheet to the 401 and sign-in pages without a password', async () => {
  const gated = createApp({
    dbPath: ':memory:', rules: loadRules(),
    config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data', adminToken: 'tok', user: 'u', pass: 'p', bankBin: '', bankAccount: '', llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 } }
  });
  await new Promise((r) => gated.server.listen(0, '127.0.0.1', r));
  try {
    const b = `http://127.0.0.1:${gated.server.address().port}`;
    assert.equal((await fetch(b + '/')).status, 401);
    const css = await fetch(b + CSS_HREF);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  } finally { gated.server.close(); }
});
