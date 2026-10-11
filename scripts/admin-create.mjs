#!/usr/bin/env node
// Create or reset an operator account, and say the password once.
//
// Called by `deploy/install.sh` on a fresh install (which is why it reads the environment first) and by
// hand when an operator is locked out: `node scripts/admin-create.mjs --email me@example.com`.
//
// The password is never written to the environment file, the repository, or anywhere the app can read
// it back — only the hash reaches the database. If one is not given, this generates one and prints it:
// a password that appears once in a terminal is a password the operator has to save, which is the
// honest version of "we set one for you".
import { randomBytes } from 'node:crypto';
import { openDb, upsertAdmin, logEvent, countAdmins } from '../src/db.mjs';
import { hashPassword, checkEmail, checkPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/server.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
const email = flag('email') ?? process.env.GEMBA_ADMIN_EMAIL ?? '';
const name = flag('name') ?? process.env.GEMBA_ADMIN_NAME ?? 'Operator';
const given = flag('password') ?? process.env.GEMBA_ADMIN_PASSWORD ?? '';

const emailCheck = checkEmail(email);
if (!emailCheck.ok) {
  console.error(`admin-create: ${emailCheck.error} (pass --email, or set GEMBA_ADMIN_EMAIL)`);
  process.exit(2);
}

// 24 base64url characters ~ 144 bits: long enough that nobody guesses it, short enough to retype.
const password = given || randomBytes(18).toString('base64url').slice(0, 24);
const passwordCheck = checkPassword(password);
if (!passwordCheck.ok) {
  console.error(`admin-create: ${passwordCheck.error}`);
  process.exit(2);
}

const db = openDb(config.dbPath);
// No password given and an operator already exists: creating a second one, or silently resetting the
// first, would lock out whoever is already using the instance. Say so and stop — resetting is a
// deliberate act, so it takes an explicit password.
if (!given && countAdmins(db) > 0) {
  const who = db.prepare("select email from users where role = 'admin' order by id limit 1").get();
  console.log(`an operator account already exists (${who?.email}) — not resetting it.`);
  console.log('  to reset it, pass GEMBA_ADMIN_PASSWORD=<new password> or --password.');
  db.close();
  process.exit(0);
}
const { user, created } = upsertAdmin(db, {
  email: emailCheck.value,
  name,
  password_hash: await hashPassword(password)
});
logEvent(db, created ? 'admin_create' : 'admin_reset', '', `actor=cli email=${emailCheck.value}`);
console.log(`${created ? 'created' : 'reset'} operator account: ${user.email} (${user.role})`);
console.log(`  operators on this instance: ${countAdmins(db)}`);
if (!given) console.log(`  password: ${password}\n  (shown once — it is stored only as a hash)`);
else console.log('  password: as given');
db.close();
