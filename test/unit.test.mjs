// Unit tests: the publishability gate, retrieval, pricing, and the answer contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkNote, decidePublication, loadRules, ATTESTATION_TEXT } from '../src/gate.mjs';
import { buildIndex, search, coverage, tokenize, fold } from '../src/retrieval.mjs';
import { quote, priceFor, split, roundVnd, formatVnd, transferInstruction, PLATFORM_TAKE_RATE, MIN_MINUTES } from '../src/pricing.mjs';
import { buildPrompt, askFromCorpus, NO_DATA_MARKER } from '../src/llm.mjs';
import { SCRIPT, draftNoteFromInterview, slugify } from '../src/interview.mjs';

const CRAFT = `# Máy dừng giữa ca

## Thứ tự kiểm tra
Giữ chỗ đứng an toàn trước, rồi đọc mã lỗi, rồi xem dừng ở một trạm hay cả chuyền.
Chỉ khi biết chắc máy đã ở trạng thái an toàn mới được lại gần và mở che chắn.
Nếu không tìm ra nguyên nhân trong khoảng thời gian cho phép thì leo bậc gọi bảo trì.
Sau khi chạy lại thì ghi lại hiện tượng và cách xử lý vào sổ tay của ca trực.
`;

test('gate: a craft note with no employer facts is clean', () => {
  const report = checkNote({ title: 'Máy dừng giữa ca', body: CRAFT });
  assert.equal(report.ok, true);
  assert.equal(report.needs_attestation, false);
  assert.equal(report.verdict, 'clean');
});

test('gate: the employer name is blocked', () => {
  const report = checkNote({ title: 'Note', body: `${CRAFT}\nTheo quy trình của RELATS thì làm ngược lại.` });
  assert.equal(report.ok, false);
  assert.equal(report.verdict, 'blocked');
  assert.ok(report.findings.some((f) => f.rule === 'block_term' && f.severity === 'block'));
});

test('gate: a person name is blocked', () => {
  const report = checkNote({ title: 'Note', body: `${CRAFT}\nAnh Nguyễn Văn Anh làm ca đó đã xử lý.` });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.rule === 'person_name'));
});

test('gate: an order number or internal document is blocked', () => {
  for (const leak of ['Theo PO 45123 giao tuần này.', 'Xem bản vẽ AB1234-C ở trạm 2.', 'Đơn giá linh kiện này rất thấp.']) {
    const report = checkNote({ title: 'Note', body: `${CRAFT}\n${leak}` });
    assert.equal(report.ok, false, `should block: ${leak}`);
    assert.ok(report.findings.some((f) => f.rule === 'document'));
  }
});

test('gate: a figure with a unit needs the author attestation, and cannot publish without it', () => {
  const note = { title: 'OEE', body: `${CRAFT}\nDây này đang chạy ở mức 72% OEE nên cần cải tiến.` };
  const report = checkNote(note);
  assert.equal(report.ok, true);
  assert.equal(report.needs_attestation, true);
  assert.equal(report.verdict, 'needs_attestation');
  assert.equal(decidePublication(note, { attested: false }).publish, false);
  assert.equal(decidePublication(note, { attested: false }).reason, 'attestation_required');
  assert.equal(decidePublication(note, { attested: true }).publish, true);
});

test('gate: a blocked note stays blocked even when attested', () => {
  const note = { title: 'Note', body: `${CRAFT}\nĐơn giá nhập của PO 99887 là vấn đề.` };
  const d = decidePublication(note, { attested: true });
  assert.equal(d.publish, false);
  assert.equal(d.reason, 'blocked');
});

test('gate: the rules are extensible per deployment', () => {
  const rules = loadRules({ block_terms: ['nhà máy ABC'], document_patterns: [] });
  const report = checkNote({ title: 'N', body: `${CRAFT}\nỞ nhà máy ABC thì khác.` }, rules);
  assert.equal(report.ok, false);
});

test('gate: the attestation wording says what the author is signing', () => {
  assert.match(ATTESTATION_TEXT, /không có số liệu/);
  assert.match(ATTESTATION_TEXT, /tên khách hàng\/nhà cung cấp/);
});

test('retrieval: folds Vietnamese diacritics both ways', () => {
  assert.deepEqual(tokenize('Chuyền'), tokenize('chuyen'));
  assert.equal(fold('Đổi khuôn'), 'doi khuon');
});

test('retrieval: finds the right note for a real question', () => {
  const notes = [
    { id: 1, title: 'Máy dừng giữa ca', topic: 'quan-ly-chuyen', body: CRAFT },
    { id: 2, title: '5S tại hiện trường', topic: 'an-toan', body: '# 5S\n\n## Sàng lọc\nBỏ ra khỏi khu vực mọi thứ không dùng cho công việc đang chạy.' },
    { id: 3, title: 'Andon', topic: 'tpm', body: '# Andon\n\n## Giao kèo\nKhi người vận hành kéo andon thì ai tới và trong bao lâu.' }
  ];
  const idx = buildIndex(notes);
  const hits = search('may dung giua ca thi kiem tra the nao', idx);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].note.id, 1);
});

test('retrieval: an off-corpus question is thin, on-corpus is not', () => {
  const notes = [
    { id: 1, title: 'Máy dừng giữa ca', topic: 'quan-ly-chuyen', body: CRAFT },
    { id: 2, title: 'Andon', topic: 'tpm', body: '# Andon\n\n## Giao kèo\nKhi người vận hành kéo andon thì ai tới, trong bao lâu, và có quyền dừng chuyền không.' },
    { id: 3, title: 'Máy dừng — leo bậc', topic: 'tpm', body: '# Leo bậc\n\n## Ngưỡng thời gian\nMáy dừng thì người vận hành xử lý trong ngưỡng cho phép, quá ngưỡng gọi tổ trưởng, quá tiếp gọi bảo trì.' }
  ];
  const idx = buildIndex(notes);
  const onCorpus = coverage('máy dừng giữa ca kiểm tra thế nào', search('máy dừng giữa ca kiểm tra thế nào', idx), idx);
  const offCorpus = coverage('thủ tục tuyển dụng nhân viên văn phòng và lương thưởng', search('thủ tục tuyển dụng nhân viên văn phòng và lương thưởng', idx), idx);
  assert.equal(onCorpus.verdict, 'ok');
  assert.equal(offCorpus.verdict, 'thin');
});

test('retrieval: coverage needs content-word agreement, not just a score', () => {
  // The real seed corpus, because this rule was written against it: an HR question about
  // hiring scored 12.3 against a note about machine stoppages — five times the old
  // score-only threshold — purely because Vietnamese questions share their common words
  // with everything. The idiomatic words are what the corpus does not have.
  const corpus = readdirSync('seed/corpus')
    .filter((f) => f.endsWith('.md'))
    .map((f, i) => {
      const raw = readFileSync(join('seed/corpus', f), 'utf8');
      const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      return { id: i + 1, title: /^title:\s*(.+)$/m.exec(raw)[1].trim(), topic: /^topic:\s*(.+)$/m.exec(raw)[1].trim(), body };
    });
  const idx = buildIndex(corpus);
  const off = 'thủ tục tuyển dụng nhân viên văn phòng và chính sách lương thưởng';
  const offHits = search(off, idx);
  const offCov = coverage(off, offHits, idx);
  assert.equal(offCov.verdict, 'thin');
  assert.ok(offHits[0].score > 2.2, `a score-only rule would have passed this (top ${offHits[0].score})`);
  assert.match(offCov.why, /trọng số/);

  const on = 'máy dừng giữa ca thì kiểm tra theo thứ tự nào';
  assert.equal(coverage(on, search(on, idx), idx).verdict, 'ok');
});

test('pricing: integer VND, 20% platform take, minimum 30 minutes', () => {
  assert.equal(roundVnd(483333), 480000);
  assert.equal(priceFor(600000, 45), 450000);
  const q = quote(600000, 45);
  assert.deepEqual(q, { minutes: 45, price_vnd: 450000, fee_vnd: 90000, payout_vnd: 360000 });
  assert.equal(PLATFORM_TAKE_RATE, 0.2);
  assert.throws(() => quote(600000, MIN_MINUTES - 1), /tối thiểu/);
  assert.equal(formatVnd(450000), '450.000đ');
  assert.deepEqual(split(1000000), { price_vnd: 1000000, fee_vnd: 200000, payout_vnd: 800000 });
});

test('pricing: the transfer instruction is a real VietQR payload, not a fake success', () => {
  const ins = transferInstruction({ bankBin: '970436', account: '0123456789', amountVnd: 450000, ref: 'B-2026-ABC' });
  assert.equal(ins.amount_vnd, 450000);
  assert.match(ins.qr_url, /img\.vietqr\.io\/image\/970436-0123456789/);
  assert.match(ins.qr_url, /amount=450000/);
  assert.match(ins.qr_url, /addInfo=B-2026-ABC/);
});

test('llm: the prompt forbids outside knowledge and demands citations', () => {
  const { system, user } = buildPrompt({ question: 'máy dừng thì làm gì?', hits: [{ note: { id: 7, title: 'Máy dừng giữa ca', topic: 'quan-ly-chuyen', body: CRAFT } }] });
  assert.match(system, /Chỉ được trả lời bằng nội dung có trong các TRÍCH ĐOẠN/);
  assert.match(system, new RegExp(NO_DATA_MARKER));
  assert.match(user, /\[1\] \(id 7\)/);
});

test('llm: the prompt carries at most three passages, each capped in length', () => {
  const long = { note: { id: 1, title: 'A', topic: 'tpm', body: 'x'.repeat(9000) }, score: 3 };
  const hits = [long, long, long, long, long];
  const { user } = buildPrompt({ question: 'q', hits });
  assert.equal((user.match(/^\[/gm) ?? []).length, 3, 'three passages only');
  assert.ok(user.length < 3 * 1500, 'and each passage is truncated');
});

test('llm: no API key means the extractive mode, clearly labelled', async () => {
  const hits = [{ note: { id: 1, title: 'Máy dừng giữa ca', topic: 'quan-ly-chuyen', body: CRAFT }, score: 3 }];
  const out = await askFromCorpus({ question: 'máy dừng giữa ca kiểm tra thế nào', hits, coverageVerdict: { verdict: 'ok' }, cfg: { enabled: false } });
  assert.equal(out.mode, 'extractive');
  assert.ok(out.citations.includes(1));
  assert.equal(out.coverage, 'ok');
});

test('llm: an API error is reported, never dressed up as a model answer', async () => {
  const hits = [{ note: { id: 1, title: 'Máy dừng giữa ca', topic: 'quan-ly-chuyen', body: CRAFT }, score: 3 }];
  const out = await askFromCorpus({
    question: 'q',
    hits,
    coverageVerdict: { verdict: 'ok' },
    cfg: { enabled: true, base: 'https://example.invalid/v1', model: 'x', key: 'k', timeoutMs: 1000 },
    fetchImpl: async () => ({ ok: false, status: 429 })
  });
  assert.equal(out.mode, 'llm-http-429');
  assert.ok(out.answer.length > 0, 'falls back to a labelled extractive answer');
});

test('llm: a model answer is parsed, citations mapped to note ids', async () => {
  const hits = [
    { note: { id: 11, title: 'A', topic: 'tpm', body: CRAFT }, score: 3 },
    { note: { id: 22, title: 'B', topic: 'tpm', body: CRAFT }, score: 2 }
  ];
  const out = await askFromCorpus({
    question: 'q',
    hits,
    coverageVerdict: { verdict: 'ok' },
    cfg: { enabled: true, base: 'https://x/v1', model: 'm', key: 'k', timeoutMs: 1000 },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"answer":"Làm theo thứ tự [2].","citations":[2],"coverage":"ok","missing":""}\n```' } }] }) })
  });
  assert.equal(out.mode, 'llm');
  assert.equal(out.coverage, 'ok');
  assert.deepEqual(out.citations, [22]);
});

test('llm: the model refusing (marker or thin vote) becomes coverage=thin', async () => {
  const hits = [{ note: { id: 1, title: 'A', topic: 'tpm', body: CRAFT }, score: 3 }];
  const out = await askFromCorpus({
    question: 'q',
    hits,
    coverageVerdict: { verdict: 'ok' },
    cfg: { enabled: true, base: 'https://x/v1', model: 'm', key: 'k', timeoutMs: 1000 },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: `{"answer":"${NO_DATA_MARKER} thiếu ghi chú về an toàn điện","citations":[],"coverage":"thin"}` } }] }) })
  });
  assert.equal(out.coverage, 'thin');
});

test('interview: the script asks for craft, and the draft becomes a structured note', () => {
  assert.ok(SCRIPT.length >= 6);
  assert.ok(SCRIPT.every((q) => q.ask && q.hint));
  assert.ok(SCRIPT.some((q) => /giới hạn/i.test(q.ask)));
  const answers = SCRIPT.map((_, i) => `Trả lời số ${i + 1} với nội dung đủ dài để đọc được trong ghi chú.`);
  const draft = draftNoteFromInterview({ expert: { slug: 'x' }, topic: 'tpm', answers, title: 'Kinh nghiệm: tpm' });
  assert.match(draft.body, /^# Kinh nghiệm: tpm/);
  assert.equal((draft.body.match(/^## /gm) ?? []).length, SCRIPT.length);
  assert.equal(draft.origin, 'interview');
});

test('interview: slugs are ASCII and stable', () => {
  assert.equal(slugify('Máy dừng giữa ca — v2'), 'may-dung-giua-ca-v2');
  assert.equal(slugify(''), 'ghi-chu');
});
