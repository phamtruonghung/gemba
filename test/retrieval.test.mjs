// Issue #29: retrieval calibration, against the real seeded corpus (the same index the server builds).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, publishedNotes } from '../src/db.mjs';
import { loadRules } from '../src/gate.mjs';
import { seedDatabase } from '../src/seed-corpus.mjs';
import { buildIndex, search, coverage, tokenize, indexTerms, chunkBody, queryUnits } from '../src/retrieval.mjs';
import { askFromCorpus, passagesSent } from '../src/llm.mjs';

const db = openDb(':memory:');
seedDatabase(db, { rules: loadRules() });
const index = buildIndex(publishedNotes(db));

const judge = (q) => {
  const hits = search(q, index, 5);
  return { hits, cov: coverage(q, hits, index), top: hits[0]?.note.slug ?? null };
};
const covered = (q) => judge(q).cov.verdict === 'ok';

test('padding invariance: "please" and a place do not flip an answerable question to a refusal', () => {
  const base = 'How do I reduce changeover time?';
  assert.ok(covered(base));
  for (const q of [
    `${base} Please help, thanks.`,
    `Please tell me how to reduce changeover time for our plant in Binh Duong`,
    `${base} for our plant in Binh Duong`
  ]) {
    const j = judge(q);
    assert.equal(j.cov.verdict, 'ok', q);
    assert.match(j.top, /smed/);
  }
});

test('a long paragraph version of a question is judged on its topic, not its length', () => {
  const q = 'Last night at our plant in Binh Duong a machine stopped in the middle of the shift, what is the right order to check things in?';
  const j = judge(q);
  assert.equal(j.cov.verdict, 'ok');
  assert.match(j.top, /machine-stops/);
});

test('"how do I fire an operator" is refused, with and without padding', () => {
  assert.equal(covered('How do I fire an operator?'), false);
  assert.equal(covered('Please tell me how to fire an operator who keeps arriving late, for our plant in Binh Duong'), false);
});

test('acronyms and their long forms are one thing, in both directions', () => {
  assert.deepEqual(tokenize('overall equipment effectiveness'), tokenize('OEE'));
  assert.deepEqual(tokenize('Single minute exchange of die'), tokenize('SMED'));
  assert.deepEqual(tokenize('OPL'), tokenize('one point lesson'));
  // spelled out in the question, abbreviated in the note (and the reverse)
  assert.ok(covered('Why keep availability, performance and quality apart in an overall equipment effectiveness report?'));
  assert.ok(covered('Single minute exchange of die: what are the steps?'));
  assert.match(judge('What does OEE measure, and what are its three parts?').top, /oee/);
});

test('diacritics are kept in the index: mã is not ma, and ca / mã / đèn are not stopwords', () => {
  // the three words the issue names are content words when accented ...
  assert.deepEqual(queryUnits('mã'), [['code']]);
  assert.deepEqual(queryUnits('ca'), [['shift']]);
  assert.ok(queryUnits('đèn').flat().includes('lamp'));
  // ... while bare "ma" (ma / má / mà / mã typed without marks) is ambiguous and says nothing
  assert.deepEqual(queryUnits('ma'), []);
  // an accented word that no dictionary knows is indexed and asked under its exact spelling as well
  assert.ok(indexTerms('hạt nhựa').includes('hạt'), 'the exact spelling is indexed');
  assert.ok(indexTerms('hạt nhựa').includes('hat'), 'and the folded one, so unaccented input still matches');
  const tiny = buildIndex([
    { id: 1, slug: 'a', title: 'Hạt nhựa', topic: 'x', body: 'Hạt nhựa phải sấy trước khi ép. Hạt ẩm làm sản phẩm có bọt khí.' },
    { id: 2, slug: 'b', title: 'Hát karaoke', topic: 'x', body: 'Hát karaoke cuối tháng. Hát cho vui, hát cùng cả tổ.' },
    { id: 3, slug: 'c', title: 'Khác', topic: 'x', body: 'Một ghi chú khác hoàn toàn.' }
  ]);
  const top = (q) => search(q, tiny, 3).map((h) => h.note.slug);
  assert.deepEqual(top('hạt'), ['a'], 'hạt does not reach hát');
  assert.deepEqual(top('hát'), ['b'], 'hát does not reach hạt');
  assert.deepEqual(top('hat').sort(), ['a', 'b'], 'unaccented input still reaches both');
});

test('a Vietnamese question reaches the right English note', () => {
  for (const [q, slug] of [
    ['SMED là gì và gồm 4 bước nào?', /smed/],
    ['máy dừng giữa ca thì kiểm tra theo thứ tự nào', /machine-stops/],
    ['5 why hỏi đến khi nào thì dừng', /5-why/]
  ]) {
    const j = judge(q);
    assert.match(j.top, slug, q);
  }
  assert.ok(covered('máy dừng giữa ca thì kiểm tra theo thứ tự nào'));
});

test('the model is sent the matched section of a long note, whole, never cut mid-word', () => {
  const q = 'how does the operating rhythm decay when leader standard work is abandoned and the boards stay clean';
  const hits = search(q, index, 3);
  const h = hits.find((x) => /supervisor-s-operating-rhythm/.test(x.note.slug));
  assert.ok(h, 'the long note is retrieved');
  const at = h.note.body.indexOf('The ways this decays');
  assert.ok(at > 1400, 'the answering section sits past the old first-1400-characters cut');
  const sent = passagesSent(hits).find((p) => p.id === h.note.id);
  assert.ok(sent.body.length <= 1400, 'it still fits the prompt');
  assert.match(sent.body, /Leader standard work is the first thing abandoned/, 'the matched section is what is sent');
  assert.match(sent.body, /^## The ways this decays|^#+ .*decays/m, 'with its heading');
  assert.ok(/[.!?)\]]$|…$/.test(sent.body.trimEnd()) && !/\w…$/.test(sent.body), 'it does not end inside a word');
  // a note with no matched chunk is cut at a word, with an ellipsis
  const cut = passagesSent([{ note: { id: 9, title: 't', topic: 'x', body: 'word '.repeat(600) }, score: 1 }])[0].body;
  assert.ok(cut.length <= 1400);
  assert.match(cut, /word …$/);
});

test('chunking splits a note at its ## headings and every chunk carries its heading', () => {
  const chunks = chunkBody('# T\nintro\n## One\naaa\n## Two\nbbb ccc\n');
  assert.deepEqual(chunks.map((c) => c.heading), ['T', 'One', 'Two']);
  assert.ok(chunks.every((c) => c.text.length));
});

test('the margin rule, when switched on, refuses two near-tied notes; off by default', () => {
  const q = 'How do I reduce changeover time?';
  const hits = search(q, index, 5);
  assert.equal(coverage(q, hits, index).verdict, 'ok');
  const tied = [hits[0], { ...hits[0], note: hits[1]?.note ?? hits[0].note }];
  const r = coverage(q, tied, index, { margin: 0.1 });
  assert.equal(r.verdict, 'thin');
  assert.equal(r.hard, false, 'a margin refusal is a soft vote');
});

test('with a key configured a soft thin verdict goes to the model; a hard one never does', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: 'Move the outside work out of the stop [1].', citations: [1], coverage: 'ok', missing: '' }) }, finish_reason: 'stop' }] }) };
  };
  const body = 'Step 1 moves the outside work out of the stop. Anything that can be done while the machine runs is done before it stops.';
  const hit = [{ note: { id: 1, slug: 's', title: 'SMED', topic: 'improvement', body: `# SMED\n## Step 1\n${body}\n` }, score: 5 }];
  const cfg = { enabled: true, base: 'https://x/v1', model: 'm', key: 'k', timeoutMs: 1000 };
  const soft = await askFromCorpus({ question: 'how to move outside work out of the stop', hits: hit, coverageVerdict: { verdict: 'thin', hard: false, why: 'share' }, cfg, fetchImpl, sleep: async () => {} });
  assert.equal(calls, 1);
  assert.equal(soft.mode, 'llm');
  assert.equal(soft.coverage, 'ok');
  const hard = await askFromCorpus({ question: 'x', hits: hit, coverageVerdict: { verdict: 'thin', hard: true, why: 'weak' }, cfg, fetchImpl, sleep: async () => {} });
  assert.equal(calls, 1, 'no model call');
  assert.equal(hard.coverage, 'thin');
});
