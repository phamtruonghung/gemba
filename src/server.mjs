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
import { loadSettings, checkSettings, saveSettings, SETTING_KEYS } from './settings.mjs';
import { checkExpert, checkInvite, checkInviteAcceptance } from './experts.mjs';
import * as views from './views.mjs';
import { parseCookies, isSecureRequest, sessionCookie, clearedSessionCookie, newSessionId, sessionExpiry, hashPassword, verifyPassword, checkEmail, checkPassword, checkName, SESSION_COOKIE } from './auth.mjs';

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
  // Extra env files, mostly for this author's host: GEMBA_ENV_FILE, then the Hermes profile, then
  // the working directory. None of them are required — a container or a systemd unit passes its own.
  const fileEnv = { ...readEnvFile(process.env.GEMBA_ENV_FILE || '/root/.hermes/.env'), ...readEnvFile('.env') };
  const merged = { ...fileEnv, ...env };
  const dataDir = merged.GEMBA_DATA_DIR || 'data';
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = `${dataDir}/admin.token`;
  let adminToken = merged.GEMBA_ADMIN_TOKEN;
  if (!adminToken) {
    if (existsSync(tokenFile)) adminToken = readFileSync(tokenFile, 'utf8').trim();
    else {
      adminToken = randomBytes(9).toString('hex');
      writeFileSync(tokenFile, adminToken);
    }
  }
  return {
    port: Number(merged.GEMBA_PORT || 8090),
    host: merged.GEMBA_HOST || '0.0.0.0',
    dbPath: merged.GEMBA_DB || `${dataDir}/gemba.db`,
    dataDir,
    adminToken,
    // Optional front gate. Set GEMBA_USER + GEMBA_PASS before publishing this to a public
    // hostname: the ask form calls a paid model, so an open instance is an open bill.
    user: merged.GEMBA_USER || '',
    pass: merged.GEMBA_PASS || '',
    bankBin: merged.GEMBA_BANK_BIN || '',
    bankAccount: merged.GEMBA_BANK_ACCOUNT || '',
    llm: llmConfig(merged)
  };
}

export function createApp({ dbPath, config = loadConfig(), rules = loadRules() } = {}) {
  // The configured path wins. GEMBA_DB / GEMBA_DATA_DIR are what the README, the systemd unit, the
  // installer and the container volume all describe, so the running app has to open *that* file.
  // (It used to default to a relative 'data/gemba.db', which silently ignored the configuration:
  // the service kept reading a file next to the source while the installer seeded, and the
  // container mounted, a different one — an empty corpus with no error anywhere.) Tests pass
  // ':memory:' explicitly; createApp({ dbPath }) still overrides for them.
  const db = dbm.openDb(dbPath ?? config.dbPath);
  let index = buildIndex(dbm.publishedNotes(db));
  const rebuildIndex = () => {
    index = buildIndex(dbm.publishedNotes(db));
    return index;
  };

  async function runAsk({ text, plant_type = '', asker = '', contact = '', topic = '', user_id = null }) {
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
      ai_mode: ai.mode,
      user_id
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
    const send = (code, html, headers = {}) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };
    // The session cookie is read once per request; `user` is the public shape (never the hash), and
    // every page that shows a nav needs it.
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '';
    const account = dbm.sessionUser(db, sessionId);
    const user = dbm.publicUser(account);
    const fail = (code, message) => send(code, views.errorPage({ code, message, user }));
    const withCookie = (to, id, secure) => {
      res.writeHead(303, { location: to, 'set-cookie': sessionCookie(id, { secure }) });
      res.end();
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
    // The gate exists for the *anonymous* surface: a public tunnel where every question spends a model
    // call. It is not a second password for people who already have an account — a shared password in
    // front of per-user accounts is the weakest link, and one that every expert has to hold is one that
    // leaks. So a request carrying a valid session passes, and the paths that exist *to* authenticate
    // stay open (otherwise nobody could ever sign in to become authenticated).
    const gateExempt = /^\/(signin|signup|admin\/login|invite\/[^/]+)$/.test(path);
    if (!gateExempt && !account && !basicAuthOk(req.headers.authorization, config)) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="gemba", charset="UTF-8"',
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      return res.end(views.unauthorizedPage());
    }

    // --- JSON API (used by tests and by anyone wiring this into a bot) ------
    if (path === '/api/ask' && method === 'POST') {
      const text = (json?.question ?? form.q ?? '').trim();
      if (!text) return sendJson(400, { error: 'missing question' });
      const out = await runAsk({
        text,
        plant_type: json?.plant_type ?? form.plant_type ?? '',
        asker: json?.asker ?? form.asker ?? account?.name ?? '',
        contact: json?.contact ?? form.contact ?? account?.email ?? '',
        topic: json?.topic ?? form.topic ?? '',
        user_id: account?.id ?? null
      });
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

    // --- accounts ----------------------------------------------------------
    if (path === '/signin' && method === 'GET') {
      if (account) return redirect('/account');
      return send(200, views.signInPage({ keep: url.searchParams.get('keep') ?? '', next: url.searchParams.get('next') ?? '', user }));
    }
    if (path === '/signup' && method === 'GET') {
      if (account) return redirect('/account');
      return send(200, views.signUpPage({ keep: url.searchParams.get('keep') ?? '', user }));
    }
    if (path === '/signin' && method === 'POST') {
      const email = String(form.email ?? '').trim();
      const password = String(form.password ?? '');
      const found = dbm.userByEmail(db, email);
      // A locked account is refused *after* the password check, not before: the person proved they own
      // the account, and "this account is locked — ask the operator" is a message they can act on,
      // where "wrong password" would send them round a loop that cannot succeed.
      if (found && (found.status ?? 'active') !== 'active' && (await verifyPassword(password, found.password_hash))) {
        dbm.logEvent(db, 'signin_locked', '', `user=${found.id}`);
        return send(403, views.signInPage({
          email, field: 'password', keep: String(form.keep ?? ''), user,
          error: 'This account is locked. Ask the operator to unlock it.'
        }));
      }
      // One message for both failures. Saying "no account with that email" tells a stranger which
      // addresses have accounts here, which is the whole of what they wanted to know.
      if (!found || !(await verifyPassword(password, found.password_hash))) {
        dbm.logEvent(db, 'signin_failed', '', `email=${email.slice(0, 60)}`);
        return send(401, views.signInPage({
          email,
          error: 'That email and password do not match an account.',
          field: 'password',
          keep: String(form.keep ?? ''),
          user
        }));
      }
      const id = newSessionId();
      dbm.createSession(db, { id, userId: found.id, expiresAt: sessionExpiry(), userAgent: req.headers['user-agent'] ?? '' });
      dbm.touchUser(db, found.id);
      dbm.logEvent(db, 'signin', '', `user=${found.id}`);
      // The guest question this person was looking at is claimed on the way through — the whole
      // point of signing in from that page.
      const keep = String(form.keep ?? '').trim();
      if (keep) dbm.claimQuestion(db, keep, found.id);
      const next = String(form.next ?? '').trim();
      return withCookie(keep ? `/q/${encodeURIComponent(keep)}` : next && next.startsWith('/') ? next : '/account', id, isSecureRequest(req));
    }
    if (path === '/signup' && method === 'POST') {
      const name = checkName(form.name);
      const email = checkEmail(form.email);
      const password = checkPassword(form.password);
      const reject = (check) =>
        send(400, views.signUpPage({ name: String(form.name ?? ''), email: String(form.email ?? ''), error: check.error, field: check.field, keep: String(form.keep ?? ''), user }));
      if (!name.ok) return reject(name);
      if (!email.ok) return reject(email);
      if (!password.ok) return reject(password);
      if (dbm.userByEmail(db, email.value)) {
        return send(409, views.signUpPage({
          name: name.value, email: email.value,
          error: 'There is already an account with that email — sign in instead.',
          field: 'email', keep: String(form.keep ?? ''), user
        }));
      }
      const created = dbm.createUser(db, { email: email.value, name: name.value, password_hash: await hashPassword(password.value) });
      const id = newSessionId();
      dbm.createSession(db, { id, userId: created.id, expiresAt: sessionExpiry(), userAgent: req.headers['user-agent'] ?? '' });
      dbm.logEvent(db, 'signup', '', `user=${created.id}`);
      const keep = String(form.keep ?? '').trim();
      if (keep) dbm.claimQuestion(db, keep, created.id);
      return withCookie(keep ? `/q/${encodeURIComponent(keep)}` : '/account', id, isSecureRequest(req));
    }
    if (path === '/signout' && method === 'POST') {
      if (sessionId) dbm.deleteSession(db, sessionId);
      res.writeHead(303, { location: '/', 'set-cookie': clearedSessionCookie({ secure: isSecureRequest(req) }) });
      return res.end();
    }
    if (path === '/account') {
      if (!account) return redirect('/signin?next=/account');
      return send(200, views.accountPage({
        user,
        questions: dbm.questionsForUser(db, account.id),
        bookings: dbm.bookingsForUser(db, account.id),
        sessions: dbm.countSessions(db, account.id),
        flash: url.searchParams.get('welcome') === '1' ? 'Account created — everything you ask from now on is kept here.' : ''
      }));
    }

    // --- operator: /admin, behind a session rather than a token in a URL ---
    // /qt/<token> stays exactly as it was (read, plus the two booking transitions): the operator has
    // that link bookmarked, and reconciling a payment is not the same power as creating people or
    // moving prices.
    if (path === '/admin/login') {
      if (method === 'POST') {
        const email = String(form.email ?? '').trim();
        const password = String(form.password ?? '');
        const found = dbm.userByEmail(db, email);
        if (!found || !(await verifyPassword(password, found.password_hash))) {
          dbm.logEvent(db, 'admin_login_failed', '', `email=${email.slice(0, 60)}`);
          return send(401, views.adminLoginPage({ email, error: 'That email and password do not match an operator account.' }));
        }
        if (found.role !== 'admin') {
          dbm.logEvent(db, 'admin_login_refused', '', `user=${found.id} reason=role`);
          return send(403, views.adminLoginPage({ email, error: 'That account is not an operator account.' }));
        }
        if ((found.status ?? 'active') !== 'active') {
          dbm.logEvent(db, 'admin_login_refused', '', `user=${found.id} reason=locked`);
          return send(403, views.adminLoginPage({ email, error: 'That account is locked.' }));
        }
        const id = newSessionId();
        dbm.createSession(db, { id, userId: found.id, expiresAt: sessionExpiry(), userAgent: req.headers['user-agent'] ?? '' });
        dbm.touchUser(db, found.id);
        dbm.logEvent(db, 'admin_login', '', `actor=${found.email}`);
        return withCookie('/admin', id, isSecureRequest(req));
      }
      if (account?.role === 'admin') return redirect('/admin');
      return send(200, views.adminLoginPage({ email: '', error: '' }));
    }
    if (path === '/admin/logout' && method === 'POST') {
      if (account) dbm.logEvent(db, 'admin_logout', '', `actor=${account.email}`);
      if (sessionId) dbm.deleteSession(db, sessionId);
      res.writeHead(303, { location: '/admin/login', 'set-cookie': clearedSessionCookie({ secure: isSecureRequest(req) }) });
      return res.end();
    }
    if (path === '/admin' || path.startsWith('/admin/')) {
      if (!account || account.role !== 'admin') return redirect(`/admin/login?next=${encodeURIComponent(path)}`);
      const actor = account.email;
      if (path === '/admin') {
        return send(200, views.adminOverviewPage({
          admin: account,
          stats: dbm.stats(db),
          settings: loadSettings(db),
          events: dbm.recentEvents(db, { limit: 20 }),
          flash: url.searchParams.get('saved') === '1' ? 'Saved.' : ''
        }));
      }
      if (path === '/admin/settings') {
        if (method === 'POST') {
          const check = checkSettings(form);
          if (!check.ok) {
            // Show back what was typed, not what is stored: the operator needs to see the typo.
            const shown = { ...loadSettings(db) };
            for (const key of SETTING_KEYS) if (form[key] !== undefined) shown[key] = String(form[key]);
            return send(400, views.adminSettingsPage({ admin: account, settings: shown, errors: check.errors, flash: '' }));
          }
          const changed = saveSettings(db, check.values, { actor });
          dbm.logEvent(db, 'setting', Object.keys(check.values).join(','), `actor=${actor} changed=${changed.join(' ') || 'nothing'}`);
          return redirect('/admin/settings?saved=1');
        }
        return send(200, views.adminSettingsPage({
          admin: account, settings: loadSettings(db), errors: {},
          flash: url.searchParams.get('saved') === '1' ? 'Saved. Prices use these immediately.' : ''
        }));
      }
      if (path === '/admin/audit') {
        const kind = url.searchParams.get('kind') ?? '';
        return send(200, views.adminAuditPage({
          admin: account, kind, events: dbm.recentEvents(db, { limit: 200, kind }), kinds: dbm.eventKinds(db)
        }));
      }
      // --- the practitioner roster -------------------------------------
      const rosterData = () => {
        const stats = dbm.expertStats(db);
        const pending = new Map();
        for (const inv of dbm.listInvites(db)) {
          if (!inv.accepted_at && inv.expert_id && !pending.has(inv.expert_id)) pending.set(inv.expert_id, inv);
        }
        return { experts: dbm.allExperts(db), stats, pending, topics: views.topicList(), settings: loadSettings(db) };
      };

      if (path === '/admin/experts' && method === 'POST') {
        const data = rosterData();
        const check = checkExpert(form, {
          topics: views.topicList().map(([slug]) => slug),
          defaultRate: data.settings.default_rate_vnd
        });
        if (!check.ok) {
          return send(400, views.adminExpertsPage({
            admin: account, ...data, errors: check.errors, draft: form, flash: ''
          }));
        }
        const slug = uniqueExpertSlug(db, slugify(check.values.name) || 'practitioner');
        const id = dbm.upsertExpert(db, { ...check.values, slug, token: newDeskToken(slug) });
        dbm.logEvent(db, 'expert', `expert:${id}`, `actor=${actor} created slug=${slug} rate=${check.values.rate_vnd} topics=${check.values.topics.join('|')}`);
        return redirect(`/admin/experts/${id}?added=1`);
      }
      if (path === '/admin/experts') {
        return send(200, views.adminExpertsPage({
          admin: account, ...rosterData(), errors: {}, draft: {},
          flash: url.searchParams.get('added') === '1' ? 'Practitioner added.' : ''
        }));
      }
      const exMatch = /^\/admin\/experts\/(\d+)(?:\/(invite|pause|resume|rotate))?$/.exec(path);
      if (exMatch) {
        const expertId = Number(exMatch[1]);
        const action = exMatch[2] ?? '';
        const expert = dbm.expertById(db, expertId);
        if (!expert) return fail(404, 'No such practitioner.');

        if (action === 'invite' && method === 'POST') {
          const check = checkInvite(form, { fallbackName: expert.name });
          if (!check.ok) {
            return send(400, views.adminExpertPage({
              admin: account, expert, stats: dbm.expertStats(db).get(expert.id),
              invite: dbm.pendingInviteForExpert(db, expert.id), topics: views.topicList(),
              errors: check.errors, draft: form, flash: ''
            }));
          }
          if (dbm.userByEmail(db, check.values.email)) {
            return send(409, views.adminExpertPage({
              admin: account, expert, stats: dbm.expertStats(db).get(expert.id),
              invite: dbm.pendingInviteForExpert(db, expert.id), topics: views.topicList(),
              draft: form, errors: { email: 'That address already has an account here — ask them to sign in at /signin.' }, flash: ''
            }));
          }
          const token = randomBytes(24).toString('base64url');
          const invite = dbm.createInvite(db, {
            token, email: check.values.email, name: check.values.name,
            expertId: expert.id, createdBy: actor
          });
          dbm.logEvent(db, 'invite', `expert:${expert.id}`, `actor=${actor} email=${invite.email} expires=${invite.expires_at.slice(0, 10)}`);
          return redirect(`/admin/experts/${expert.id}?invited=${encodeURIComponent(token)}`);
        }
        if ((action === 'pause' || action === 'resume') && method === 'POST') {
          const paused = action === 'pause';
          dbm.setExpertField(db, expert.id, 'accept_questions', paused ? 0 : 1);
          dbm.logEvent(db, 'expert', `expert:${expert.id}`, `actor=${actor} accept_questions=${paused ? 0 : 1}`);
          return redirect(`/admin/experts/${expert.id}`);
        }
        if (action === 'rotate' && method === 'POST') {
          const token = newDeskToken(expert.slug);
          dbm.setExpertField(db, expert.id, 'token', token);
          dbm.logEvent(db, 'expert', `expert:${expert.id}`, `actor=${actor} desk token rotated`);
          return redirect(`/admin/experts/${expert.id}?rotated=1`);
        }
        if (action === '') {
          if (method === 'POST') {
            const check = checkExpert(form, {
              topics: views.topicList().map(([slug]) => slug),
              defaultRate: loadSettings(db).default_rate_vnd
            });
            if (!check.ok) {
              return send(400, views.adminExpertPage({
                admin: account, expert, stats: dbm.expertStats(db).get(expert.id),
                invite: dbm.pendingInviteForExpert(db, expert.id), topics: views.topicList(),
                errors: check.errors, draft: form, flash: ''
              }));
            }
            const before = dbm.expertById(db, expert.id);
            dbm.updateExpert(db, expert.id, { ...check.values, status: before.status });
            const changes = [];
            if (before.rate_vnd !== check.values.rate_vnd) changes.push(`rate ${before.rate_vnd}→${check.values.rate_vnd}`);
            if (before.years !== check.values.years) changes.push(`years ${before.years}→${check.values.years}`);
            if (before.name !== check.values.name) changes.push('name');
            if (JSON.stringify(before.topics) !== JSON.stringify(check.values.topics)) changes.push(`topics ${check.values.topics.join('|')}`);
            if (before.accept_questions !== check.values.accept_questions) changes.push(`accept_questions=${check.values.accept_questions}`);
            dbm.logEvent(db, 'expert', `expert:${expert.id}`, `actor=${actor} changed=${changes.join(' ') || 'nothing'}`);
            return redirect(`/admin/experts/${expert.id}?saved=1`);
          }
          return send(200, views.adminExpertPage({
            admin: account, expert, stats: dbm.expertStats(db).get(expert.id),
            invite: dbm.pendingInviteForExpert(db, expert.id), topics: views.topicList(),
            errors: {}, draft: {},
            flash: url.searchParams.get('saved') === '1' ? 'Saved.'
              : url.searchParams.get('added') === '1' ? 'Practitioner added. Invite them so they can sign in.'
              : url.searchParams.get('rotated') === '1' ? 'A new desk link was generated. The old one no longer works.' : '',
            inviteLink: url.searchParams.get('invited') ? `/invite/${url.searchParams.get('invited')}` : ''
          }));
        }
        return fail(404, 'No such operator page.');
      }
      if (path === '/admin/invites') {
        return send(200, views.adminInvitesPage({
          admin: account, invites: dbm.listInvites(db).map((i) => ({ ...i, state: dbm.inviteState(i) })),
          flash: ''
        }));
      }

      return fail(404, 'No such operator page.');
    }

    // --- pages -------------------------------------------------------------
    if (path === '/') {
      return send(200, views.home({
        stats: dbm.stats(db),
        experts: dbm.listExperts(db),
        notes: dbm.publishedNotes(db).slice(-6).reverse(),
        questions: dbm.recentQuestions(db, 8),
        user
      }));
    }
    if (path === '/how-it-works') return send(200, views.howItWorksPage({ user }));
    if (path === '/experts') return send(200, views.expertListPage({ experts: dbm.listExperts(db), topics: views.topicList(), user }));
    if (path === '/library') return send(200, views.corpusPage({ notes: (() => { const t = url.searchParams.get('topic'); const all = dbm.publishedNotes(db); return t ? all.filter((n) => n.topic === t) : all; })(), topic: url.searchParams.get('topic') ?? '', topics: views.topicList(), user }));
    if (path.startsWith('/notes/')) {
      const slug = decodeURIComponent(path.slice('/notes/'.length));
      const note = dbm.noteBySlug(db, slug);
      if (!note || note.status !== 'published') return fail(404, 'No such note in the library.');
      const expert = note.expert_id ? dbm.listExperts(db).find((e) => e.id === note.expert_id) : null;
      // `[[wiki links]]` in a note name other notes by their vault name; resolve them against what
      // the library actually holds, under both the stored slug and its bare name.
      const links = new Map();
      for (const n of dbm.publishedNotes(db)) {
        links.set(n.slug, n.title);
        links.set(n.slug.replace(/^(vault|demo)-/, ''), n.title);
      }
      return send(200, views.notePage({ note, expert, user, links }));
    }
    if (path === '/ask' && method === 'POST') {
      const text = String(form.q ?? '').trim();
      if (!text) return fail(400, 'No question was entered.');
      const out = await runAsk({
        text,
        plant_type: form.plant_type ?? '',
        asker: String(form.asker ?? '').trim() || account?.name || '',
        contact: String(form.contact ?? '').trim() || account?.email || '',
        topic: form.topic ?? '',
        user_id: account?.id ?? null
      });
      return redirect(`/q/${out.question.ref}`);
    }

    // --- question page + escalation + booking ------------------------------
    const qMatch = /^\/q\/([^/]+)$/.exec(path);
    if (qMatch) {
      const q = dbm.questionByRef(db, decodeURIComponent(qMatch[1]));
      if (!q) return fail(404, 'No such question.');
      const ids = JSON.parse(q.ai_citations);
      const cited = ids.map((id) => dbm.publishedNotes(db).find((n) => n.id === id)).filter(Boolean);
      const owned = Boolean(account && q.user_id === account.id);
      return send(200, views.questionPage({
        q,
        aiCitations: cited,
        answers: dbm.answersFor(db, q.ref),
        experts: dbm.listExperts(db),
        routedNames: dbm.expertsForTopic(db, q.topic).map((e) => e.name),
        bankConfigured: Boolean(config.bankBin && config.bankAccount),
        user,
        claimed: owned
      }));
    }
    const escMatch = /^\/q\/([^/]+)\/ask-expert$/.exec(path);
    if (escMatch && method === 'POST') {
      const ref = decodeURIComponent(escMatch[1]);
      const q = dbm.questionByRef(db, ref);
      if (!q) return fail(404, 'No such question.');
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
      if (!expert) return fail(400, 'No valid expert selected.');
      const minutes = Number(form.minutes ?? 45);
      const moneySettings = loadSettings(db);
      let money;
      try {
        money = quote(expert.rate_vnd, minutes, moneySettings.platform_take_rate / 100, moneySettings.min_minutes);
      } catch (err) {
        return fail(400, String(err.message));
      }
      const q = ref ? dbm.questionByRef(db, ref) : null;
      const b = dbm.insertBooking(db, {
        expert_id: expert.id,
        user_id: account?.id ?? null,
        asker: String(form.asker ?? '').trim() || account?.name || 'guest',
        contact: String(form.contact ?? '').trim() || account?.email || '',
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
      if (!b) return fail(404, 'No such booking.');
      const instruction = config.bankBin && config.bankAccount
        ? transferInstruction({ bankBin: config.bankBin, account: config.bankAccount, amountVnd: b.price_vnd, ref: b.ref })
        : null;
      return send(200, views.bookingPage({ b, instruction, bankConfigured: Boolean(instruction), user }));
    }
    const paidMatch = /^\/b\/([^/]+)\/transferred$/.exec(path);
    if (paidMatch && method === 'POST') {
      const ref = decodeURIComponent(paidMatch[1]);
      const b = dbm.bookingByRef(db, ref);
      if (!b) return fail(404, 'No such booking.');
      if (b.status === 'requested') dbm.setBookingStatus(db, ref, 'awaiting_payment');
      return redirect(`/b/${ref}`);
    }

    // --- an invitation is the only way an account is created for a practitioner ---
    const invMatch = /^\/invite\/([^/]+)$/.exec(path);
    if (invMatch) {
      const invite = dbm.inviteByToken(db, decodeURIComponent(invMatch[1]));
      const state = dbm.inviteState(invite);
      if (state !== 'pending') {
        return send(state === 'unknown' ? 404 : 410, views.inviteDeadPage({ state, email: invite?.email ?? '' }));
      }
      const expert = invite.expert_id ? dbm.expertById(db, invite.expert_id) : null;
      if (method === 'POST') {
        if (dbm.userByEmail(db, invite.email)) {
          return send(409, views.invitePage({
            invite, expert, draft: form,
            errors: { password: 'An account already exists for this address. Sign in instead, or ask the operator for a new invitation.' }
          }));
        }
        const check = checkInviteAcceptance(form);
        if (!check.ok) return send(400, views.invitePage({ invite, expert, errors: check.errors, draft: form }));

        const created = dbm.createUser(db, {
          email: invite.email,
          name: check.values.name,
          password_hash: await hashPassword(check.values.password),
          role: 'expert'
        });
        if (invite.expert_id) dbm.linkExpertUser(db, invite.expert_id, created.id);
        dbm.acceptInvite(db, invite.id);
        dbm.logEvent(db, 'invite_accepted', `expert:${invite.expert_id ?? '-'}`, `actor=${invite.email} role=expert`);
        const id = newSessionId();
        dbm.createSession(db, { id, userId: created.id, expiresAt: sessionExpiry(), userAgent: req.headers['user-agent'] ?? '' });
        dbm.touchUser(db, created.id);
        return withCookie('/desk', id, isSecureRequest(req));
      }
      return send(200, views.invitePage({ invite, expert, errors: {}, draft: {} }));
    }

    // --- the desk, for a practitioner who signed in -------------------------
    if (path === '/desk') {
      if (!account) return redirect('/signin?next=/desk');
      const expert = dbm.expertByUser(db, account.id);
      if (!expert) return redirect('/experts');
      return send(200, views.expertWorkspacePage({
        expert,
        expertNotes: dbm.notesForExpert(db, expert.id),
        queue: dbm.openQuestionsFor(db, expert),
        bookings: dbm.bookingsFor(db, { expertId: expert.id })
      }));
    }

    // --- expert workspace --------------------------------------------------
    const cMatch = /^\/c\/([^/]+)(\/[a-z-]+)?$/.exec(path);
    if (cMatch) {
      const token = decodeURIComponent(cMatch[1]);
      const sub = cMatch[2] ?? '';
      const expert = dbm.expertByToken(db, token);
      if (!expert) return fail(404, 'This link is not valid.');

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
          if (!it || it.expert_id !== expert.id) return fail(404, 'That interview session is not valid.');
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
      if (token !== config.adminToken) return fail(404, 'No such page.');
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
        answerable: db.prepare(`select * from questions where status = 'routed'`).all().filter((q) => !answered.has(q.id)),
        accounts: dbm.countUsers(db),
        user
      }));
    }

    return fail(404, `There is no page ${path}.`);
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
      res.end(fail(500, String(err?.message ?? err)));
    }
  });

  return { server, db, index: () => index, rebuildIndex, runAsk, escalate: escalate(), config, rules };
}

/** A slug nobody has taken. `uniqueSlug` below is for notes; practitioners need their own. */
function uniqueExpertSlug(db, base) {
  const taken = new Set(dbm.allExperts(db).map((e) => e.slug));
  let slug = base;
  let i = 2;
  while (taken.has(slug)) {
    slug = `${base}-${i}`;
    i += 1;
  }
  return slug;
}

/** The desk token: recognisable at a glance, unguessable in practice. */
const newDeskToken = (slug) => `${slug.slice(0, 16).replace(/-+$/, '')}-${randomBytes(5).toString('hex')}`;

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
    console.log(`Gemba listening on http://${app.config.host}:${app.config.port}`);
    console.log(`  notes indexed: ${app.index().n}`);
    console.log(`  AI tier: ${app.config.llm.enabled ? `model ${app.config.llm.model}` : 'no API key — extractive fallback only'}`);
    console.log(`  bank: ${bankBin && bankAccount ? `${bankBin}/${bankAccount}` : 'NOT configured — booking pages show no QR'}`);
    console.log(`  admin: /qt/${app.config.adminToken}`);
  });
}

export { formatVnd, suggestRateVnd, MIN_MINUTES, checkNote, slugify };
