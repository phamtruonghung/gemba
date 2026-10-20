// The documentation's numbers, checked against the code that produces them (issue #46).
//
// README.md and SPEC.md state counts, defaults, prices and file names. Each one used to drift the first
// time the code moved ("64 tests" while 300 ran, a 90 s timeout that had become 45 s, an ADR that never
// existed). A number in a document is a claim; here every counted claim is compared with its source, so
// the next drift fails the build instead of waiting for a reader to catch it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

import { quote } from '../src/pricing.mjs';
import { llmConfig } from '../src/llm.mjs';
import { SETTING_SPECS } from '../src/settings.mjs';
import { SCRIPT } from '../src/interview.mjs';
import { hashPassword } from '../src/auth.mjs';
import { loadRules } from '../src/gate.mjs';
import { openDb } from '../src/db.mjs';
import { seedDatabase } from '../src/seed-corpus.mjs';

const README = readFileSync('README.md', 'utf8');
const SPEC = readFileSync('SPEC.md', 'utf8');
const testFiles = readdirSync('test').filter((f) => f.endsWith('.test.mjs'));

test('docs: README states the number of tests `npm test` runs', () => {
  // `npm test` is `node --test test/*.test.mjs`; its "tests" line counts every test() call. That equals the
  // static count of top-level `test(` lines only while every test is a top-level call, so the guard below
  // is what keeps this number honest: a nested or describe/it test would make the two differ.
  const counted = new RegExp(`^${'test'}\\(`);
  const nested = new RegExp(`^\\s+${'test'}\\(`);
  const suites = [new RegExp(`\\b${'describe'}\\(`), new RegExp(`\\b${'it'}\\(`)];
  let n = 0;
  for (const f of testFiles) {
    for (const line of readFileSync(`test/${f}`, 'utf8').split('\n')) {
      if (counted.test(line)) n += 1;
      assert.ok(!nested.test(line), `${f}: an indented test() call; the static count would no longer equal npm test's "tests" line`);
      for (const re of suites) assert.ok(!re.test(line), `${f}: a describe or it suite is in use; the static count would no longer equal npm test's "tests" line`);
    }
  }
  assert.ok(README.includes(`${n} tests (\`npm test\`)`), `README must say "${n} tests (\`npm test\`)"`);
});

test('docs: README\'s model timeout default is the code\'s', () => {
  const row = /\| `GEMBA_LLM_TIMEOUT_MS` \| `(\d+)` \|/.exec(README);
  assert.ok(row, 'README has a GEMBA_LLM_TIMEOUT_MS row');
  assert.equal(Number(row[1]), llmConfig({}).timeoutMs);
});

test('docs: the Node floor in README is the one in package.json', () => {
  const floor = /^>=\s*([\d.]+)$/.exec(JSON.parse(readFileSync('package.json', 'utf8')).engines.node)?.[1];
  assert.ok(floor, 'package.json engines.node is ">=<version>"');
  assert.ok(README.includes(`Node ≥ ${floor}`), `README names "Node ≥ ${floor}"`);
  assert.ok(README.includes(`needs >= ${floor}`), `README names "needs >= ${floor}"`);
  assert.deepEqual([...README.matchAll(/(?:Node ≥|needs >=) ([\d.]+)/g)].map((m) => m[1]).filter((v) => v !== floor), [], 'and no other floor');
});

test('docs: every file README and SPEC point at exists, and no ADR is cited that does not', () => {
  const roots = /^(?:src|scripts|deploy|test|seed|eval|design-system|\.github)\//;
  for (const [name, text] of [['README.md', README], ['SPEC.md', SPEC]]) {
    for (const m of text.matchAll(/`([^`\s]+)`/g)) {
      const path = m[1].replace(/[.,;:)]+$/, '');
      if (!roots.test(path) || /[<*:]|\.\.\./.test(path)) continue;
      assert.ok(existsSync(path), `${name} names \`${path}\`, which does not exist`);
    }
    for (const adr of text.matchAll(/\bADR-\d+/g)) {
      const found = existsSync('docs') && readdirSync('docs', { recursive: true }).some((f) => String(f).includes(adr[0]));
      assert.ok(found, `${name} cites ${adr[0]}, and no file for it exists`);
    }
  }
});

test('docs: SPEC §6 prices are what quote() computes', () => {
  const section = SPEC.slice(SPEC.indexOf('## 6. Money'), SPEC.indexOf('## 7.'));
  const header = /^\| Hourly rate \|(.+)\|$/m.exec(section);
  assert.ok(header, 'the §6 table has a header row');
  const minutes = [...header[1].matchAll(/(\d+) min/g)].map((m) => Number(m[1]));
  assert.ok(minutes.length >= 4);
  const num = (c) => Number(c.replace(/[,\s]/g, ''));
  const rows = [...section.matchAll(/^\| (\d[\d,]*) \|(.+)\|$/gm)];
  assert.ok(rows.length >= 6, 'the table has its rows');
  const at45 = [];
  for (const row of rows) {
    const rate = num(row[1]);
    const cells = row[2].split('|').map(num);
    assert.equal(cells.length, minutes.length, `row ${rate} has a cell per column`);
    minutes.forEach((m, i) => {
      assert.equal(cells[i], quote(rate, m).price_vnd, `${rate}/h for ${m} minutes`);
    });
    at45.push(cells[minutes.indexOf(45)]);
  }
  const range = /VND (\d+)–(\d+)k/.exec(section);
  assert.ok(range, 'the §6 prose states a range for 45 minutes');
  assert.equal(Number(range[1]) * 1000, Math.min(...at45));
  assert.equal(Number(range[2]) * 1000, Math.max(...at45));
});

test('docs: README\'s settings table is the settings defaults', () => {
  const rows = [...README.matchAll(/^\| (Platform share|Shortest session|Default session|Default rate) \| ([^|]+) \|/gm)];
  assert.equal(rows.length, 4, 'all four settings are in the table');
  for (const [, label, shown] of rows) {
    const spec = Object.values(SETTING_SPECS).find((s) => s.label === label);
    assert.ok(spec, `${label} is a setting`);
    assert.equal(Number(shown.replace(/[^\d]/g, '')), spec.fallback, label);
  }
});

test('docs: README\'s seed and expert counts are what the seed produces', () => {
  const db = openDb(':memory:');
  const result = seedDatabase(db, { rules: loadRules() });
  const shipped = /All (\d+) shipped notes publish without one/.exec(README);
  assert.ok(shipped, 'README states how many shipped notes publish without an attestation');
  assert.equal(result.blocked, 0);
  assert.equal(result.published, result.files, 'every shipped note publishes');
  assert.equal(Number(shipped[1]), result.published);
  const experts = /(\d+) demo expert profiles/.exec(README);
  assert.ok(experts, 'README states the demo expert count');
  assert.equal(Number(experts[1]), JSON.parse(readFileSync('seed/experts.json', 'utf8')).length);
});

test('docs: README\'s interview length is the script\'s', () => {
  const stated = /\((\d+) fixed questions\)/.exec(README);
  assert.ok(stated, 'README says how many questions the interview asks');
  assert.equal(Number(stated[1]), SCRIPT.length);
});

test('docs: README\'s password cost is the one that hashes use', async () => {
  const stated = /`N=2\^(\d+)`/.exec(README);
  assert.ok(stated, 'README states the scrypt cost');
  const hash = await hashPassword('ten chars!!');
  assert.equal(Number(hash.split('$')[1]), 2 ** Number(stated[1]));
});
