// End-to-end test over real HTTP: the whole ladder, walked as a customer would.
// No API key is configured here, so the AI tier runs in its labelled extractive mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, upsertNote } from '../src/db.mjs';

const ADMIN = 'test-admin-token';
const EXPERT_TOKEN = 'tok-hung-test';

let app;
let base;

function noteFromCorpus(file) {
  const raw = readFileSync(join('seed/corpus', file), 'utf8');
  const title = /^title:\s*(.+)$/m.exec(raw)[1].trim();
  const topic = /^topic:\s*(.+)$/m.exec(raw)[1].trim();
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return { title, topic, body, slug: file.replace(/\.md$/, '') };
}

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0,
      host: '127.0.0.1',
      dbPath: ':memory:',
      dataDir: 'data',
      adminToken: ADMIN,
      bankBin: '970436',
      bankAccount: '0123456789',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  const expertId = upsertExpert(app.db, {
    slug: 'hung-qa',
    name: 'Hung',
    headline: 'Production supervisor (sample profile)',
    topics: ['tpm', 'shift-management', 'improvement', 'safety'],
    years: 20,
    rate_vnd: 800000,
    token: EXPERT_TOKEN
  });
  const lanId = upsertExpert(app.db, {
    slug: 'lan-lap-rap',
    name: 'Lan',
    headline: 'Assembly shift leader (sample profile)',
    topics: ['quality', 'safety'],
    years: 12,
    rate_vnd: 600000,
    token: 'tok-lan-test'
  });
  let n = 0;
  for (const file of ['demo-machine-stops-mid-shift.md', 'demo-andon-surface-the-abnormal.md', 'demo-5s-on-the-floor.md', 'demo-one-point-standard.md']) {
    const note = noteFromCorpus(file);
    n += 1;
    upsertNote(app.db, {
      expert_id: note.topic === 'quality' ? lanId : expertId,
      slug: `seed-${n}-${note.slug}`,
      title: note.title,
      topic: note.topic,
      body: note.body,
      status: 'published',
      gate: { verdict: 'clean', ok: true, needs_attestation: false, findings: [] },
      origin: 'demo'
    });
  }
  app.rebuildIndex();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.server.close());

async function ask(question, extra = {}) {
  const res = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, ...extra })
  });
  return { res, body: await res.json() };
}

// redirect: 'manual' — fetch follows 303 by default, which would hide the redirect the
// platform uses to move the browser to the question / booking / note page.
function post(path, data = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data)
  });
}

test('healthz reports the corpus size and the AI tier honestly', async () => {
  const res = await fetch(`${base}/healthz`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.notes, 4);
  assert.equal(body.llm, 'none');
  assert.equal(body.db, undefined, 'healthz must not print the database path on a public host');
});

test('ask: an on-corpus question is answered with citations to real notes', async () => {
  const { res, body } = await ask('the machine stops mid-shift, what do I check and in what order');
  assert.equal(res.status, 200);
  assert.equal(body.coverage, 'ok');
  assert.ok(body.citations.length >= 1);
  assert.equal(body.hits[0].slug, 'seed-1-demo-machine-stops-mid-shift');
  const note = await fetch(`${base}/api/question/${body.ref}`);
  const stored = await note.json();
  assert.equal(stored.ai_coverage, 'ok');
  assert.equal(stored.status, 'open');
});

test('ask: an off-corpus question says so instead of guessing', async () => {
  const { body } = await ask('office recruitment procedure and the salary policy');
  assert.equal(body.coverage, 'thin');
  assert.match(body.answer, /INSUFFICIENT_DATA/);
});

test('the full ladder: ask → escalate → a practitioner answers', async () => {
  const { body: asked } = await ask('rules for seasonal labour contracts outside the plant', { asker: 'Test client', contact: 'thu@example.com' });
  assert.equal(asked.coverage, 'thin');

  const esc = await post(`/q/${asked.ref}/ask-expert`, { asker: 'Test client', contact: 'thu@example.com' });
  assert.equal(esc.status, 303);
  const routed = await (await fetch(`${base}/api/question/${asked.ref}`)).json();
  assert.equal(routed.status, 'routed');
  assert.ok(routed.due_at, 'a reply deadline is set');

  const workspace = await fetch(`${base}/c/${EXPERT_TOKEN}`);
  const html = await workspace.text();
  assert.equal(workspace.status, 200);
  assert.match(html, new RegExp(asked.ref), 'the question reaches the expert workspace');

  const answered = await post(`/c/${EXPERT_TOKEN}/answer`, { ref: asked.ref, body: 'A seasonal contract has to state its term and any annex; check the termination clause before signing.' });
  assert.equal(answered.status, 303);
  const after = await (await fetch(`${base}/api/question/${asked.ref}`)).json();
  assert.equal(after.status, 'answered');
  assert.equal(after.answers.length, 1);
  assert.match(after.answers[0].body, /termination clause/);

  const page = await (await fetch(`${base}/q/${asked.ref}`)).text();
  assert.match(page, /Answer from Hung/);
});

test('gate at the door: a note with an order number is refused, a clean note publishes', async () => {
  const leaky = await post(`/c/${EXPERT_TOKEN}/note`, {
    title: 'Handling a bad batch',
    topic: 'quality',
    attested: '1',
    body: `# Handling a bad batch\n\n## Context\nThe batch on PO 45123 was wrong and the unit price came in above plan, so it had to be handled inside the shift.\n\n## What to do\nCheck in order and write the symptom down before changing anything.`
  });
  assert.equal(leaky.status, 422);
  assert.match(await leaky.text(), /document/);

  const clean = await post(`/c/${EXPERT_TOKEN}/note`, {
    title: 'Checking the last-station sensor, in order',
    topic: 'tpm',
    body: `# Checking the last-station sensor, in order\n\n## The order\nFirst look at the indicator light on the station, then check that the material matches the specification, and only then measure the sensor.\n\n## Why this order\nMaterial out of specification is mistaken for a sensor fault far more often than a real sensor fault, so checking the material first saves stop time.\n\n## Write it down\nRecord the symptom in the shift notebook so the next crew can read it. Do not record the plant's output figures.`
  });
  assert.equal(clean.status, 303);
  const published = await (await fetch(`${base}/library`)).text();
  assert.match(published, /Checking the last-station sensor, in order/);
});

test('the AI-moderated interview turns eight answers into a draft the expert attests and publishes', async () => {
  const start = await fetch(`${base}/c/${EXPERT_TOKEN}/interview`);
  const html = await start.text();
  assert.equal(start.status, 200);
  assert.match(html, /Question 1 of 8/);

  const idMatch = /name="id" value="(\d+)"/.exec(html);
  assert.ok(idMatch, 'the interview session id is in the form');
  const id = idMatch[1];

  const answers = [
    'I have done this work for twenty years, covering assembly and basic maintenance.',
    'The most repeated problem is material off specification at the last station stopping the line.',
    'The first sign is the indicator light at the last station blinking, and the final checker notices it.',
    'The root cause is usually a mis-picked material batch; verify it by comparing the packaging against the delivery note.',
    'The fix: stop the station, quarantine the suspect material, tell the team leader, write the symptom down, then restart.',
    'A newcomer replaces the sensor before checking the material, which wastes time and leaves the fault in place.',
    'The standard is to check the material before the sensor, and everyone follows that order.',
    'This works on a multi-station assembly line. It does not work when the customer supplies the material and the packaging may not be opened.'
  ];
  let last;
  for (let i = 0; i < answers.length; i += 1) {
    last = await post(`/c/${EXPERT_TOKEN}/interview`, { id, answer: answers[i] });
    assert.equal(last.status, 303);
  }
  // The interview ends at a draft to review, not at a published note.
  const reviewUrl = last.headers.get('location');
  assert.match(reviewUrl, /\/draft\?slug=/);
  assert.doesNotMatch(await (await fetch(`${base}/library`)).text(), /Field notes: The most repeated problem/, 'a draft is not in the corpus');
  const review = await (await fetch(`${base}${reviewUrl}`)).text();
  assert.match(review, /Field notes: The most repeated problem/);
  assert.match(review, /I confirm: I confirm this is my own craft knowledge/);

  const slug = new URL(reviewUrl, base).searchParams.get('slug');
  const done = await post(`/c/${EXPERT_TOKEN}/draft`, { slug, title: 'Field notes: The most repeated problem', body: decodeHtml(/<textarea id="draft-body"[^>]*>([\s\S]*?)<\/textarea>/.exec(review)[1]), attested: '1', action: 'publish' });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Note published/);

  const corpus = await (await fetch(`${base}/library`)).text();
  assert.match(corpus, /Field notes: The most repeated problem/, 'the interview note is in the corpus, titled after the problem');
});

async function runInterview(answers) {
  const html = await (await fetch(`${base}/c/${EXPERT_TOKEN}/interview`)).text();
  const id = /name="id" value="(\d+)"/.exec(html)[1];
  let last;
  for (const answer of answers) {
    last = await post(`/c/${EXPERT_TOKEN}/interview`, { id, answer });
    assert.equal(last.status, 303);
  }
  assert.match(last.headers.get('location'), /\/draft\?slug=/);
  return { id, slug: new URL(last.headers.get('location'), base).searchParams.get('slug') };
}

const noteCount = () => app.db.prepare('select count(*) n from notes').get().n;
const healthNotes = async () => (await (await fetch(`${base}/healthz`)).json()).notes;

test('a ninth interview answer after the published note is filed sends the practitioner to that note, not a second draft', async () => {
  const { id, slug } = await runInterview([
    'Alpha: I have worked the paint line for fifteen years, mostly on changeovers.',
    'Alpha: the most repeated problem is colour drift after a changeover on the paint line.',
    'Alpha: the first sign is a faint stripe on the first panels out of the oven.',
    'Alpha: the root cause is residue in the hose; verify it by flushing into a white cup.',
    'Alpha: the fix is to flush the hose, tell the team leader, log the stripe, then restart the line.',
    'Alpha: a newcomer repaints the panels instead of flushing the hose first.',
    'Alpha: the standard is to flush before the first panel after any changeover.',
    'Alpha: this works on the paint line, not on the powder coating line.'
  ]);
  const review = await (await fetch(`${base}/c/${EXPERT_TOKEN}/draft?slug=${encodeURIComponent(slug)}`)).text();
  const done = await post(`/c/${EXPERT_TOKEN}/draft`, { slug, title: 'Field notes: Alpha colour drift', body: decodeHtml(/<textarea id="draft-body"[^>]*>([\s\S]*?)<\/textarea>/.exec(review)[1]), attested: '1', action: 'publish' });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Note published/);

  const countBefore = noteCount();
  const deskBefore = await (await fetch(`${base}/c/${EXPERT_TOKEN}`)).text();
  const healthBefore = await healthNotes();
  const libraryBefore = await (await fetch(`${base}/library`)).text();

  const ninth = await post(`/c/${EXPERT_TOKEN}/interview`, { id, answer: 'Alpha: one more thing nobody asked about.' });
  assert.equal(ninth.status, 303);
  assert.equal(ninth.headers.get('location'), `/notes/${slug}`);
  assert.doesNotMatch(ninth.headers.get('location'), /draft\?slug=|-2/);
  assert.equal(noteCount(), countBefore);
  assert.equal(await healthNotes(), healthBefore);
  const libraryAfter = await (await fetch(`${base}/library`)).text();
  assert.equal(libraryAfter, libraryBefore);
  assert.equal(libraryAfter.split('Field notes: Alpha colour drift').length, libraryBefore.split('Field notes: Alpha colour drift').length, 'no duplicated title');
  const deskAfter = await (await fetch(`${base}/c/${EXPERT_TOKEN}`)).text();
  assertDeskUnchanged(deskBefore, deskAfter, 'Field notes: Alpha colour drift');
});

test('a ninth interview answer while the draft is still unpublished sends the practitioner back to that same draft', async () => {
  const { id, slug } = await runInterview([
    'Beta: I have run the packing bench for ten years, mostly on export orders.',
    'Beta: the most repeated problem is a carton sealed with the wrong label on the packing bench.',
    'Beta: the first sign is a label whose barcode does not match the carton size.',
    'Beta: the root cause is a label roll swapped at shift change; verify it against the roll tag.',
    'Beta: the fix is to stop the bench, pull the cartons, tell the team leader, log it, then relabel.',
    'Beta: a newcomer peels the label off instead of pulling the whole carton.',
    'Beta: the standard is to check the roll tag at every shift change.',
    'Beta: this works on the packing bench, not on the pallet wrapper.'
  ]);
  const title = decodeHtml(/<input id="draft-title"[^>]*value="([^"]*)"/.exec(await (await fetch(`${base}/c/${EXPERT_TOKEN}/draft?slug=${encodeURIComponent(slug)}`)).text())[1]);
  const countBefore = noteCount();
  const deskBefore = await (await fetch(`${base}/c/${EXPERT_TOKEN}`)).text();
  const ninth = await post(`/c/${EXPERT_TOKEN}/interview`, { id, answer: 'Beta: an afterthought that must not file anything.' });
  assert.equal(ninth.status, 303);
  assert.equal(ninth.headers.get('location'), `/c/${EXPERT_TOKEN}/draft?slug=${encodeURIComponent(slug)}`);
  assert.equal(noteCount(), countBefore);
  const deskAfter = await (await fetch(`${base}/c/${EXPERT_TOKEN}`)).text();
  assertDeskUnchanged(deskBefore, deskAfter, title);
});

test('a failure while filing the finished interview leaves no note behind, and the retry files exactly one', async () => {
  const html = await (await fetch(`${base}/c/${EXPERT_TOKEN}/interview`)).text();
  const id = /name="id" value="(\d+)"/.exec(html)[1];
  const answers = [
    'Gamma: I have run the spray booth for twelve years, mostly on lacquer batches.',
    'Gamma: the most repeated problem is orange peel on lacquered doors from the spray booth.',
    'Gamma: the first sign is a dull, dimpled surface on the first doors out of the booth.',
    'Gamma: the root cause is a clogged nozzle; verify it by spraying a test card first.',
    'Gamma: the fix is to swap the nozzle, tell the team leader, log the doors, then restart the booth.',
    'Gamma: a newcomer sands the doors instead of swapping the nozzle first.',
    'Gamma: the standard is to spray a test card before the first door of every batch.',
    'Gamma: this works on the spray booth, not on the dip tank.'
  ];
  for (const answer of answers.slice(0, 7)) {
    assert.equal((await post(`/c/${EXPERT_TOKEN}/interview`, { id, answer })).status, 303);
  }
  const interviewNotes = () => app.db.prepare("select count(*) n from notes where origin = 'interview'").get().n;
  const countBefore = noteCount();
  const interviewBefore = interviewNotes();
  app.db.exec("create trigger fail_finish before update on interviews when new.status = 'done' begin select raise(abort, 'injected'); end;");
  try {
    const res = await post(`/c/${EXPERT_TOKEN}/interview`, { id, answer: answers[7] });
    assert.equal(res.status, 500);
    assert.equal(noteCount(), countBefore, 'a half-filed note survived the failure');
    assert.equal(interviewNotes(), interviewBefore);
    const row = app.db.prepare('select step, status, note_id from interviews where id = ?').get(id);
    assert.equal(row.step, 7);
    assert.equal(row.status, 'in_progress');
    assert.equal(row.note_id, null);
  } finally {
    app.db.exec('drop trigger if exists fail_finish');
  }
  const retry = await post(`/c/${EXPERT_TOKEN}/interview`, { id, answer: answers[7] });
  assert.equal(retry.status, 303);
  const slug = new URL(retry.headers.get('location'), base).searchParams.get('slug');
  assert.equal(retry.headers.get('location'), `/c/${EXPERT_TOKEN}/draft?slug=${encodeURIComponent(slug)}`);
  assert.doesNotMatch(slug, /-2$/);
  assert.equal(noteCount(), countBefore + 1);
  assert.equal(interviewNotes(), interviewBefore + 1);
  assert.equal(app.db.prepare('select count(*) n from notes where slug = ?').get(slug).n, 1);
});

function assertDeskUnchanged(deskBefore, deskAfter, title) {
  const count = (html) => /My notes \((\d+)\)/.exec(html)[1];
  assert.equal(count(deskAfter), count(deskBefore), "a stray draft appeared in the practitioner's own list");
  assert.equal(deskAfter.split(title).length, 2);
  assert.equal(deskAfter.split(title).length, deskBefore.split(title).length);
}

function decodeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

test('money: a booking is priced in VND, split, and never marked paid by the system', async () => {
  const res = await post('/book', {
    expert: 'hung-qa',
    minutes: '60',
    starts_at: '2030-10-20 20:00',
    asker: 'Test client',
    contact: 'thu@example.com',
    topic: 'tpm',
    agenda: 'The line keeps stopping at the last station; I need an order to check things in.'
  });
  assert.equal(res.status, 303);
  const location = res.headers.get('location');
  const ref = location.split('/').pop();

  const page = await (await fetch(`${base}${location}`)).text();
  assert.match(page, /800\.000\u00a0₫/, 'one hour at the expert rate');
  assert.match(page, /640\.000\u00a0₫/, 'expert payout after the 20% platform fee');
  assert.match(page, /waiting for .* to confirm/i, 'the client is told the practitioner has to confirm the time first');
  assert.ok(!/vietqr/.test(page), 'and is not asked for money before that');
  assert.match(page, /waiting for the practitioner to confirm the time/, 'status shown as an English label, never the raw token');

  // The platform operator cannot mark a booking paid that nobody confirmed.
  const early = await post(`/qt/${ADMIN}/confirm`, { ref });
  assert.match(early.headers.get('location'), /err=/);
  assert.ok(!/payment received/.test(await (await fetch(`${base}/b/${ref}`)).text()));

  const confirmed = await post(`/c/${EXPERT_TOKEN}/booking`, { ref, action: 'confirm', meeting_url: 'https://meet.example.com/hung-session' });
  assert.equal(confirmed.status, 303);
  const pay = await (await fetch(`${base}${location}`)).text();
  assert.match(pay, /img\.vietqr\.io\/image\/\d+-\d+-compact2\.png\?amount=800000&amp;addInfo=B-/, 'the QR carries bank, account, amount and ref');
  assert.ok(!/meet\.example\.com/.test(pay), 'the meeting link is not shown before payment');

  const claim = await post(`/b/${ref}/transferred`);
  assert.equal(claim.status, 303);
  const claimed = await (await fetch(`${base}/b/${ref}`)).text();
  assert.match(claimed, /You reported the transfer/);
  assert.equal(app.db.prepare('select status from bookings where ref = ?').get(ref).status, 'awaiting_payment', 'reporting is a claim, not a state change');

  // The platform operator confirms against the bank statement; the system alone never does.
  const adminBefore = await (await fetch(`${base}/qt/${ADMIN}`)).text();
  assert.match(adminBefore, new RegExp(ref));
  const confirm = await post(`/qt/${ADMIN}/confirm`, { ref });
  assert.equal(confirm.status, 303);
  const paid = await (await fetch(`${base}/b/${ref}`)).text();
  assert.match(paid, /payment received/);
  assert.match(paid, /href="https:\/\/meet\.example\.com\/hung-session"/, 'the meeting link appears once paid');

  const done = await post(`/qt/${ADMIN}/complete`, { ref });
  assert.equal(done.status, 303);
  assert.match(await (await fetch(`${base}/b/${ref}`)).text(), /session completed/);
});

test('the admin surface is not reachable without the token', async () => {
  const res = await fetch(`${base}/qt/wrong-token`);
  assert.equal(res.status, 404);
});

test('the expert workspace is not reachable without the token', async () => {
  const res = await fetch(`${base}/c/wrong-token`);
  assert.equal(res.status, 404);
});

test('the home page states the ladder and the demo status plainly', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Answer from the note library|Ask the library/);
  assert.match(html, /Prototype/);
  const how = await (await fetch(`${base}/how-it-works`)).text();
  assert.match(how, /The gate/);
  // The refusal is explained in words; the machine marker stays out of the page.
  assert.match(how, /refusal/);
  assert.doesNotMatch(how, /INSUFFICIENT_DATA/);
});

test('no raw state token reaches an asker\'s or practitioner\'s page', async () => {
  // The operator's audit trail (/qt, /admin) prints events as logged ("coverage=thin mode=extractive") and
  // is left out on purpose; every page a guest, an asker or a practitioner reads is in.
  const refs = app.db.prepare('select ref from questions').all().map((r) => `/q/${r.ref}`);
  const bookings = app.db.prepare('select ref from bookings').all().map((r) => `/b/${r.ref}`);
  assert.ok(refs.length >= 2 && bookings.length >= 1, 'earlier tests left questions and a booking to look at');
  assert.ok(app.db.prepare("select 1 from questions where ai_coverage = 'thin'").get(), 'a refused question is among them');
  assert.ok(app.db.prepare("select 1 from questions where ai_mode = 'extractive'").get(), 'and an answered-by-extractive one');
  const paths = ['/', '/library', '/experts', `/c/${EXPERT_TOKEN}`, ...refs, ...bookings];
  const pages = await Promise.all(paths.map((p) => fetch(`${base}${p}`).then((r) => r.text())));
  for (const [i, html] of pages.entries()) {
    const body = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script[^>]*>[\s\S]*?<\/script>/, '');
    for (const word of ['>open<', '>routed<', '>answered<', '>published<', '>blocked<', '>requested<', '>awaiting_payment<', '>paid<', '>completed<', 'INSUFFICIENT_DATA', 'extractive', 'llm-']) {
      assert.ok(!body.includes(word), `${paths[i]} leaks the raw state token ${word}`);
    }
  }
});

test('the public pages state no legal conclusion about who holds the money', async () => {
  for (const path of ['/', '/how-it-works', '/experts']) {
    const html = await (await fetch(`${base}${path}`)).text();
    assert.doesNotMatch(html, /needs no payment licence|not a payment intermediary|never holds/i, path);
  }
});

// Regression: createApp() used to default to a relative 'data/gemba.db' and ignore config.dbPath.
// The service then read an empty corpus while the installer seeded, and the container volume
// mounted, a different file — with no error anywhere. The configured path must be the one opened.
test('the app opens the database the configuration names, not a file next to the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemba-configured-db-'));
  const configured = join(dir, 'nested', 'gemba.db');
  const app = createApp({
    config: {
      port: 0,
      host: '127.0.0.1',
      dbPath: configured,
      dataDir: dir,
      adminToken: ADMIN,
      bankBin: '',
      bankAccount: '',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    },
    rules: loadRules()
  });
  assert.ok(existsSync(configured), 'the configured database file should have been created');
  assert.equal(app.index().n, 0, 'a fresh configured database starts with an empty corpus');
  app.db.close?.();
});

async function healthzApp(status, calls) {
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300 };
  };
  const a = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    fetchImpl,
    config: {
      ...app.config,
      llm: { enabled: true, base: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash', key: 'k-test', timeoutMs: 1000, session: '' }
    }
  });
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  return { a, b: `http://127.0.0.1:${a.server.address().port}` };
}

test("healthz reports the gateway's verdict on the key, not its presence", async () => {
  for (const [status, want] of [[401, 'rejected'], [200, 'configured']]) {
    const calls = [];
    const { a, b } = await healthzApp(status, calls);
    try {
      const res = await fetch(`${b}/healthz`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.llm, want);
      assert.equal(body.db, undefined);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith('/models'));
    } finally {
      a.server.close();
      a.shutdown();
    }
  }
});

test('healthz asks the gateway once for a burst of requests', async () => {
  const calls = [];
  const { a, b } = await healthzApp(200, calls);
  try {
    const bodies = await Promise.all(Array.from({ length: 5 }, async () => (await fetch(`${b}/healthz`)).json()));
    assert.equal(calls.length, 1);
    for (const body of bodies) assert.equal(body.llm, 'configured');
  } finally {
    a.server.close();
    a.shutdown();
  }
});
