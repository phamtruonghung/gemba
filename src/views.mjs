// src/views.mjs — server-rendered HTML. No build step, no framework, no client JavaScript.
//
// The visual system is generated and persisted in `design-system/xuong/MASTER.md` (ui-ux-pro-max):
// navy/grey "Trust & Authority", light and dark, contrast at or above 4.5:1, visible focus, 44px
// touch targets. Four deliberate departures from the generated system, each for a stated reason:
//
//   1. No webfont request. The pairing is Roboto, but this runs as an appliance on a factory LAN and
//      behind a tunnel; a fonts.googleapis.com call is a third-party request on every page load and
//      a blank flash while it resolves. The stack prefers Roboto when the device has it and falls
//      back to the platform UI font — never to the network.
//   2. No animation library. The recommended reveal is GSAP + ScrollTrigger; this app ships no
//      JavaScript by decision, so the only motion is one CSS fade under
//      `prefers-reduced-motion: no-preference`, and all content is in the HTML regardless.
//   3. The refusal gets the loudest treatment, not the quietest. The guideline reserves the accent
//      for CTAs; here "the library does not cover this" is the product's most important sentence, so
//      it is a bordered panel naming what is missing, with the escalation as its primary action.
//   4. No proof strip, no logo carousel. There are no customers yet, and the README promises not to
//      fake evidence.

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

// --- icons -----------------------------------------------------------------
// Inline SVG, 20px, currentColor. No emoji as icons and no icon font: an icon that fails to load is
// an icon that lies about what a control does.

const ICON = {
  ask: '<path d="M4 5h16v10H8l-4 4z"/>',
  library: '<path d="M5 4h5v16H5zM14 4h5v16h-5z"/>',
  people: '<path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 1 0 0-6M15 20c0-2 1-3.5 3-4.2 2 .4 4 1.9 4 4.2"/>',
  rules: '<path d="M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7"/>',
  account: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6"/>',
  lock: '<path d="M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z"/>',
  warn: '<path d="M12 3 2 20h20zM12 9v5M12 17h.01"/>',
  check: '<path d="m4 13 5 5L20 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
};

const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[name] ?? ''}</svg>`;

// --- the design system -----------------------------------------------------
// Tokens first, then components. Every colour used is a token, so dark mode is one override block
// rather than a hunt through rules — and the accessible pairs stay accessible in both modes.

const CSS = `
:root{
  --color-primary:#0f172a; --color-on-primary:#ffffff;
  --color-secondary:#334155; --color-on-secondary:#ffffff;
  --color-accent:#075985; --color-on-accent:#ffffff;
  --color-accent-hover:#0c4a6e;
  --color-background:#f8fafc; --color-foreground:#020617;
  --color-card:#ffffff; --color-card-foreground:#020617;
  --color-muted:#e8ecf1; --color-muted-foreground:#475569;
  --color-border:#e2e8f0; --color-ring:#0f172a;
  --color-destructive:#dc2626; --color-on-destructive:#ffffff;
  --color-warn-bg:#fef6e7; --color-warn-fg:#7a4708; --color-warn-line:#f0c37a;
  --color-ok-bg:#eaf6ef; --color-ok-fg:#14532d; --color-ok-line:#a6d5b8;
  --shadow-sm:0 1px 2px rgba(2,6,23,.06);
  --shadow-md:0 4px 14px rgba(2,6,23,.08);
  --font-sans:"Roboto","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:24px; --space-6:32px; --space-7:48px;
  --radius:10px; --radius-sm:8px; --radius-pill:999px;
  --measure:70ch;
}
@media (prefers-color-scheme: dark){
  :root{
    --color-primary:#e8eef7; --color-on-primary:#0b1220;
    --color-secondary:#c3cddb; --color-on-secondary:#0b1220;
    --color-accent:#7cc0ea; --color-on-accent:#04121e;
    --color-accent-hover:#9dd0f2;
    --color-background:#0b1220; --color-foreground:#eef2f8;
    --color-card:#111a2b; --color-card-foreground:#eef2f8;
    --color-muted:#1b2437; --color-muted-foreground:#a9b6c8;
    --color-border:#26314a; --color-ring:#8cc7ef;
    --color-destructive:#f87171; --color-on-destructive:#3b0a0a;
    --color-warn-bg:#2a2113; --color-warn-fg:#f2cf96; --color-warn-line:#6b5426;
    --color-ok-bg:#10251a; --color-ok-fg:#a7e3c0; --color-ok-line:#2c5942;
    --shadow-sm:0 1px 2px rgba(0,0,0,.4); --shadow-md:0 6px 18px rgba(0,0,0,.45);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--color-background);color:var(--color-foreground);font:16px/1.6 var(--font-sans)}
img{max-width:100%;height:auto}
a{color:var(--color-accent);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{color:var(--color-accent-hover)}
:focus-visible{outline:3px solid var(--color-ring);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-9999px;top:0;background:var(--color-card);color:var(--color-foreground);padding:var(--space-3) var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-sm);z-index:10}
.skip:focus{left:var(--space-4);top:var(--space-4)}
.ico{width:20px;height:20px;flex:none}

header.site{background:var(--color-card);border-bottom:1px solid var(--color-border);position:sticky;top:0;z-index:5}
header.site .inner{max-width:1080px;margin:0 auto;padding:var(--space-3) var(--space-5);display:flex;gap:var(--space-5);align-items:center;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:var(--space-3);font-weight:700;font-size:19px;letter-spacing:-.2px;color:var(--color-foreground);text-decoration:none;min-height:44px;padding:4px 6px;margin-left:-6px;border-radius:var(--radius-sm)}
.brand:hover{background:var(--color-muted)}
.brand .mark{width:30px;height:30px;border-radius:8px;background:var(--color-primary);color:var(--color-on-primary);display:grid;place-items:center;font-size:15px;font-weight:700}
nav.site{display:flex;gap:var(--space-2);flex-wrap:wrap;font-size:14.5px;margin-left:auto;align-items:center}
nav.site a{display:inline-flex;align-items:center;gap:6px;color:var(--color-muted-foreground);text-decoration:none;padding:9px 11px;border-radius:var(--radius-sm);min-height:44px}
nav.site a:hover{background:var(--color-muted);color:var(--color-foreground)}
nav.site a[aria-current="page"]{color:var(--color-foreground);font-weight:600;background:var(--color-muted)}
nav.site form{display:inline-flex;margin:0}
nav.site button.link{background:none;border:0;color:var(--color-muted-foreground);font:inherit;padding:9px 11px;border-radius:var(--radius-sm);cursor:pointer;min-height:44px}
nav.site button.link:hover{background:var(--color-muted);color:var(--color-foreground)}
.who{font-size:13.5px;color:var(--color-muted-foreground);display:inline-flex;align-items:center;gap:6px}

main{max-width:1080px;margin:0 auto;padding:var(--space-6) var(--space-5) var(--space-7)}
.prose{max-width:var(--measure)}
h1{font-size:clamp(24px,3.4vw,32px);line-height:1.2;letter-spacing:-.5px;margin:0 0 var(--space-3)}
h2{font-size:clamp(19px,2.2vw,22px);line-height:1.3;margin:var(--space-6) 0 var(--space-3)}
h3{font-size:17px;margin:var(--space-4) 0 var(--space-2)}
p,li{font-size:15.5px}
.lead{color:var(--color-muted-foreground);font-size:17px;max-width:var(--measure);margin:0 0 var(--space-5)}
.muted{color:var(--color-muted-foreground);font-size:14px}
.small{font-size:13.5px}
hr{border:0;border-top:1px solid var(--color-border);margin:var(--space-6) 0}

.card{background:var(--color-card);border:1px solid var(--color-border);border-radius:var(--radius);padding:var(--space-5);margin:var(--space-4) 0;box-shadow:var(--shadow-sm);display:flex;flex-direction:column;gap:var(--space-3)}
.card > .push{margin-top:auto}
.card h2,.card h3{margin-top:0}
.grid{display:grid;gap:var(--space-4);grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.split{display:grid;gap:var(--space-5);grid-template-columns:minmax(0,2fr) minmax(0,1fr);align-items:start}
@media (max-width:900px){.split{grid-template-columns:1fr}}
.stack-sm{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center}

.btn,button.btn{display:inline-flex;align-items:center;gap:8px;justify-content:center;background:var(--color-accent);color:var(--color-on-accent);border:1px solid var(--color-accent);border-radius:var(--radius-sm);padding:13px 20px;font:inherit;font-weight:600;font-size:15.5px;cursor:pointer;text-decoration:none;min-height:44px;box-shadow:var(--shadow-md);transition:background-color .18s ease,border-color .18s ease,transform .18s ease}
.btn:hover{background:var(--color-accent-hover);border-color:var(--color-accent-hover);color:var(--color-on-accent)}
.btn:active{transform:translateY(1px)}
.btn.alt{background:var(--color-card);color:var(--color-accent);border-color:var(--color-border);box-shadow:var(--shadow-sm)}
.btn.alt:hover{background:var(--color-muted);color:var(--color-accent-hover)}
.btn.ghost{background:none;border-color:transparent;color:var(--color-accent);padding:10px 8px;font-weight:500}
.btn.ghost:hover{background:var(--color-muted);color:var(--color-accent-hover)}
.btn[disabled]{opacity:.55;cursor:not-allowed}
.btn.row{display:flex;width:fit-content}

label{display:block;font-size:14px;font-weight:500;color:var(--color-foreground);margin:var(--space-3) 0 var(--space-2)}
.hint{font-size:13px;color:var(--color-muted-foreground);margin:-4px 0 var(--space-2);font-weight:400}
input,textarea,select{width:100%;padding:11px 12px;border:1px solid var(--color-border);border-radius:var(--radius-sm);font:inherit;font-size:15.5px;background:var(--color-card);color:var(--color-foreground);min-height:44px}
textarea{min-height:120px;resize:vertical}
input[type=checkbox]{width:auto;min-height:auto;margin-right:8px}
.field-error{color:var(--color-destructive);font-size:13.5px;margin:6px 0 0;font-weight:500}
input[aria-invalid="true"],textarea[aria-invalid="true"]{border-color:var(--color-destructive);box-shadow:0 0 0 1px var(--color-destructive)}

.badge{display:inline-flex;align-items:center;gap:6px;background:var(--color-muted);color:var(--color-muted-foreground);border-radius:var(--radius-pill);padding:4px 11px;font-size:12.5px;font-weight:500;white-space:nowrap}
.badge.ok{background:var(--color-ok-bg);color:var(--color-ok-fg)}
.badge.warn{background:var(--color-warn-bg);color:var(--color-warn-fg)}
.badge.bad{background:color-mix(in srgb,var(--color-destructive) 14%,transparent);color:var(--color-destructive)}
a.badge{text-decoration:none;padding:10px 13px;min-height:44px}
a.badge:hover{background:var(--color-border);color:var(--color-foreground)}

.notice{border:1px solid var(--color-border);border-left:4px solid var(--color-accent);background:var(--color-card);padding:var(--space-4);border-radius:var(--radius-sm);margin:var(--space-4) 0}
.notice.warn{border-left-color:var(--color-warn-line);background:var(--color-warn-bg);color:var(--color-warn-fg)}
.notice.bad{border-left-color:var(--color-destructive)}
.notice.ok{border-left-color:var(--color-ok-line);background:var(--color-ok-bg);color:var(--color-ok-fg)}
.notice h3{margin:0 0 var(--space-2)}
.notice p:last-child{margin-bottom:0}

/* The refusal. The product's most important sentence gets its own frame, not a grey footnote. */
.refusal{border:1px solid var(--color-warn-line);border-left:4px solid var(--color-warn-line);background:var(--color-warn-bg);color:var(--color-warn-fg);border-radius:var(--radius);padding:var(--space-5);margin:var(--space-4) 0}
.refusal h2{margin:0 0 var(--space-2);color:inherit;display:flex;align-items:center;gap:10px}
.refusal .why{font-size:14px;opacity:.9;margin:0 0 var(--space-3)}
.answer{white-space:pre-wrap;font-size:15.5px;line-height:1.65}
.cite{display:inline-flex;align-items:center;gap:4px;background:var(--color-muted);border-radius:var(--radius-pill);padding:3px 10px;font-size:12.5px;font-weight:600;color:var(--color-accent);text-decoration:none;margin:0 6px 6px 0}
.cite:hover{background:var(--color-border)}

table{width:100%;border-collapse:collapse;font-size:14.5px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--color-border);vertical-align:top}
th{color:var(--color-muted-foreground);font-weight:600;font-size:13px;text-transform:none}
tbody tr:hover{background:var(--color-muted)}

ul.plain{list-style:none;padding:0;margin:0}
ul.plain > li{padding:var(--space-3) 0;border-bottom:1px solid var(--color-border)}
ul.plain > li:last-child{border-bottom:0}
ol.steps{list-style:none;counter-reset:step;padding:0;margin:0}
ol.steps li{counter-increment:step;display:flex;gap:var(--space-3);padding:var(--space-3) 0;border-bottom:1px solid var(--color-border);align-items:flex-start}
ol.steps li:last-child{border-bottom:0}
ol.steps li::before{content:counter(step);flex:none;width:26px;height:26px;border-radius:50%;background:var(--color-muted);color:var(--color-muted-foreground);display:grid;place-items:center;font-size:13px;font-weight:700}
ol.steps li.here::before{background:var(--color-accent);color:var(--color-on-accent)}
footer.site{border-top:1px solid var(--color-border);background:var(--color-card);margin-top:var(--space-7)}
footer.site .inner{max-width:1080px;margin:0 auto;padding:var(--space-5);color:var(--color-muted-foreground);font-size:13.5px;display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:center;justify-content:space-between}
code{background:var(--color-muted);padding:2px 6px;border-radius:5px;font-size:13.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.kv{display:grid;grid-template-columns:minmax(120px,180px) minmax(0,1fr);gap:2px var(--space-4);font-size:14.5px}
.kv dt{color:var(--color-muted-foreground);padding:8px 0;border-bottom:1px solid var(--color-border)}
.kv dd{margin:0;padding:8px 0;border-bottom:1px solid var(--color-border)}
@media (max-width:520px){.kv{grid-template-columns:1fr}.kv dt{border-bottom:0;padding-bottom:0}}
.auth{max-width:440px;margin:0 auto}
.auth .card{gap:var(--space-2)}
@media (prefers-reduced-motion: no-preference){
  main > *{animation:enter .28s ease-out both}
  @keyframes enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
}
@media (max-width:600px){
  header.site .inner{padding:var(--space-3) var(--space-4);gap:var(--space-3)}
  main{padding:var(--space-5) var(--space-4) var(--space-7)}
  nav.site{gap:2px;font-size:14px}
  nav.site a,nav.site button.link{padding:8px}
}
`;

const NAV = [
  ['/', 'Ask', 'ask'],
  ['/library', 'Library', 'library'],
  ['/experts', 'Experts', 'people'],
  ['/how-it-works', 'How it works', 'rules']
];

/**
 * The one page frame. `user` is the signed-in person or null; `active` marks the nav item for
 * screen readers and for the one visible "you are here" state.
 */
export function layout({ title, body, nav = true, footer = '', user = null, active = '' }) {
  const links = NAV.map(
    ([href, label, ico]) =>
      `<a href="${href}"${href === active ? ' aria-current="page"' : ''}>${icon(ico)}${esc(label)}</a>`
  ).join('');
  const account = user
    ? `<span class="who">${icon('account')}${esc(user.name)}</span>
       <a href="/account"${active === '/account' ? ' aria-current="page"' : ''}>${icon('account')}My questions</a>
       <form method="post" action="/signout"><button class="link" type="submit">Sign out</button></form>`
    : `<a href="/signin"${active === '/signin' ? ' aria-current="page"' : ''}>${icon('account')}Sign in</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · Xuong</title><style>${CSS}</style></head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site"><div class="inner">
  <a class="brand" href="/"><span class="mark">X</span>Xuong</a>
  ${nav ? `<nav class="site" aria-label="Main">${links}${account}</nav>` : ''}
</div></header>
<main id="main">${body}</main>
<footer class="site"><div class="inner">
  <span>${footer || 'Xuong — a factory-knowledge platform, built in Vietnam.'}</span>
  <span>Prototype (v0.1): sample experts, no real transactions yet.</span>
</div></footer>
</body></html>`;
}

// --- shared pieces ---------------------------------------------------------

function askForm({ q = '', action = '/ask', user = null } = {}) {
  return `<form method="post" action="${action}" class="card">
  <label for="q">Your question about production</label>
  <p class="hint" id="q-hint">One question, as you would ask a colleague. The more specific, the better the answer.</p>
  <textarea id="q" name="q" aria-describedby="q-hint" placeholder="For example: the press keeps stopping mid-shift — what should I check, and in what order?">${esc(q)}</textarea>
  <div class="grid">
    <div><label for="plant_type">Type of plant <span class="muted">(optional)</span></label>
      <input id="plant_type" name="plant_type" placeholder="electronics assembly, injection moulding, garment, food…"></div>
    <div><label for="asker">Your name <span class="muted">(optional)</span></label>
      <input id="asker" name="asker" value="${user ? esc(user.name) : ''}" placeholder="Hung"></div>
  </div>
  <div class="stack-sm">
    <button class="btn" type="submit">${icon('ask')}Ask the knowledge library</button>
    <span class="muted">${user ? 'This question will be kept in your account.' : 'Answers cite notes written by people who worked the line. If the library does not cover it, the system says so instead of guessing — and offers to put you in touch with a practitioner.'}</span>
  </div>
</form>`;
}

function field({ id, label, name = null, type = 'text', value = '', hint = '', error = '', attrs = '', autocomplete = '' }) {
  const n = name ?? id;
  const described = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ');
  return `<label for="${id}">${esc(label)}</label>
${hint ? `<p class="hint" id="${id}-hint">${esc(hint)}</p>` : ''}
<input id="${id}" name="${n}" type="${type}" value="${esc(value)}"${autocomplete ? ` autocomplete="${autocomplete}"` : ''}${error ? ' aria-invalid="true"' : ''}${described ? ` aria-describedby="${described}"` : ''} ${attrs}>
${error ? `<p class="field-error" id="${id}-err">${icon('warn')} ${esc(error)}</p>` : ''}`;
}

// --- pages -----------------------------------------------------------------

export function home({ stats, experts, notes, questions, user = null }) {
  const chips = topicList()
    .map(([slug, label]) => `<a class="badge" href="/library?topic=${encodeURIComponent(slug)}">${esc(label)}</a>`)
    .join('');
  const expertCards = experts
    .slice(0, 3)
    .map(
      (e) => `<article class="card">
    <h3>${esc(e.name)}</h3>
    <p class="muted">${esc(e.headline)}</p>
    <p class="stack-sm">${e.topics.map((t) => `<span class="badge">${esc(topicLabel(t))}</span>`).join('')}</p>
    <p><strong>${formatVnd(e.rate_vnd)}</strong> / hour · minimum ${MIN_MINUTES} minutes</p>
    <p class="push"><a class="btn alt" href="/experts#${esc(e.slug)}">${icon('people')}Book a 1:1 session</a></p>
  </article>`
    )
    .join('');
  const recent = questions
    .slice(0, 6)
    .map(
      (q) => `<li><a href="/q/${esc(q.ref)}">${esc(q.text.slice(0, 90))}${q.text.length > 90 ? '…' : ''}</a>
      <div class="stack-sm"><span class="badge ${q.ai_coverage === 'thin' ? 'warn' : 'ok'}">${q.ai_coverage === 'thin' ? 'library could not cover it' : 'answered from the library'}</span>
      <span class="muted">${esc(topicLabel(q.topic))} · ${esc(questionStatus(q.status))}</span></div></li>`
    )
    .join('');
  return layout({
    title: 'Ask someone who has run the line',
    user,
    active: '/',
    body: `
<h1>Ask someone who has run the line</h1>
<p class="lead">Real production knowledge, from people who have stood at the line — not from slide decks. Ask the note library. If it does not cover your question, the system says so, and the question can go straight to a practitioner.</p>
${askForm({ user })}
<div class="card">
  <h2>What the platform holds right now</h2>
  <p><strong>${stats.notes}</strong> published notes · <strong>${stats.experts}</strong> expert profiles · <strong>${stats.questions}</strong> questions received · <strong>${stats.thin}</strong> the library could not answer (those went to a person).</p>
  <h3>Topics</h3>
  <p class="stack-sm">${chips}</p>
</div>
<h2>Experts</h2>
<div class="grid">${expertCards}</div>
<p><a href="/experts">See every expert and their rate ${icon('arrow')}</a></p>
${recent ? `<h2>Recent questions</h2><ul class="plain">${recent}</ul>` : ''}
${notes.length ? `<h2>Newly published notes</h2><ul class="plain">${notes.slice(0, 5).map((n) => `<li><a href="/notes/${esc(n.slug)}">${esc(n.title)}</a> <span class="muted">— ${esc(topicLabel(n.topic))}</span></li>`).join('')}</ul>` : ''}
`
  });
}

export function signInPage({ email = '', error = '', field: bad = '', keep = '', user = null, next = '' } = {}) {
  return layout({
    title: 'Sign in',
    user,
    active: '/signin',
    body: `<div class="auth">
<h1>Sign in</h1>
<p class="lead">An account keeps the questions you ask, the answers, and any 1:1 session you book. Asking without one still works.</p>
${error && !bad ? `<div class="notice bad" role="alert">${icon('warn')} ${esc(error)}</div>` : ''}
<form method="post" action="/signin" class="card">
  ${keep ? `<input type="hidden" name="keep" value="${esc(keep)}">` : ''}
  ${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
  ${field({ id: 'email', label: 'Email', type: 'email', value: email, error: bad === 'email' ? error : '', autocomplete: 'username', attrs: 'required' })}
  ${field({ id: 'password', label: 'Password', type: 'password', error: bad === 'password' ? error : '', autocomplete: 'current-password', attrs: 'required' })}
  <button class="btn row" type="submit">${icon('lock')}Sign in</button>
</form>
<p class="muted">No account yet? <a href="/signup${keep ? `?keep=${encodeURIComponent(keep)}` : ''}">Create one</a>.</p>
<p class="muted small">Password reset is not built yet: it needs a mail path this deployment does not have. If you are locked out, the operator can reset the account by hand.</p>
</div>`
  });
}

export function signUpPage({ name = '', email = '', error = '', field: bad = '', keep = '', user = null } = {}) {
  return layout({
    title: 'Create an account',
    user,
    active: '/signin',
    body: `<div class="auth">
<h1>Create an account</h1>
<p class="lead">Two fields and a password. Nothing is sent to your email — this deployment has no mail path, and it will not pretend to.</p>
${error && !bad ? `<div class="notice bad" role="alert">${icon('warn')} ${esc(error)}</div>` : ''}
<form method="post" action="/signup" class="card">
  ${keep ? `<input type="hidden" name="keep" value="${esc(keep)}">` : ''}
  ${field({ id: 'name', label: 'Your name', value: name, hint: 'This is what an expert sees on a question you send them.', error: bad === 'name' ? error : '', autocomplete: 'name', attrs: 'required' })}
  ${field({ id: 'email', label: 'Email', type: 'email', value: email, error: bad === 'email' ? error : '', autocomplete: 'username', attrs: 'required' })}
  ${field({ id: 'password', label: 'Password', type: 'password', hint: 'At least 10 characters. A sentence you can remember beats a short one you cannot.', error: bad === 'password' ? error : '', autocomplete: 'new-password', attrs: 'required' })}
  <button class="btn row" type="submit">${icon('account')}Create account</button>
</form>
<p class="muted">Already have one? <a href="/signin${keep ? `?keep=${encodeURIComponent(keep)}` : ''}">Sign in</a>.</p>
</div>`
  });
}

export function accountPage({ user, questions = [], bookings = [], sessions = 0, flash = '' }) {
  const qRows = questions
    .map(
      (q) => `<li>
      <a href="/q/${esc(q.ref)}">${esc(q.text.slice(0, 92))}${q.text.length > 92 ? '…' : ''}</a>
      <div class="stack-sm">
        <span class="badge ${q.ai_coverage === 'thin' ? 'warn' : 'ok'}">${q.ai_coverage === 'thin' ? 'library could not cover it' : 'answered from the library'}</span>
        <span class="muted">${esc(topicLabel(q.topic))} · ${esc(questionStatus(q.status))} · ${esc((q.created_at ?? '').slice(0, 10))}</span>
      </div>
      <div class="muted small">Ref <code>${esc(q.ref)}</code></div></li>`
    )
    .join('');
  const bRows = bookings
    .map(
      (b) => `<li>${esc((b.starts_at ?? '').slice(0, 16))} · ${esc(b.expert_name ?? 'an expert')} · ${b.minutes} minutes · <strong>${formatVnd(b.price_vnd)}</strong>
      <div class="stack-sm"><span class="badge">${esc(bookingStatus(b.status))}</span> <a href="/b/${esc(b.ref)}">Booking <code>${esc(b.ref)}</code></a></div></li>`
    )
    .join('');
  return layout({
    title: 'My questions',
    user,
    active: '/account',
    body: `
<h1>My questions</h1>
<p class="lead">Signed in as ${esc(user.name)} — <span class="muted">${esc(user.email)}</span>${sessions > 1 ? ` · signed in on ${sessions} devices` : ''}</p>
${flash ? `<div class="notice ok" role="status">${icon('check')} ${esc(flash)}</div>` : ''}
<div class="card">
  <h2>Questions you asked (${questions.length})</h2>
  ${questions.length ? `<ul class="plain">${qRows}</ul>` : '<p class="muted">Nothing yet. <a href="/">Ask your first question</a>.</p>'}
</div>
<div class="card">
  <h2>1:1 sessions you booked (${bookings.length})</h2>
  ${bookings.length ? `<ul class="plain">${bRows}</ul>` : '<p class="muted">No sessions booked. <a href="/experts">See the experts</a>.</p>'}
</div>
`
  });
}

export function questionPage({ q, aiCitations, answers, experts, routedNames = [], bankConfigured, user = null, claimed = false }) {
  const cov = q.ai_coverage === 'thin';
  const cites = aiCitations
    .map((n) => `<a class="cite" href="/notes/${esc(n.slug)}" title="${esc(n.title)}">[${n.id}] ${esc(n.title.slice(0, 40))}</a>`)
    .join(' ');
  const answerBlocks = answers
    .map(
      (a) => `<article class="card"><h3>Answer from ${esc(a.expert_name ?? 'an expert')}</h3>
    <p class="muted">${esc(a.expert_headline ?? '')} · ${esc((a.created_at ?? '').slice(0, 10))}</p>
    <div class="answer">${esc(a.body)}</div></article>`
    )
    .join('');
  const expertOptions = experts
    .map((e) => `<option value="${esc(e.slug)}">${esc(e.name)} — ${formatVnd(e.rate_vnd)}/hour</option>`)
    .join('');
  const keepBanner =
    user && claimed
      ? `<div class="notice ok" role="status">${icon('check')} This question is now saved to your account — it will be here when you come back.</div>`
      : !user
        ? `<div class="notice">${icon('account')} <strong>Keep this question.</strong> <a href="/signin?keep=${encodeURIComponent(q.ref)}">Sign in</a> or <a href="/signup?keep=${encodeURIComponent(q.ref)}">create an account</a> and it will be waiting, with its answer and any escalation, next time.</div>`
        : '';
  return layout({
    title: `Question ${q.ref}`,
    user,
    body: `
<h1>Question <code>${esc(q.ref)}</code></h1>
<p class="muted">${esc(topicLabel(q.topic))}${q.plant_type ? ` · ${esc(q.plant_type)}` : ''} · status: <strong>${esc(questionStatus(q.status))}</strong>${q.due_at && q.status === 'routed' ? ` · expert answers by ${esc(q.due_at.slice(0, 10))}` : ''}</p>
${keepBanner}
<div class="card">
  <p class="muted">Question</p>
  <div class="answer">${esc(q.text)}</div>
</div>
${cov
      ? `<section class="refusal">
  <h2>${icon('warn')}The library does not cover this</h2>
  <p class="why">${esc(q.ai_answer || '') || 'No note in the library answers this question closely enough to cite.'}</p>
  <p class="muted" style="color:inherit">What is missing is a published note on this topic — not an answer. That is why the next rung exists: ask a practitioner who does the work.</p>
</section>`
      : `<div class="card">
  <h2>Answer from the note library <span class="badge ok">${icon('check')}cited</span></h2>
  <div class="answer">${esc(q.ai_answer || '(none yet)')}</div>
  ${cites ? `<p>Sources: ${cites}</p>` : ''}
  <p class="muted">How it was produced: ${esc(q.ai_mode || 'unknown')}${q.ai_mode === 'extractive' ? ' (no model API key configured — the system quotes the note verbatim and does not paraphrase)' : ''}</p>
</div>`}
${answerBlocks}
${q.status === 'open' || q.status === 'routed'
      ? `<div class="card">
  <h2>${q.status === 'routed' ? 'Waiting for an expert' : 'Send this question to a practitioner'}</h2>
  ${q.status === 'routed'
        ? `<p>Sent to ${routedNames.length || 1} experts covering this topic (${esc(routedNames.join(', ') || 'the expert on duty')}). The answer will appear on this page.</p>`
        : `<form method="post" action="/q/${esc(q.ref)}/ask-expert">
      <p class="muted">Free. The question goes to the expert covering “${esc(topicLabel(q.topic))}”, with a 48-hour answer window.</p>
      <div class="grid">
        <div><label for="asker">Your name</label><input id="asker" name="asker" value="${esc(q.asker || (user?.name ?? ''))}"></div>
        <div><label for="contact">Email or phone so we can send the answer</label><input id="contact" name="contact" value="${esc(q.contact || (user?.email ?? ''))}" placeholder="…@gmail.com"></div>
      </div>
      <p><button class="btn" type="submit">${icon('people')}Send to the expert</button></p>
    </form>`}
</div>`
      : ''}
<div class="card">
  <h2>Book a 1:1 session</h2>
  <p class="muted">Online session, paid, by bank transfer. The platform keeps 20% (adjustable per expert in the prototype).</p>
  ${experts.length
      ? `<form method="post" action="/q/${esc(q.ref)}/book">
    <div class="grid">
      <div><label for="expert">Expert</label><select id="expert" name="expert">${expertOptions}</select></div>
      <div><label for="minutes">Duration</label><select id="minutes" name="minutes">
        <option value="30">30 minutes</option><option value="45" selected>45 minutes</option><option value="60">60 minutes</option><option value="90">90 minutes</option></select></div>
      <div><label for="starts_at">Preferred time</label><input id="starts_at" name="starts_at" placeholder="2026-10-15 20:00" required></div>
      <div><label for="contact">Contact for the meeting link</label><input id="contact" name="contact" value="${esc(q.contact || (user?.email ?? ''))}" required></div>
    </div>
    <label for="agenda">What you want to solve in the session</label>
    <textarea id="agenda" name="agenda">${esc(q.text.slice(0, 300))}</textarea>
    <p class="stack-sm"><button class="btn" type="submit">Create booking</button>
    <span class="muted">${bankConfigured ? 'You will get transfer instructions and a booking code.' : 'No receiving account is configured — the booking stays pending with no transfer instructions.'}</span></p>
  </form>`
      : '<p class="muted">No expert covers this topic yet.</p>'}
</div>
`
  });
}

export function bookingPage({ b, instruction, bankConfigured, user = null }) {
  const steps = [
    ['requested', 'Booking created — waiting for transfer instructions'],
    ['awaiting_payment', 'You reported the transfer — the platform is checking'],
    ['paid', 'Payment received — slot confirmed, meeting link sent'],
    ['completed', 'Session completed']
  ];
  const idx = steps.findIndex(([s]) => s === b.status);
  return layout({
    title: `Booking ${b.ref}`,
    user,
    body: `
<h1>Booking <code>${esc(b.ref)}</code></h1>
<div class="card">
  <dl class="kv">
    <dt>Expert</dt><dd>${esc(b.expert_name)} — ${esc(b.expert_headline ?? '')}</dd>
    <dt>Time</dt><dd>${esc(b.starts_at)} · ${b.minutes} minutes</dd>
    <dt>Client</dt><dd>${esc(b.asker)} · ${esc(b.contact)}</dd>
    <dt>Agenda</dt><dd>${esc(b.agenda || b.topic)}</dd>
    <dt>Price</dt><dd><strong>${formatVnd(b.price_vnd)}</strong></dd>
    <dt>Split</dt><dd>platform ${formatVnd(b.fee_vnd)} · expert receives ${formatVnd(b.payout_vnd)}</dd>
    <dt>Status</dt><dd><strong>${esc(bookingStatus(b.status))}</strong></dd>
  </dl>
</div>
${instruction
      ? `<div class="card">
  <h3>Bank transfer</h3>
  <p>Amount <strong>${formatVnd(instruction.amount_vnd)}</strong> — put exactly this reference in the transfer note: <code>${esc(instruction.ref)}</code></p>
  <p class="muted">Beneficiary bank: BIN ${esc(instruction.bank_bin)} · account ${esc(instruction.account)}</p>
  <p><img src="${esc(instruction.qr_url)}" alt="VietQR code for transfer reference ${esc(instruction.ref)}" width="260" height="260" style="border:1px solid var(--color-border);border-radius:var(--radius-sm);background:#fff"></p>
  ${b.status === 'requested' ? `<form method="post" action="/b/${esc(b.ref)}/transferred"><p><button class="btn" type="submit">I have transferred the money</button></p></form>` : ''}
</div>`
      : `<div class="notice warn">${icon('warn')} No receiving account is configured (<code>XUONG_BANK_BIN</code>, <code>XUONG_BANK_ACCOUNT</code>). The platform does not draw a fake QR code and does not claim money it has not received.</div>`}
<div class="card">
  <h3>Process</h3>
  <ol class="steps">${steps.map(([s, label], i) => `<li class="${i === idx ? 'here' : ''}"><span>${esc(label)}${i === idx ? ' — you are here' : ''}</span></li>`).join('')}</ol>
  <p class="muted">Money counts as received only when the operator reconciles the bank statement and confirms it in the operator console. The system never marks a booking paid by itself.</p>
</div>
`
  });
}

export function corpusPage({ notes, topic, topics, user = null }) {
  const chips = topics
    .map(([slug, label]) => `<a class="badge${slug === topic ? ' warn' : ''}" href="/library?topic=${encodeURIComponent(slug)}"${slug === topic ? ' aria-current="true"' : ''}>${esc(label)}</a>`)
    .join('');
  const rows = notes
    .map(
      (n) => `<li><a href="/notes/${esc(n.slug)}">${esc(n.title)}</a>
      <div class="muted">${esc(topicLabel(n.topic))} · ${esc(n.origin === 'vault' ? 'craft note from the founder' : 'sample note')} · ${esc((n.published_at ?? '').slice(0, 10))}</div></li>`
    )
    .join('');
  return layout({
    title: 'Knowledge library',
    user,
    active: '/library',
    body: `<h1>Knowledge library</h1>
<p class="lead">Only notes that passed the gate are in here: no customer names, no plant figures, no internal documents. <a href="/how-it-works">See the rules</a>.</p>
<p class="stack-sm">${chips}<a class="badge" href="/library"${topic ? '' : ' aria-current="true"'}>all</a></p>
<ul class="plain">${rows || '<li class="muted">No notes yet.</li>'}</ul>`
  });
}

export function notePage({ note, expert, user = null }) {
  const gate = JSON.parse(note.gate || '{}');
  return layout({
    title: note.title,
    user,
    active: '/library',
    body: `
<h1>${esc(note.title)}</h1>
<p class="stack-sm">
  <span class="badge">${esc(topicLabel(note.topic))}</span>
  <span class="muted">${expert ? `Author: ${esc(expert.name)} — ${esc(expert.headline)}` : 'Author: sample note'}</span>
  ${gate.verdict ? `<span class="badge${gate.verdict === 'clean' ? ' ok' : ' warn'}">gate: ${esc(gate.verdict)}</span>` : ''}
</p>
<article class="card"><div class="answer">${esc(note.body)}</div></article>
<p><a href="/library">← Knowledge library</a></p>`
  });
}

export function howItWorksPage({ user = null } = {}) {
  return layout({
    title: 'How this platform works',
    user,
    active: '/how-it-works',
    body: `<div class="prose">
<h1>How this platform works</h1>
<p class="lead">Four rungs and one rule at the door. Every rung earns its place — none of them is decoration.</p>
</div>
<h2>1. The gate — the rule at the door</h2>
<div class="prose">
<p>Practitioners write from where they work, so raw notes are usually the plant owner's information. The library only accepts <em>craft knowledge</em>: what happens, the signs, how to verify it, what to do in what order, the mistake newcomers make, and where the advice stops applying.</p>
<p>The gate blocks automatically: company, customer and supplier names; personal names; part and order codes; drawings; prices and contract terms; internal documents. A figure with a unit is published only when the author attests that it is general craft knowledge, not their plant's data.</p>
</div>
<div class="notice"><strong>What an author signs:</strong> ${esc(ATTESTATION_TEXT)}</div>
<h2>2. An answer with citations, and a plain refusal when the library is short</h2>
<div class="prose">
<p>The automatic answer uses only what is in the library, and tags each point with the note it came from. When the library does not cover the question the system does not guess: it returns <code>INSUFFICIENT_DATA</code>, says what is missing, and opens the path to a human.</p>
</div>
<div class="refusal">
  <h2>${icon('warn')}This is the product, not a failure of it</h2>
  <p class="why">A machine that always answers is worth nothing on a shop floor: a confident wrong answer costs a shift. A machine that knows what it does not know is worth a subscription.</p>
</div>
<h2>3. Ask a practitioner directly</h2>
<div class="prose"><p>The question goes to the expert covering that topic, with a 48-hour window. This rung keeps the person; it is not the paid product.</p></div>
<h2>4. Paid 1:1 sessions</h2>
<div class="prose"><p>The expert sets their own hourly rate, minimum 30 minutes. Money moves by bank transfer and the platform keeps a share; a booking only becomes “payment received” when the operator has reconciled the statement.</p></div>
<h2>The AI is not a replacement for the person</h2>
<div class="prose"><p>The automatic answer is the shopfront, not the product: a general model is already free to everyone. What is for sale is the craft notes of Vietnamese practitioners, plus getting the right question to the right person.</p></div>`
  });
}

export function expertListPage({ experts, topics, user = null }) {
  const cards = experts
    .map(
      (e) => `<article class="card" id="${esc(e.slug)}">
    <h3>${esc(e.name)}</h3><p class="muted">${esc(e.headline)}</p>
    <p class="stack-sm">${e.topics.map((t) => `<span class="badge">${esc(topicLabel(t))}</span>`).join('')}</p>
    <p class="muted">${esc(e.years)} years · ${e.bio ? esc(e.bio) : ''}</p>
    <p><strong>${formatVnd(e.rate_vnd)}</strong>/hour</p>
    <form method="post" action="/book">
      <input type="hidden" name="expert" value="${esc(e.slug)}">
      <div class="grid">
        <div><label for="m-${esc(e.slug)}">Duration</label><select id="m-${esc(e.slug)}" name="minutes">
          <option value="30">30 minutes</option><option value="45" selected>45 minutes</option><option value="60">60 minutes</option><option value="90">90 minutes</option></select></div>
        <div><label for="s-${esc(e.slug)}">Preferred time</label><input id="s-${esc(e.slug)}" name="starts_at" placeholder="2026-10-15 20:00" required></div>
        <div><label for="n-${esc(e.slug)}">Your name</label><input id="n-${esc(e.slug)}" name="asker" value="${esc(user?.name ?? '')}" required></div>
        <div><label for="c-${esc(e.slug)}">Email / phone</label><input id="c-${esc(e.slug)}" name="contact" value="${esc(user?.email ?? '')}" required></div>
      </div>
      <label for="a-${esc(e.slug)}">What you need to solve</label>
      <textarea id="a-${esc(e.slug)}" name="agenda" placeholder="For example: a 12-person assembly line, output drops in the afternoon, where should I start looking?"></textarea>
      <label for="t-${esc(e.slug)}">Topic</label>
      <select id="t-${esc(e.slug)}" name="topic">${topics.map(([s, l]) => `<option value="${esc(s)}">${esc(l)}</option>`).join('')}</select>
      <p class="push"><button class="btn" type="submit">Create booking</button></p>
    </form>
  </article>`
    )
    .join('');
  return layout({
    title: 'Experts',
    user,
    active: '/experts',
    body: `<h1>Experts</h1>
<p class="lead">Sample profiles in the prototype: no real expert has signed up yet. The rates are indicative and exist to exercise the booking flow.</p>
<div class="grid">${cards}</div>`
  });
}

export function expertWorkspacePage({ expert, expertNotes, queue, bookings }) {
  const noteRows = expertNotes
    .map(
      (n) => `<li><a href="/notes/${esc(n.slug)}">${esc(n.title)}</a>
      <div class="stack-sm"><span class="badge${n.status === 'published' ? ' ok' : ' bad'}">${esc(noteStatus(n.status))}</span>
      <span class="muted">${esc(n.origin === 'interview' ? 'from the interview' : n.origin === 'vault' ? 'from my notebook' : 'written by hand')}</span></div></li>`
    )
    .join('');
  const qRows = queue
    .map(
      (q) => `<div class="card"><p class="muted">${esc(topicLabel(q.topic))} · due ${esc((q.due_at ?? '').slice(0, 10))}</p>
    <div class="answer">${esc(q.text)}</div>
    <form method="post" action="/c/${esc(expert.token)}/answer">
      <input type="hidden" name="ref" value="${esc(q.ref)}">
      <label for="ans-${esc(q.ref)}">Your answer</label>
      <p class="hint" id="ans-${esc(q.ref)}-hint">Short, with something they can do today. Do not include figures from your own plant.</p>
      <textarea id="ans-${esc(q.ref)}" name="body" aria-describedby="ans-${esc(q.ref)}-hint"></textarea>
      <p><button class="btn" type="submit">Send answer</button></p>
    </form></div>`
    )
    .join('');
  const bRows = bookings.map((b) => `<li>${esc(b.starts_at)} · ${b.minutes}p · ${formatVnd(b.payout_vnd)} to you · <code>${esc(b.ref)}</code> <span class="badge">${esc(bookingStatus(b.status))}</span></li>`).join('');
  return layout({
    title: `Desk — ${expert.name}`,
    nav: false,
    body: `<h1>Desk — ${esc(expert.name)}</h1>
<p class="muted">Your private link — do not share it. <a href="/c/${esc(expert.token)}/interview">Write a note through the interview (8 questions) →</a></p>
<h2>Questions routed to you (${queue.length})</h2>
${qRows || '<p class="muted">No questions waiting.</p>'}
<h2>My notes (${expertNotes.length})</h2>
<ul class="plain">${noteRows || '<li class="muted">No notes yet.</li>'}</ul>
<h2>Write a new note</h2>
<form method="post" action="/c/${esc(expert.token)}/note" class="card">
  <label for="title">Title</label><input id="title" name="title" required placeholder="For example: the machine stops mid-shift — what to check, in what order">
  <label for="topic">Topic</label><select id="topic" name="topic">${topicList().map(([s, l]) => `<option value="${esc(s)}">${esc(l)}</option>`).join('')}</select>
  <label for="body">Body</label>
  <p class="hint" id="body-hint">Craft knowledge — <strong>not</strong> your plant's figures or names.</p>
  <textarea id="body" name="body" aria-describedby="body-hint" style="min-height:220px"></textarea>
  <label for="attested"><input type="checkbox" id="attested" name="attested" value="1"> I confirm: ${esc(ATTESTATION_TEXT)}</label>
  <p><button class="btn" type="submit">Send through the gate</button></p>
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
      body: `<div class="card"><h1>${icon('check')} Note created</h1><p>The note went through the gate.</p>
      <p><a class="btn alt" href="/notes/${esc(doneNoteSlug)}">Read the note</a> <a class="btn ghost" href="/c/${esc(expert.token)}">← Back to the desk</a></p></div>`
    });
  }
  const p = question
    ? `<div class="card">
    <p class="muted">Question ${step + 1} of ${SCRIPT.length}</p>
    <h2>${esc(question.ask)}</h2>
    <p class="muted">${esc(question.hint)}</p>
    <form method="post" action="/c/${esc(expert.token)}/interview">
      <input type="hidden" name="id" value="${interview.id}">
      <label for="answer">Your answer</label>
      <textarea id="answer" name="answer" style="min-height:160px" placeholder="Answer in your own words. The more specific the better."></textarea>
      <p><button class="btn" type="submit">${step + 1 === SCRIPT.length ? 'Done — create the note' : 'Next question'}</button></p>
    </form></div>`
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

export function adminPage({ token, stats, pendingBookings, blockedNotes, openQuestions, answerable, accounts = 0, user = null }) {
  const bRows = pendingBookings
    .map(
      (b) => `<tr><td><code>${esc(b.ref)}</code></td><td>${esc(b.expert_name ?? '')}</td><td>${esc(b.contact)}</td><td>${esc(b.starts_at)}</td><td>${formatVnd(b.price_vnd)}</td><td>${esc(bookingStatus(b.status))}</td>
    <td>${b.status === 'awaiting_payment' ? `<form method="post" action="/qt/${esc(token)}/confirm"><input type="hidden" name="ref" value="${esc(b.ref)}"><button class="btn">Payment received</button></form>` : b.status === 'paid' ? `<form method="post" action="/qt/${esc(token)}/complete"><input type="hidden" name="ref" value="${esc(b.ref)}"><button class="btn">Session done</button></form>` : ''}</td></tr>`
    )
    .join('');
  const qRows = openQuestions
    .map(
      (q) => `<li><a href="/q/${esc(q.ref)}">${esc(q.text.slice(0, 80))}</a>
      <div class="stack-sm"><span class="badge">${esc(questionStatus(q.status))}</span>
      <span class="muted">${esc(topicLabel(q.topic))}${q.due_at ? ` · due ${esc(q.due_at.slice(0, 10))}` : ''}</span></div></li>`
    )
    .join('');
  const nRows = blockedNotes
    .map(
      (n) => `<li>${esc(n.title)} <span class="badge bad">blocked by the gate</span> <span class="muted">${esc((JSON.parse(n.gate || '{}').findings ?? []).filter((f) => f.severity === 'block').map((f) => f.rule).join(', '))}</span></li>`
    )
    .join('');
  const needAnswer = answerable
    .map((q) => `<li><a href="/q/${esc(q.ref)}">${esc(q.ref)}</a> — ${esc(q.text.slice(0, 70))} <span class="muted">no expert has answered</span></li>`)
    .join('');
  return layout({
    title: 'Operator console',
    nav: false,
    user,
    body: `<h1>Operator console</h1>
<p class="muted">${stats.notes} notes · ${stats.questions} questions (${stats.thin} the library could not cover) · ${stats.bookings} bookings (${stats.paid} paid) · ${stats.experts} profiles · ${accounts} accounts.</p>
<h2>Bookings to reconcile</h2>
<table><thead><tr><th>Code</th><th>Expert</th><th>Contact</th><th>Time</th><th>Price</th><th>Status</th><th></th></tr></thead>
<tbody>${bRows || '<tr><td colspan="7" class="muted">No bookings.</td></tr>'}</tbody></table>
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
    .map((f) => `<li><span class="badge bad">${esc(f.rule)}</span> ${esc(f.hint)}</li>`)
    .join('');
  return layout({
    title: 'The note did not reach the library',
    nav: false,
    body: `<h1>The note did not reach the library</h1>
<div class="notice bad">${icon('warn')} Reason: <strong>${esc(decision.reason === 'attestation_required' ? 'it carries a figure with a unit and was not attested as general knowledge' : 'it contains information that is not the author’s to publish')}</strong>
${title ? `<div class="muted">Note: ${esc(title)}</div>` : ''}</div>
<ul class="plain">${reasons || '<li class="muted">No detail.</li>'}</ul>
<p class="muted">Fix it and send it again: remove personal names, part codes and prices; or remove the figure — or tick the attestation if that figure is general knowledge, not your plant's data.</p>
${expert ? `<p><a class="btn alt" href="/c/${esc(expert.token)}">← Back to the desk</a></p>` : ''}`
  });
}

export function unauthorizedPage() {
  return layout({
    title: 'Sign-in required',
    nav: false,
    body: `<div class="auth"><div class="card"><h1>${icon('lock')} Instance sign-in</h1>
<p>This demonstration instance is open to invited visitors only. Your browser asks for the shared username and password it was given — this is the deployment's own gate, and it is separate from a Xuong account.</p>
<p class="muted">If no dialog appears: reload the page, or open it in a private window to clear an older sign-in.</p></div></div>`
  });
}

export function errorPage({ code, message, user = null }) {
  return layout({
    title: `Error ${code}`,
    user,
    body: `<div class="auth"><div class="card"><h1>${code}</h1><p>${esc(message)}</p><p><a class="btn alt" href="/">← Back to the ask page</a></p></div></div>`
  });
}
