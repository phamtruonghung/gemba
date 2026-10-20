// Unit tests: the publishability gate, retrieval, pricing, and the answer contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkNote, decidePublication, loadRules, ATTESTATION_TEXT } from '../src/gate.mjs';
import { buildIndex, search, coverage, tokenize, fold } from '../src/retrieval.mjs';
import { quote, priceFor, split, roundVnd, formatVnd, transferInstruction, PLATFORM_TAKE_RATE, MIN_MINUTES } from '../src/pricing.mjs';
import { buildPrompt, askFromCorpus, NO_DATA_MARKER, llmConfig } from '../src/llm.mjs';
import { SCRIPT, draftNoteFromInterview, slugify } from '../src/interview.mjs';
import { openDb, upsertNote, pruneSeedNotes, publishedNotes } from '../src/db.mjs';

const CRAFT = `# The machine stops mid-shift

## The order to check things in
Make the spot safe before anything else, then read the fault code, and then decide whether one
station stopped or the whole line did. Only stand close and open the guard once you are certain the
machine is in a safe state. If you cannot find the cause within the time you are allowed to work on
it, escalate to maintenance instead of staying with it. Once it runs again, write the symptom and
what actually fixed it into the shift notebook so the next crew can read it.
`;

test('gate: a craft note with no employer facts is clean', () => {
  const report = checkNote({ title: 'The machine stops mid-shift', body: CRAFT });
  assert.equal(report.ok, true);
  assert.equal(report.needs_attestation, false);
  assert.equal(report.verdict, 'clean');
});

test('gate: a deployment\'s employer name is blocked', () => {
  const rules = loadRules({ block_terms: ['acme-fab'] });
  const report = checkNote({ title: 'Note', body: `${CRAFT}\nThe ACME-FAB procedure says to do the opposite.` }, rules);
  assert.equal(report.ok, false);
  assert.equal(report.verdict, 'blocked');
  assert.ok(report.findings.some((f) => f.rule === 'block_term' && f.severity === 'block'));
});

test('gate: a person name is blocked', () => {
  const report = checkNote({ title: 'Note', body: `${CRAFT}\nAnh Nguyễn Văn Anh làm ca đó đã xử lý.` });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.rule === 'person_name'));
});

// The leak strings are deliberately half Vietnamese, half English: the corpus is published in
// English now, but a Vietnamese note carrying an employer's part number is still someone else's
// information, and the rules have to catch both languages.
test('gate: an English name with a title is blocked, like a Vietnamese one', () => {
  const report = checkNote({ title: 'Note', body: `${CRAFT}\nMr. Johnson signed the batch off.` });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.rule === 'document'));
});

test('gate: an order number, a drawing or a price is blocked, in either language', () => {
  for (const leak of ['Theo PO 45123 giao tuần này.', 'Xem bản vẽ AB1234-C ở trạm 2.', 'Đơn giá linh kiện này là 45.000 đồng.', 'Unit price per piece is 4.5 dollars.', 'Invoice no 8891 is attached.']) {
    const report = checkNote({ title: 'Note', body: `${CRAFT}\n${leak}` });
    assert.equal(report.ok, false, `should block: ${leak}`);
    assert.ok(report.findings.some((f) => f.rule === 'document'));
  }
});

test('gate: a figure with a unit needs the author attestation, and cannot publish without it', () => {
  const note = { title: 'OEE', body: `${CRAFT}\nThis line runs at 72% OEE, so something has to change.` };
  const report = checkNote(note);
  assert.equal(report.ok, true);
  assert.equal(report.needs_attestation, true);
  assert.equal(report.verdict, 'needs_attestation');
  assert.equal(decidePublication(note, { attested: false }).publish, false);
  assert.equal(decidePublication(note, { attested: false }).reason, 'attestation_required');
  assert.equal(decidePublication(note, { attested: true }).publish, true);
});

test('gate: a blocked note stays blocked even when attested', () => {
  const note = { title: 'Note', body: `${CRAFT}\nUnit price on PO 99887 is the problem.` };
  const d = decidePublication(note, { attested: true });
  assert.equal(d.publish, false);
  assert.equal(d.reason, 'blocked');
});

test('gate: the rules are extensible per deployment', () => {
  const rules = loadRules({ block_terms: ['abc plant'], document_patterns: [] });
  const report = checkNote({ title: 'N', body: `${CRAFT}\nAt abc plant it is different.` }, rules);
  assert.equal(report.ok, false);
});

test('gate: the attestation wording says what the author is signing', () => {
  assert.match(ATTESTATION_TEXT, /no figures/);
  assert.match(ATTESTATION_TEXT, /customer or supplier names/);
});

test('db: a re-seed retires the notes this deployment no longer ships, and never a person\'s note', () => {
  const db = openDb(':memory:');
  const note = (slug, origin) => upsertNote(db, { slug, title: slug, topic: 'tpm', body: 'x', status: 'published', origin });
  note('demo-retired-name', 'demo');
  note('vault-retired-name', 'vault');
  note('demo-current-name', 'demo');
  note('expert-kept', 'expert');

  const retired = pruneSeedNotes(db, ['demo-current-name']);

  assert.deepEqual(retired.map((n) => n.slug).sort(), ['demo-retired-name', 'vault-retired-name']);
  assert.deepEqual(publishedNotes(db).map((n) => n.slug).sort(), ['demo-current-name', 'expert-kept']);
});

test('seed: every topic in the corpus is covered by an expert, so no note falls back silently', () => {
  const experts = JSON.parse(readFileSync('seed/experts.json', 'utf8'));
  const covered = new Set(experts.flatMap((e) => e.topics ?? []));
  const used = readdirSync('seed/corpus')
    .filter((f) => f.endsWith('.md'))
    .map((f) => /^topic:\s*(.+)$/m.exec(readFileSync(join('seed/corpus', f), 'utf8'))[1].trim());
  const orphans = [...new Set(used)].filter((t) => !covered.has(t));
  assert.deepEqual(orphans, [], `no expert covers: ${orphans.join(', ')}`);
});

test('retrieval: folds Vietnamese diacritics both ways', () => {
  assert.deepEqual(tokenize('Chuyền'), tokenize('chuyen'));
  assert.equal(fold('Đổi khuôn'), 'doi khuon');
});

test('retrieval: finds the right note for a real question', () => {
  const notes = [
    { id: 1, title: 'The machine stops mid-shift', topic: 'shift-management', body: CRAFT },
    { id: 2, title: '5S on the floor', topic: 'safety', body: '# 5S\n\n## Sort\nTake out of the area everything the running job does not use.' },
    { id: 3, title: 'Andon', topic: 'tpm', body: '# Andon\n\n## The agreement\nWhen an operator pulls the andon, who comes and how fast.' }
  ];
  const idx = buildIndex(notes);
  const hits = search('the machine stops mid shift, what do I check', idx);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].note.id, 1);
});

test('retrieval: an off-corpus question is thin, on-corpus is not', () => {
  const notes = [
    { id: 1, title: 'The machine stops mid-shift', topic: 'shift-management', body: CRAFT },
    { id: 2, title: 'Andon', topic: 'tpm', body: '# Andon\n\n## The agreement\nWhen an operator pulls the andon: who comes, how fast, and whether they may stop the line.' },
    { id: 3, title: 'Machine stopped — escalate', topic: 'tpm', body: '# Escalation\n\n## Time thresholds\nThe operator handles a stopped machine inside the allowed window; beyond it the team leader is called, and beyond that, maintenance.' }
  ];
  const idx = buildIndex(notes);
  const onCorpus = coverage('the machine stops mid-shift, what do I check', search('the machine stops mid-shift, what do I check', idx), idx);
  const offCorpus = coverage('office recruitment procedure and salary bands', search('office recruitment procedure and salary bands', idx), idx);
  assert.equal(onCorpus.verdict, 'ok');
  assert.equal(offCorpus.verdict, 'thin');
});

test('retrieval: coverage needs content-word agreement, not just a score', () => {
  // The real seed corpus, because this rule was written against it: an HR question about
  // hiring scored 12.3 against a note about machine stoppages — five times the old
  // score-only threshold — purely because Vietnamese questions share their common words
  // with everything. The idiomatic words are what the corpus does not have.
  const corpus = readdirSync('seed/corpus')
    .filter((f) => f.endsWith('.md'))
    .map((f, i) => {
      const raw = readFileSync(join('seed/corpus', f), 'utf8');
      const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      return { id: i + 1, title: /^title:\s*(.+)$/m.exec(raw)[1].trim(), topic: /^topic:\s*(.+)$/m.exec(raw)[1].trim(), body };
    });
  const idx = buildIndex(corpus);
  const off = 'office recruitment procedure and the salary policy';
  const offHits = search(off, idx);
  const offCov = coverage(off, offHits, idx);
  assert.equal(offCov.verdict, 'thin');
  assert.ok(offHits[0].score > 2.2, `a score-only rule would have passed this (top ${offHits[0].score})`);
  assert.match(offCov.why, /key terms/);

  const on = 'the machine stops mid-shift, what do I check and in what order';
  assert.equal(coverage(on, search(on, idx), idx).verdict, 'ok');
});

test('pricing: integer VND, 20% platform take, minimum 30 minutes', () => {
  assert.equal(roundVnd(483333), 480000);
  assert.equal(priceFor(600000, 45), 450000);
  const q = quote(600000, 45);
  assert.deepEqual(q, { minutes: 45, price_vnd: 450000, fee_vnd: 90000, payout_vnd: 360000 });
  assert.equal(PLATFORM_TAKE_RATE, 0.2);
  assert.throws(() => quote(600000, MIN_MINUTES - 1), /minimum/);
  assert.equal(formatVnd(450000), '450.000\u00a0₫');
  assert.equal(formatVnd(0), '0\u00a0₫');
  assert.equal(formatVnd(10000), '10.000\u00a0₫');
  assert.equal(formatVnd(999), '999\u00a0₫');
  assert.equal(formatVnd(1234567), '1.234.567\u00a0₫');
  assert.equal(formatVnd(-1500), '-1.500\u00a0₫', 'a negative keeps its sign (no caller passes one today)');
  assert.equal(formatVnd(520000.4), '520.000\u00a0₫', 'whole dong only');
  assert.deepEqual(split(1000000), { price_vnd: 1000000, fee_vnd: 200000, payout_vnd: 800000 });
});

test('pricing: the transfer instruction is a real VietQR payload, not a fake success', () => {
  const ins = transferInstruction({ bankBin: '970436', account: '0123456789', amountVnd: 450000, ref: 'B-2026-ABC' });
  assert.equal(ins.amount_vnd, 450000);
  assert.match(ins.qr_url, /img\.vietqr\.io\/image\/970436-0123456789/);
  assert.match(ins.qr_url, /amount=450000/);
  assert.match(ins.qr_url, /addInfo=B-2026-ABC/);
});

test('llm: the prompt forbids outside knowledge and demands citations', () => {
  const { system, user } = buildPrompt({ question: 'what do I do when the machine stops?', hits: [{ note: { id: 7, title: 'The machine stops mid-shift', topic: 'shift-management', body: CRAFT } }] });
  assert.match(system, /Answer only from the PASSAGES/);
  assert.match(system, new RegExp(NO_DATA_MARKER));
  assert.match(user, /\[1\] The machine stops mid-shift/);
  assert.doesNotMatch(user, /id 7/, 'the internal note id is not part of the numbering');
});

test('llm: the prompt carries at most three passages, each capped in length', () => {
  const long = { note: { id: 1, title: 'A', topic: 'tpm', body: 'x'.repeat(9000) }, score: 3 };
  const hits = [long, long, long, long, long];
  const { user } = buildPrompt({ question: 'q', hits });
  assert.equal((user.match(/^\[/gm) ?? []).length, 3, 'three passages only');
  assert.ok(user.length < 3 * 1500, 'and each passage is truncated');
});

test('llm: no API key means the extractive mode, clearly labelled', async () => {
  const hits = [{ note: { id: 1, title: 'The machine stops mid-shift', topic: 'shift-management', body: CRAFT }, score: 3 }];
  const out = await askFromCorpus({ question: 'the machine stops mid-shift, what do I check', hits, coverageVerdict: { verdict: 'ok' }, cfg: { enabled: false } });
  assert.equal(out.mode, 'extractive');
  assert.ok(out.citations.includes(1));
  assert.equal(out.coverage, 'ok');
});

test('llm: an API error is reported, never dressed up as a model answer', async () => {
  const hits = [{ note: { id: 1, title: 'The machine stops mid-shift', topic: 'shift-management', body: CRAFT }, score: 3 }];
  const out = await askFromCorpus({
    question: 'q',
    hits,
    coverageVerdict: { verdict: 'ok' },
    cfg: { enabled: true, base: 'https://example.invalid/v1', model: 'x', key: 'k', timeoutMs: 1000 },
    sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 429 })
  });
  assert.equal(out.mode, 'llm-http-429');
  assert.ok(out.answer.length > 0, 'falls back to a labelled extractive answer');
});

test('llm: a model answer is parsed, citations mapped to note ids', async () => {
  const hits = [
    { note: { id: 11, title: 'A', topic: 'tpm', body: CRAFT }, score: 3 },
    { note: { id: 22, title: 'B', topic: 'tpm', body: CRAFT }, score: 2 }
  ];
  const out = await askFromCorpus({
    question: 'q',
    hits,
    coverageVerdict: { verdict: 'ok' },
    cfg: { enabled: true, base: 'https://x/v1', model: 'm', key: 'k', timeoutMs: 1000 },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"answer":"Do it in that order [2].","citations":[2],"coverage":"ok","missing":""}\n```' } }] }) })
  });
  assert.equal(out.mode, 'llm');
  assert.equal(out.coverage, 'ok');
  assert.deepEqual(out.citations, [22]);
});

test('llm: the model refusing (marker or thin vote) becomes coverage=thin', async () => {
  const hits = [{ note: { id: 1, title: 'A', topic: 'tpm', body: CRAFT }, score: 3 }];
  const out = await askFromCorpus({
    question: 'q',
    hits,
    coverageVerdict: { verdict: 'ok' },
    cfg: { enabled: true, base: 'https://x/v1', model: 'm', key: 'k', timeoutMs: 1000 },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: `{"answer":"${NO_DATA_MARKER} no notes on electrical safety","citations":[],"coverage":"thin"}` } }] }) })
  });
  assert.equal(out.coverage, 'thin');
});

test('interview: the script asks for craft, and the draft becomes a structured note', () => {
  assert.ok(SCRIPT.length >= 6);
  assert.ok(SCRIPT.every((q) => q.ask && q.hint));
  assert.ok(SCRIPT.some((q) => /where does it stop applying/i.test(q.ask)));
  const answers = SCRIPT.map((_, i) => `Answer number ${i + 1}, long enough to read as a paragraph in a note.`);
  const draft = draftNoteFromInterview({ expert: { slug: 'x' }, topic: 'tpm', answers, title: 'Field notes: tpm' });
  assert.match(draft.body, /^# Field notes: tpm/);
  assert.equal((draft.body.match(/^## /gm) ?? []).length, SCRIPT.length);
  assert.equal(draft.origin, 'interview');
});

test('interview: slugs are ASCII and stable', () => {
  assert.equal(slugify('Máy dừng giữa ca — v2'), 'may-dung-giua-ca-v2');
  assert.equal(slugify('The machine stops mid-shift — v2'), 'the-machine-stops-mid-shift-v2');
  assert.equal(slugify(''), 'note');
});

test('llm: the gateway and the model id are one decision', () => {
  // These must move together: an OpenRouter-style namespaced model id sent to the OpenCode gateway
  // (or the reverse) 404s at the first question, long after the install said it was fine.
  const def = llmConfig({});
  assert.equal(def.base, 'https://opencode.ai/zen/go/v1', 'the default gateway is the OpenCode one');
  assert.equal(def.model, 'deepseek-v4.1-flash', 'and the default model is the one it serves');

  const or = llmConfig({ GEMBA_LLM_BASE_URL: 'https://openrouter.ai/api/v1' });
  assert.equal(or.model, 'deepseek/deepseek-v4-flash-0731', 'OpenRouter gets its namespaced id');

  const pinned = llmConfig({ GEMBA_LLM_BASE_URL: 'https://openrouter.ai/api/v1', GEMBA_LLM_MODEL: 'x/y' });
  assert.equal(pinned.model, 'x/y', 'an explicit model always wins');

  const local = llmConfig({ GEMBA_LLM_BASE_URL: 'http://192.168.1.105:8080/v1' });
  assert.equal(local.model, 'deepseek-v4.1-flash', 'an unknown gateway still gets a usable id');
});

test('llm: the OpenCode gateway gets its session header, and other gateways do not', async () => {
  // Observed against the live gateway: without this header it answers 400 MissingSessionID and the
  // product silently degrades to the extractive answer — correct-looking output, no model involved.
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"answer":"a","citations":[1],"coverage":"ok"}' }, finish_reason: 'stop' }] })
    };
  };
  const hits = [{ note: { id: 7, title: 'A note', topic: 'tpm', body: CRAFT }, score: 9 }];

  await askFromCorpus({
    question: 'why does the press stop', hits, coverageVerdict: { verdict: 'ok' },
    cfg: { base: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash', key: 'k', session: 'sess-1', enabled: true, timeoutMs: 1000 },
    fetchImpl: fakeFetch
  });
  assert.equal(calls[0].headers['x-opencode-session'], 'sess-1');
  assert.match(calls[0].url, /opencode\.ai\/zen\/go\/v1\/chat\/completions$/);

  calls.length = 0;
  await askFromCorpus({
    question: 'why does the press stop', hits, coverageVerdict: { verdict: 'ok' },
    cfg: { base: 'https://openrouter.ai/api/v1', model: 'x/y', key: 'k', session: '', enabled: true, timeoutMs: 1000 },
    fetchImpl: fakeFetch
  });
  assert.equal('x-opencode-session' in calls[0].headers, false, 'OpenRouter must not receive the header');
});
