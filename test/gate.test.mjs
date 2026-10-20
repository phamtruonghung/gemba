// The publishability gate, measured against what a Vietnamese supervisor would actually write
// (issue #35), and the attestation flow that sits on top of it: no path publishes on the author's
// behalf, and the seed publishes nothing that would need an attestation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkNote, decidePublication, loadRules, readRulesFile, DEFAULT_RULES } from '../src/gate.mjs';
import { createApp } from '../src/server.mjs';
import { openDb, upsertExpert, noteBySlug, publishedNotes, answersFor, insertQuestion, routeQuestion } from '../src/db.mjs';
import { seedDatabase } from '../src/seed-corpus.mjs';

// --- the 18-note adversarial set (ported from gemba-review/harness-gate.mjs) -----------------------

const CRAFT = `
## Cách làm
Đứng tại chỗ, quan sát chỗ dụng cụ hay bị để sai. Hỏi người vận hành ba câu: cái này để làm gì, bao lâu dùng một lần, ai chịu trách nhiệm.
Nếu họ trả lời được thì khu vực đó đang giữ được. Nếu không trả lời được thì bảng điểm vẫn có thể đẹp mà thực tế không giữ.
## Lỗi thường gặp
Biến nó thành phong trào: làm mạnh một tuần rồi đâu lại vào đấy. Dấu hiệu giữ được là khu vực tự giữ trật tự khi không có ai kiểm tra.
`;

const N = (label, title, extra, expect) => ({ label, title, body: `# ${title}\n${extra}\n${CRAFT}`, expect });

const ADVERSARIAL = [
  N('name with diacritics, mid-sentence', 'Bài học từ tổ cắt',
    '## Bối cảnh\nAnh Nguyễn Văn Anh bên tổ cắt cho biết cảm biến hay bị bẩn sau ca đêm, nên vệ sinh trước khi chạy.', 'block'),
  N('name in ALL CAPS as a heading', 'Ghi chú bàn giao',
    '## Người thực hiện\nTRẦN THỊ LAN — tổ trưởng tổ lắp ráp, người đã kiểm tra và xác nhận cách làm này.', 'block'),
  N('name lowercase (Zalo chat style)', 'Kinh nghiệm từ chị Hoa',
    '## Nguồn\nchị nguyễn thị hoa nói rằng cứ để vật tư trong hộp xanh thì ít lẫn hơn, nên giữ cách đó.', 'block'),
  N('surname Đào (not in the old family list)', 'Cách kiểm tra khuôn',
    '## Nguồn\nAnh Đào Văn Hùng, thợ khuôn 20 năm, dạy lại cách nghe tiếng máy trước khi khuôn hỏng.', 'block'),
  N('surname Mai (not in the old family list)', 'Mẹo gá phôi',
    '## Nguồn\nChị Mai Thị Dung bên tổ dập chỉ cho một mẹo: gá phôi sát chốt trước rồi mới siết.', 'block'),
  N('plant line identifier: chuyền 3', 'Ghi chú chuyền 3',
    '## Hiện trạng\nChuyền 3 đang bị kẹt phôi ở trạm cuối, nguyên nhân là con lăn mòn. Thay con lăn là hết.', 'block'),
  N('part code: mã hàng 1234', 'Lỗi lẫn vật tư',
    '## Hiện trạng\nMã hàng 1234 hay bị lẫn với mã hàng 1235 vì bao bì giống nhau, phải so nhãn trước khi cấp.', 'block'),
  N('purchase order: PO 4500123', 'Nhận hàng sai',
    '## Hiện trạng\nPO 4500123 giao thiếu hai thùng, thủ kho phát hiện khi đối chiếu phiếu giao.', 'block'),
  // The original harness expected `attest` (a figure). "Ca 2" is a plant identifier, which is
  // block-class, so the stricter verdict is the right one; what must never happen is `clean`.
  N('shift and plant output figure', 'Năng suất ca 2',
    '## Hiện trạng\nCa 2 chạy khoảng 1200 cái/ngày nếu không dừng máy, ca 1 thấp hơn vì thiếu người.', 'block'),
  N('phone and Zalo numbers', 'Liên hệ khi máy dừng',
    '## Liên hệ\nGọi 0909 123 456 hoặc Zalo 0912.345.678 khi máy dừng quá 10 phút, đừng chờ hết ca.', 'block'),
  N('customer name', 'Yêu cầu của khách hàng',
    '## Hiện trạng\nKhách hàng Bosch yêu cầu nhãn phải in đúng vị trí, lệch 2 mm là trả lại cả lô.', 'block'),
  N('factory / company name', 'Nhà máy Acme Fab Việt Nam',
    '## Hiện trạng\nCông ty TNHH Sản xuất ABC có ba nhà máy, nhà máy Acme Fab Việt Nam là nơi áp dụng cách này đầu tiên.', 'block'),
  N('OEE figure', 'OEE của chuyền',
    '## Hiện trạng\nOEE 67% tuần trước, phần lớn mất ở dừng máy ngắn, không phải ở chất lượng.', 'attest'),
  N('portable craft: sentence starts with "Do Not"', 'Machine start-up',
    '## Start of shift\nDo Not run the machine dry. Prime the pump, watch the gauge for ten seconds, then start the cycle.', 'clean'),
  N('portable craft: sentence starts with "Hồ sơ"', 'Cách lưu hồ sơ',
    '## Cách làm\nHồ sơ kiểm tra để tại chỗ, mỗi lần kiểm tra ghi ngày và người kiểm tra vào cùng một tờ.', 'clean'),
  N('portable craft: sentence starts with "Làm đúng"', 'Tiêu chuẩn một điểm',
    '## Câu chuẩn\nLàm đúng ngay từ đầu rẻ hơn sửa lại. Một câu, dán tại chỗ, ai cũng đọc được trong ba giây.', 'clean'),
  N('portable craft: mentions "part number" generically', 'Nhãn hành trình',
    '## Cách làm\nWrite the part number on the traveller before the part leaves the station, so the next station can check it.', 'clean'),
  N('portable craft: machining rate, not a contract', 'Cách tính đơn giá gia công',
    '## Cách làm\nĐơn giá gia công tính theo giờ máy, không theo sản phẩm, vì thời gian gá chiếm phần lớn.', 'clean')
];

const FIXTURE_RULES = loadRules({ block_terms: ['acme fab'] });
const verdictOf = (n) => checkNote({ title: n.title, body: n.body }, FIXTURE_RULES).verdict;
const klass = (v) => (v === 'blocked' ? 'block' : v === 'needs_attestation' ? 'attest' : 'clean');

test('gate: the 18-note adversarial set has 18 notes', () => {
  assert.equal(ADVERSARIAL.length, 18);
});

test('gate: the adversarial set leaks 0 block-class notes', () => {
  const leaks = ADVERSARIAL.filter((n) => n.expect === 'block' && klass(verdictOf(n)) !== 'block');
  assert.deepEqual(leaks.map((n) => n.label), []);
});

test('gate: the adversarial set blocks 0 clean craft notes and forces no attestation on them', () => {
  const falsePositives = ADVERSARIAL.filter((n) => n.expect === 'clean' && klass(verdictOf(n)) !== 'clean');
  assert.deepEqual(falsePositives.map((n) => `${n.label}: ${verdictOf(n)}`), []);
});

test('gate: a figure is never under-classified to clean', () => {
  const under = ADVERSARIAL.filter((n) => n.expect === 'attest' && klass(verdictOf(n)) === 'clean');
  assert.deepEqual(under.map((n) => n.label), []);
  assert.equal(klass(verdictOf(ADVERSARIAL.find((n) => n.label === 'OEE figure'))), 'attest');
});

// --- the strings named in the issue, and the extra probes -----------------------------------------

const note = (text) => ({ title: 'Ghi chú', body: `# Ghi chú\n\n## Hiện trạng\n${text}\n${CRAFT}` });
const blockRules = (text, rules) => checkNote(note(text), rules).findings.filter((f) => f.severity === 'block');

test('gate: every string in the issue is block-class', () => {
  const leaks = [
    'chị nguyễn thị hoa nói là nên để gần máy.',
    'Anh Đào Văn Hùng dạy lại cách nghe tiếng máy.',
    'Chị Mai Thị Dung chỉ một mẹo gá phôi.',
    'Chuyền 3 đang bị kẹt phôi.',
    'Gọi 0909 123 456 hoặc Zalo 0912.345.678',
    'Khách hàng Bosch yêu cầu nhãn đúng vị trí.',
    'Lô 45 bị trả lại.',
    'Line 3 was down for most of the shift.',
    'Ca 2 trên chuyền 3 chỉ có bốn người.',
    'Máy dập số hiệu 88-2041 hay kẹt phôi.',
    'mã hàng 1234 hay lẫn.',
    'PO 4500123 giao thiếu.'
  ];
  for (const t of leaks) assert.ok(blockRules(t).length > 0, `should block: ${t}`);
});

test('gate: the issue\'s false blocks are clean', () => {
  for (const t of ['Do Not run the machine dry.', 'Write the part number on the traveller', 'Đơn giá gia công tính theo giờ máy']) {
    assert.deepEqual(blockRules(t), [], `should be clean: ${t}`);
  }
});

test('gate: contact details, in the shapes people write them', () => {
  for (const t of [
    'Gọi 0909 123 456 khi dừng máy.', 'Gọi 0912.345.678 khi dừng máy.', 'Gọi 0912-345-678 nhé.', 'Số 0987654321 là bảo trì.',
    'Call +84 912 345 678 first.', 'Call +84912345678 first.', 'Zalo: 0912 345 678', 'Zalo 0912.345.678',
    'Văn phòng 024 3825 1234 trả lời.', 'Văn phòng (0236) 3 654 321 trả lời.', 'Liên hệ: lan.tran@example.com khi cần.'
  ]) {
    assert.ok(blockRules(t).some((f) => f.rule === 'contact'), `should be a contact: ${t}`);
  }
  for (const t of ['Máy chạy 1200 chu kỳ mỗi ca đêm.', 'Zalo group của tổ.', 'Đặt áp suất 0.5 bar rồi chờ.']) {
    assert.ok(!blockRules(t).some((f) => f.rule === 'contact'), `should not be a contact: ${t}`);
  }
});

test('gate: customers and suppliers by name, and by context', () => {
  assert.ok(blockRules('The Bosch auditor asked for the label position.').some((f) => f.rule === 'customer_name'));
  assert.ok(blockRules('Nhà cung cấp Song Long giao thiếu hai thùng.').some((f) => f.rule === 'customer_name'));
  assert.ok(blockRules('Our customer Acme wants the label on the left.').some((f) => f.rule === 'customer_name'));
  // The list is configurable per deployment.
  const rules = loadRules({ customer_names: ['Fubon'] });
  assert.ok(blockRules('Fubon trả lại cả đợt hàng.', rules).some((f) => f.rule === 'customer_name'));
  // A heading about customers, and a lean case study, are not a named customer.
  assert.deepEqual(blockRules('Customer Complaints are logged at the station. Toyota built the andon cord.'), []);
});

test('gate: plant identifiers are case- and diacritic-insensitive, and need a code', () => {
  for (const t of ['CHUYỀN 3 dừng', 'chuyen 3 dung', 'Trạm: 7B', 'tram #12', 'Serial AB-1234', 'Lot 45', 'lô 46', 'Ca 2', 'ca 1', 'Line A', 'số hiệu 88-2041', 'SO HIEU 88-2041']) {
    assert.ok(blockRules(t).some((f) => f.rule === 'plant_identifier'), `should be an identifier: ${t}`);
  }
  for (const t of ['The line stops when the guard opens.', 'Chuyền chạy ổn định.', 'Làm việc ca đêm cần nghỉ đủ.', 'Check the serial number on the label.', 'a lot of scrap', 'Đi lên trạm xăng.']) {
    assert.ok(!blockRules(t).some((f) => f.rule === 'plant_identifier'), `should not be an identifier: ${t}`);
  }
});

test('gate: person names: full surname set, kinship prefix, ALL CAPS, and ambiguous short surnames', () => {
  for (const t of [
    'Anh Đào Văn Hùng dạy lại.', 'Chị Mai Thị Dung chỉ cho.', 'Ông Tạ Quang Minh ký.', 'bà Lưu Thị Hà nói.', 'Mai Thị Dung chỉ cho.',
    'chị nguyễn thị hoa nói.', 'anh Hồ Văn Nam nói.', 'TRẦN THỊ LAN kiểm tra.', 'NGUYỄN VĂN ANH kiểm tra.', 'Phùng Quang Huy ký.',
    'Nguyen Van An ky.', 'chị Mai nói là để gần máy.', 'ông Đỗ Văn Tám'
  ]) {
    assert.ok(blockRules(t).some((f) => f.rule === 'person_name'), `should be a person: ${t}`);
  }
  for (const t of [
    'Do Not run the machine dry.', 'DO NOT run the machine dry.', 'Đỗ lại máy trước khi mở cửa.', 'Hồ sơ để tại chỗ.', 'Hồ Sơ năng lực để tại chỗ.',
    'Làm đúng ngay từ đầu.', 'Làm Đúng ngay từ đầu.', 'Lý do chính là dao mòn.', 'Lý Do Chính Là Dao Mòn.', 'Lưu ý khi thay dao.',
    'Mai kiểm tra lại cũng được.', 'Kim loại bị cong.', 'Phạm vi áp dụng là cả tổ.', 'Phạm Vi Áp Dụng', 'Nguyên nhân gốc là con lăn mòn.',
    'Nguyên Nhân Gốc', 'Vũ khí cạnh tranh là giá.', 'Lê kế hoạch sản xuất mỗi tuần.', 'nghi phạm đầu tiên là con lăn.', 'nguyễn văn anh kiểm tra.'
  ]) {
    assert.deepEqual(blockRules(t).filter((f) => f.rule === 'person_name'), [], `should not be a person: ${t}`);
  }
});

test('gate: folding Đỗ to "do" does not create a block', () => {
  assert.equal(checkNote(note('Đỗ xe an toàn, Do the check twice, DO NOT skip it.')).ok, true);
});

test('gate: document patterns need an actual value', () => {
  for (const t of [
    'mã hàng 1234', 'Mã vật tư AB-1234 bị lẫn', 'PO 4500123', 'LSX 88', 'part no 4417-B', 'Part number: 77A21', 'item # 5500',
    'Đơn giá 45.000 đồng', 'Đơn giá linh kiện này là 45.000', 'hợp đồng số 12', 'bản vẽ AB1234-C', 'drawing 10-2231', 'Invoice no 8891',
    'Unit price per piece is 4.5', 'supplier code S-7741', 'Mr. Johnson'
  ]) {
    assert.ok(blockRules(t).some((f) => f.rule === 'document'), `should block: ${t}`);
  }
  for (const t of [
    'Write the part number on the traveller', 'The part number is on the label.', 'Đơn giá gia công tính theo giờ máy', 'mã hàng nằm trên nhãn',
    'Check the drawing before you cut.', 'Bản vẽ phải mới nhất.', 'Compare the unit price per piece across suppliers.', 'Ghi hợp đồng số vào hồ sơ', 'Show the invoice number to the buyer.'
  ]) {
    assert.deepEqual(blockRules(t).filter((f) => f.rule === 'document'), [], `should be clean: ${t}`);
  }
});

test('gate: every finding is reported, not just the first (matchAll)', () => {
  const r = checkNote(note('PO 100 và PO 200. Gọi 0909 123 456, rồi 0912 345 678. Lô 1, lô 2. Giảm 5% rồi 7%.'));
  assert.equal(r.findings.filter((f) => f.rule === 'document').length, 2);
  assert.equal(r.findings.filter((f) => f.rule === 'contact').length, 2);
  assert.equal(r.findings.filter((f) => f.rule === 'plant_identifier').length, 2);
  assert.equal(r.findings.filter((f) => f.rule === 'figure').length, 2);
  assert.equal(checkNote(note('Anh Nguyễn Văn An và chị Trần Thị Bình đều biết.')).findings.filter((f) => f.rule === 'person_name').length, 2);
});

test('gate: corpus_lint is its own class: reported, not blocking, one finding per kind', () => {
  const r = checkNote(note('Xem [[SCHEMA]] và [[index|danh sách]]. Quyết định ngày 2026-09-20.\n`src: documents/2026-09-26-x.md`\nKhông chạy ở this plant. We do it at this plant, in our plant, và nhà máy mình.'));
  const lint = r.findings.filter((f) => f.rule === 'corpus_lint');
  for (const kind of ['wiki_link', 'iso_date', 'src_path', 'employer_deixis']) {
    assert.ok(lint.some((f) => f.kind === kind && f.severity === 'lint'), `missing lint kind ${kind}`);
  }
  assert.equal(lint.filter((f) => f.kind === 'wiki_link').length, 2);
  assert.equal(r.ok, true, 'lint does not block a person\'s note');
  assert.equal(r.verdict, 'clean');
  assert.equal(r.lint, lint.length);
});

test('gate: loadRules extends every list and keeps the defaults', () => {
  const rules = loadRules({ family_names: ['zzz'], contact_patterns: ['QQ\\d+'], plant_identifier_words: ['cell'] });
  assert.ok(rules.family_names.includes('nguyễn') && rules.family_names.includes('zzz'));
  assert.ok(blockRules('QQ12345 là liên hệ.', rules).some((f) => f.rule === 'contact'));
  assert.ok(blockRules('Cell 4 ran hot.', rules).some((f) => f.rule === 'plant_identifier'));
  assert.ok(blockRules('Chuyền 3 ran hot.', rules).some((f) => f.rule === 'plant_identifier'));
});

test('gate: attestation is never defaulted: no source file passes attested: true', () => {
  for (const dir of ['src', 'scripts']) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
      assert.ok(!/attested\s*:\s*true/.test(readFileSync(join(dir, f), 'utf8')), `${dir}/${f} hard-codes attested: true`);
    }
  }
  assert.equal(decidePublication({ title: 't', body: 'Giảm 5% phế phẩm.' }).publish, false);
  assert.equal(decidePublication({ title: 't', body: 'Giảm 5% phế phẩm.' }, { attested: 'yes' }).publish, false, 'only boolean true attests');
});

// --- the seed -----------------------------------------------------------------------------------------

test('seed: publishes nothing that needs attestation, and every shipped note is clean of vault metadata', () => {
  const db = openDb(':memory:');
  const result = seedDatabase(db, { rules: loadRules() });
  const files = readdirSync('seed/corpus').filter((f) => f.endsWith('.md'));
  assert.equal(result.files, files.length);
  const published = publishedNotes(db);
  assert.ok(published.length > 0);
  for (const n of published) {
    const gate = JSON.parse(n.gate);
    assert.equal(gate.ok, true, `${n.slug} is blocked`);
    assert.equal(gate.needs_attestation, false, `${n.slug} was published although it needs attestation`);
    assert.deepEqual(gate.findings.filter((f) => f.severity === 'lint'), [], `${n.slug} carries vault metadata`);
  }
  // Every shipped note passes with no attestation at all, so all of them are published.
  assert.equal(published.length, files.length, `unpublished: ${db.prepare(`select slug, status from notes where status != 'published'`).all().map((r) => r.slug).join(', ')}`);
  const pub = published.map((n) => n.slug);
  assert.ok(pub.some((s) => s.startsWith('vault-hoshin-kanri')) && pub.some((s) => s.startsWith('vault-lessons')));
});

test('seed: a note that needs attestation is left as a draft, never published for the author', () => {
  const db = openDb(':memory:');
  const dir = join('/tmp', `gemba-seed-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'a.md'), `---\ntitle: Scrap by shift\ntopic: tpm\n---\n\n# Scrap by shift\n\n## Hiện trạng\nPhế phẩm giảm 12% sau khi đổi cách kiểm.\n\n## Cách làm\n${CRAFT}`);
    writeFileSync(join(dir, 'b.md'), `---\ntitle: Notes with metadata\ntopic: tpm\n---\n\n# Notes with metadata\n\n## Cách làm\nXem [[SCHEMA]] ngày 2026-09-20.\n${CRAFT}`);
    const log = [];
    const r = seedDatabase(db, { rules: loadRules(), corpusDir: dir, log: (m) => log.push(m) });
    assert.equal(r.published, 0);
    assert.deepEqual(db.prepare('select status from notes order by slug').all().map((x) => x.status), ['draft', 'draft']);
    assert.ok(log.some((m) => /NOT PUBLISHED/.test(m)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the attestation flow over real HTTP -----------------------------------------------------------------

const TOKEN = 'tok-gate-flow';
const ANSWERS = [
  'I have done this work for twenty years, covering assembly and basic maintenance.',
  'The most repeated problem is material off specification at the last station stopping the line.',
  'The first sign is the indicator light at the last station blinking, and the final checker notices it.',
  'The root cause is usually a mis-picked material batch; verify it by comparing the packaging against the delivery note.',
  'The fix: stop the station, quarantine the suspect material, tell the team leader, write the symptom down, then restart.',
  'A newcomer replaces the sensor before checking the material, which wastes time and leaves the fault in place.',
  'The standard is to check the material before the sensor, and everyone follows that order.',
  'This works on a multi-station assembly line. It does not work when the customer supplies the material.'
];

let app;
let base;

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data', adminToken: 'adm', bankBin: '', bankAccount: '', llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 } }
  });
  upsertExpert(app.db, { slug: 'hung-qa', name: 'Hung', headline: 'x', topics: ['tpm'], years: 20, rate_vnd: 800000, token: TOKEN });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

const post = (path, data = {}) =>
  fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** Walk the whole interview and return the review page for the draft it produced. */
async function interviewDraft(answers = ANSWERS) {
  const start = await (await fetch(`${base}/c/${TOKEN}/interview`)).text();
  const id = /name="id" value="(\d+)"/.exec(start)[1];
  let last;
  for (const answer of answers) last = await post(`/c/${TOKEN}/interview`, { id, answer });
  assert.equal(last.status, 303);
  const location = last.headers.get('location');
  assert.match(location, /^\/c\/[^/]+\/draft\?slug=/);
  const slug = new URL(location, base).searchParams.get('slug');
  const html = await (await fetch(`${base}${location}`)).text();
  const body = decode(/<textarea id="draft-body"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)[1]);
  const title = decode(/id="draft-title" name="title" required value="([^"]*)"/.exec(html)[1]);
  return { slug, html, body, title };
}

const inLibrary = async (needle) => (await (await fetch(`${base}/library`)).text()).includes(needle);

test('flow: the interview ends in a draft with the rendered note, the findings and the attestation text', async () => {
  const d = await interviewDraft();
  assert.equal(noteBySlug(app.db, d.slug).status, 'draft', 'the interview publishes nothing by itself');
  assert.ok(!(await inLibrary('Field notes: The most repeated problem')));
  assert.match(d.html, /What the gate found/);
  assert.match(d.html, /How the note will read/);
  assert.match(d.html, /I confirm this is my own craft knowledge: it holds no figures/);
  assert.match(d.html, /<input type="checkbox" id="draft-attested" name="attested" value="1">/);
  assert.match(d.html, /<textarea id="draft-body"/, 'the draft is editable');
  assert.match(d.html, /<form method="post" action="\/c\/[^"]+\/draft"/, 'a plain form POST: it works with JS off');
  assert.doesNotMatch(d.html, /<script[^>]*src=|fetch\(/, 'no client-side state');
  assert.equal((await fetch(`${base}/notes/${d.slug}`)).status, 404, 'a draft has no public page');
});

test('flow: a draft posted without the checkbox is not published', async () => {
  const d = await interviewDraft();
  const res = await post(`/c/${TOKEN}/draft`, { slug: d.slug, title: d.title, body: d.body, action: 'publish' });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /Tick the attestation box/);
  assert.equal(noteBySlug(app.db, d.slug).status, 'draft');
  assert.ok(!publishedNotes(app.db).some((n) => n.slug === d.slug));
  assert.equal((await fetch(`${base}/notes/${d.slug}`)).status, 404);
});

test('flow: with the checkbox and a clean note it is published', async () => {
  const d = await interviewDraft();
  const res = await post(`/c/${TOKEN}/draft`, { slug: d.slug, title: d.title, body: d.body, attested: '1', action: 'publish' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Note published/);
  assert.equal(noteBySlug(app.db, d.slug).status, 'published');
  assert.equal((await fetch(`${base}/notes/${d.slug}`)).status, 200);
  assert.ok(await inLibrary('Field notes: The most repeated problem'));
});

test('flow: "check again" never publishes, even with the box ticked, and re-runs the gate on the edit', async () => {
  const d = await interviewDraft();
  const res = await post(`/c/${TOKEN}/draft`, { slug: d.slug, title: d.title, body: `${d.body}\nGiảm 12% phế phẩm.`, attested: '1', action: 'check' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /figure/);
  assert.match(html, /Giảm 12% phế phẩm/, 'the edit is kept in the textarea');
  assert.equal(noteBySlug(app.db, d.slug).status, 'draft');
  assert.match(noteBySlug(app.db, d.slug).body, /12%/, 'the edit is saved');
});

test('flow: a blocked note cannot be published, even with the checkbox', async () => {
  const d = await interviewDraft();
  const leaky = `${d.body}\nGọi anh Nguyễn Văn Bình 0909 123 456 khi máy dừng, khách hàng Bosch yêu cầu vậy.`;
  const res = await post(`/c/${TOKEN}/draft`, { slug: d.slug, title: d.title, body: leaky, attested: '1', action: 'publish' });
  assert.equal(res.status, 422);
  const html = await res.text();
  assert.match(html, /contact/);
  assert.match(html, /person_name/);
  assert.match(html, /customer_name/);
  assert.equal(noteBySlug(app.db, d.slug).status, 'blocked');
  assert.ok(!publishedNotes(app.db).some((n) => n.slug === d.slug));
  // Fix the text and it can then be published: the draft was kept, not lost.
  const fixed = await post(`/c/${TOKEN}/draft`, { slug: d.slug, title: d.title, body: d.body, attested: '1', action: 'publish' });
  assert.equal(fixed.status, 200);
  assert.equal(noteBySlug(app.db, d.slug).status, 'published');
});

test('flow: an interview whose answers already leak lands in review as blocked, not in the library', async () => {
  const answers = [...ANSWERS];
  answers[4] = 'Gọi 0909 123 456 rồi dừng chuyền 3, sau đó restart.';
  const d = await interviewDraft(answers);
  assert.equal(noteBySlug(app.db, d.slug).status, 'blocked');
  assert.match(d.html, /blocks publication/);
  const res = await post(`/c/${TOKEN}/draft`, { slug: d.slug, title: d.title, body: d.body, attested: '1', action: 'publish' });
  assert.equal(res.status, 422);
  assert.ok(!publishedNotes(app.db).some((n) => n.slug === d.slug));
});

test('flow: nobody else can review or publish an expert\'s draft', async () => {
  upsertExpert(app.db, { slug: 'other', name: 'Other', headline: 'x', topics: ['tpm'], years: 1, rate_vnd: 1, token: 'tok-other' });
  const d = await interviewDraft();
  assert.equal((await fetch(`${base}/c/tok-other/draft?slug=${d.slug}`)).status, 404);
  const res = await post('/c/tok-other/draft', { slug: d.slug, title: d.title, body: d.body, attested: '1', action: 'publish' });
  assert.equal(res.status, 404);
  assert.equal(noteBySlug(app.db, d.slug).status, 'draft');
});

function routedQuestion(text) {
  const q = insertQuestion(app.db, { asker: 'Lan', contact: 'lan@example.com', plant_type: '', topic: 'tpm', text, ai_answer: 'INSUFFICIENT_DATA', ai_citations: [], ai_coverage: 'thin', ai_mode: 'extractive', user_id: null });
  routeQuestion(app.db, q.ref, [], new Date(Date.now() + 864e5).toISOString());
  return q.ref;
}

test('flow: an expert answer with a phone number is stopped, and nothing is stored', async () => {
  const ref = routedQuestion('Who do I call when the press stops?');
  const res = await post(`/c/${TOKEN}/answer`, { ref, body: 'Call Hung on 0909 123 456 and describe the fault code before touching the guard.', attested: '1' });
  assert.equal(res.status, 422);
  const html = await res.text();
  assert.match(html, /contact/);
  assert.match(html, /The answer was not sent/);
  assert.match(html, /<textarea id="answer-body"/, 'the answer is kept for editing');
  assert.deepEqual(answersFor(app.db, ref), []);
});

test('flow: an expert answer with a name, a code or an email is stopped too', async () => {
  for (const body of ['Ask anh Nguyễn Văn Bình at the next station.', 'Check mã hàng 1234 first, it is often mixed up.', 'Mail lan.tran@example.com the fault code.']) {
    const ref = routedQuestion(`Question for ${body.slice(0, 12)}`);
    const res = await post(`/c/${TOKEN}/answer`, { ref, body, attested: '1' });
    assert.equal(res.status, 422, body);
    assert.deepEqual(answersFor(app.db, ref), [], body);
  }
});

test('flow: an expert answer with a figure needs the attestation; a clean answer is stored', async () => {
  const ref = routedQuestion('How do I cut changeover time?');
  const figure = 'Prepare the next tool offline; that usually saves 30% of the stop.';
  const no = await post(`/c/${TOKEN}/answer`, { ref, body: figure });
  assert.equal(no.status, 422);
  assert.deepEqual(answersFor(app.db, ref), []);
  const yes = await post(`/c/${TOKEN}/answer`, { ref, body: figure, attested: '1' });
  assert.equal(yes.status, 303);
  assert.equal(answersFor(app.db, ref).length, 1);

  const ref2 = routedQuestion('How do I start a cold press?');
  const ok = await post(`/c/${TOKEN}/answer`, { ref: ref2, body: 'Do Not run the press dry. Prime the pump, watch the gauge for ten seconds, then start the cycle.' });
  assert.equal(ok.status, 303);
  assert.equal(answersFor(app.db, ref2).length, 1);
});

test('gate: a shift length is a quantity, not a shift identifier — but the shift code still blocks', () => {
  const rules = loadRules();
  const ids = (t) => checkNote({ title: 'Ca làm việc', body: t }, rules).findings.filter((f) => f.rule === 'plant_identifier');
  assert.equal(ids('Một ca 8 tiếng nên có hai lần dừng ngắn để vệ sinh.').length, 0);
  assert.equal(ids('A shift of line 2 hours is too short to see the pattern.').length, 0);
  assert.equal(ids('Ca 2 chạy chậm vì thiếu người.').length, 1);
});

// --- the employer's names are a deployment file, not source (issue #45) ---------------------------

const rulesDir = mkdtempSync(join(tmpdir(), 'gemba-rules-'));
const rulesFile = (name, text) => {
  const path = join(rulesDir, name);
  writeFileSync(path, text);
  return path;
};

test('gate rules: the built-in block list is empty — the source names no employer', () => {
  assert.deepEqual(DEFAULT_RULES.block_terms, []);
});

test('gate rules: an absent file is the documented default, a valid file adds to it', () => {
  assert.deepEqual(readRulesFile(join(rulesDir, 'nope.json')), {});
  assert.deepEqual(readRulesFile(undefined), {});
  const path = rulesFile('ok.json', JSON.stringify({ block_terms: ['acme fab'] }));
  const rules = loadRules(readRulesFile(path));
  const report = checkNote({ title: 'Note', body: `${CRAFT}\nAt Acme Fab we did it the other way round.` }, rules);
  assert.equal(report.verdict, 'blocked');
  assert.ok(report.findings.some((f) => f.rule === 'block_term'));
});

test('gate rules: a present but wrong file throws and names the path — the gate fails closed', () => {
  const bad = rulesFile('bad.json', '{ not json');
  assert.throws(() => readRulesFile(bad), (e) => e.message.includes(bad));
  assert.throws(() => readRulesFile(rulesFile('str.json', '{"block_terms": "acme"}')), /block_terms.*array of strings/);
  assert.throws(() => readRulesFile(rulesFile('typo.json', '{"blok_terms": []}')), /unknown key "blok_terms"/);
  assert.throws(() => readRulesFile(rulesFile('arr.json', '[]')), /JSON object/);
});

test('gate rules: the tracked example parses through the loader', () => {
  const rules = readRulesFile('deploy/gate.rules.example.json');
  assert.ok(rules.block_terms.length > 0);
});

test('gate rules: the server loads the file named in its config and refuses a note that names the employer', async () => {
  const path = rulesFile('server.json', JSON.stringify({ block_terms: ['acme fab'] }));
  const local = createApp({
    dbPath: ':memory:',
    config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data', gateRulesPath: path, adminToken: 'adm', bankBin: '', bankAccount: '', llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 } }
  });
  upsertExpert(local.db, { slug: 'hung-qa', name: 'Hung', headline: 'x', topics: ['tpm'], years: 20, rate_vnd: 800000, token: 'tok-rules' });
  await new Promise((r) => local.server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${local.server.address().port}/c/tok-rules/note`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: 'A note', topic: 'tpm', body: `${CRAFT}\nAt Acme Fab we did it the other way round.` })
    });
    assert.equal(res.status, 422);
  } finally {
    local.server.close();
  }
});
