#!/usr/bin/env node
// scripts/eval-retrieval.mjs — measure retrieval + coverage against eval/questions.jsonl.
//
// Builds the corpus exactly as the server does (seed into :memory:, buildIndex(publishedNotes)),
// runs every question through search / coverage / askFromCorpus (forced offline), and reports
// coverage precision/recall, refusal accuracy, top-1 accuracy and MRR@5.
// Deterministic: no clock, no randomness, no files touched except with --write-baseline.
//   node scripts/eval-retrieval.mjs                  compare against eval/baseline.json (exit 1 on regression)
//   node scripts/eval-retrieval.mjs --json           machine-readable results
//   node scripts/eval-retrieval.mjs --write-baseline write eval/baseline.json

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, publishedNotes } from '../src/db.mjs';
import { loadRules } from '../src/gate.mjs';
import { seedDatabase } from '../src/seed-corpus.mjs';
import { buildIndex, search, coverage } from '../src/retrieval.mjs';
import { askFromCorpus } from '../src/llm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUESTIONS = join(ROOT, 'eval', 'questions.jsonl');
const BASELINE = join(ROOT, 'eval', 'baseline.json');
const args = new Set(process.argv.slice(2));

const db = openDb(':memory:');
seedDatabase(db, { rules: loadRules() });
const index = buildIndex(publishedNotes(db));

const questions = readFileSync(QUESTIONS, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const results = [];
for (const q of questions) {
  const hits = search(q.question, index, 5);
  const cov = coverage(q.question, hits, index);
  const ai = await askFromCorpus({
    question: q.question,
    hits,
    plantType: q.plant,
    coverageVerdict: cov,
    cfg: { enabled: false }
  });
  const predicted = cov.verdict === 'ok' ? 'answer' : 'refuse';
  const top1 = hits[0]?.note.slug ?? '';
  const rank = q.expect_note ? hits.findIndex((h) => h.note.slug === q.expect_note) + 1 : 0;
  let cls = 'ok';
  if (q.expect === 'refuse' && predicted === 'answer') cls = 'false-cover';
  else if (q.expect === 'answer' && predicted === 'refuse') cls = 'false-refuse';
  else if (q.expect === 'answer' && top1 !== q.expect_note) cls = 'wrong-note';
  results.push({
    id: q.id,
    set: q.set,
    expect: q.expect,
    predicted,
    top1,
    rank,
    share: cov.share ?? 0,
    top: cov.top ?? 0,
    class: cls,
    ai_coverage: ai.coverage,
    ai_mode: ai.mode
  });
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const div = (a, b) => (b ? a / b : 0);
const count = (f) => results.filter(f).length;
const TP = count((r) => r.expect === 'answer' && r.predicted === 'answer');
const FP = count((r) => r.expect === 'refuse' && r.predicted === 'answer');
const TN = count((r) => r.expect === 'refuse' && r.predicted === 'refuse');
const FN = count((r) => r.expect === 'answer' && r.predicted === 'refuse');
const N = results.length;
const ans = results.filter((r) => r.expect === 'answer');
const strict = count(
  (r) => (r.expect === 'refuse' && r.predicted === 'refuse') || (r.expect === 'answer' && r.predicted === 'answer' && r.class === 'ok')
);
const perSet = {};
for (const s of ['on', 'near', 'off', 'adv']) {
  const rs = results.filter((r) => r.set === s);
  perSet[s] = { n: rs.length, accuracy: r4(div(rs.filter((r) => r.expect === r.predicted).length, rs.length)) };
}
const summary = {
  n: N,
  tp: TP,
  fp: FP,
  tn: TN,
  fn: FN,
  coverage_precision: r4(div(TP, TP + FP)),
  coverage_recall: r4(div(TP, TP + FN)),
  refusal_accuracy: r4(div(TN, TN + FP)),
  accuracy: r4(div(TP + TN, N)),
  top1_accuracy: r4(div(ans.filter((r) => r.top1 === questions.find((q) => q.id === r.id).expect_note).length, ans.length)),
  mrr_at_5: r4(div(ans.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0), ans.length)),
  answered_wrong_note: count((r) => r.class === 'wrong-note'),
  correct_strict: strict,
  correct_strict_rate: r4(div(strict, N)),
  per_set: perSet
};

if (args.has('--json')) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  console.log(['id ', 'set ', 'expect ', 'actual ', pad('top1', 28), 'rank', 'share', 'top   ', 'class'].join(' '));
  for (const r of results) {
    console.log(
      [pad(r.id, 3), pad(r.set, 4), pad(r.expect, 7), pad(r.predicted, 7), pad(r.top1 || '-', 28), pad(r.rank || '-', 4), r.share.toFixed(3), r.top.toFixed(2).padStart(6), r.class].join(' ')
    );
  }
  console.log('');
  console.log(`questions: ${N}   TP=${TP} FP=${FP} TN=${TN} FN=${FN}`);
  console.log(`coverage precision: ${summary.coverage_precision}`);
  console.log(`coverage recall:    ${summary.coverage_recall}`);
  console.log(`refusal accuracy:   ${summary.refusal_accuracy}`);
  console.log(`overall accuracy:   ${summary.accuracy}`);
  console.log(`top-1 accuracy:     ${summary.top1_accuracy}   (expect=answer)`);
  console.log(`MRR@5:              ${summary.mrr_at_5}   (expect=answer)`);
  console.log(`answered with wrong note: ${summary.answered_wrong_note}`);
  console.log(`strict correct:     ${summary.correct_strict}/${N} = ${summary.correct_strict_rate}`);
  console.log(`per-set accuracy:   ${Object.entries(perSet).map(([s, v]) => `${s}=${v.accuracy} (n=${v.n})`).join('  ')}`);
}

if (args.has('--write-baseline')) {
  writeFileSync(BASELINE, JSON.stringify(summary, null, 2) + '\n');
  console.error(`baseline written: ${BASELINE}`);
} else if (!args.has('--json')) {
  let base = null;
  try {
    base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    console.log('\nno eval/baseline.json — nothing to compare against (run with --write-baseline)');
  }
  if (base) {
    const EPS = 1e-9;
    const regressed = ['accuracy', 'correct_strict_rate', 'refusal_accuracy', 'coverage_precision', 'coverage_recall', 'top1_accuracy', 'mrr_at_5'].filter(
      (m) => summary[m] < base[m] - EPS
    );
    if (regressed.length) {
      for (const m of regressed) console.log(`REGRESSION ${m}: ${summary[m]} < baseline ${base[m]}`);
      process.exit(1);
    }
    console.log('\nno regression against eval/baseline.json');
  }
}
