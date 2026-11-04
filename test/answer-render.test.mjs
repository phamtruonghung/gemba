// Issue #30: a refusal must read as a refusal. No marker, no scoring sentence, no model answer
// in the panel, and the status label for a refused `open` question never claims an answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

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

const strip = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const page = async (ref) => strip(await (await fetch(`${base}/q/${ref}`)).text());
// The share block embeds this request's own origin, percent-encoded, so the Host decides what the page
// carries. `page` is a plain fetch; `pageAs` pins the Host when a test needs a fixed origin.
const pageAs = (ref, host) => new Promise((resolve, reject) => {
  const req = httpRequest(
    { host: '127.0.0.1', port: app.server.address().port, path: `/q/${ref}`, headers: { host } },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(strip(body)));
    }
  );
  req.on('error', reject);
  req.end();
});
// The refusal panel, never the whole page: the share block embeds the origin, so a port ending in 11 puts
// `11%` on the page through no fault of the render. A missing panel throws instead of widening to the page.
const refusal = (html) => {
  const panel = /<div class="refusal">([\s\S]*?)<\/div>\s*(?=<div class="actionbar"|<div class="card"|$)/.exec(html)?.[1];
  assert.ok(panel, 'the page carries the refusal panel this test asserts against');
  return panel;
};

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
  // A fixed origin whose port ends in 11: the share block encodes it as `127.0.0.1%3A35811%2F`, so the page
  // really does contain `11%` while the panel must not. Every check of the marker and the scoring sentence is
  // therefore scoped to the panel, or to phrases a port cannot produce.
  const html = await pageAs(q.ref, '127.0.0.1:35811');
  assert.match(html, /127\.0\.0\.1%3A35811%2F/, 'the share block carries the origin, port included');
  assert.match(refusal(html), /No note in the library answers this question closely enough to cite\./);
  assert.doesNotMatch(refusal(html), /INSUFFICIENT_DATA|11%/);
  assert.doesNotMatch(html, /INSUFFICIENT_DATA/);
  assert.doesNotMatch(html, /key terms|closest note covers only/);
});

test('the open status label is honest about a refusal', () => {
  assert.doesNotMatch(questionStatus('open', 'thin'), /answered/);
  assert.equal(questionStatus('open', 'ok'), 'answered from the library');
  assert.equal(missingReason({ ai_missing: '' }), 'No note in the library answers this question closely enough to cite.');
});
