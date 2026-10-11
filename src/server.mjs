// src/server.mjs — the app: routing, the ladder (ask → escalate → pay), expert and admin surfaces.
// Zero dependencies: node:http + node:sqlite.

import http from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import * as dbm from './db.mjs';
import { checkNote, decidePublication, loadRules } from './gate.mjs';
import { buildIndex, search, coverage } from './retrieval.mjs';
import { askFromCorpus, llmConfig } from './llm.mjs';
import { quote, formatVnd, MIN_MINUTES, transferInstruction, suggestRateVnd } from './pricing.mjs';
import { questionAt, draftNoteFromInterview, slugify, SCRIPT } from './interview.mjs';
import * as views from './views.mjs';

const ROUTE_DUE_HOURS = 48;

// Constant-time compare; lengths are allowed to differ (a length leak is not the secret).
function sameSecret(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function basicAuthOk(header, { user, pass }) {
  if (!user || !pass) return true;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return sameSecret(decoded.slice(0, i), user) && sameSecret(decoded.slice(i + 1), pass);
}
const MAX_EXPERTS_PER_QUESTION = 3;

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadConfig(env = process.env) {
  const fileEnv = { ...readEnvFile('/root/.hermes/.env'), ...readEnvFile('.env') };
  const merged = { ...fileEnv, ...env };
  const dataDir = merged.XUONG_DATA_DIR || 'data';
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = `${dataDir}/admin.token`;
  let adminToken = merged.XUONG_ADMIN_TOKEN;
  if (!adminToken) {
    if (existsSync(tokenFile)) adminToken = readFileSync(tokenFile, 'utf8').trim();
    else {
      adminToken = randomBytes(9).toString('hex');
      writeFileSync(tokenFile, adminToken);
    }
  }
  return {
    port: Number(merged.XUONG_PORT || 8090),
    host: merged.XUONG_HOST || '0.0.0.0',
    dbPath: merged.XUONG_DB || `${dataDir}/xuong.db`,
    dataDir,
    adminToken,
    // Optional front gate. Set XUONG_USER + XUONG_PASS before publishing this to a public
    // hostname: the ask form calls a paid model, so an open instance is an open bill.
    user: merged.XUONG_USER || '',
    pass: merged.XUONG_PASS || '',
    bankBin: merged.XUONG_BANK_BIN || '',
    bankAccount: merged.XUONG_BANK_ACCOUNT || '',
    llm: llmConfig(merged)
  };
}

export function createApp({ dbPath, config = loadConfig(), rules = loadRules() } = {}) {
  // The configured path wins. XUONG_DB / XUONG_DATA_DIR are what the README, the systemd unit, the
  // installer and the container volume all describe, so the running app has to open *that* file.
  // (It used to default to a relative 'data/xuong.db', which silently ignored the configuration:
  // the service kept reading a file next to the source while the installer seeded, and the
  // container mounted, a different one — an empty corpus with no error anywhere.) Tests pass
  // ':memory:' explicitly; createApp({ dbPath }) still overrides for them.
  const db = dbm.openDb(dbPath ?? config.dbPath);
  let index = buildIndex(dbm.publishedNotes(db));
  const rebuildIndex = () => {
    index = buildIndex(dbm.publishedNotes(db));
    return index;
  };

  async function runAsk({ text, plant_type = '', asker = '', contact = '', topic = '' }) {
    const hits = search(text, index, 5);
    const cov = coverage(text, hits, index);
    const inferredTopic = topic || hits[0]?.note?.topic || 'other';
    const ai = await askFromCorpus({ question: text, hits, plantType: plant_type, coverageVerdict: cov, cfg: config.llm });
    const q = dbm.insertQuestion(db, {
      asker,
      contact,
      plant_type,
      topic: inferredTopic,
      text,
      ai_answer: ai.answer,
      ai_citations: ai.citations,
      ai_coverage: ai.coverage,
      ai_mode: ai.mode
    });
    dbm.logEvent(db, 'ask', q.ref, `coverage=${ai.coverage} mode=${ai.mode} hits=${hits.length}`);
    return { question: q, hits, ai, cov };
  }

  function escalate(emailOf) {
    return (ref, contact) => {
      const q = dbm.questionByRef(db, ref);
      if (!q) return null;
      const pool = dbm.expertsForTopic(db, q.topic).slice(0, MAX_EXPERTS_PER_QUESTION);
      const due = new Date(Date.now() + ROUTE_DUE_HOURS * 3600 * 1000).toISOString();
      const routed = pool.length ? pool : dbm.listExperts(db).slice(0, 1);
      const updated = dbm.routeQuestion(db, ref, routed.map((e) => e.id), due);
      dbm.logEvent(db, 'escalate', ref, `-> ${routed.map((e) => e.slug).join(', ')} due ${due}`);
      return { question: updated, routed };
    };
  }

  async function handle(req, res, body) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const form = body.form ?? {};
    const json = body.json ?? null;
    const send = (code, html) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    const sendJson = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj, null, 2));
    };
    const redirect = (to) => {
      res.writeHead(303, { location: to });
      res.end();
    };

    // --- health (the only path that answers without the front gate) --------
    if (path === '/healthz') return sendJson(200, { ok: true, notes: index.n, llm: config.llm.enabled ? 'configured' : 'none' });

    // --- front gate: optional HTTP basic auth ------------------------------
    if (!basicAuthOk(req.headers.authorization, config)) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="xuong", charset="UTF-8"',
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      return res.end(views.unauthorizedPage());
    }

    // --- JSON API (used by tests and by anyone wiring this into a bot) ------
    if (path === '/api/ask' && method === 'POST') {
      const text = (json?.question ?? form.q ?? '').trim();
      if (!text) return sendJson(400, { error: 'missing question' });
      const out = await runAsk({ text, plant_type: json?.plant_type ?? form.plant_type ?? '', asker: json?.asker ?? form.asker ?? '', contact: json?.contact ?? form.contact ?? '', topic: json?.topic ?? form.topic ?? '' });
      return sendJson(200, {
        ref: out.question.ref,
        topic: out.question.topic,
        answer: out.question.ai_answer,
        citations: JSON.parse(out.question.ai_citations).map((id) => {
          const n = dbm.publishedNotes(db).find((x) => x.id === id);
          return n ? { id, slug: n.slug, title: n.title } : { id };
        }),
        coverage: out.question.ai_coverage,
        mode: out.question.ai_mode,
        hits: out.hits.map((h) => ({ slug: h.note.slug, title: h.note.title, score: h.score })),
        why: out.cov.why
      });
    }
    if (path.startsWith('/api/question/') && method === 'GET') {
      const ref = decodeURIComponent(path.slice('/api/question/'.length));
      const q = dbm.questionByRef(db, ref);
      if (!q) return sendJson(404, { error: 'not found' });
      return sendJson(200, { ...q, ai_citations: JSON.parse(q.ai_citations), answers: dbm.answersFor(db, ref) });
    }
    if (path === '/api/experts' && method === 'GET') {
      return sendJson(200, dbm.listExperts(db).map((e) => ({ slug: e.slug, name: e.name, topics: e.topics, rate_vnd: e.rate_vnd })));
    }

    // --- pages -------------------------------------------------------------
    if (path === '/') {
      return send(200, views.home({
        stats: dbm.stats(db),
        experts: dbm.listExperts(db),
        notes: dbm.publishedNotes(db).slice(-6).reverse(),
        questions: dbm.recentQuestions(db, 8)
      }));
    }
    if (path === '/how-it-works') return send(200, views.howItWorksPage());
    if (path === '/experts') return send(200, views.expertListPage({ experts: dbm.listExperts(db), topics: views.topicList() }));
    if (path === '/library') return send(200, views.corpusPage({ notes: (() => { const t = url.searchParams.get('topic'); const all = dbm.publishedNotes(db); return t ? all.filter((n) => n.topic === t) : all; })(), topic: url.searchParams.get('topic') ?? '', topics: views.topicList() }));
    if (path.startsWith('/notes/')) {
      const slug = decodeURIComponent(path.slice('/notes/'.length));
      const note = dbm.noteBySlug(db, slug);
      if (!note || note.status !== 'published') return send(404, views.errorPage({ code: 404, message: 'No such note in the library.' }));
      const expert = note.expert_id ? dbm.listExperts(db).find((e) => e.id === note.expert_id) : null;
      return send(200, views.notePage({ note, expert }));
    }
    if (path === '/ask' && method === 'POST') {
      const text = String(form.q ?? '').trim();
      if (!text) return send(400, views.errorPage({ code: 400, message: 'No question was entered.' }));
      const out = await runAsk({ text, plant_type: form.plant_type ?? '', asker: form.asker ?? '', contact: form.contact ?? '', topic: form.topic ?? '' });
      return redirect(`/q/${out.question.ref}`);
    }

    // --- question page + escalation + booking ------------------------------
    const qMatch = /^\/q\/([^/]+)$/.exec(path);
    if (qMatch) {
      const q = dbm.questionByRef(db, decodeURIComponent(qMatch[1]));
      if (!q) return send(404, views.errorPage({ code: 404, message: 'No such question.' }));
      const ids = JSON.parse(q.ai_citations);
      const cited = ids.map((id) => dbm.publishedNotes(db).find((n) => n.id === id)).filter(Boolean);
      return send(200, views.questionPage({
        q,
        aiCitations: cited,
        answers: dbm.answersFor(db, q.ref),
        experts: dbm.listExperts(db),
        routedNames: dbm.expertsForTopic(db, q.topic).map((e) => e.name),
        bankConfigured: Boolean(config.bankBin && config.bankAccount)
      }));
    }
    const escMatch = /^\/q\/([^/]+)\/ask-expert$/.exec(path);
    if (escMatch && method === 'POST') {
      const ref = decodeURIComponent(escMatch[1]);
      const q = dbm.questionByRef(db, ref);
      if (!q) return send(404, views.errorPage({ code: 404, message: 'No such question.' }));
      if (q.contact === '' && (form.contact ?? '')) {
        db.prepare('update questions set contact = ?, asker = ? where ref = ?').run(String(form.contact), String(form.asker ?? ''), ref);
      }
      escalate()(ref, form.contact);
      return redirect(`/q/${ref}`);
    }
    const bookFromQ = /^\/q\/([^/]+)\/book$/.exec(path);
    if (bookFromQ && method === 'POST') return createBooking(send, redirect, { ref: decodeURIComponent(bookFromQ[1]), form });
    if (path === '/book' && method === 'POST') return createBooking(send, redirect, { ref: '', form });

    function createBooking(send, redirect, { ref, form }) {
      const expertSlug = String(form.expert ?? '');
      const expert = dbm.listExperts(db).find((e) => e.slug === expertSlug);
      if (!expert) return send(400, views.errorPage({ code: 400, message: 'No valid expert selected.' }));
      const minutes = Number(form.minutes ?? 45);
      let money;
      try {
        money = quote(expert.rate_vnd, minutes);
      } catch (err) {
        return send(400, views.errorPage({ code: 400, message: String(err.message) }));
      }
      const q = ref ? dbm.questionByRef(db, ref) : null;
      const b = dbm.insertBooking(db, {
        expert_id: expert.id,
        asker: String(form.asker ?? '').trim() || 'guest',
        contact: String(form.contact ?? '').trim(),
        topic: String(form.topic ?? q?.topic ?? 'other'),
        agenda: String(form.agenda ?? q?.text ?? '').slice(0, 1000),
        starts_at: String(form.starts_at ?? '').trim(),
        minutes: money.minutes,
        price_vnd: money.price_vnd,
        fee_vnd: money.fee_vnd,
        payout_vnd: money.payout_vnd
      });
      dbm.logEvent(db, 'booking', b.ref, `${expert.slug} ${minutes}p ${money.price_vnd}`);
      return redirect(`/b/${b.ref}`);
    }

    const bMatch = /^\/b\/([^/]+)$/.exec(path);
    if (bMatch) {
      const b = dbm.bookingByRef(db, decodeURIComponent(bMatch[1]));
      if (!b) return send(404, views.errorPage({ code: 404, message: 'No such booking.' }));
      const instruction = config.bankBin && config.bankAccount
        ? transferInstruction({ bankBin: config.bankBin, account: config.bankAccount, amountVnd: b.price_vnd, ref: b.ref })
        : null;
      return send(200, views.bookingPage({ b, instruction, bankConfigured: Boolean(instruction) }));
    }
    const paidMatch = /^\/b\/([^/]+)\/transferred$/.exec(path);
    if (paidMatch && method === 'POST') {
      const ref = decodeURIComponent(paidMatch[1]);
      const b = dbm.bookingByRef(db, ref);
      if (!b) return send(404, views.errorPage({ code: 404, message: 'No such booking.' }));
      if (b.status === 'requested') dbm.setBookingStatus(db, ref, 'awaiting_payment');
      return redirect(`/b/${ref}`);
    }

    // --- expert workspace --------------------------------------------------
    const cMatch = /^\/c\/([^/]+)(\/[a-z-]+)?$/.exec(path);
    if (cMatch) {
      const token = decodeURIComponent(cMatch[1]);
      const sub = cMatch[2] ?? '';
      const expert = dbm.expertByToken(db, token);
      if (!expert) return send(404, views.errorPage({ code: 404, message: 'This link is not valid.' }));

      if (sub === '' && method === 'GET') {
        return send(200, views.expertWorkspacePage({
          expert,
          expertNotes: dbm.notesForExpert(db, expert.id),
          queue: dbm.openQuestionsFor(db, expert),
          bookings: dbm.bookingsFor(db, { expertId: expert.id })
        }));
      }
      if (sub === '/answer' && method === 'POST') {
        const ref = String(form.ref ?? '');
        const text = String(form.body ?? '').trim();
        if (ref && text) dbm.addAnswer(db, { questionRef: ref, expertId: expert.id, body: text });
        return redirect(`/c/${expert.token}`);
      }
      if (sub === '/note' && method === 'POST') {
        const title = String(form.title ?? '').trim();
        const topic = String(form.topic ?? 'other');
        const text = String(form.body ?? '');
        const attested = form.attested === '1' || form.attested === 'on';
        const decision = decidePublication({ title, body: text }, { attested, rules });
        const slug = uniqueSlug(db, slugify(title));
        dbm.upsertNote(db, {
          expert_id: expert.id,
          slug,
          title,
          topic,
          body: text,
          status: decision.publish ? 'published' : 'blocked',
          gate: decision.report,
          origin: 'expert'
        });
        rebuildIndex();
        dbm.logEvent(db, 'note_submit', slug, `${decision.reason} findings=${decision.report.findings.length}`);
        if (!decision.publish) {
          return send(422, views.blockedNotePage({ expert, decision, title }));
        }
        return redirect(`/notes/${slug}`);
      }
      if (sub === '/interview') {
        if (method === 'POST') {
          const id = Number(form.id);
          const it = dbm.interviewById(db, id);
          if (!it || it.expert_id !== expert.id) return send(404, views.errorPage({ code: 404, message: 'That interview session is not valid.' }));
          const advanced = dbm.advanceInterview(db, id, String(form.answer ?? '').trim());
          if (advanced.step >= SCRIPT.length) {
            const answers = JSON.parse(advanced.answers);
            // The title comes from the problem the expert described (question 2), not from the
            // topic slug: a corpus of notes all called "Field notes: tpm" is unusable.
            const problem = String(answers[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
            const title = `Field notes: ${problem || advanced.topic}`;
            const draft = draftNoteFromInterview({ expert, topic: advanced.topic, answers, title });
            const decision = decidePublication({ title: draft.title, body: draft.body }, { attested: true, rules });
            const slug = uniqueSlug(db, slugify(`${advanced.topic}-${String(answers[0] ?? '').slice(0, 30)}`));
            const noteId = dbm.upsertNote(db, {
              expert_id: expert.id,
              slug,
              title: draft.title,
              topic: advanced.topic,
              body: draft.body,
              status: decision.publish ? 'published' : 'blocked',
              gate: decision.report,
              origin: 'interview'
            });
            dbm.finishInterview(db, id, noteId);
            rebuildIndex();
            dbm.logEvent(db, 'interview_done', slug, decision.reason);
            if (!decision.publish) {
              // An interview whose draft fails the gate says so, with the reasons: the expert
              // just spent eight answers, and a silent return to the form reads as a bug.
              return send(422, views.blockedNotePage({ expert, decision, title: draft.title }));
            }
            return send(200, views.interviewPage({ expert, interview: advanced, step: advanced.step, question: null, answers, doneNoteSlug: slug }));
          }
          return redirect(`/c/${expert.token}/interview?id=${id}`);
        }
        const idParam = Number(url.searchParams.get('id'));
        let it = idParam ? dbm.interviewById(db, idParam) : null;
        if (!it || it.expert_id !== expert.id) it = dbm.startInterview(db, { expertId: expert.id, topic: expert.topics[0] ?? 'other' });
        const answers = JSON.parse(it.answers);
        return send(200, views.interviewPage({ expert, interview: it, step: it.step, question: questionAt(it.step), answers }));
      }
    }

    // --- admin -------------------------------------------------------------
    const aMatch = /^\/qt\/([^/]+)(\/[a-z-]+)?$/.exec(path);
    if (aMatch) {
      const token = decodeURIComponent(aMatch[1]);
      const sub = aMatch[2] ?? '';
      if (token !== config.adminToken) return send(404, views.errorPage({ code: 404, message: 'No such page.' }));
      if (sub === '/confirm' && method === 'POST') {
        const ref = String(form.ref ?? '');
        const b = dbm.bookingByRef(db, ref);
        if (b && b.status === 'awaiting_payment') dbm.setBookingStatus(db, ref, 'paid');
        else if (b && b.status === 'requested') {
          dbm.setBookingStatus(db, ref, 'awaiting_payment');
          dbm.setBookingStatus(db, ref, 'paid');
        }
        return redirect(`/qt/${token}`);
      }
      if (sub === '/complete' && method === 'POST') {
        const ref = String(form.ref ?? '');
        const b = dbm.bookingByRef(db, ref);
        if (b && b.status === 'paid') dbm.setBookingStatus(db, ref, 'completed');
        return redirect(`/qt/${token}`);
      }
      const answered = new Set(db.prepare('select distinct question_id from answers').all().map((r) => r.question_id));
      return send(200, views.adminPage({
        token,
        stats: dbm.stats(db),
        pendingBookings: dbm.bookingsFor(db, {}).filter((b) => b.status !== 'cancelled'),
        blockedNotes: db.prepare(`select * from notes where status = 'blocked' order by id desc`).all(),
        openQuestions: dbm.recentQuestions(db, 30),
        answerable: db.prepare(`select * from questions where status = 'routed'`).all().filter((q) => !answered.has(q.id))
      }));
    }

    return send(404, views.errorPage({ code: 404, message: `There is no page ${path}.` }));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      let form = {};
      let json = null;
      const ctype = String(req.headers['content-type'] ?? '');
      if (raw && ctype.includes('application/json')) {
        try { json = JSON.parse(raw); } catch { json = null; }
      } else if (raw) {
        form = Object.fromEntries(new URLSearchParams(raw));
      }
      await handle(req, res, { form, json });
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(views.errorPage({ code: 500, message: String(err?.message ?? err) }));
    }
  });

  return { server, db, index: () => index, rebuildIndex, runAsk, escalate: escalate(), config, rules };
}

function uniqueSlug(db, base) {
  let slug = base;
  let i = 2;
  while (dbm.noteBySlug(db, slug)) {
    slug = `${base}-${i}`;
    i += 1;
  }
  return slug;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.server.listen(app.config.port, app.config.host, () => {
    const { bankBin, bankAccount } = app.config;
    console.log(`Xuong listening on http://${app.config.host}:${app.config.port}`);
    console.log(`  notes indexed: ${app.index().n}`);
    console.log(`  AI tier: ${app.config.llm.enabled ? `model ${app.config.llm.model}` : 'no API key — extractive fallback only'}`);
    console.log(`  bank: ${bankBin && bankAccount ? `${bankBin}/${bankAccount}` : 'NOT configured — booking pages show no QR'}`);
    console.log(`  admin: /qt/${app.config.adminToken}`);
  });
}

export { formatVnd, suggestRateVnd, MIN_MINUTES, checkNote, slugify };
