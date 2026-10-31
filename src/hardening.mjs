// Security headers for every response, and the script nonce the Content-Security-Policy hangs on.
// Pure: strings in, strings and plain objects out (no imports from views.mjs or server.mjs).
//
// The nonce is DERIVED, not random per response:
//   nonce = base64url(HMAC-SHA256(processSecret, htmlWithPlaceholder)).slice(0, 32)
// with processSecret = randomBytes(32), created once in createApp. A per-response random nonce is wrong
// *here*: (a) a `304 Not Modified` replaces the stored content-security-policy header, so the browser
// would hold a body whose <script nonce> is the old value against a header carrying a new one, and the
// page's only script would be blocked on every revalidation; (b) `/`'s gzip and plain encodings would
// stop being byte-identical (test/mobile.test.mjs). A derived nonce is still unguessable before the
// response (it needs the process secret) and differs for every distinct page.
// Responses that carry no HTML script (JSON, CSS, static files, 413/500 pages) have nothing to allow,
// so any nonce is inert there: they get a random one.
import { createHmac, randomBytes } from 'node:crypto';

/** What layout() writes as its script's nonce; replaced by stampNonce on the way out. */
export const NONCE_PLACEHOLDER = '__gemba_csp_nonce__';

/** The one definition of this header in the tree (static.mjs spreads it too). */
export const NOSNIFF = { 'x-content-type-options': 'nosniff' };

export function nonceFor(secret, html) {
  return createHmac('sha256', secret).update(html).digest('base64url').slice(0, 32);
}

/**
 * Put the nonce on the page's script. Only the LAST placeholder is replaced, and every earlier one is
 * removed: the product's script is the last thing layout() writes, so everything before it is page
 * content. The threat this policy exists for is a missed escape in the markdown renderer; if text an
 * attacker controls could carry `<script nonce="__gemba_csp_nonce__">`, a replace-all would stamp the
 * real nonce into the attacker's own tag. After one call no placeholder remains, so a second is a no-op.
 */
export function stampNonce(html, nonce) {
  const at = html.lastIndexOf(NONCE_PLACEHOLDER);
  if (at < 0) return html;
  const before = html.slice(0, at).split(NONCE_PLACEHOLDER).join('');
  return before + nonce + html.slice(at + NONCE_PLACEHOLDER.length);
}

export function securityHeaders({ nonce, secure = false }) {
  return {
    ...NOSNIFF,
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
    'content-security-policy': [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      // 'unsafe-inline' for styles: the design system is one external stylesheet plus style="..." attributes
      // on many elements throughout src/views.mjs (test/mobile.test.mjs asserts there is no <style> element).
      // Dropping it means replacing every one of those attributes with a class first.
      "style-src 'self' 'unsafe-inline'",
      // The booking page renders the VietQR transfer image (src/pricing.mjs, <img> in src/views.mjs).
      "img-src 'self' data: https://img.vietqr.io",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'"
    ].join('; '),
    // Only over HTTPS: on a plain-http LAN instance the header would be ignored at best.
    ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {})
  };
}

/** A nonce for a response that has no script to allow. */
export const randomNonce = () => randomBytes(18).toString('base64url');
