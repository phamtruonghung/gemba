// #44: the strings that decide trust speak the language asked, money reads as money, and the legal pages exist.
// Everything else in the product is still English on purpose; a full translation is a later slice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, insertQuestion, createBookingOnce } from '../src/db.mjs';
import { t, STRINGS } from '../src/i18n.mjs';
import { formatVnd } from '../src/pricing.mjs';

let app, base;
const R = { capacity: 10_000, perMs: 60_000 };

before(async () => {
  app = createApp({
    dbPath: ':memory:', rules: loadRules(),
    config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', dataDir: 'data', adminToken: 'tok', bankBin: '970436', bankAccount: '0123456789',
      limits: { askIp: R, askIdentity: R, signinIp: R, signinEmail: R, signupIp: R }, llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 } }
  });
  upsertExpert(app.db, { slug: 'hung-qa', name: 'Hung', headline: 'x', topics: ['tpm'], years: 5, rate_vnd: 800000, token: 'tok-h' });
  app.rebuildIndex();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());
const page = async (path) => (await fetch(base + path)).text();
const thin = (lang, text) => insertQuestion(app.db, { asker: '', contact: '', topic: 'tpm', text, ai_answer: 'INSUFFICIENT_DATA', ai_coverage: 'thin', ai_mode: 'extractive', lang }).ref;

test('every string has both languages, and t() fills placeholders', () => {
  for (const [key, v] of Object.entries(STRINGS)) assert.ok(v.vi && v.en, key);
  assert.equal(t('cost_session_value', 'vi', { minutes: 45, rate: '800.000 ₫' }), '45 phút, 800.000 ₫ một giờ');
  assert.equal(t('cost_session_value', 'en', { minutes: 45, rate: 'x' }), '45 minutes at x an hour');
  assert.equal(t('ask_submit', 'fr'), 'Ask the library', 'an unknown language is English');
  assert.throws(() => t('nope'), /no string called/);
});

test('a Vietnamese question page refuses, offers a practitioner, and routes in Vietnamese', async () => {
  const ref = thin('vi', 'Máy dập hay dừng giữa ca, tôi nên kiểm tra gì?');
  const html = await page(`/q/${ref}`);
  assert.ok(html.includes('Thư viện chưa trả lời được câu này'));
  assert.ok(html.includes('Hỏi một chuyên gia'));
  assert.ok(html.includes('Email hoặc số điện thoại, để câu trả lời đến được với bạn'));
  assert.ok(html.includes('trong vòng 48 giờ'));
  assert.ok(html.includes('<section class="tight" lang="vi">'));
  assert.ok(!html.includes('Ask a practitioner'), 'no English beside it on a Vietnamese question');
  assert.match(html, /<html lang="en"/, 'the root language is left alone: the text-size preference matches it literally');

  await fetch(`${base}/q/${ref}/ask-expert`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'contact=a%40b.vn', redirect: 'manual' });
  assert.ok((await page(`/q/${ref}`)).includes('Đã gửi tới 1 chuyên gia phụ trách chủ đề này'));
});

test('an English question page is exactly as it was', async () => {
  const ref = thin('en', 'Something off-corpus about presses');
  const html = await page(`/q/${ref}`);
  assert.ok(html.includes('The library cannot cover this one yet'));
  assert.ok(html.includes('Ask a practitioner'));
  assert.ok(!html.includes('Hỏi một chuyên gia'));
});

test('a Vietnamese answer gets a Vietnamese header; the offline extract says it is quoted English', async () => {
  const ref = insertQuestion(app.db, { topic: 'tpm', text: 'Khi nào thay khuôn?', ai_answer: '- Replace the die. [1]', ai_citations: [], ai_coverage: 'ok', ai_mode: 'extractive', lang: 'vi' }).ref;
  const html = await page(`/q/${ref}`);
  assert.ok(html.includes('Câu trả lời từ thư viện ghi chú'));
  assert.ok(html.includes('Trích nguyên văn từ ghi chú (tiếng Anh)'));
  const llm = insertQuestion(app.db, { topic: 'tpm', text: 'Khi nào thay khuôn?', ai_answer: 'Thay khuôn khi ba via vượt vạch [1].', ai_citations: [], ai_coverage: 'ok', ai_mode: 'llm', lang: 'vi' }).ref;
  const h2 = await page(`/q/${llm}`);
  assert.ok(h2.includes('<div class="answer" lang="vi">Thay khuôn'));
  assert.ok(!h2.includes('Trích nguyên văn'));
});

test('a question is stored with the language it was asked in', async () => {
  const post = (q) => fetch(`${base}/ask`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q }) });
  const vi = (await post('Khi nào tôi phải thay khuôn dập?')).headers.get('location').split('/').pop();
  const en = (await post('When do I replace the die on a press?')).headers.get('location').split('/').pop();
  assert.equal(app.db.prepare('select lang from questions where ref = ?').get(vi).lang, 'vi');
  assert.equal(app.db.prepare('select lang from questions where ref = ?').get(en).lang, 'en');
});

test('the booking page speaks the language of the question it came from, with money as 520.000 ₫', async () => {
  const qref = thin('vi', 'Khi nào tôi phải thay khuôn dập?');
  const res = await fetch(`${base}/q/${qref}/book`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ expert: 'hung-qa', minutes: '45', starts_at: '2031-06-02 09:00', asker: 'Lan', contact: 'lan@plant.vn' }) });
  const loc = res.headers.get('location');
  assert.equal(app.db.prepare('select lang from bookings where ref = ?').get(loc.split('/').pop()).lang, 'vi');
  const html = await page(loc);
  assert.ok(html.includes('Chi phí'));
  assert.ok(html.includes('Tổng cộng'));
  assert.ok(html.includes('Chờ chuyên gia xác nhận giờ hẹn'));
  assert.ok(html.includes(formatVnd(600000)));
  assert.ok(html.includes('600.000 ₫') && !/600,000/.test(html));
  await fetch(`${base}/c/tok-h/booking`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ref: loc.split('/').pop(), action: 'confirm', meeting_url: 'https://meet.example.com/a' }) });
  const pay = await page(loc);
  assert.ok(pay.includes('Cách thanh toán'));
  assert.ok(pay.includes('Ghi đúng mã này vào nội dung chuyển khoản'));
  assert.ok(pay.includes('Tôi đã chuyển tiền'));
  assert.ok(pay.includes('Đã xác nhận giờ hẹn'));
});

test('an English booking is unchanged', async () => {
  const made = createBookingOnce(app.db, { expert_id: 1, expert_name: 'Hung', asker: 'A', contact: 'a@b.vn', topic: 'tpm', agenda: 'press', starts_at: '2031-07-02T02:00:00.000Z', minutes: 45, price_vnd: 600000, fee_vnd: 120000, payout_vnd: 480000 });
  const html = await page(`/b/${made.booking.ref}`);
  assert.ok(html.includes('What it costs') && html.includes('Waiting for the practitioner to confirm the time'));
});

test('pages with no question show Vietnamese first and the English beneath: ask box, sign in, error', async () => {
  const home = await page('/');
  for (const s of ['Câu hỏi của bạn về sản xuất', 'Your question about production', 'Hỏi thư viện', 'Ask the library']) assert.ok(home.includes(s), s);
  assert.ok(home.includes('<span lang="vi">Hỏi thư viện</span><span lang="en" style="font-weight:400"> · Ask the library</span>'), 'Vietnamese comes first, English after it');
  const signin = await page('/signin');
  assert.ok(signin.includes('<span lang="vi">Đăng nhập</span>') && signin.includes('>Sign in</span>'));
  const missing = await fetch(`${base}/q/NOPE`);
  const err = await missing.text();
  assert.equal(missing.status, 404);
  assert.ok(err.includes('Không tìm thấy trang này') && err.includes('No such question.'));
  assert.ok(err.includes('Không có gì được đoán mò ở đây') && err.includes('Nothing is guessed here either'));
});

test('terms, privacy and complaints are Vietnamese, marked as a draft for counsel, and linked from the footer', async () => {
  for (const path of ['/dieu-khoan', '/bao-mat', '/khieu-nai']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.ok(html.includes('BẢN NHÁP — chưa được luật sư xem xét'), path);
    assert.ok(html.includes('DRAFT — not yet reviewed by counsel'), path);
    assert.ok(html.includes('<article lang="vi"'), path);
    assert.ok(html.includes('[TÊN DOANH NGHIỆP]') && html.includes('[MST]') && html.includes('[ĐỊA CHỈ]'), `${path} uses placeholders, not an invented company`);
    assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1);
  }
  assert.ok((await page('/bao-mat')).includes('cookie'));
  assert.ok((await page('/dieu-khoan')).includes('không giữ tiền'));
  const home = await page('/');
  for (const path of ['/dieu-khoan', '/bao-mat', '/khieu-nai']) assert.ok(home.includes(`href="${path}"`), `the footer links ${path}`);
});

test('formatVnd reads as money in Vietnam', () => {
  assert.equal(formatVnd(520000), '520.000 ₫');
});
