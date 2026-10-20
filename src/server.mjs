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
import { cachePolicy, buildServiceWorker, MANIFEST, PUBLIC_DIR } from './pwa.mjs';
import { serveStatic } from './static.mjs';
import { parseCookies, isSecureRequest, sessionCookie, clearedSessionCookie, newSessionId, sessionExpiry, hashPassword, verifyPassword, checkEmail, checkPassword, checkName, SESSION_COOKIE } from './auth.mjs';

const ROUTE_DUE_HOURS = 48;
const TEXT_COOKIE = 'gemba_text';
const PLACE_COOKIE = 'gemba_place';
const prefCookie = (name, value, secure) =>
  `${name}=${value}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
/** A same-origin path or '/': one leading slash, never `//` or `/\\` (both are protocol-relative to a browser). */
export function safeNext(next) {
  const n = String(next ?? '');
  return /^\/(?![/\\])/.test(n) && !/[\r\n\0]/.test(n) ? n : '/';
}

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
  // The worker's source and version are fixed at start: the version hashes the template, views.mjs and
  // public/, so a deploy that changes any of them gives clients a new cache name and drops the old ones.
  const sw = buildServiceWorker();
  const manifestJson = JSON.stringify(MANIFEST);
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
      // The numbered citations with their snippets, not bare ids: the page must show [1]..[k] and a real excerpt.
      ai_citations: ai.cites,
      ai_coverage: ai.coverage,
      ai_mode: ai.mode,
      ai_missing: ai.missing,
      user_id
    });
    dbm.logEvent(db, 'ask', q.ref, `coverage=${ai.coverage} mode=${ai.mode} hits=${hits.length}`);
    return { question: q, hits, ai, cov };
  }

  // Stored citations are { n, id, snippet }. Rows written before the snippet existed hold bare note ids;
  // they are numbered by position and given the opening of the note as their excerpt.
  function citedNotes(raw) {
    const published = dbm.publishedNotes(db);
    return JSON.parse(raw || '[]')
      .map((c, i) => {
        const entry = typeof c === 'object' && c !== null ? c : { id: c, n: i + 1, snippet: '' };
        const note = published.find((x) => x.id === entry.id);
        if (!note) return null;
        const snippet = entry.snippet || note.body.replace(/[#>*_`\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        return { n: entry.n ?? i + 1, id: note.id, slug: note.slug, title: note.title, snippet };
      })
      .filter(Boolean);
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
    // Reader preferences are plain cookies (not identity): text size scales the reading text, and the
    // place is "<note slug>#<heading id>". Both are validated when read, never trusted.
    const cookies = parseCookies(req.headers.cookie);
    const textSize = ['normal', 'large', 'xl'].includes(cookies[TEXT_COOKIE]) ? cookies[TEXT_COOKIE] : 'normal';
    const send = (code, html, headers = {}) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(typeof html === 'string' ? views.withTextSize(html, textSize) : html);
    };
    // Absolute URL of this request's page, for the share block. x-forwarded-proto is honoured the way
    // the session cookie honours it; the Host header is used only if it looks like a host.
    const hostHeader = String(req.headers.host ?? '');
    const origin = `${isSecureRequest(req) ? 'https' : 'http'}://${/^[A-Za-z0-9.:\-\[\]]{1,255}$/.test(hostHeader) ? hostHeader : 'localhost'}`;
    // The session cookie is read once per request; `user` is the public shape (never the hash), and
    // every page that shows a nav needs it.
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '';
    const account = dbm.sessionUser(db, sessionId);
    const user = dbm.publicUser(account);
    // Central cache rule for the service worker (src/pwa.mjs). The worker cannot see Set-Cookie, so
    // every response that sets one, every response on a never-cache path, and every page rendered for a
    // signed-in person (except a note, which stays cacheable: offline notes are the point and the sign-out
    // purge covers a shared phone) says `private, no-store` here, once, whichever route produced it. A route that
    // sets its own cache-control (the static files, sw.js, the 401) is left alone.
    const writeHead = res.writeHead;
    res.writeHead = function (code, headers = {}) {
      const keys = Object.keys(headers).map((k) => k.toLowerCase());
      if (!keys.includes('cache-control')) {
        const policy = cachePolicy(path, method);
        const html = String(headers['content-type'] ?? '').startsWith('text/html');
        if (keys.includes('set-cookie') || policy === 'none' || policy === 'network-first' || (account && html && policy !== 'swr')) {
          headers = { ...headers, 'cache-control': 'private, no-store' };
        }
      }
      return writeHead.call(this, code, headers);
    };
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
    // The PWA files are exempt too: a browser fetches the manifest, the worker script and the icons
    // without credentials, so a gated instance would otherwise never be installable. All five are
    // public by construction: the manifest and sw.js are generated from constants and the repo's own
    // source, the icons are static art, and /offline renders the signed-out frame with no data.
    const gateExempt = /^\/(signin|signup|admin\/login|invite\/[^/]+|manifest\.webmanifest|sw\.js|offline|icons\/[A-Za-z0-9._-]+)$/.test(path);
    if (!gateExempt && !account && !basicAuthOk(req.headers.authorization, config)) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="gemba", charset="UTF-8"',
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      return res.end(views.unauthorizedPage());
    }

    // --- installable-app files: manifest, worker, offline page, icons ------
    if ((path === '/manifest.webmanifest' || path === '/sw.js') && (method === 'GET' || method === 'HEAD')) {
      const isSw = path === '/sw.js';
      res.writeHead(200, {
        'content-type': isSw ? 'text/javascript; charset=utf-8' : 'application/manifest+json',
        'cache-control': isSw ? 'no-cache' : 'public, max-age=86400',
        ...(isSw ? { 'service-worker-allowed': '/' } : {})
      });
      return res.end(method === 'HEAD' ? undefined : isSw ? sw.source : manifestJson);
    }
    if (path === '/offline' && method === 'GET') return send(200, views.offlinePage());

    // --- reader preferences: both answer with a cookie, so both are `no-store` -----------------
    if (path === '/prefs/text' && method === 'POST') {
      const size = ['normal', 'large', 'xl'].includes(form.size) ? form.size : 'normal';
      res.writeHead(303, { location: safeNext(form.next), 'set-cookie': prefCookie(TEXT_COOKIE, size, isSecureRequest(req)) });
      return res.end();
    }
    const placeMatch = /^\/notes\/([^/]+)\/place$/.exec(path);
    if (placeMatch && method === 'POST') {
      const note = dbm.noteBySlug(db, decodeURIComponent(placeMatch[1]));
      if (!note || note.status !== 'published') return fail(404, 'No such note in the library.');
      const outline = [];
      views.renderNoteBody(note, outline);
      const id = String(form.section ?? '');
      // The section must be a heading of this very note; anything else keeps the place at the note's top.
      const ok = outline.some((h) => h.id === id);
      const target = `/notes/${encodeURIComponent(note.slug)}${ok ? `#${id}` : ''}`;
      res.writeHead(303, { location: target, ...(ok ? { 'set-cookie': prefCookie(PLACE_COOKIE, `${note.slug}#${id}`, isSecureRequest(req)) } : {}) });
      return res.end();
    }
    // "Continue reading": the saved place, only if it still names a published note and a real heading.
    const placeOf = () => {
      const m = /^([^#]+)#([a-z0-9-]+)$/.exec(cookies[PLACE_COOKIE] ?? '');
      if (!m) return null;
      const note = dbm.noteBySlug(db, m[1]);
      if (!note || note.status !== 'published') return null;
      const outline = [];
      views.renderNoteBody(note, outline);
      return outline.some((h) => h.id === m[2]) ? { slug: note.slug, id: m[2], title: note.title } : null;
    };
    if (path.startsWith('/icons/') && serveStatic(req, res, { root: PUBLIC_DIR, rawPath: (req.url ?? '').split('?')[0] })) return;

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
        citations: citedNotes(out.question.ai_citations).map((c) => ({ n: c.n, id: c.id, slug: c.slug, title: c.title, snippet: c.snippet })),
        coverage: out.question.ai_coverage,
        mode: out.question.ai_mode,
        missing: out.question.ai_missing,
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
      // --- accounts: who exists, what they are, and stopping them ----------
      if (path === '/admin/accounts' && method === 'POST') {
        // An operator account is invited, never handed a password the first operator picked: the
        // person who will use it chooses it, and the invitation is single-use like any other.
        const check = checkInvite(form, { fallbackName: '' });
        const role = form.role === 'admin' ? 'admin' : 'expert';
        if (!check.ok) {
          return send(400, views.adminAccountsPage({
            admin: account, users: dbm.allUsers(db), q: '', flash: '',
            errors: check.errors, draft: form
          }));
        }
        if (dbm.userByEmail(db, check.values.email)) {
          return send(409, views.adminAccountsPage({
            admin: account, users: dbm.allUsers(db), q: '', flash: '',
            errors: { email: 'That address already has an account here.' }, draft: form
          }));
        }
        const token = randomBytes(24).toString('base64url');
        dbm.createInvite(db, { token, email: check.values.email, name: check.values.name, expertId: null, role, createdBy: actor });
        dbm.logEvent(db, 'account', `invite:${role}`, `actor=${actor} invited=${check.values.email}`);
        return redirect(`/admin/invites?invited=${encodeURIComponent(check.values.email)}`);
      }
      if (path === '/admin/accounts') {
        return send(200, views.adminAccountsPage({
          admin: account, users: dbm.allUsers(db, { q: url.searchParams.get('q') ?? '' }),
          q: url.searchParams.get('q') ?? '', errors: {}, draft: {},
          flash: url.searchParams.get('locked') ? 'Account locked and signed out everywhere.'
            : url.searchParams.get('unlocked') ? 'Account unlocked.'
            : url.searchParams.get('role') ? 'Role changed.'
            : url.searchParams.get('signout') ? 'Every session for that account was ended.' : ''
        }));
      }
      const accMatch = /^\/admin\/accounts\/(\d+)\/(role|lock|unlock|signout)$/.exec(path);
      if (accMatch && method === 'POST') {
        const target = dbm.userById(db, Number(accMatch[1]));
        if (!target) return fail(404, 'No such account.');
        const action = accMatch[2];
        const self = target.id === account.id;
        const lastAdmin = target.role === 'admin' && target.status === 'active' && dbm.countActiveAdmins(db) <= 1;

        if (action === 'lock') {
          // Locking the account you are signed in as is a mistake nobody can undo from inside the
          // console, and locking the last operator locks everybody out of it. Both are refused.
          if (self) return fail(400, 'You cannot lock the account you are signed in as.');
          if (lastAdmin) return fail(400, 'That is the last operator who can sign in. Invite another operator first.');
          dbm.setUserStatus(db, target.id, 'locked');
          // A lock that leaves live sessions running is a claim about the future, not about now.
          const ended = dbm.deleteSessionsForUser(db, target.id);
          dbm.logEvent(db, 'account', `user:${target.id}`, `actor=${actor} locked=${target.email} sessions_ended=${ended}`);
          return redirect('/admin/accounts?locked=1');
        }
        if (action === 'unlock') {
          dbm.setUserStatus(db, target.id, 'active');
          dbm.logEvent(db, 'account', `user:${target.id}`, `actor=${actor} unlocked=${target.email}`);
          return redirect('/admin/accounts?unlocked=1');
        }
        if (action === 'role') {
          const role = String(form.role ?? '');
          if (!['asker', 'expert', 'admin'].includes(role)) return fail(400, 'Choose a role.');
          if (self) return fail(400, 'You cannot change your own role.');
          if (role !== 'admin' && lastAdmin) return fail(400, 'That is the last operator who can sign in.');
          if (role === 'expert' && !dbm.expertByUser(db, target.id)) {
            return fail(400, 'An expert account needs a practitioner row — invite them from the practitioners page instead.');
          }
          dbm.setUserRole(db, target.id, role);
          dbm.logEvent(db, 'account', `user:${target.id}`, `actor=${actor} role ${target.role}->${role} for=${target.email}`);
          return redirect('/admin/accounts?role=1');
        }
        if (action === 'signout') {
          const ended = dbm.deleteSessionsForUser(db, target.id);
          dbm.logEvent(db, 'account', `user:${target.id}`, `actor=${actor} signed_out_everywhere=${target.email} sessions_ended=${ended}`);
          return redirect('/admin/accounts?signout=1');
        }
        return fail(404, 'No such action.');
      }

      // --- bookings: reconcile, move, or cancel with the money accounted for ---
      if (path === '/admin/bookings') {
        const status = url.searchParams.get('status') ?? '';
        return send(200, views.adminBookingsPage({
          admin: account, bookings: dbm.allBookings(db, { status }),
          counts: dbm.bookingStatusCounts(db), revenue: dbm.revenueByExpert(db),
          refunds: dbm.refundsOwed(db), status,
          flash: url.searchParams.get('paid') ? `Booking ${url.searchParams.get('paid')} marked as paid.`
            : url.searchParams.get('completed') ? `Booking ${url.searchParams.get('completed')} marked as done.`
            : url.searchParams.get('moved') ? `Booking ${url.searchParams.get('moved')} moved and re-quoted.`
            : url.searchParams.get('cancelled') ? `Booking ${url.searchParams.get('cancelled')} cancelled.`
            : url.searchParams.get('err') ? url.searchParams.get('err') : ''
        }));
      }
      const bkMatch = /^\/admin\/bookings\/([^/]+)\/(paid|completed|cancel|reschedule)$/.exec(path);
      if (bkMatch && method === 'POST') {
        const ref = decodeURIComponent(bkMatch[1]);
        const b = dbm.bookingByRef(db, ref);
        if (!b) return fail(404, 'No such booking.');
        const action = bkMatch[2];

        if (action === 'paid' || action === 'completed') {
          // `setBookingStatus` guards the transitions (requested -> awaiting_payment -> paid ->
          // completed), so a client who transferred without ever opening their booking page is moved
          // through the middle state rather than skipping it — the same two steps the token console
          // takes. Skipping it here would throw where an operator least expects a crash.
          const allowedFrom = action === 'paid' ? ['requested', 'awaiting_payment'] : ['paid'];
          if (!allowedFrom.includes(b.status)) {
            return redirect(`/admin/bookings?err=${encodeURIComponent(`Booking ${ref} is ${b.status}; it cannot be marked ${action} from there.`)}`);
          }
          if (b.status === 'requested') dbm.setBookingStatus(db, ref, 'awaiting_payment');
          dbm.setBookingStatus(db, ref, action === 'paid' ? 'paid' : 'completed');
          dbm.logEvent(db, 'booking', ref, `actor=${actor} ${action} ${b.price_vnd}`);
          return redirect(`/admin/bookings?${action}=${encodeURIComponent(ref)}`);
        }

        if (action === 'reschedule') {
          const startsAt = String(form.starts_at ?? '').trim();
          const when = new Date(startsAt);
          if (!startsAt || Number.isNaN(when.getTime())) {
            return redirect(`/admin/bookings?err=${encodeURIComponent('That start time is not a date the system can read.')}`);
          }
          const settings = loadSettings(db);
          const expert = dbm.expertById(db, b.expert_id);
          const minutes = Number(form.minutes ?? b.minutes);
          let money;
          try {
            money = quote(expert?.rate_vnd ?? b.price_vnd, minutes, settings.platform_take_rate / 100, settings.min_minutes);
          } catch (err) {
            return redirect(`/admin/bookings?err=${encodeURIComponent(String(err.message))}`);
          }
          dbm.rescheduleBooking(db, ref, {
            startsAt: when.toISOString(), minutes: money.minutes,
            priceVnd: money.price_vnd, feeVnd: money.fee_vnd, payoutVnd: money.payout_vnd
          });
          dbm.logEvent(db, 'booking', ref, `actor=${actor} rescheduled to ${when.toISOString().slice(0, 16)} ${money.minutes}p price ${b.price_vnd}->${money.price_vnd}`);
          return redirect(`/admin/bookings?moved=${encodeURIComponent(ref)}`);
        }

        if (action === 'cancel') {
          if (b.status === 'cancelled') return redirect('/admin/bookings?err=' + encodeURIComponent('That booking is already cancelled.'));
          const reason = String(form.reason ?? '').trim();
          // A cancellation after payment is not a status change, it is money owed back. The platform
          // instructs payment and never holds it (ADR-0008), so this records the amount the operator
          // has to send back rather than pretending a transfer can be reversed.
          const alreadyPaid = ['paid', 'completed'].includes(b.status);
          const refundVnd = alreadyPaid ? b.price_vnd : 0;
          dbm.cancelBooking(db, ref, { reason, refundVnd });
          dbm.logEvent(db, 'booking', ref, `actor=${actor} cancel reason="${reason.slice(0, 80)}" refund_owed=${refundVnd}`);
          return redirect(`/admin/bookings?cancelled=${encodeURIComponent(ref)}`);
        }
        return fail(404, 'No such booking action.');
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
        user,
        place: placeOf()
      }));
    }
    if (path === '/how-it-works') return send(200, views.howItWorksPage({ user }));
    if (path === '/experts') return send(200, views.expertListPage({ experts: dbm.listExperts(db), topics: views.topicList(), user }));
    if (path === '/library') return send(200, views.corpusPage({ notes: (() => { const t = url.searchParams.get('topic'); const all = dbm.publishedNotes(db); return t ? all.filter((n) => n.topic === t) : all; })(), topic: url.searchParams.get('topic') ?? '', topics: views.topicList(), user, place: placeOf() }));
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
      return send(200, views.notePage({ note, expert, user, links, highlight: (url.searchParams.get('hl') ?? '').slice(0, 300), url: `${origin}/notes/${encodeURIComponent(note.slug)}`, text: textSize }));
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
      const cited = citedNotes(q.ai_citations);
      const owned = Boolean(account && q.user_id === account.id);
      return send(200, views.questionPage({
        q,
        aiCitations: cited,
        answers: dbm.answersFor(db, q.ref),
        experts: dbm.listExperts(db),
        routedNames: dbm.expertsForTopic(db, q.topic).map((e) => e.name),
        bankConfigured: Boolean(config.bankBin && config.bankAccount),
        user,
        claimed: owned,
        url: `${origin}/q/${encodeURIComponent(q.ref)}`,
        text: textSize
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
          // The role comes from the invitation row, never from the form: a field on the page cannot
          // promote the account it is creating into an operator.
          role: invite.role === 'admin' ? 'admin' : 'expert'
        });
        if (invite.expert_id) dbm.linkExpertUser(db, invite.expert_id, created.id);
        dbm.acceptInvite(db, invite.id);
        dbm.logEvent(db, 'invite_accepted', `expert:${invite.expert_id ?? '-'}`, `actor=${invite.email} role=${created.role}`);
        const id = newSessionId();
        dbm.createSession(db, { id, userId: created.id, expiresAt: sessionExpiry(), userAgent: req.headers['user-agent'] ?? '' });
        dbm.touchUser(db, created.id);
        return withCookie(created.role === 'admin' ? '/admin' : '/desk', id, isSecureRequest(req));
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
        if (!ref || !text) return redirect(`/c/${expert.token}`);
        // An expert's answer is shown to the asker, so it passes the same gate as a note: a block-class
        // finding (a phone number, a name, a part code) stops it, a figure needs this answer's attestation.
        const attested = form.attested === '1' || form.attested === 'on';
        const decision = decidePublication({ title: '', body: text }, { attested, rules });
        dbm.logEvent(db, 'answer_submit', ref, `${decision.reason} findings=${decision.report.findings.filter((f) => f.severity !== 'note').length}`);
        if (!decision.publish) return send(422, views.blockedNotePage({ expert, decision, title: '', answer: { ref, body: text } }));
        dbm.addAnswer(db, { questionRef: ref, expertId: expert.id, body: text });
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
      if (sub === '/draft') {
        // The review step for a note that has not been published: an interview draft, or a note the gate
        // held back. Only the author sees it; it is not in the library until the gate passes AND the author
        // ticks the attestation on this very form.
        const slug = String((method === 'POST' ? form.slug : url.searchParams.get('slug')) ?? '');
        const note = slug ? dbm.noteBySlug(db, slug) : null;
        if (!note || note.expert_id !== expert.id || note.status === 'published') return fail(404, 'That draft is not available.');
        if (method === 'GET') {
          return send(200, views.draftReviewPage({ expert, note, title: note.title, body: note.body, report: JSON.parse(note.gate || '{}') }));
        }
        if (method === 'POST') {
          const title = String(form.title ?? note.title).trim() || note.title;
          const body = String(form.body ?? note.body);
          const attested = form.attested === '1' || form.attested === 'on';
          const wantsPublish = form.action === 'publish';
          const decision = decidePublication({ title, body }, { attested, rules });
          const publish = wantsPublish && attested && decision.publish;
          dbm.upsertNote(db, {
            expert_id: expert.id,
            slug: note.slug,
            title,
            topic: note.topic,
            body,
            status: publish ? 'published' : decision.reason === 'blocked' ? 'blocked' : 'draft',
            gate: decision.report,
            origin: note.origin
          });
          dbm.logEvent(db, 'draft_review', note.slug, `${wantsPublish ? 'publish' : 'check'} attested=${attested} ${decision.reason}`);
          if (publish) {
            rebuildIndex();
            return send(200, views.interviewPage({ expert, interview: null, step: SCRIPT.length, question: null, answers: [], doneNoteSlug: note.slug }));
          }
          const [message, kind, code] =
            decision.reason === 'blocked' ? ['The gate blocks this draft. Remove what is listed below — names, contact details, codes, prices — and check it again. It cannot be published until it is clean.', 'bad', 422]
            : !wantsPublish ? [decision.reason === 'attestation_required' ? 'Checked. This draft carries a figure with a unit: attest that it is general craft knowledge, or remove the figure.' : 'Checked. Nothing blocks this draft. To publish, tick the attestation and press “Publish this note”.', 'info', 200]
            : !attested ? ['Not published. Tick the attestation box to confirm this is your own craft knowledge, then publish. The draft is saved.', 'bad', 422]
            : ['Not published.', 'bad', 422];
          return send(code, views.draftReviewPage({ expert, note, title, body, report: decision.report, message, messageKind: kind }));
        }
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
            // The interview only ever produces a DRAFT. The expert reads it, edits it and attests it on
            // the review page; nothing here decides to publish for them.
            const report = checkNote({ title: draft.title, body: draft.body }, rules);
            const slug = uniqueSlug(db, slugify(`${advanced.topic}-${String(answers[0] ?? '').slice(0, 30)}`));
            const noteId = dbm.upsertNote(db, {
              expert_id: expert.id,
              slug,
              title: draft.title,
              topic: advanced.topic,
              body: draft.body,
              status: report.ok ? 'draft' : 'blocked',
              gate: report,
              origin: 'interview'
            });
            dbm.finishInterview(db, id, noteId);
            dbm.logEvent(db, 'interview_done', slug, `draft verdict=${report.verdict}`);
            return redirect(`/c/${expert.token}/draft?slug=${encodeURIComponent(slug)}`);
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
      // `send`/`fail` live inside the request closure and are not in scope here. Calling `fail` from
      // this catch used to throw a second error *while handling the first*, which took the whole
      // process down: every later request then hung on a socket nobody was listening to, and the
      // original error was never printed. A 500 handler that can kill the server is worse than no
      // 500 handler.
      const message = String(err?.stack ?? err?.message ?? err);
      console.error('unhandled error:', message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`500 — the request could not be completed.\n\n${message}\n`);
      } else {
        res.end();
      }
    }
  });

  return { server, db, sw, index: () => index, rebuildIndex, runAsk, escalate: escalate(), config, rules };
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
