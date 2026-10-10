// scratch probe: walk the interview over real HTTP and print what lands in the database.
import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, publishedNotes } from '../src/db.mjs';

const app = createApp({
  dbPath: ':memory:',
  rules: loadRules(),
  config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data', adminToken: 't', bankBin: '', bankAccount: '', llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 } }
});
upsertExpert(app.db, { slug: 'hung-qa', name: 'Anh Hùng', headline: 'x', topics: ['tpm', 'quan-ly-chuyen'], years: 20, rate_vnd: 800000, token: 'tok' });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const post = (p, d) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(d) });

const start = await fetch(`${base}/c/tok/phong-van`);
const html = await start.text();
const id = /name="id" value="(\d+)"/.exec(html)[1];
console.log('session id', id, '| step in page:', /Câu (\d+)\/(\d+)/.exec(html)?.[0]);

const answers = Array.from({ length: 8 }, (_, i) => `Trả lời ${i + 1} đủ dài để tạo thành một đoạn trong ghi chú, mô tả hiện tượng và cách xử lý theo thứ tự.`);
let res;
for (let i = 0; i < 8; i += 1) {
  res = await post('/c/tok/phong-van', { id, answer: answers[i] });
  console.log('post', i + 1, '->', res.status, res.headers.get('location') ?? '');
  if (res.status !== 303) console.log('  body head:', (await res.text()).slice(0, 300).replace(/\n/g, ' '));
}
const notes = publishedNotes(app.db);
console.log('published notes:', notes.map((n) => `${n.id}:${n.title}`).join(' | '));
const kho = await (await fetch(`${base}/kho`)).text();
console.log('corpus page has the interview note:', kho.includes('Kinh nghiệm'));
app.server.close();
