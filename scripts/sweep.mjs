// Run the 48-hour sweep and the outbox once, by hand. The server does the same every minute; this is the
// demo command and the cron fallback: it opens the same database, flags what is late, sends what is pending
// through the configured transport, and prints what happened and what is still waiting.
//
//   GEMBA_ENV_FILE=/dev/null GEMBA_DB=/tmp/gp/gemba.db GEMBA_MAIL_TRANSPORT=file node scripts/sweep.mjs
//
// A second process alongside a running server is safe: rows are claimed with a compare-and-set before they
// are sent, so each message goes out once.
import { loadConfig } from '../src/server.mjs';
import * as dbm from '../src/db.mjs';
import * as outbox from '../src/outbox.mjs';

const config = loadConfig();
const db = dbm.openDb(config.dbPath);
const result = await outbox.runOnce(db, {
  transport: outbox.transportFrom(config),
  publicUrl: config.publicUrl || `http://localhost:${config.port}`,
  operatorEmails: config.operatorEmail ? [config.operatorEmail] : [],
  from: config.mailFrom
});
console.log(JSON.stringify(result));
const rows = dbm.outboxRows(db, { limit: 20 });
console.log(`\noutbox (${rows.length} newest of ${Object.entries(dbm.outboxCounts(db)).map(([k, v]) => `${v} ${k}`).join(', ')}):`);
for (const r of rows) {
  const domain = r.to_addr ? `…@${r.to_addr.split('@')[1]}` : '(no address)';
  console.log(`  #${r.id} ${r.kind.padEnd(26)} ${r.ref.padEnd(20)} ${domain.padEnd(24)} ${r.status} attempts=${r.attempts}${r.last_error ? ` — ${r.last_error}` : ''}`);
}
db.close();
