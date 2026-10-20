// src/ratelimit.mjs — in-memory token buckets. No Redis, no middleware, no dependency.
//
// A bucket holds up to `capacity` tokens and earns them back evenly over `perMs`. The keys are chosen by
// whoever is knocking (an address, an email), so the map is bounded: past `maxKeys` the oldest go.

export function createBuckets({ capacity, perMs, maxKeys = 10_000 }) {
  const refill = capacity / perMs;
  const buckets = new Map();
  return {
    /** Spend one token for `key`: `{ ok: true }`, or `{ ok: false, retryAfter }` in whole seconds. */
    take(key, now = Date.now()) {
      let b = buckets.get(key);
      if (b) {
        b.tokens = Math.min(capacity, b.tokens + (now - b.at) * refill);
        b.at = now;
        buckets.delete(key); // re-insert so the Map's order is least-recently-used first
      } else {
        b = { tokens: capacity, at: now };
      }
      buckets.set(key, b);
      if (buckets.size > maxKeys) {
        for (const k of buckets.keys()) {
          if (buckets.size <= maxKeys) break;
          buckets.delete(k);
        }
      }
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true, retryAfter: 0 };
      }
      return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / refill / 1000)) };
    },
    size: () => buckets.size
  };
}

const MIN = 60_000;
const HOUR = 3_600_000;

/** Per-IP and per-identity budgets. A fixture that signs in a lot passes its own generous `limits`. */
export const DEFAULT_LIMITS = {
  askIp: { capacity: 10, perMs: MIN },
  askIdentity: { capacity: 60, perMs: HOUR },
  signinIp: { capacity: 5, perMs: MIN },
  signinEmail: { capacity: 20, perMs: HOUR },
  signupIp: { capacity: 5, perMs: MIN }
};

/** One bucket set per rule; `check(rule, key)` is `{ ok, retryAfter }`. */
export function createLimiter(limits = DEFAULT_LIMITS) {
  const sets = Object.fromEntries(Object.entries(limits).map(([name, spec]) => [name, createBuckets(spec)]));
  return {
    check(rule, key) {
      return sets[rule] ? sets[rule].take(String(key)) : { ok: true, retryAfter: 0 };
    },
    /** Several rules at once; the first refusal wins. */
    checkAll(pairs) {
      for (const [rule, key] of pairs) {
        const r = this.check(rule, key);
        if (!r.ok) return r;
      }
      return { ok: true, retryAfter: 0 };
    }
  };
}
