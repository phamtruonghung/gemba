// test/deploy.test.mjs — the installer's two ways to lose an operator's data or his login.
//
// Both bugs this file guards against were real and silent: a password containing `&` was rewritten
// by `sed` while the installer reported success, and `migrate-rename.sh --cleanup` deleted a legacy
// database it had just declined to migrate. Each test here fails on the old code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SET_ENV = join(ROOT, 'deploy/set-env.py');

async function scratch() {
  return mkdtemp(join(tmpdir(), 'gemba-deploy-'));
}

async function writeEnv(dir, body) {
  const path = join(dir, 'gemba.env');
  await writeFile(path, body);
  return path;
}

test('set-env.py stores a password verbatim, including every character sed used to eat', async () => {
  const dir = await scratch();
  try {
    const env = await writeEnv(dir, 'GEMBA_PORT=8090\nGEMBA_USER=\nGEMBA_PASS=\n');
    const passwords = [
      'Ca&nd1date2026',          // & meant "the whole match" to sed
      'a|b',                      // | was the delimiter
      'p@ss w0rd $HOME',          // space split the sourced line; $ expanded
      'back`id`tick',             // command substitution in the sourced file
      "quote'single",             // a quote must not unbalance anything
      'trailing space '
    ];
    for (const password of passwords) {
      const { stderr } = await run('python3', [SET_ENV, env, 'GEMBA_USER', 'ops@gemba.local', 'GEMBA_PASS', password]);
      assert.equal(stderr, '', `set-env.py warned on ${JSON.stringify(password)}`);
      const body = await readFile(env, 'utf8');
      assert.ok(
        body.split('\n').includes(`GEMBA_PASS=${password}`),
        `password not stored verbatim: ${JSON.stringify(body)}`
      );
      // The other keys are untouched, and the file did not grow a second GEMBA_PASS.
      assert.equal(body.split('\n').filter((l) => l.startsWith('GEMBA_PASS=')).length, 1);
      assert.equal(body.split('\n').filter((l) => l.startsWith('GEMBA_PORT=')).length, 1);
    }
    assert.equal((await stat(env)).mode & 0o777, 0o600, 'the env file must stay mode 600');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('set-env.py appends a key the file has never held, and refuses a newline', async () => {
  const dir = await scratch();
  try {
    const env = await writeEnv(dir, 'GEMBA_PORT=8090\n');
    await run('python3', [SET_ENV, env, 'GEMBA_LLM_KEY', 'sk-abc123']);
    assert.match(await readFile(env, 'utf8'), /^GEMBA_LLM_KEY=sk-abc123$/m);

    await assert.rejects(
      run('python3', [SET_ENV, env, 'GEMBA_PASS', 'two\nlines']),
      (err) => err.code === 2,
      'a value with a newline must be refused, not written as two keys'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the installer never builds a secret into sed, a heredoc, or a sourced file', async () => {
  const script = await readFile(join(ROOT, 'deploy/install.sh'), 'utf8');
  assert.ok(script.includes('deploy/set-env.py'), 'install.sh must write secrets through set-env.py');
  assert.ok(!/sed -i\s+"[^"]*GEMBA_PASS/.test(script), 'a sed replacement built from the password is the bug');
  assert.ok(!/^\s*set -a;\s*\.\s+.*gemba\.env/m.test(script), 'sourcing the env file executes its values');
  assert.ok(!/admin-create\.mjs \|\| true/.test(script), 'a failed operator account must fail the install');
  // The health loop used to end in `sleep`, so its status was always 0 and it could not fail.
  assert.match(script, /HEALTH_OK=0/, 'the health wait must be able to fail');
  assert.match(script, /sha256sum[^\n]*SHASUMS256/, 'the Node tarball must be checksum-verified');
});

test('cleanup refuses to delete a legacy data directory that still holds a database', async () => {
  const dir = await scratch();
  try {
    const app = join(dir, 'oldapp');
    const env = join(dir, 'oldetc');
    const data = join(dir, 'olddata');
    for (const d of [app, env, data]) await mkdir(d, { recursive: true });
    await writeFile(join(data, 'legacy.db'), 'pretend this is the operator database');

    const runCleanup = () =>
      run('bash', [join(ROOT, 'deploy/migrate-rename.sh'), '--cleanup'], {
        env: {
          ...process.env,
          GEMBA_LEGACY_APP_DIR: app,
          GEMBA_LEGACY_ENV_DIR: env,
          GEMBA_LEGACY_DATA_DIR: data
        }
      });

    await assert.rejects(runCleanup(), (err) => err.code === 1, 'a non-empty data directory must abort the cleanup');
    assert.equal(await readFile(join(data, 'legacy.db'), 'utf8'), 'pretend this is the operator database');
    // The app and config copies are not data; they are removed.
    await assert.rejects(stat(app), 'the stale app tree is still removed');

    // An empty data directory is just a directory.
    await rm(join(data, 'legacy.db'));
    const { stdout } = await runCleanup();
    assert.match(stdout, /empty legacy/);
    await assert.rejects(stat(data), 'an empty data directory is removed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a backup of a live database opens, checks out, and reports what it holds', async () => {
  const dir = await scratch();
  try {
    const data = join(dir, 'data');
    await mkdir(data, { recursive: true });
    await run(process.execPath, [join(ROOT, 'scripts/seed.mjs')], {
      env: { ...process.env, GEMBA_DATA_DIR: data, GEMBA_DB: join(data, 'gemba.db') }
    });

    const { stdout } = await run('bash', [join(ROOT, 'deploy/gemba-backup.sh')], {
      env: {
        ...process.env,
        GEMBA_DB: join(data, 'gemba.db'),
        GEMBA_BACKUP_DIR: join(dir, 'backups'),
        GEMBA_NODE: process.execPath
      }
    });
    assert.match(stdout, /integrity=ok/);
    assert.match(stdout, /notes=1[0-9]/); // the seeded corpus, not an empty file
    assert.match(stdout, /questions=0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
