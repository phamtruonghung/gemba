// src/static.mjs — serves files from public/, deny by default.
//
// Zero dependencies. A request is answered only if every check passes; any failure returns `false`
// and the caller falls through to its ordinary 404. The checks, in order: decode once; refuse NUL,
// backslashes, `..` segments, absolute paths and a second layer of encoding; resolve under the root;
// realpath and re-check (a symlink must not lead out); regular files only; extension on the allow-list.

import { createHash } from 'node:crypto';
import { realpathSync, statSync, readFileSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';

export const CONTENT_TYPES = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Map a raw request path (`/icons/icon-192.png`, still percent-encoded, no query) to a real file
 * under `root`, or null. Exported so the traversal cases can be tested without a socket.
 */
export function resolvePublicFile(root, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return null;
  // Encoded dots, slashes and backslashes have no business in a public file name.
  if (/%2e|%2f|%5c|%00/i.test(rawPath)) return null;
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  // After one decode there must be no second layer of encoding left.
  if (/%2e|%2f|%5c|%00/i.test(decoded)) return null;
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const rel = decoded.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) return null;
  if (rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  if (!(extname(rel).toLowerCase() in CONTENT_TYPES)) return null;
  let realRoot;
  try { realRoot = realpathSync(root); } catch { return null; }
  const candidate = resolve(realRoot, rel);
  if (!candidate.startsWith(realRoot + sep)) return null;
  let real;
  try { real = realpathSync(candidate); } catch { return null; }
  if (!real.startsWith(realRoot + sep)) return null;
  try { if (!statSync(real).isFile()) return null; } catch { return null; }
  return real;
}

/** Answer GET/HEAD for a public file. Returns true when it responded, false to fall through. */
export function serveStatic(req, res, { root, rawPath }) {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  const file = resolvePublicFile(root, rawPath);
  if (!file) return false;
  let body, mtime;
  try { body = readFileSync(file); mtime = statSync(file).mtime; } catch { return false; }
  const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
  const headers = {
    'content-type': CONTENT_TYPES[extname(file).toLowerCase()],
    'cache-control': 'public, max-age=86400',
    etag,
    'last-modified': mtime.toUTCString(),
    'x-content-type-options': 'nosniff'
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*')) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(method === 'HEAD' ? undefined : body);
  return true;
}
