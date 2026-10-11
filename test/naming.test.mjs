// The name is an identifier, not a label: it is the GitHub repo, the image, the systemd unit, the
// config file, the database path and the cookie. A rename that stops at the visible brand leaves the
// rest answering to a name nobody recognises, so this test holds the whole surface at once.
//
// The two allowlisted places are deliberate and documented:
//   - deploy/migrate-rename.sh has to spell the old name, because it is what looks for it.
//   - src/retrieval.mjs carries 'xuong' as the Vietnamese stopword (xưởng, ASCII-folded). Renaming
//     that token would quietly change what retrieval ignores — a silent quality change, not a rename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data']);
const ALLOWED_FILES = new Set([
  'deploy/migrate-rename.sh', // knows the old name on purpose
  'src/retrieval.mjs', // the folded Vietnamese stopword, not the product name
  'test/naming.test.mjs' // this file, which has to name what it forbids
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full));
  }
  return out;
}

test('no file is still named after the old product', () => {
  const offenders = walk(ROOT).filter((f) => /xuong/i.test(f) && !ALLOWED_FILES.has(f));
  assert.deepEqual(offenders, []);
});

test('the old name survives only where it is load-bearing', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    if (ALLOWED_FILES.has(file)) continue;
    let text;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // a binary asset has no name in it
    }
    if (/xuong/i.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'these files still mention the old name');
});

test('the stopword is still the stopword', () => {
  const retrieval = readFileSync(join(ROOT, 'src/retrieval.mjs'), 'utf8');
  assert.match(retrieval, /'xuong'/, "the Vietnamese stopword 'xuong' was renamed away");
  assert.match(retrieval, /'len', 'xuong', 'roi'/, 'and it is still in the stopword list, in place');
});

test('the brand, the paths and the environment all agree on the new name', async () => {
  const views = readFileSync(join(ROOT, 'src/views.mjs'), 'utf8');
  assert.match(views, /Gemba/, 'the interface names the product');
  const auth = readFileSync(join(ROOT, 'src/auth.mjs'), 'utf8');
  assert.match(auth, /SESSION_COOKIE = 'gemba_session'/, 'and the cookie carries the new name');

  const install = readFileSync(join(ROOT, 'deploy/install.sh'), 'utf8');
  for (const path of ['/opt/gemba', '/etc/gemba', '/var/lib/gemba', 'gemba.service']) {
    assert.ok(install.includes(path), `install.sh owns ${path}`);
  }
  assert.match(install, /GEMBA_LLM_BASE_URL/, 'and the config prefix matches the product');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'gemba');
});

test('the migration script is the only way the old paths are still reachable', () => {
  const mig = readFileSync(join(ROOT, 'deploy/migrate-rename.sh'), 'utf8');
  for (const legacy of ['/etc/xuong', '/var/lib/xuong', '/opt/xuong', 'xuong.service']) {
    assert.ok(mig.includes(legacy), `the migration knows about ${legacy}`);
  }
  assert.match(mig, /XUONG_/, 'and it renames the old environment keys');
  assert.match(mig, /sed 's\/\^XUONG_\/GEMBA_\//, 'by prefix rewrite, not by hand');
  // install.sh must call it, or a legacy host keeps a dead unit and an orphaned database
  const install = readFileSync(join(ROOT, 'deploy/install.sh'), 'utf8');
  assert.match(install, /migrate-rename\.sh/, 'install.sh runs the migration');
});
