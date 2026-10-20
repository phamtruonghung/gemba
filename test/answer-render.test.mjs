// Issue #30: a refusal must read as a refusal. No marker, no scoring sentence, no model answer
// in the panel, and the status label for a refused `open` question never claims an answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { insertQuestion } from '../src/db.mjs';
import { questionStatus, missingReason } from '../src/views.mjs';

let app;
let base;
const ANSWER = 'Check the hydraulic pressure first, then the die temperature, then the cycle counter.';

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data', adminToken: 'a', bankBin: '970436', bankAccount: '0123456789', llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 } }
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

const page = async (ref) => {
  const html = await (await fetch(`${base}/q/${ref}`)).text();
  return html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script>[\s\S]*?<\/script>/g, '');
};
const refusal = (html) => /<div class="refusal">([\s\S]*?)<\/div>\s*(?=<div class="actionbar"|<div class="card"|$)/.exec(html)?.[1] ?? html;

test('a refused question (extractive fallback) shows no marker and no scoring sentence', async () => {
  const res = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How do I recruit office staff' }) });
  const ask = await res.json();
  assert.equal(ask.coverage, 'thin');
  const html = await page(ask.ref);
  assert.doesNotMatch(html, /INSUFFICIENT_DATA/);
  assert.doesNotMatch(html, /key terms/);
  assert.doesNotMatch(html, /closest note covers only/);
  assert.match(html, /refused — the library had nothing for this/);
  assert.doesNotMatch(html, /answered from the library/);
});

test('a refused question with a model answer prints only the missing-reason in the panel', async () => {
  const q = insertQuestion(app.db, {
    text: 'Máy ép dừng giữa ca thì nên kiểm tra theo thứ tự nào?', topic: 'tpm',
    ai_answer: `INSUFFICIENT_DATA\n${ANSWER}`, ai_citations: [], ai_coverage: 'thin', ai_mode: 'llm',
    ai_missing: 'INSUFFICIENT_DATA The notes do not cover press hydraulics.'
  });
  const html = await page(q.ref);
  assert.doesNotMatch(html, /INSUFFICIENT_DATA/);
  assert.doesNotMatch(html, /hydraulic pressure first/, 'the model answer is not shown');
  assert.match(html, /The notes do not cover press hydraulics\./);
  assert.doesNotMatch(refusal(html), /<div class="answer">/);
});

test('without a stored reason the panel uses a plain fixed sentence', async () => {
  const q = insertQuestion(app.db, { text: 'Old row', ai_answer: 'INSUFFICIENT_DATA\nnope (the closest note covers only 11% of the question\'s key terms)', ai_coverage: 'thin' });
  const html = await page(q.ref);
  assert.match(html, /No note in the library answers this question closely enough to cite\./);
  assert.doesNotMatch(html, /INSUFFICIENT_DATA|11%/);
});

test('the open status label is honest about a refusal', () => {
  assert.doesNotMatch(questionStatus('open', 'thin'), /answered/);
  assert.equal(questionStatus('open', 'ok'), 'answered from the library');
  assert.equal(missingReason({ ai_missing: '' }), 'No note in the library answers this question closely enough to cite.');
});
