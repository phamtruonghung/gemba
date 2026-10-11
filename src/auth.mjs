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

export const SESSION_COOKIE = 'xuong_session';
export const SESSION_DAYS = 30;

// Cost parameters. N is the CPU/memory cost (2^14 = 16384), r the block size, p the parallelism.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** Hash a password into a self-describing string: `scrypt$N$r$p$salt$key`. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(key)}`;
}

/** Verify a password against a stored hash, with the parameters that hash was made with. */
export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, salt, key] = String(stored ?? '').split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64url');
    const got = await scryptAsync(String(password), Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    });
    return got.length === expected.length && timingSafeEqual(got, expected);
  } catch {
    return false;
  }
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
    `${SESSION_COOKIE}=${id}`,
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
