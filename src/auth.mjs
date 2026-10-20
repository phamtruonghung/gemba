// src/auth.mjs — accounts for askers: passwords, sessions, cookies.
//
// Zero dependencies: node:crypto only. Two decisions worth knowing before reading:
//
//  * The session cookie is an **opaque random id**, not a signed token. A row in `sessions` means
//    sign-out and "sign out everywhere" are real, no signing secret has to stay in step across
//    restarts and redeploys, and the cookie carries nothing worth reading if it leaks.
//  * Password hashing is **scrypt** (memory-hard) with a per-user salt, and the parameters are
//    stored in the hash string itself, so the cost can be raised later without invalidating
//    existing passwords — the old hash still verifies with its own parameters.
//
// scrypt is async on purpose: the sync form blocks the event loop for the whole derivation, and a
// single-process server that stops answering for ~100ms per sign-in is a denial-of-service on itself.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const SESSION_COOKIE = 'gemba_session';
// Over HTTPS the cookie is named with the `__Host-` prefix, which makes the browser refuse it unless it is
// Secure, Path=/ and has no Domain: a sibling subdomain cannot plant or overwrite it. Plain HTTP (a LAN
// instance, the tests) keeps the old name, because a Secure cookie would never be sent back.
export const HOST_SESSION_COOKIE = '__Host-gemba_session';

/** The session id a request carries, preferring the `__Host-` cookie. */
export const sessionIdFrom = (cookies) => cookies[HOST_SESSION_COOKIE] ?? cookies[SESSION_COOKIE] ?? '';
export const SESSION_DAYS = 30;

// Cost parameters. N is the CPU/memory cost (2^17 = 131072, the OWASP floor for r=8, p=1), r the block
// size, p the parallelism. One derivation holds about 128 MiB, which is more than Node's default
// `maxmem` allows, so every call passes MAX_MEM; and the semaphore below keeps two of them from being
// resident at once on a small container. Hashes made with the older, cheaper N still verify, and are
// re-made at the next sign-in (needsRehash).
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 32 };
const MAX_MEM = 256 * 1024 * 1024;
const MAX_WAITING = 16;

let running = false;
const waiting = [];
/** Raised when too many derivations are already queued: the route answers 503 rather than queue memory. */
export class Busy extends Error {}

/** One derivation at a time; up to MAX_WAITING queued behind it, then `Busy`. */
async function derive(password, salt, keylen, params) {
  if (running) {
    if (waiting.length >= MAX_WAITING) throw new Busy('password hashing is busy');
    await new Promise((resolve) => waiting.push(resolve));
  }
  running = true;
  try {
    return await scryptAsync(String(password), salt, keylen, { ...params, maxmem: MAX_MEM });
  } finally {
    running = false;
    waiting.shift()?.();
  }
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** Hash a password into a self-describing string: `scrypt$N$r$p$salt$key`. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(key)}`;
}

/** Verify a password against a stored hash, with the parameters that hash was made with. */
export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, salt, key] = String(stored ?? '').split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64url');
    const got = await derive(password, Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    });
    return got.length === expected.length && timingSafeEqual(got, expected);
  } catch (err) {
    if (err instanceof Busy) throw err; // not "wrong password": the caller says "try again"
    return false;
  }
}

/** True when a stored hash was made with a cheaper N than today's, so a successful sign-in should re-hash it. */
export function needsRehash(stored) {
  const [scheme, n] = String(stored ?? '').split('$');
  return scheme === 'scrypt' && Number(n) < SCRYPT.N;
}

export const newSessionId = () => randomBytes(32).toString('base64url');
export const sessionExpiry = (from = Date.now()) => new Date(from + SESSION_DAYS * 86400_000).toISOString();

// --- validation ------------------------------------------------------------
// Length only, no composition rules: "must contain a symbol" produces worse passwords and is not
// what current guidance asks for. The floor is 10 characters, which is the honest lever.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function checkEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!value) return { ok: false, field: 'email', error: 'Enter your email address.' };
  if (value.length > 200) return { ok: false, field: 'email', error: 'That email address is too long.' };
  if (!EMAIL_RE.test(value)) return { ok: false, field: 'email', error: 'That does not look like an email address.' };
  return { ok: true, value };
}

export function checkPassword(password) {
  const value = String(password ?? '');
  if (!value) return { ok: false, field: 'password', error: 'Enter a password.' };
  if (value.length < 10) return { ok: false, field: 'password', error: 'Use at least 10 characters — a sentence you can remember is stronger than a short one you cannot.' };
  if (value.length > 200) return { ok: false, field: 'password', error: 'That password is too long (200 characters maximum).' };
  return { ok: true, value };
}

export function checkName(name) {
  const value = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (value.length < 2) return { ok: false, field: 'name', error: 'Enter the name an expert should see.' };
  if (value.length > 80) return { ok: false, field: 'name', error: 'That name is too long.' };
  return { ok: true, value };
}

// --- cookies ---------------------------------------------------------------

/** Parse a Cookie header into an object. Malformed pairs are skipped, never thrown on. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * True when the visitor actually arrived over HTTPS. Behind the Cloudflare tunnel the app itself
 * sees plain HTTP, so the forwarded header is the only honest signal; without it the cookie would
 * be marked Secure on a plain-HTTP LAN instance and never be sent, i.e. sign-in would silently
 * not work.
 */
export function isSecureRequest(req) {
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

export function sessionCookie(id, { secure = false, maxAge = SESSION_DAYS * 86400 } = {}) {
  const parts = [
    `${secure ? HOST_SESSION_COOKIE : SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie({ secure = false } = {}) {
  return sessionCookie('', { secure, maxAge: 0 });
}

/** Both names cleared: a browser that signed in before the rename may still hold the plain one. */
export function clearedSessionCookies({ secure = false } = {}) {
  return secure
    ? [clearedSessionCookie({ secure: true }), clearedSessionCookie({ secure: false })]
    : [clearedSessionCookie({ secure: false })];
}
