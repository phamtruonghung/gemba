// End-to-end test over real HTTP: the whole ladder, walked as a customer would.
// No API key is configured here, so the AI tier runs in its labelled extractive mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../src/server.mjs';
import { loadRules } from '../src/gate.mjs';
import { upsertExpert, upsertNote } from '../src/db.mjs';

const ADMIN = 'test-admin-token';
const EXPERT_TOKEN = 'tok-hung-test';

let app;
let base;

function noteFromCorpus(file) {
  const raw = readFileSync(join('seed/corpus', file), 'utf8');
  const title = /^title:\s*(.+)$/m.exec(raw)[1].trim();
  const topic = /^topic:\s*(.+)$/m.exec(raw)[1].trim();
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return { title, topic, body, slug: file.replace(/\.md$/, '') };
}

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    rules: loadRules(),
    config: {
      port: 0,
      host: '127.0.0.1',
      dbPath: ':memory:',
      dataDir: 'data',
      adminToken: ADMIN,
      bankBin: '970436',
      bankAccount: '0123456789',
      llm: { enabled: false, base: '', model: '', key: '', timeoutMs: 1000 }
    }
  });
  const expertId = upsertExpert(app.db, {
    slug: 'hung-qa',
    name: 'Anh Hùng',
    headline: 'Giám sát sản xuất (hồ sơ mẫu)',
    topics: ['tpm', 'quan-ly-chuyen', 'cai-tien', 'an-toan'],
    years: 20,
    rate_vnd: 800000,
    token: EXPERT_TOKEN
  });
  const lanId = upsertExpert(app.db, {
    slug: 'lan-lap-rap',
    name: 'Chị Lan',
    headline: 'Trưởng ca lắp ráp (hồ sơ mẫu)',
    topics: ['chat-luong', 'an-toan'],
    years: 12,
    rate_vnd: 600000,
    token: 'tok-lan-test'
  });
  let n = 0;
  for (const file of ['demo-dung-may-giua-ca.md', 'demo-andon-bat-thuong.md', 'demo-5s-hien-truong.md', 'demo-tieu-chuan-mot-diem.md']) {
    const note = noteFromCorpus(file);
    n += 1;
    upsertNote(app.db, {
      expert_id: note.topic === 'chat-luong' ? lanId : expertId,
      slug: `seed-${n}-${note.slug}`,
      title: note.title,
      topic: note.topic,
      body: note.body,
      status: 'published',
      gate: { verdict: 'clean', ok: true, needs_attestation: false, findings: [] },
      origin: 'demo'
    });
  }
  app.rebuildIndex();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.server.close());

async function ask(question, extra = {}) {
  const res = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, ...extra })
  });
  return { res, body: await res.json() };
}

// redirect: 'manual' — fetch follows 303 by default, which would hide the redirect the
// platform uses to move the browser to the question / booking / note page.
function post(path, data = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data)
  });
}

test('healthz reports the corpus size and the AI tier honestly', async () => {
  const res = await fetch(`${base}/healthz`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.notes, 4);
  assert.equal(body.llm, 'none');
});

test('ask: an on-corpus question is answered with citations to real notes', async () => {
  const { res, body } = await ask('may dung giua ca thi kiem tra theo thu tu nao');
  assert.equal(res.status, 200);
  assert.equal(body.coverage, 'ok');
  assert.ok(body.citations.length >= 1);
  assert.equal(body.hits[0].slug, 'seed-1-demo-dung-may-giua-ca');
  const note = await fetch(`${base}/api/question/${body.ref}`);
  const stored = await note.json();
  assert.equal(stored.ai_coverage, 'ok');
  assert.equal(stored.status, 'open');
});

test('ask: an off-corpus question says so instead of guessing', async () => {
  const { body } = await ask('thủ tục tuyển dụng nhân viên văn phòng và chính sách lương thưởng');
  assert.equal(body.coverage, 'thin');
  assert.match(body.answer, /THIEU_DU_LIEU/);
});

test('the full ladder: ask → escalate → a practitioner answers', async () => {
  const { body: asked } = await ask('quy định về hợp đồng lao động thời vụ ngoài nhà máy', { asker: 'Khách thử', contact: 'thu@example.com' });
  assert.equal(asked.coverage, 'thin');

  const esc = await post(`/q/${asked.ref}/hoi-chuyen-gia`, { asker: 'Khách thử', contact: 'thu@example.com' });
  assert.equal(esc.status, 303);
  const routed = await (await fetch(`${base}/api/question/${asked.ref}`)).json();
  assert.equal(routed.status, 'routed');
  assert.ok(routed.due_at, 'a reply deadline is set');

  const workspace = await fetch(`${base}/c/${EXPERT_TOKEN}`);
  const html = await workspace.text();
  assert.equal(workspace.status, 200);
  assert.match(html, new RegExp(asked.ref), 'the question reaches the expert workspace');

  const answered = await post(`/c/${EXPERT_TOKEN}/tra-loi`, { ref: asked.ref, body: 'Hợp đồng thời vụ theo luật lao động hiện hành: nêu rõ thời hạn và phụ lục.' });
  assert.equal(answered.status, 303);
  const after = await (await fetch(`${base}/api/question/${asked.ref}`)).json();
  assert.equal(after.status, 'answered');
  assert.equal(after.answers.length, 1);
  assert.match(after.answers[0].body, /luật lao động/);

  const page = await (await fetch(`${base}/q/${asked.ref}`)).text();
  assert.match(page, /Trả lời từ Anh Hùng/);
});

test('gate at the door: a note with an order number is refused, a clean note publishes', async () => {
  const leaky = await post(`/c/${EXPERT_TOKEN}/ghi-chu`, {
    title: 'Kinh nghiệm xử lý lô hàng',
    topic: 'chat-luong',
    attested: '1',
    body: `# Kinh nghiệm\n\n## Bối cảnh\nLô theo PO 45123 bị lỗi và đơn giá nhập cao hơn kế hoạch nên phải xử lý trong ca.\n\n## Cách làm\nKiểm tra theo thứ tự và ghi lại hiện tượng trước khi sửa bất cứ thứ gì.`
  });
  assert.equal(leaky.status, 422);
  assert.match(await leaky.text(), /document/);

  const clean = await post(`/c/${EXPERT_TOKEN}/ghi-chu`, {
    title: 'Kiểm tra cảm biến trạm cuối theo thứ tự',
    topic: 'tpm',
    body: `# Kiểm tra cảm biến trạm cuối theo thứ tự\n\n## Thứ tự\nĐầu tiên xem đèn báo trên trạm, sau đó kiểm tra vật tư có đúng quy cách không, cuối cùng mới đo cảm biến.\n\n## Vì sao theo thứ tự này\nSai vật tư bị nhầm thành lỗi cảm biến nhiều hơn lỗi cảm biến thật, nên kiểm tra vật tư trước sẽ tiết kiệm thời gian dừng máy.\n\n## Ghi lại\nGhi hiện tượng vào sổ tay của ca trực để người sau đọc được, không ghi số liệu sản lượng của nhà máy.`
  });
  assert.equal(clean.status, 303);
  const published = await (await fetch(`${base}/kho`)).text();
  assert.match(published, /Kiểm tra cảm biến trạm cuối theo thứ tự/);
});

test('the AI-moderated interview turns eight answers into a published note', async () => {
  const start = await fetch(`${base}/c/${EXPERT_TOKEN}/phong-van`);
  const html = await start.text();
  assert.equal(start.status, 200);
  assert.match(html, /Câu 1\/8/);

  const idMatch = /name="id" value="(\d+)"/.exec(html);
  assert.ok(idMatch, 'the interview session id is in the form');
  const id = idMatch[1];

  const answers = [
    'Tôi làm nghề này hai mươi năm, phụ trách khu vực lắp ráp và bảo trì cơ bản.',
    'Vấn đề lặp lại nhiều nhất là vật tư sai quy cách ở trạm cuối làm dừng chuyền.',
    'Dấu hiệu đầu tiên là đèn báo trạm cuối nhấp nháy và người kiểm hàng cuối cùng phát hiện ra.',
    'Nguyên nhân gốc thường là nhập sai lô vật tư; kiểm chứng bằng cách đối chiếu bao bì với phiếu giao.',
    'Cách xử lý: dừng trạm, cách ly vật tư nghi ngờ, báo tổ trưởng, ghi lại hiện tượng rồi mới chạy lại.',
    'Người mới hay đổi cảm biến trước khi kiểm vật tư, nên mất thời gian mà lỗi vẫn còn.',
    'Tiêu chuẩn là kiểm vật tư trước cảm biến, ai cũng làm theo đúng thứ tự đó.',
    'Cách này dùng được cho chuyền lắp ráp nhiều trạm, không dùng khi vật tư do khách cấp và không được mở bao bì.'
  ];
  let last;
  for (let i = 0; i < answers.length; i += 1) {
    last = await post(`/c/${EXPERT_TOKEN}/phong-van`, { id, answer: answers[i] });
    if (i < answers.length - 1) assert.equal(last.status, 303);
  }
  const done = await last.text();
  assert.equal(last.status, 200);
  assert.match(done, /Đã tạo ghi chú/);

  const corpus = await (await fetch(`${base}/kho`)).text();
  assert.match(corpus, /Kinh nghiệm: Vấn đề lặp lại nhiều nhất/, 'the interview note is in the corpus, titled after the problem');
});

test('money: a booking is priced in VND, split, and never marked paid by the system', async () => {
  const res = await post('/dat-lich', {
    expert: 'hung-qa',
    minutes: '60',
    starts_at: '2026-10-20 20:00',
    asker: 'Khách thử',
    contact: 'thu@example.com',
    topic: 'tpm',
    agenda: 'Chuyền hay dừng ở trạm cuối, cần lộ trình kiểm tra.'
  });
  assert.equal(res.status, 303);
  const location = res.headers.get('location');
  const ref = location.split('/').pop();

  const page = await (await fetch(`${base}${location}`)).text();
  assert.match(page, /800\.000đ/, 'one hour at the expert rate');
  assert.match(page, /640\.000đ/, 'expert payout after the 20% platform fee');
  assert.match(page, /img\.vietqr\.io/);
  assert.match(page, /B-/, 'the transfer code is the booking ref');
  assert.match(page, /chờ hướng dẫn chuyển khoản/, 'status shown in Vietnamese');

  const claim = await post(`/b/${ref}/da-chuyen`);
  assert.equal(claim.status, 303);
  const claimed = await (await fetch(`${base}/b/${ref}`)).text();
  assert.match(claimed, /khách báo đã chuyển khoản/);

  // The platform operator confirms against the bank statement; the system alone never does.
  const adminBefore = await (await fetch(`${base}/qt/${ADMIN}`)).text();
  assert.match(adminBefore, new RegExp(ref));
  const confirm = await post(`/qt/${ADMIN}/xac-nhan`, { ref });
  assert.equal(confirm.status, 303);
  assert.match(await (await fetch(`${base}/b/${ref}`)).text(), /đã nhận tiền/);

  const done = await post(`/qt/${ADMIN}/hoan-tat`, { ref });
  assert.equal(done.status, 303);
  assert.match(await (await fetch(`${base}/b/${ref}`)).text(), /đã xong buổi/);
});

test('the admin surface is not reachable without the token', async () => {
  const res = await fetch(`${base}/qt/wrong-token`);
  assert.equal(res.status, 404);
});

test('the expert workspace is not reachable without the token', async () => {
  const res = await fetch(`${base}/c/wrong-token`);
  assert.equal(res.status, 404);
});

test('the home page states the ladder and the demo status plainly', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Trả lời từ kho ghi chú|Hỏi kho kiến thức/);
  assert.match(html, /Bản thử nghiệm/);
  const how = await (await fetch(`${base}/cach-lam`)).text();
  assert.match(how, /Cổng kiểm duyệt/);
  assert.match(how, /THIEU_DU_LIEU/);
});

test('no English state word reaches a Vietnamese page', async () => {
  const pages = await Promise.all(['/', '/kho', '/chuyen-gia', `/c/${EXPERT_TOKEN}`, `/qt/${ADMIN}`].map((p) => fetch(`${base}${p}`).then((r) => r.text())));
  for (const [i, html] of pages.entries()) {
    const body = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '');
    for (const word of ['>open<', '>routed<', '>answered<', '>published<', '>blocked<', '>requested<', '>awaiting_payment<', '>paid<', '>completed<']) {
      assert.ok(!body.includes(word), `page ${i} leaks the English state ${word}`);
    }
  }
});
