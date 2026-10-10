// src/views.mjs — server-rendered HTML, Vietnamese-first. No build step, no framework.

import { formatVnd, MIN_MINUTES } from './pricing.mjs';
import { ATTESTATION_TEXT } from './gate.mjs';
import { SCRIPT } from './interview.mjs';

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const TOPICS = {
  tpm: 'TPM & thiết bị',
  'quan-ly-chuyen': 'Quản lý chuyền / ca',
  'cai-tien': 'Cải tiến & kaizen',
  'chat-luong': 'Chất lượng',
  'an-toan': 'An toàn & 5S',
  'cong-viec': 'Quản lý công việc',
  'chien-luoc': 'Chiến lược & mục tiêu',
  khac: 'Khác'
};

export const topicLabel = (t) => TOPICS[t] ?? t;
export const topicList = () => Object.entries(TOPICS);

// The UI is Vietnamese; the state machine is not. Every status shown to a person goes
// through here — an English status word in an all-Vietnamese page reads as a bug.
const QUESTION_STATUS = { open: 'chưa hỏi chuyên gia', routed: 'đã chuyển chuyên gia', answered: 'đã có trả lời', closed: 'đã đóng' };
const BOOKING_STATUS = { requested: 'chờ hướng dẫn chuyển khoản', awaiting_payment: 'khách báo đã chuyển khoản', paid: 'đã nhận tiền', completed: 'đã xong buổi', cancelled: 'đã huỷ' };
const NOTE_STATUS = { published: 'đã xuất bản', blocked: 'bị cổng chặn', draft: 'bản nháp' };

export const questionStatus = (s) => QUESTION_STATUS[s] ?? s;
export const bookingStatus = (s) => BOOKING_STATUS[s] ?? s;
export const noteStatus = (s) => NOTE_STATUS[s] ?? s;

const CSS = `
:root{--ink:#14181f;--muted:#5b6472;--line:#e3e6ec;--bg:#f7f8fa;--acc:#0f5c4a;--acc2:#f0a322;--warn:#8a4b00;--bad:#a11c1c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 "Segoe UI",Roboto,system-ui,-apple-system,sans-serif}
a{color:var(--acc)}a:hover{opacity:.8}
header{background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;display:flex;gap:18px;align-items:baseline;flex-wrap:wrap}
header .brand{font-weight:700;font-size:20px;letter-spacing:-.3px}
header .brand span{color:var(--acc2)}
header nav{display:flex;gap:14px;flex-wrap:wrap;font-size:14px}
main{max-width:940px;margin:0 auto;padding:24px 20px 80px}
h1{font-size:26px;letter-spacing:-.4px;margin:0 0 8px}
h2{font-size:19px;margin:28px 0 10px}
h3{font-size:16px;margin:18px 0 6px}
p,li{font-size:15.5px}
.lead{color:var(--muted);margin:0 0 20px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px;margin:14px 0;display:flex;flex-direction:column}
.card > .push{margin-top:auto}
.grid .card > form,.grid .card > p:last-child{margin-top:auto}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input,textarea,select{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit;background:#fff}
textarea{min-height:110px;resize:vertical}
button,.btn{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:11px 18px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.btn.alt{background:#fff;color:var(--acc);border:1px solid var(--acc)}
.tag{display:inline-block;background:#eef2f0;color:var(--acc);border-radius:999px;padding:2px 10px;font-size:12.5px;margin:0 6px 6px 0}
.tag.warn{background:#fdf3e2;color:var(--warn)}
.tag.bad{background:#fdecec;color:var(--bad)}
.muted{color:var(--muted);font-size:14px}
.answer{white-space:pre-wrap;font-size:15.5px}
.cite{background:#eef2f0;border-radius:6px;padding:1px 6px;font-size:13px;font-weight:600;color:var(--acc);text-decoration:none}
table{width:100%;border-collapse:collapse;font-size:14.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:13px}
.notice{border-left:4px solid var(--acc2);background:#fffdf7;padding:12px 14px;border-radius:0 8px 8px 0;margin:14px 0}
.notice.bad{border-color:var(--bad);background:#fdf7f7}
footer{border-top:1px solid var(--line);margin-top:40px;padding:18px 20px;color:var(--muted);font-size:13.5px}
code{background:#eef0f4;padding:1px 5px;border-radius:4px;font-size:13.5px}
ul.plain{list-style:none;padding:0}
ul.plain li{padding:8px 0;border-bottom:1px solid var(--line)}
`;

export function layout({ title, body, nav = true, footer = '' }) {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Xưởng</title><style>${CSS}</style></head>
<body>
<header>
  <div class="brand">Xưởng<span>.</span></div>
  ${nav ? `<nav>
    <a href="/">Hỏi</a>
    <a href="/kho">Kho kiến thức</a>
    <a href="/chuyen-gia">Chuyên gia &amp; đặt lịch</a>
    <a href="/cach-lam">Cách nền tảng này làm việc</a>
  </nav>` : ''}
</header>
<main>${body}</main>
<footer>${footer || 'Xưởng — nền tảng kiến thức sản xuất, làm tại Việt Nam. Bản thử nghiệm (v0.1): dữ liệu mẫu, chưa có giao dịch thật.'}</footer>
</body></html>`;
}

function askForm({ q = '', action = '/hoi' } = {}) {
  return `<form method="post" action="${action}" class="card">
  <label for="q">Câu hỏi của anh/chị về sản xuất</label>
  <textarea id="q" name="q" placeholder="Ví dụ: máy ép hay bị dừng đột ngột giữa ca, nên kiểm tra theo thứ tự nào?">${esc(q)}</textarea>
  <div class="grid">
    <div><label for="plant_type">Loại nhà máy (không bắt buộc)</label>
      <input id="plant_type" name="plant_type" placeholder="lắp ráp điện tử, ép nhựa, may mặc, thực phẩm..."></div>
    <div><label for="asker">Tên anh/chị (không bắt buộc)</label><input id="asker" name="asker" placeholder="Hùng"></div>
  </div>
  <p><button type="submit">Hỏi kho kiến thức</button> <span class="muted">Trả lời có trích dẫn từ ghi chú của người trong nghề. Nếu kho chưa đủ, hệ thống nói thẳng và cho anh/chị hỏi thẳng chuyên gia.</span></p>
</form>`;
}

export function home({ stats, experts, notes, questions }) {
  const chips = topicList()
    .map(([slug, label]) => `<a class="tag" href="/kho?topic=${encodeURIComponent(slug)}">${esc(label)}</a>`)
    .join('');
  const expertCards = experts
    .slice(0, 3)
    .map(
      (e) => `<div class="card">
    <h3>${esc(e.name)}</h3>
    <p class="muted">${esc(e.headline)}</p>
    <p>${e.topics.map((t) => `<span class="tag">${esc(topicLabel(t))}</span>`).join('')}</p>
    <p><strong>${formatVnd(e.rate_vnd)}</strong> / giờ · tối thiểu ${MIN_MINUTES} phút</p>
    <a class="btn alt" href="/chuyen-gia#${esc(e.slug)}">Đặt tư vấn 1:1</a>
  </div>`
    )
    .join('');
  const recent = questions
    .slice(0, 6)
    .map((q) => `<li><a href="/q/${esc(q.ref)}">${esc(q.text.slice(0, 90))}${q.text.length > 90 ? '…' : ''}</a> <span class="tag ${q.ai_coverage === 'thin' ? 'warn' : ''}">${q.ai_coverage === 'thin' ? 'kho chưa đủ' : 'đã trả lời'}</span> <span class="muted">${esc(topicLabel(q.topic))} · ${esc(questionStatus(q.status))}</span></li>`)
    .join('');
  return layout({
    title: 'Hỏi người trong xưởng',
    body: `
<h1>Hỏi người trong xưởng</h1>
<p class="lead">Kiến thức sản xuất thật — từ người đã đứng chuyền, không phải từ bài giảng. Hỏi kho ghi chú; nếu kho chưa đủ, câu hỏi được chuyển thẳng tới người làm nghề, và anh/chị có thể đặt một buổi 1:1.</p>
${askForm()}
<div class="card">
  <h2 style="margin-top:0">Nền tảng đang có gì</h2>
  <p>${stats.notes} ghi chú đã xuất bản · ${stats.experts} hồ sơ chuyên gia · ${stats.questions} câu hỏi đã nhận · ${stats.thin} câu mà kho chưa đủ để trả lời (những câu đó được đẩy cho người).</p>
  <h3>Chủ đề</h3><p>${chips}</p>
</div>
<h2>Chuyên gia</h2>
<div class="grid">${expertCards}</div>
<p><a href="/chuyen-gia">Xem tất cả chuyên gia và mức phí →</a></p>
${recent ? `<h2>Câu hỏi gần đây</h2><ul class="plain">${recent}</ul>` : ''}
${notes.length ? `<h2>Ghi chú mới xuất bản</h2><ul class="plain">${notes.slice(0, 5).map((n) => `<li><a href="/ghi-chu/${esc(n.slug)}">${esc(n.title)}</a> <span class="muted">— ${esc(topicLabel(n.topic))}</span></li>`).join('')}</ul>` : ''}
`
  });
}

export function questionPage({ q, aiCitations, answers, experts, routedNames = [], bankConfigured }) {
  const cov = q.ai_coverage === 'thin';
  const cites = aiCitations
    .map((n) => `<a class="cite" href="/ghi-chu/${esc(n.slug)}" title="${esc(n.title)}">[${n.id}] ${esc(n.title.slice(0, 40))}</a>`)
    .join(' ');
  const answerBlocks = answers
    .map((a) => `<div class="card"><h3>Trả lời từ ${esc(a.expert_name ?? 'chuyên gia')}</h3><p class="muted">${esc(a.expert_headline ?? '')} · ${esc(a.created_at.slice(0, 10))}</p><div class="answer">${esc(a.body)}</div></div>`)
    .join('');
  const expertOptions = experts
    .map((e) => `<option value="${esc(e.slug)}">${esc(e.name)} — ${formatVnd(e.rate_vnd)}/giờ (${e.topics.map(topicLabel).map(esc).join(', ')})</option>`)
    .join('');
  return layout({
    title: `Câu hỏi ${q.ref}`,
    body: `
<h1>Câu hỏi <code>${esc(q.ref)}</code></h1>
<p class="muted">${esc(topicLabel(q.topic))}${q.plant_type ? ` · ${esc(q.plant_type)}` : ''} · trạng thái: <strong>${esc(questionStatus(q.status))}</strong>${q.due_at && q.status === 'routed' ? ` · chuyên gia trả lời trước ${esc(q.due_at.slice(0, 10))}` : ''}</p>
<div class="card">
  <p class="muted">Câu hỏi</p>
  <div class="answer">${esc(q.text)}</div>
</div>
<div class="card">
  <h2 style="margin-top:0">Trả lời từ kho ghi chú ${cov ? '<span class="tag warn">kho chưa đủ</span>' : '<span class="tag">có trích dẫn</span>'}</h2>
  <div class="answer">${esc(q.ai_answer || '(chưa có)')}</div>
  ${cites ? `<p style="margin-top:14px">Nguồn: ${cites}</p>` : ''}
  <p class="muted">Cách tạo: ${esc(q.ai_mode || 'không rõ')}${q.ai_mode === 'extractive' ? ' (chưa cấu hình API model — hệ thống trích đoạn nguyên văn, không tự diễn giải)' : ''}</p>
</div>
${answerBlocks}
${q.status === 'open' || q.status === 'routed'
      ? `<div class="card">
  <h2 style="margin-top:0">${q.status === 'routed' ? 'Đang chờ chuyên gia' : 'Chưa hài lòng? Hỏi thẳng người làm nghề'}</h2>
  ${q.status === 'routed'
        ? `<p>Đã chuyển tới ${routedNames.length || 1} chuyên gia phụ trách chủ đề này (${esc(routedNames.join(', ') || 'chuyên gia phụ trách')}). Câu trả lời sẽ hiện ngay trên trang này.</p>`
        : `<form method="post" action="/q/${esc(q.ref)}/hoi-chuyen-gia">
      <p class="muted">Miễn phí. Câu hỏi được gửi tới chuyên gia phụ trách chủ đề “${esc(topicLabel(q.topic))}”, hạn trả lời 48 giờ.</p>
      <div class="grid">
        <div><label for="asker">Tên anh/chị</label><input id="asker" name="asker" value="${esc(q.asker)}"></div>
        <div><label for="contact">Email hoặc số Zalo để nhận trả lời</label><input id="contact" name="contact" value="${esc(q.contact)}" placeholder="…@gmail.com"></div>
      </div>
      <p><button type="submit">Gửi tới chuyên gia</button></p>
    </form>`}
</div>`
      : ''}
<div class="card">
  <h2 style="margin-top:0">Đặt tư vấn 1:1</h2>
  <p class="muted">Buổi online, có tính phí, thanh toán bằng chuyển khoản. Nền tảng giữ ${'20'}% (bản thử nghiệm có thể điều chỉnh theo từng chuyên gia).</p>
  ${experts.length ? `<form method="post" action="/q/${esc(q.ref)}/dat-lich">
    <div class="grid">
      <div><label for="expert">Chuyên gia</label><select id="expert" name="expert">${expertOptions}</select></div>
      <div><label for="minutes">Thời lượng</label><select id="minutes" name="minutes">
        <option value="30">30 phút</option><option value="45" selected>45 phút</option><option value="60">60 phút</option><option value="90">90 phút</option></select></div>
      <div><label for="starts_at">Thời gian mong muốn</label><input id="starts_at" name="starts_at" placeholder="2026-10-15 20:00" required></div>
      <div><label for="contact">Liên hệ nhận link họp</label><input id="contact" name="contact" value="${esc(q.contact)}" required></div>
    </div>
    <label for="agenda">Vấn đề muốn giải quyết trong buổi</label>
    <textarea id="agenda" name="agenda">${esc(q.text.slice(0, 300))}</textarea>
    <p><button type="submit">Tạo đơn đặt lịch</button> <span class="muted">${bankConfigured ? 'Sẽ hiện hướng dẫn chuyển khoản và mã đơn.' : 'Tài khoản nhận tiền chưa được cấu hình — đơn sẽ ở trạng thái chờ, không có hướng dẫn chuyển khoản.'}</span></p>
  </form>` : '<p class="muted">Chưa có chuyên gia nào phụ trách chủ đề này.</p>'}
</div>
`
  });
}

export function bookingPage({ b, instruction, bankConfigured }) {
  const steps = [
    ['requested', 'Đã tạo đơn — chờ hướng dẫn chuyển khoản'],
    ['awaiting_payment', 'Khách báo đã chuyển khoản — nền tảng kiểm tra'],
    ['paid', 'Đã nhận tiền — chốt lịch, gửi link họp'],
    ['completed', 'Buổi tư vấn đã xong']
  ];
  const idx = steps.findIndex(([s]) => s === b.status);
  return layout({
    title: `Đơn ${b.ref}`,
    body: `
<h1>Đơn đặt lịch <code>${esc(b.ref)}</code></h1>
<table>
  <tr><th>Chuyên gia</th><td>${esc(b.expert_name)} — ${esc(b.expert_headline ?? '')}</td></tr>
  <tr><th>Thời gian</th><td>${esc(b.starts_at)} · ${b.minutes} phút</td></tr>
  <tr><th>Khách</th><td>${esc(b.asker)} · ${esc(b.contact)}</td></tr>
  <tr><th>Nội dung</th><td>${esc(b.agenda || b.topic)}</td></tr>
  <tr><th>Giá</th><td><strong>${formatVnd(b.price_vnd)}</strong></td></tr>
  <tr><th>Nền tảng giữ</th><td>${formatVnd(b.fee_vnd)} · chuyên gia nhận ${formatVnd(b.payout_vnd)}</td></tr>
  <tr><th>Trạng thái</th><td><strong>${esc(bookingStatus(b.status))}</strong></td></tr>
</table>
${instruction
      ? `<div class="card">
  <h3>Chuyển khoản</h3>
  <p>Số tiền <strong>${formatVnd(instruction.amount_vnd)}</strong> — nội dung chuyển khoản ghi đúng mã: <code>${esc(instruction.ref)}</code></p>
  <p class="muted">Ngân hàng thụ hưởng: BIN ${esc(instruction.bank_bin)} · số tài khoản ${esc(instruction.account)}</p>
  <p><img src="${esc(instruction.qr_url)}" alt="VietQR ${esc(instruction.ref)}" style="max-width:260px;border:1px solid var(--line);border-radius:8px"></p>
  ${b.status === 'requested' ? `<form method="post" action="/b/${esc(b.ref)}/da-chuyen"><p><button type="submit">Tôi đã chuyển khoản</button></p></form>` : ''}
</div>`
      : `<div class="notice">Chưa cấu hình tài khoản nhận tiền (<code>XUONG_BANK_BIN</code>, <code>XUONG_BANK_ACCOUNT</code>). Nền tảng không hiển thị QR giả và không tự nhận là đã thu tiền.</div>`}
<div class="card">
  <h3>Quy trình</h3>
  <ol>${steps.map(([s, label], i) => `<li>${i === idx ? '<strong>' : ''}${esc(label)}${i === idx ? '</strong> — đang ở đây' : ''}</li>`).join('')}</ol>
  <p class="muted">Tiền chỉ được coi là đã nhận khi người vận hành đối chiếu sao kê và xác nhận trong trang quản trị. Hệ thống không tự đánh dấu đã thanh toán.</p>
</div>
`
  });
}

export function corpusPage({ notes, topic, topics }) {
  const chips = topics
    .map(([slug, label]) => `<a class="tag${slug === topic ? ' warn' : ''}" href="/kho?topic=${encodeURIComponent(slug)}">${esc(label)}</a>`)
    .join('');
  const rows = notes
    .map(
      (n) => `<li><a href="/ghi-chu/${esc(n.slug)}">${esc(n.title)}</a>
      <div class="muted">${esc(topicLabel(n.topic))} · ${esc(n.origin === 'vault' ? 'ghi chú nghề của người sáng lập' : 'ghi chú mẫu')} · ${esc((n.published_at ?? '').slice(0, 10))}</div></li>`
    )
    .join('');
  return layout({
    title: 'Kho kiến thức',
    body: `<h1>Kho kiến thức</h1>
<p class="lead">Chỉ những ghi chú đã qua cổng kiểm duyệt mới vào kho: không tên khách hàng, không số liệu nhà máy, không tài liệu nội bộ. <a href="/cach-lam">Xem quy tắc</a>.</p>
<p>${chips}<a class="tag" href="/kho">tất cả</a></p>
<ul class="plain">${rows || '<li class="muted">Chưa có ghi chú nào.</li>'}</ul>`
  });
}

export function notePage({ note, expert }) {
  const gate = JSON.parse(note.gate || '{}');
  return layout({
    title: note.title,
    body: `<h1>${esc(note.title)}</h1>
<p class="muted"><span class="tag">${esc(topicLabel(note.topic))}</span>
${expert ? `Tác giả: ${esc(expert.name)} — ${esc(expert.headline)}` : 'Tác giả: ghi chú mẫu'}
${gate.verdict ? ` · cổng kiểm duyệt: <span class="tag${gate.verdict === 'clean' ? '' : ' warn'}">${esc(gate.verdict)}</span>` : ''}</p>
<div class="card"><div class="answer">${esc(note.body)}</div></div>
<p><a href="/kho">← Kho kiến thức</a></p>`
  });
}

export function howItWorksPage() {
  return layout({
    title: 'Cách nền tảng này làm việc',
    body: `<h1>Cách nền tảng này làm việc</h1>
<p class="lead">Ba bậc, và một quy tắc ở cửa vào. Bậc nào cũng có lý do tồn tại — không có bậc nào để trang trí.</p>
<h2>1. Cổng kiểm duyệt — quy tắc ở cửa vào</h2>
<p>Người làm nghề viết ghi chú tại nơi họ làm việc, nên ghi chú thô thường là thông tin của chủ nhà máy. Kho chỉ nhận <em>kiến thức nghề</em>: hiện tượng, dấu hiệu, cách kiểm chứng, cách xử lý theo thứ tự, lỗi người mới hay mắc, giới hạn khi áp dụng.</p>
<p>Cổng tự động chặn: tên công ty/khách hàng/nhà cung cấp, tên người, mã hàng và đơn hàng, bản vẽ, giá và điều khoản hợp đồng, tài liệu nội bộ. Con số kèm đơn vị (%) chỉ được đăng khi tác giả tự xác nhận đó là kiến thức chung, không phải số của nhà máy họ.</p>
<div class="notice">${esc(ATTESTATION_TEXT)}</div>
<h2>2. Trả lời có trích dẫn, và nói thẳng khi kho chưa đủ</h2>
<p>Câu trả lời tự động chỉ dùng nội dung trong kho và gắn số hiệu ghi chú cho từng ý. Nếu kho không đủ, hệ thống không đoán: nó trả về <code>THIEU_DU_LIEU</code>, nói còn thiếu gì, và mở đường chuyển câu hỏi cho người.</p>
<h2>3. Hỏi thẳng người làm nghề</h2>
<p>Câu hỏi được chuyển tới chuyên gia phụ trách đúng chủ đề, có hạn 48 giờ. Đây là bậc giữ khách, chưa phải sản phẩm thu tiền.</p>
<h2>4. Tư vấn 1:1 có phí</h2>
<p>Chuyên gia tự đặt mức phí theo giờ, buổi tối thiểu 30 phút. Tiền đi bằng chuyển khoản, nền tảng giữ một phần; trạng thái đơn chỉ chuyển sang “đã nhận tiền” khi người vận hành đối chiếu sao kê.</p>
<h2>Cổng AI không thay người</h2>
<p>Trả lời tự động là mặt tiền, không phải sản phẩm: một mô hình chung đã miễn phí cho mọi người. Thứ bán được là ghi chú của người làm nghề Việt Nam, cộng với việc chuyển đúng câu hỏi tới đúng người.</p>`
  });
}

export function expertListPage({ experts, topics }) {
  const cards = experts
    .map(
      (e) => `<div class="card" id="${esc(e.slug)}">
    <h3>${esc(e.name)}</h3><p class="muted">${esc(e.headline)}</p>
    <p>${e.topics.map((t) => `<span class="tag">${esc(topicLabel(t))}</span>`).join('')}</p>
    <p class="muted">${esc(e.years)} năm · ${e.bio ? esc(e.bio) : ''}</p>
    <p><strong>${formatVnd(e.rate_vnd)}</strong>/giờ</p>
    <form method="post" action="/dat-lich">
      <input type="hidden" name="expert" value="${esc(e.slug)}">
      <div class="grid">
        <div><label for="m-${esc(e.slug)}">Thời lượng</label><select id="m-${esc(e.slug)}" name="minutes">
          <option value="30">30 phút</option><option value="45" selected>45 phút</option><option value="60">60 phút</option><option value="90">90 phút</option></select></div>
        <div><label for="s-${esc(e.slug)}">Thời gian mong muốn</label><input id="s-${esc(e.slug)}" name="starts_at" placeholder="2026-10-15 20:00" required></div>
        <div><label for="n-${esc(e.slug)}">Tên anh/chị</label><input id="n-${esc(e.slug)}" name="asker" required></div>
        <div><label for="c-${esc(e.slug)}">Email / Zalo</label><input id="c-${esc(e.slug)}" name="contact" required></div>
      </div>
      <label for="a-${esc(e.slug)}">Vấn đề cần giải quyết</label>
      <textarea id="a-${esc(e.slug)}" name="agenda" placeholder="Ví dụ: chuyền lắp ráp 12 người, năng suất chiều tụt, cần tìm nguyên nhân theo thứ tự nào?"></textarea>
      <label for="t-${esc(e.slug)}">Chủ đề</label>
      <select id="t-${esc(e.slug)}" name="topic">${topics.map(([s, l]) => `<option value="${esc(s)}">${esc(l)}</option>`).join('')}</select>
      <p><button type="submit">Tạo đơn đặt lịch</button></p>
    </form>
  </div>`
    )
    .join('');
  return layout({
    title: 'Chuyên gia',
    body: `<h1>Chuyên gia</h1>
<p class="lead">Hồ sơ mẫu trong bản thử nghiệm: chưa có chuyên gia thật nào ký tham gia. Mức phí là giá gợi ý, dùng để thử luồng đặt lịch.</p>
<div class="grid">${cards}</div>`
  });
}

export function expertWorkspacePage({ expert, expertNotes, queue, bookings }) {
  const noteRows = expertNotes
    .map((n) => `<li><a href="/ghi-chu/${esc(n.slug)}">${esc(n.title)}</a> <span class="tag${n.status === 'published' ? '' : ' bad'}">${esc(noteStatus(n.status))}</span> <span class="muted">${esc(n.origin === 'interview' ? 'từ phỏng vấn' : n.origin === 'vault' ? 'từ sổ tay' : 'tự viết')}</span></li>`)
    .join('');
  const qRows = queue
    .map(
      (q) => `<div class="card"><p class="muted">${esc(topicLabel(q.topic))} · hạn ${esc((q.due_at ?? '').slice(0, 10))}</p>
    <div class="answer">${esc(q.text)}</div>
    <form method="post" action="/c/${esc(expert.token)}/tra-loi">
      <input type="hidden" name="ref" value="${esc(q.ref)}">
      <label for="ans-${esc(q.ref)}">Trả lời của anh/chị</label>
      <textarea id="ans-${esc(q.ref)}" name="body" placeholder="Trả lời ngắn, có việc làm được ngay. Không nêu số liệu nhà máy anh/chị đang làm."></textarea>
      <p><button type="submit">Gửi trả lời</button></p>
    </form></div>`
    )
    .join('');
  const bRows = bookings.map((b) => `<li>${esc(b.starts_at)} · ${b.minutes}p · ${formatVnd(b.payout_vnd)} về anh/chị · <code>${esc(b.ref)}</code> <span class="tag">${esc(bookingStatus(b.status))}</span></li>`).join('');
  return layout({
    title: `Bàn làm việc — ${expert.name}`,
    nav: false,
    body: `<h1>Bàn làm việc — ${esc(expert.name)}</h1>
<p class="muted">Liên kết riêng của anh/chị, không chia sẻ. <a href="/c/${esc(expert.token)}/phong-van">Phỏng vấn viết ghi chú (8 câu hỏi) →</a></p>
<h2>Câu hỏi được chuyển tới (${queue.length})</h2>
${qRows || '<p class="muted">Chưa có câu hỏi nào đang chờ.</p>'}
<h2>Ghi chú của tôi (${expertNotes.length})</h2>
<ul class="plain">${noteRows || '<li class="muted">Chưa có ghi chú.</li>'}</ul>
<h2>Viết ghi chú mới</h2>
<form method="post" action="/c/${esc(expert.token)}/ghi-chu" class="card">
  <label for="title">Tiêu đề</label><input id="title" name="title" required placeholder="Ví dụ: máy dừng giữa ca — kiểm tra theo thứ tự nào">
  <label for="topic">Chủ đề</label><select id="topic" name="topic">${topicList().map(([s, l]) => `<option value="${esc(s)}">${esc(l)}</option>`).join('')}</select>
  <label for="body">Nội dung (kiến thức nghề, <strong>không</strong> số liệu/tên riêng của nhà máy)</label>
  <textarea id="body" name="body" style="min-height:220px"></textarea>
  <label><input type="checkbox" name="attested" value="1" style="width:auto"> Tôi xác nhận: ${esc(ATTESTATION_TEXT)}</label>
  <p><button type="submit">Gửi qua cổng kiểm duyệt</button></p>
</form>
<h2>Buổi tư vấn được xếp cho tôi</h2>
<ul class="plain">${bRows || '<li class="muted">Chưa có buổi nào.</li>'}</ul>`
  });
}

export function interviewPage({ expert, interview, step, question, answers, doneNoteSlug }) {
  if (doneNoteSlug) {
    return layout({
      title: 'Đã xong phỏng vấn',
      nav: false,
      body: `<div class="card"><h1>Đã tạo ghi chú</h1><p>Ghi chú đã qua cổng kiểm duyệt: <a href="/ghi-chu/${esc(doneNoteSlug)}">xem ghi chú</a>.</p>
      <p><a class="btn alt" href="/c/${esc(expert.token)}">← Về bàn làm việc</a></p></div>`
    });
  }
  const p = question
    ? `<p class="muted">Câu ${step + 1}/${SCRIPT.length}</p><h2>${esc(question.ask)}</h2><p class="muted">${esc(question.hint)}</p>
    <form method="post" action="/c/${esc(expert.token)}/phong-van">
      <input type="hidden" name="id" value="${interview.id}">
      <textarea name="answer" style="min-height:160px" placeholder="Trả lời bằng lời của anh/chị. Càng cụ thể càng tốt."></textarea>
      <p><button type="submit">${step + 1 === SCRIPT.length ? 'Xong — tạo ghi chú' : 'Tiếp'}</button></p>
    </form>`
    : '';
  const sofar = answers.length
    ? `<h3>Đã ghi</h3><ul class="plain">${SCRIPT.slice(0, answers.length).map((q, i) => `<li><strong>${esc(q.ask.slice(0, 60))}…</strong><div class="muted">${esc(String(answers[i]).slice(0, 160))}</div></li>`).join('')}</ul>`
    : '';
  return layout({
    title: 'Phỏng vấn viết ghi chú',
    nav: false,
    body: `<h1>Phỏng vấn viết ghi chú</h1>
<p class="lead">Tám câu hỏi, mỗi câu một đoạn. Trả lời xong, hệ thống ghép thành ghi chú và đưa qua cổng kiểm duyệt — anh/chị không phải viết từ đầu.</p>
${p}${sofar}
<p><a href="/c/${esc(expert.token)}">← Về bàn làm việc</a></p>`
  });
}

export function adminPage({ token, stats, pendingBookings, blockedNotes, openQuestions, answerable }) {
  const bRows = pendingBookings
    .map(
      (b) => `<tr><td><code>${esc(b.ref)}</code></td><td>${esc(b.expert_name ?? '')}</td><td>${esc(b.contact)}</td><td>${esc(b.starts_at)}</td><td>${formatVnd(b.price_vnd)}</td><td>${esc(bookingStatus(b.status))}</td>
    <td>${b.status === 'awaiting_payment' ? `<form method="post" action="/qt/${esc(token)}/xac-nhan"><input type="hidden" name="ref" value="${esc(b.ref)}"><button>Đã nhận tiền</button></form>` : b.status === 'paid' ? `<form method="post" action="/qt/${esc(token)}/hoan-tat"><input type="hidden" name="ref" value="${esc(b.ref)}"><button>Đã xong buổi</button></form>` : ''}</td></tr>`
    )
    .join('');
  const qRows = openQuestions
    .map((q) => `<li><a href="/q/${esc(q.ref)}">${esc(q.text.slice(0, 80))}</a> <span class="tag">${esc(questionStatus(q.status))}</span> <span class="muted">${esc(topicLabel(q.topic))}${q.due_at ? ` · hạn ${esc(q.due_at.slice(0, 10))}` : ''}</span></li>`)
    .join('');
  const nRows = blockedNotes
    .map((n) => `<li>${esc(n.title)} <span class="tag bad">bị chặn</span> <span class="muted">${esc((JSON.parse(n.gate || '{}').findings ?? []).filter((f) => f.severity === 'block').map((f) => f.rule).join(', '))}</span></li>`)
    .join('');
  const needAnswer = answerable
    .map((q) => `<li><a href="/q/${esc(q.ref)}">${esc(q.ref)}</a> — ${esc(q.text.slice(0, 70))} <span class="muted">chưa chuyên gia nào trả lời</span></li>`)
    .join('');
  return layout({
    title: 'Quản trị',
    nav: false,
    body: `<h1>Quản trị</h1>
<p class="muted">${stats.notes} ghi chú · ${stats.questions} câu hỏi (${stats.thin} kho chưa đủ) · ${stats.bookings} đơn (${stats.paid} đã thu tiền) · ${stats.experts} hồ sơ.</p>
<h2>Đơn cần đối chiếu</h2>
<table><tr><th>Mã</th><th>Chuyên gia</th><th>Liên hệ</th><th>Thời gian</th><th>Giá</th><th>Trạng thái</th><th></th></tr>${bRows || '<tr><td colspan="7" class="muted">Không có đơn nào.</td></tr>'}</table>
<h2>Câu hỏi chưa có người trả lời</h2>
<ul class="plain">${needAnswer || '<li class="muted">Không có.</li>'}</ul>
<h2>Câu hỏi theo chủ đề</h2>
<ul class="plain">${qRows || '<li class="muted">Chưa có câu hỏi.</li>'}</ul>
<h2>Ghi chú bị cổng chặn</h2>
<ul class="plain">${nRows || '<li class="muted">Không có.</li>'}</ul>`
  });
}

export function blockedNotePage({ expert, decision, title }) {
  const reasons = decision.report.findings
    .filter((f) => f.severity !== 'note')
    .map((f) => `<li><span class="tag bad">${esc(f.rule)}</span> ${esc(f.hint)}</li>`)
    .join('');
  return layout({
    title: 'Ghi chú chưa vào được kho',
    nav: false,
    body: `<h1>Ghi chú chưa vào được kho</h1>
<div class="notice bad">Lý do: <strong>${esc(decision.reason === 'attestation_required' ? 'có con số kèm đơn vị nhưng chưa xác nhận là kiến thức chung' : 'chứa thông tin không thuộc về tác giả')}</strong>
${title ? `<div class="muted">Ghi chú: ${esc(title)}</div>` : ''}</div>
<ul class="plain">${reasons || '<li class="muted">Không có chi tiết.</li>'}</ul>
<p class="muted">Sửa lại rồi gửi lại: bỏ tên riêng, mã hàng, giá; hoặc bỏ con số — hoặc tick xác nhận nếu con số đó là kiến thức chung, không phải số liệu của nhà máy anh/chị.</p>
${expert ? `<p><a class="btn alt" href="/c/${esc(expert.token)}">← Về bàn làm việc</a></p>` : ''}`
  });
}

export function unauthorizedPage() {
  return layout({
    title: 'Cần đăng nhập',
    body: `<div class="card"><h1>Cần đăng nhập</h1>
<p>Bản thử nghiệm này chỉ mở cho người có tài khoản. Trình duyệt sẽ hỏi tên và mật khẩu — nhập cặp đã cấp cho anh/chị.</p>
<p class="muted">Nếu hộp thoại không hiện: đóng tab rồi mở lại, hoặc dùng chế độ ẩn danh để xoá thông tin đăng nhập cũ.</p></div>`
  });
}

export function errorPage({ code, message }) {
  return layout({
    title: `Lỗi ${code}`,
    body: `<div class="card"><h1>${code}</h1><p>${esc(message)}</p><p><a href="/">← Về trang hỏi</a></p></div>`
  });
}
