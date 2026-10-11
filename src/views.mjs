// src/views.mjs — server-rendered HTML. No build step, no framework.

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
  tpm: 'TPM & equipment',
  'shift-management': 'Line & shift management',
  improvement: 'Improvement & kaizen',
  quality: 'Quality',
  safety: 'Safety & 5S',
  'open-work': 'Managing open work',
  strategy: 'Strategy & targets',
  other: 'Other'
};

export const topicLabel = (t) => TOPICS[t] ?? t;
export const topicList = () => Object.entries(TOPICS);

// The state machine stores English tokens; this is the one place a person reads them. A raw
// `awaiting_payment` on a page reads as a bug, so every status goes through a label here.
const QUESTION_STATUS = { open: 'not yet sent to an expert', routed: 'sent to an expert', answered: 'answered by an expert', closed: 'closed' };
const BOOKING_STATUS = { requested: 'waiting for transfer instructions', awaiting_payment: 'you reported the transfer — being checked', paid: 'payment received', completed: 'session completed', cancelled: 'cancelled' };
const NOTE_STATUS = { published: 'published in the library', blocked: 'blocked by the gate', draft: 'draft' };

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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Xuong</title><style>${CSS}</style></head>
<body>
<header>
  <div class="brand">Xuong<span>.</span></div>
  ${nav ? `<nav>
    <a href="/">Ask</a>
    <a href="/library">Knowledge library</a>
    <a href="/experts">Experts &amp; booking</a>
    <a href="/how-it-works">How this platform works</a>
  </nav>` : ''}
</header>
<main>${body}</main>
<footer>${footer || 'Xuong — a factory-knowledge platform, built in Vietnam. Prototype (v0.1): sample data, no real transactions yet.'}</footer>
</body></html>`;
}

function askForm({ q = '', action = '/ask' } = {}) {
  return `<form method="post" action="${action}" class="card">
  <label for="q">Your question about production</label>
  <textarea id="q" name="q" placeholder="For example: the press keeps stopping mid-shift — what should I check, and in what order?">${esc(q)}</textarea>
  <div class="grid">
    <div><label for="plant_type">Type of plant (optional)</label>
      <input id="plant_type" name="plant_type" placeholder="electronics assembly, injection moulding, garment, food..."></div>
    <div><label for="asker">Your name (optional)</label><input id="asker" name="asker" placeholder="Hung"></div>
  </div>
  <p><button type="submit">Ask the knowledge library</button> <span class="muted">Answers cite notes written by people who worked the line. If the library does not cover it, the system says so instead of guessing, and offers to put you in touch with a practitioner.</span></p>
</form>`;
}

export function home({ stats, experts, notes, questions }) {
  const chips = topicList()
    .map(([slug, label]) => `<a class="tag" href="/library?topic=${encodeURIComponent(slug)}">${esc(label)}</a>`)
    .join('');
  const expertCards = experts
    .slice(0, 3)
    .map(
      (e) => `<div class="card">
    <h3>${esc(e.name)}</h3>
    <p class="muted">${esc(e.headline)}</p>
    <p>${e.topics.map((t) => `<span class="tag">${esc(topicLabel(t))}</span>`).join('')}</p>
    <p><strong>${formatVnd(e.rate_vnd)}</strong> / hour · minimum ${MIN_MINUTES} minutes</p>
    <a class="btn alt" href="/experts#${esc(e.slug)}">Book a 1:1 session</a>
  </div>`
    )
    .join('');
  const recent = questions
    .slice(0, 6)
    .map((q) => `<li><a href="/q/${esc(q.ref)}">${esc(q.text.slice(0, 90))}${q.text.length > 90 ? '…' : ''}</a> <span class="tag ${q.ai_coverage === 'thin' ? 'warn' : ''}">${q.ai_coverage === 'thin' ? 'not covered yet' : 'cited'}</span> <span class="muted">${esc(topicLabel(q.topic))} · ${esc(questionStatus(q.status))}</span></li>`)
    .join('');
  return layout({
    title: 'Ask someone who has run the line',
    body: `
<h1>Ask someone who has run the line</h1>
<p class="lead">Real production knowledge — from people who have stood at the line, not from slide decks. Ask the note library; if it does not cover your question, the question goes straight to a practitioner, and you can book a 1:1 session.</p>
${askForm()}
<div class="card">
  <h2 style="margin-top:0">What the platform holds right now</h2>
  <p>${stats.notes} published notes · ${stats.experts} expert profiles · ${stats.questions} questions received · ${stats.thin} questions the library could not answer (those went to a person).</p>
  <h3>Topics</h3><p>${chips}</p>
</div>
<h2>Experts</h2>
<div class="grid">${expertCards}</div>
<p><a href="/experts">See every expert and their rate →</a></p>
${recent ? `<h2>Recent questions</h2><ul class="plain">${recent}</ul>` : ''}
${notes.length ? `<h2>Newly published notes</h2><ul class="plain">${notes.slice(0, 5).map((n) => `<li><a href="/notes/${esc(n.slug)}">${esc(n.title)}</a> <span class="muted">— ${esc(topicLabel(n.topic))}</span></li>`).join('')}</ul>` : ''}
`
  });
}

export function questionPage({ q, aiCitations, answers, experts, routedNames = [], bankConfigured }) {
  const cov = q.ai_coverage === 'thin';
  const cites = aiCitations
    .map((n) => `<a class="cite" href="/notes/${esc(n.slug)}" title="${esc(n.title)}">[${n.id}] ${esc(n.title.slice(0, 40))}</a>`)
    .join(' ');
  const answerBlocks = answers
    .map((a) => `<div class="card"><h3>Answer from ${esc(a.expert_name ?? 'an expert')}</h3><p class="muted">${esc(a.expert_headline ?? '')} · ${esc(a.created_at.slice(0, 10))}</p><div class="answer">${esc(a.body)}</div></div>`)
    .join('');
  const expertOptions = experts
    .map((e) => `<option value="${esc(e.slug)}">${esc(e.name)} — ${formatVnd(e.rate_vnd)}/hour (${e.topics.map(topicLabel).map(esc).join(', ')})</option>`)
    .join('');
  return layout({
    title: `Question ${q.ref}`,
    body: `
<h1>Question <code>${esc(q.ref)}</code></h1>
<p class="muted">${esc(topicLabel(q.topic))}${q.plant_type ? ` · ${esc(q.plant_type)}` : ''} · status: <strong>${esc(questionStatus(q.status))}</strong>${q.due_at && q.status === 'routed' ? ` · expert answers by ${esc(q.due_at.slice(0, 10))}` : ''}</p>
<div class="card">
  <p class="muted">Question</p>
  <div class="answer">${esc(q.text)}</div>
</div>
<div class="card">
  <h2 style="margin-top:0">Answer from the note library ${cov ? '<span class="tag warn">library not sufficient</span>' : '<span class="tag">cited</span>'}</h2>
  <div class="answer">${esc(q.ai_answer || '(none yet)')}</div>
  ${cites ? `<p style="margin-top:14px">Sources: ${cites}</p>` : ''}
  <p class="muted">How it was produced: ${esc(q.ai_mode || 'unknown')}${q.ai_mode === 'extractive' ? ' (no model API key configured — the system quotes the note verbatim and does not paraphrase)' : ''}</p>
</div>
${answerBlocks}
${q.status === 'open' || q.status === 'routed'
      ? `<div class="card">
  <h2 style="margin-top:0">${q.status === 'routed' ? 'Waiting for an expert' : 'Not satisfied? Ask a practitioner directly'}</h2>
  ${q.status === 'routed'
        ? `<p>Sent to ${routedNames.length || 1} experts covering this topic (${esc(routedNames.join(', ') || 'the expert on duty')}). The answer will appear on this page.</p>`
        : `<form method="post" action="/q/${esc(q.ref)}/ask-expert">
      <p class="muted">Free. The question goes to the expert covering “${esc(topicLabel(q.topic))}”, with a 48-hour answer window.</p>
      <div class="grid">
        <div><label for="asker">Your name</label><input id="asker" name="asker" value="${esc(q.asker)}"></div>
        <div><label for="contact">Email or phone so we can send the answer</label><input id="contact" name="contact" value="${esc(q.contact)}" placeholder="…@gmail.com"></div>
      </div>
      <p><button type="submit">Send to the expert</button></p>
    </form>`}
</div>`
      : ''}
<div class="card">
  <h2 style="margin-top:0">Book a 1:1 session</h2>
  <p class="muted">Online session, paid, by bank transfer. The platform keeps ${'20'}% (adjustable per expert in the prototype).</p>
  ${experts.length ? `<form method="post" action="/q/${esc(q.ref)}/book">
    <div class="grid">
      <div><label for="expert">Expert</label><select id="expert" name="expert">${expertOptions}</select></div>
      <div><label for="minutes">Duration</label><select id="minutes" name="minutes">
        <option value="30">30 minutes</option><option value="45" selected>45 minutes</option><option value="60">60 minutes</option><option value="90">90 minutes</option></select></div>
      <div><label for="starts_at">Preferred time</label><input id="starts_at" name="starts_at" placeholder="2026-10-15 20:00" required></div>
      <div><label for="contact">Contact for the meeting link</label><input id="contact" name="contact" value="${esc(q.contact)}" required></div>
    </div>
    <label for="agenda">What you want to solve in the session</label>
    <textarea id="agenda" name="agenda">${esc(q.text.slice(0, 300))}</textarea>
    <p><button type="submit">Create booking</button> <span class="muted">${bankConfigured ? 'You will get transfer instructions and a booking code.' : 'No receiving account is configured — the booking stays pending with no transfer instructions.'}</span></p>
  </form>` : '<p class="muted">No expert covers this topic yet.</p>'}
</div>
`
  });
}

export function bookingPage({ b, instruction, bankConfigured }) {
  const steps = [
    ['requested', 'Booking created — waiting for transfer instructions'],
    ['awaiting_payment', 'You reported the transfer — the platform is checking'],
    ['paid', 'Payment received — slot confirmed, meeting link sent'],
    ['completed', 'Session completed']
  ];
  const idx = steps.findIndex(([s]) => s === b.status);
  return layout({
    title: `Booking ${b.ref}`,
    body: `
<h1>Booking <code>${esc(b.ref)}</code></h1>
<table>
  <tr><th>Expert</th><td>${esc(b.expert_name)} — ${esc(b.expert_headline ?? '')}</td></tr>
  <tr><th>Time</th><td>${esc(b.starts_at)} · ${b.minutes} minutes</td></tr>
  <tr><th>Client</th><td>${esc(b.asker)} · ${esc(b.contact)}</td></tr>
  <tr><th>Agenda</th><td>${esc(b.agenda || b.topic)}</td></tr>
  <tr><th>Price</th><td><strong>${formatVnd(b.price_vnd)}</strong></td></tr>
  <tr><th>Platform keeps</th><td>${formatVnd(b.fee_vnd)} · expert receives ${formatVnd(b.payout_vnd)}</td></tr>
  <tr><th>Status</th><td><strong>${esc(bookingStatus(b.status))}</strong></td></tr>
</table>
${instruction
      ? `<div class="card">
  <h3>Bank transfer</h3>
  <p>Amount <strong>${formatVnd(instruction.amount_vnd)}</strong> — put exactly this reference in the transfer note: <code>${esc(instruction.ref)}</code></p>
  <p class="muted">Beneficiary bank: BIN ${esc(instruction.bank_bin)} · account ${esc(instruction.account)}</p>
  <p><img src="${esc(instruction.qr_url)}" alt="VietQR ${esc(instruction.ref)}" style="max-width:260px;border:1px solid var(--line);border-radius:8px"></p>
  ${b.status === 'requested' ? `<form method="post" action="/b/${esc(b.ref)}/transferred"><p><button type="submit">I have transferred the money</button></p></form>` : ''}
</div>`
      : `<div class="notice">No receiving account is configured (<code>XUONG_BANK_BIN</code>, <code>XUONG_BANK_ACCOUNT</code>). The platform does not draw a fake QR code and does not claim money it has not received.</div>`}
<div class="card">
  <h3>Process</h3>
  <ol>${steps.map(([s, label], i) => `<li>${i === idx ? '<strong>' : ''}${esc(label)}${i === idx ? '</strong> — you are here' : ''}</li>`).join('')}</ol>
  <p class="muted">Money counts as received only when the operator reconciles the bank statement and confirms it in the admin page. The system never marks a booking paid by itself.</p>
</div>
`
  });
}

export function corpusPage({ notes, topic, topics }) {
  const chips = topics
    .map(([slug, label]) => `<a class="tag${slug === topic ? ' warn' : ''}" href="/library?topic=${encodeURIComponent(slug)}">${esc(label)}</a>`)
    .join('');
  const rows = notes
    .map(
      (n) => `<li><a href="/notes/${esc(n.slug)}">${esc(n.title)}</a>
      <div class="muted">${esc(topicLabel(n.topic))} · ${esc(n.origin === 'vault' ? 'craft note from the founder' : 'sample note')} · ${esc((n.published_at ?? '').slice(0, 10))}</div></li>`
    )
    .join('');
  return layout({
    title: 'Knowledge library',
    body: `<h1>Knowledge library</h1>
<p class="lead">Only notes that passed the gate are in here: no customer names, no plant figures, no internal documents. <a href="/how-it-works">See the rules</a>.</p>
<p>${chips}<a class="tag" href="/library">all</a></p>
<ul class="plain">${rows || '<li class="muted">No notes yet.</li>'}</ul>`
  });
}

export function notePage({ note, expert }) {
  const gate = JSON.parse(note.gate || '{}');
  return layout({
    title: note.title,
    body: `<h1>${esc(note.title)}</h1>
<p class="muted"><span class="tag">${esc(topicLabel(note.topic))}</span>
${expert ? `Author: ${esc(expert.name)} — ${esc(expert.headline)}` : 'Author: sample note'}
${gate.verdict ? ` · gate: <span class="tag${gate.verdict === 'clean' ? '' : ' warn'}">${esc(gate.verdict)}</span>` : ''}</p>
<div class="card"><div class="answer">${esc(note.body)}</div></div>
<p><a href="/library">← Knowledge library</a></p>`
  });
}

export function howItWorksPage() {
  return layout({
    title: 'How this platform works',
    body: `<h1>How this platform works</h1>
<p class="lead">Four rungs and one rule at the door. Every rung earns its place — none of them is decoration.</p>
<h2>1. The gate — the rule at the door</h2>
<p>Practitioners write from where they work, so raw notes are usually the plant owner's information. The library only accepts <em>craft knowledge</em>: what happens, the signs, how to verify it, what to do in what order, the mistake newcomers make, and where the advice stops applying.</p>
<p>The gate blocks automatically: company, customer and supplier names; personal names; part and order codes; drawings; prices and contract terms; internal documents. A figure with a unit is published only when the author attests that it is general craft knowledge, not their plant's data.</p>
<div class="notice">${esc(ATTESTATION_TEXT)}</div>
<h2>2. An answer with citations, and a plain refusal when the library is short</h2>
<p>The automatic answer uses only what is in the library, and tags each point with the note it came from. When the library does not cover the question the system does not guess: it returns <code>INSUFFICIENT_DATA</code>, says what is missing, and opens the path to a human.</p>
<h2>3. Ask a practitioner directly</h2>
<p>The question goes to the expert covering that topic, with a 48-hour window. This rung keeps the person; it is not the paid product.</p>
<h2>4. Paid 1:1 sessions</h2>
<p>The expert sets their own hourly rate, minimum 30 minutes. Money moves by bank transfer and the platform keeps a share; a booking only becomes “payment received” when the operator has reconciled the statement.</p>
<h2>The AI is not a replacement for the person</h2>
<p>The automatic answer is the shopfront, not the product: a general model is already free to everyone. What is for sale is the craft notes of Vietnamese practitioners, plus getting the right question to the right person.`
  });
}

export function expertListPage({ experts, topics }) {
  const cards = experts
    .map(
      (e) => `<div class="card" id="${esc(e.slug)}">
    <h3>${esc(e.name)}</h3><p class="muted">${esc(e.headline)}</p>
    <p>${e.topics.map((t) => `<span class="tag">${esc(topicLabel(t))}</span>`).join('')}</p>
    <p class="muted">${esc(e.years)} years · ${e.bio ? esc(e.bio) : ''}</p>
    <p><strong>${formatVnd(e.rate_vnd)}</strong>/hour</p>
    <form method="post" action="/book">
      <input type="hidden" name="expert" value="${esc(e.slug)}">
      <div class="grid">
        <div><label for="m-${esc(e.slug)}">Duration</label><select id="m-${esc(e.slug)}" name="minutes">
          <option value="30">30 minutes</option><option value="45" selected>45 minutes</option><option value="60">60 minutes</option><option value="90">90 minutes</option></select></div>
        <div><label for="s-${esc(e.slug)}">Preferred time</label><input id="s-${esc(e.slug)}" name="starts_at" placeholder="2026-10-15 20:00" required></div>
        <div><label for="n-${esc(e.slug)}">Your name</label><input id="n-${esc(e.slug)}" name="asker" required></div>
        <div><label for="c-${esc(e.slug)}">Email / phone</label><input id="c-${esc(e.slug)}" name="contact" required></div>
      </div>
      <label for="a-${esc(e.slug)}">What you need to solve</label>
      <textarea id="a-${esc(e.slug)}" name="agenda" placeholder="For example: a 12-person assembly line, output drops in the afternoon, where should I start looking?"></textarea>
      <label for="t-${esc(e.slug)}">Topic</label>
      <select id="t-${esc(e.slug)}" name="topic">${topics.map(([s, l]) => `<option value="${esc(s)}">${esc(l)}</option>`).join('')}</select>
      <p><button type="submit">Create booking</button></p>
    </form>
  </div>`
    )
    .join('');
  return layout({
    title: 'Experts',
    body: `<h1>Experts</h1>
<p class="lead">Sample profiles in the prototype: no real expert has signed up yet. The rates are indicative and exist to exercise the booking flow.</p>
<div class="grid">${cards}</div>`
  });
}

export function expertWorkspacePage({ expert, expertNotes, queue, bookings }) {
  const noteRows = expertNotes
    .map((n) => `<li><a href="/notes/${esc(n.slug)}">${esc(n.title)}</a> <span class="tag${n.status === 'published' ? '' : ' bad'}">${esc(noteStatus(n.status))}</span> <span class="muted">${esc(n.origin === 'interview' ? 'from the interview' : n.origin === 'vault' ? 'from my notebook' : 'written by hand')}</span></li>`)
    .join('');
  const qRows = queue
    .map(
      (q) => `<div class="card"><p class="muted">${esc(topicLabel(q.topic))} · due ${esc((q.due_at ?? '').slice(0, 10))}</p>
    <div class="answer">${esc(q.text)}</div>
    <form method="post" action="/c/${esc(expert.token)}/answer">
      <input type="hidden" name="ref" value="${esc(q.ref)}">
      <label for="ans-${esc(q.ref)}">Your answer</label>
      <textarea id="ans-${esc(q.ref)}" name="body" placeholder="Short, with something they can do today. Do not include figures from your own plant."></textarea>
      <p><button type="submit">Send answer</button></p>
    </form></div>`
    )
    .join('');
  const bRows = bookings.map((b) => `<li>${esc(b.starts_at)} · ${b.minutes}p · ${formatVnd(b.payout_vnd)} to you · <code>${esc(b.ref)}</code> <span class="tag">${esc(bookingStatus(b.status))}</span></li>`).join('');
  return layout({
    title: `Desk — ${expert.name}`,
    nav: false,
    body: `<h1>Desk — ${esc(expert.name)}</h1>
<p class="muted">Your private link, do not share it. <a href="/c/${esc(expert.token)}/interview">Write a note through the interview (8 questions) →</a></p>
<h2>Questions routed to you (${queue.length})</h2>
${qRows || '<p class="muted">No questions waiting.</p>'}
<h2>My notes (${expertNotes.length})</h2>
<ul class="plain">${noteRows || '<li class="muted">No notes yet.</li>'}</ul>
<h2>Write a new note</h2>
<form method="post" action="/c/${esc(expert.token)}/note" class="card">
  <label for="title">Title</label><input id="title" name="title" required placeholder="For example: the machine stops mid-shift — what to check, in what order">
  <label for="topic">Topic</label><select id="topic" name="topic">${topicList().map(([s, l]) => `<option value="${esc(s)}">${esc(l)}</option>`).join('')}</select>
  <label for="body">Body (craft knowledge, <strong>not</strong> your plant's figures or names)</label>
  <textarea id="body" name="body" style="min-height:220px"></textarea>
  <label><input type="checkbox" name="attested" value="1" style="width:auto"> I confirm: ${esc(ATTESTATION_TEXT)}</label>
  <p><button type="submit">Send through the gate</button></p>
</form>
<h2>Sessions booked with me</h2>
<ul class="plain">${bRows || '<li class="muted">No sessions yet.</li>'}</ul>`
  });
}

export function interviewPage({ expert, interview, step, question, answers, doneNoteSlug }) {
  if (doneNoteSlug) {
    return layout({
      title: 'Interview finished',
      nav: false,
      body: `<div class="card"><h1>Note created</h1><p>The note went through the gate: <a href="/notes/${esc(doneNoteSlug)}">read the note</a>.</p>
      <p><a class="btn alt" href="/c/${esc(expert.token)}">← Back to the desk</a></p></div>`
    });
  }
  const p = question
    ? `<p class="muted">Question ${step + 1}/${SCRIPT.length}</p><h2>${esc(question.ask)}</h2><p class="muted">${esc(question.hint)}</p>
    <form method="post" action="/c/${esc(expert.token)}/interview">
      <input type="hidden" name="id" value="${interview.id}">
      <textarea name="answer" style="min-height:160px" placeholder="Answer in your own words. The more specific the better."></textarea>
      <p><button type="submit">${step + 1 === SCRIPT.length ? 'Done — create the note' : 'Next'}</button></p>
    </form>`
    : '';
  const sofar = answers.length
    ? `<h3>Recorded so far</h3><ul class="plain">${SCRIPT.slice(0, answers.length).map((q, i) => `<li><strong>${esc(q.ask.slice(0, 60))}…</strong><div class="muted">${esc(String(answers[i]).slice(0, 160))}</div></li>`).join('')}</ul>`
    : '';
  return layout({
    title: 'Interview — write a note',
    nav: false,
    body: `<h1>Interview — write a note</h1>
<p class="lead">Eight questions, one paragraph each. When you are done, the system assembles the note and runs it through the gate — you do not have to write it from scratch.</p>
${p}${sofar}
<p><a href="/c/${esc(expert.token)}">← Back to the desk</a></p>`
  });
}

export function adminPage({ token, stats, pendingBookings, blockedNotes, openQuestions, answerable }) {
  const bRows = pendingBookings
    .map(
      (b) => `<tr><td><code>${esc(b.ref)}</code></td><td>${esc(b.expert_name ?? '')}</td><td>${esc(b.contact)}</td><td>${esc(b.starts_at)}</td><td>${formatVnd(b.price_vnd)}</td><td>${esc(bookingStatus(b.status))}</td>
    <td>${b.status === 'awaiting_payment' ? `<form method="post" action="/qt/${esc(token)}/confirm"><input type="hidden" name="ref" value="${esc(b.ref)}"><button>Payment received</button></form>` : b.status === 'paid' ? `<form method="post" action="/qt/${esc(token)}/complete"><input type="hidden" name="ref" value="${esc(b.ref)}"><button>Session done</button></form>` : ''}</td></tr>`
    )
    .join('');
  const qRows = openQuestions
    .map((q) => `<li><a href="/q/${esc(q.ref)}">${esc(q.text.slice(0, 80))}</a> <span class="tag">${esc(questionStatus(q.status))}</span> <span class="muted">${esc(topicLabel(q.topic))}${q.due_at ? ` · due ${esc(q.due_at.slice(0, 10))}` : ''}</span></li>`)
    .join('');
  const nRows = blockedNotes
    .map((n) => `<li>${esc(n.title)} <span class="tag bad">blocked by the gate</span> <span class="muted">${esc((JSON.parse(n.gate || '{}').findings ?? []).filter((f) => f.severity === 'block').map((f) => f.rule).join(', '))}</span></li>`)
    .join('');
  const needAnswer = answerable
    .map((q) => `<li><a href="/q/${esc(q.ref)}">${esc(q.ref)}</a> — ${esc(q.text.slice(0, 70))} <span class="muted">no expert has answered</span></li>`)
    .join('');
  return layout({
    title: 'Admin',
    nav: false,
    body: `<h1>Admin</h1>
<p class="muted">${stats.notes} notes · ${stats.questions} questions (${stats.thin} the library could not cover) · ${stats.bookings} bookings (${stats.paid} paid) · ${stats.experts} profiles.</p>
<h2>Bookings to reconcile</h2>
<table><tr><th>Code</th><th>Expert</th><th>Contact</th><th>Time</th><th>Price</th><th>Status</th><th></th></tr>${bRows || '<tr><td colspan="7" class="muted">No bookings.</td></tr>'}</table>
<h2>Questions with nobody answering them</h2>
<ul class="plain">${needAnswer || '<li class="muted">None.</li>'}</ul>
<h2>Questions by topic</h2>
<ul class="plain">${qRows || '<li class="muted">No questions yet.</li>'}</ul>
<h2>Notes the gate blocked</h2>
<ul class="plain">${nRows || '<li class="muted">None.</li>'}</ul>`
  });
}

export function blockedNotePage({ expert, decision, title }) {
  const reasons = decision.report.findings
    .filter((f) => f.severity !== 'note')
    .map((f) => `<li><span class="tag bad">${esc(f.rule)}</span> ${esc(f.hint)}</li>`)
    .join('');
  return layout({
    title: 'The note did not reach the library',
    nav: false,
    body: `<h1>The note did not reach the library</h1>
<div class="notice bad">Reason: <strong>${esc(decision.reason === 'attestation_required' ? 'it carries a figure with a unit and was not attested as general knowledge' : 'it contains information that is not the author’s to publish')}</strong>
${title ? `<div class="muted">Note: ${esc(title)}</div>` : ''}</div>
<ul class="plain">${reasons || '<li class="muted">No detail.</li>'}</ul>
<p class="muted">Fix it and send it again: remove personal names, part codes and prices; or remove the figure — or tick the attestation if that figure is general knowledge, not your plant's data.</p>
${expert ? `<p><a class="btn alt" href="/c/${esc(expert.token)}">← Back to the desk</a></p>` : ''}`
  });
}

export function unauthorizedPage() {
  return layout({
    title: 'Sign-in required',
    body: `<div class="card"><h1>Sign-in required</h1>
<p>This prototype is open to account holders only. The browser asks for a username and password — use the pair you were given.</p>
<p class="muted">If no dialog appears: close the tab and open it again, or use a private window to clear an older sign-in.</p></div>`
  });
}

export function errorPage({ code, message }) {
  return layout({
    title: `Error ${code}`,
    body: `<div class="card"><h1>${code}</h1><p>${esc(message)}</p><p><a href="/">← Back to the ask page</a></p></div>`
  });
}
