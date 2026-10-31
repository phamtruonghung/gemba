// src/ratelimit.mjs — in-memory sliding-window limits. No Redis, no middleware, no dependency.
//
// For each key we remember when its last `capacity` allowed takes happened; a take is refused while
// `capacity` of them are less than `perMs` old. The keys are chosen by whoever is knocking (an address,
// an email), so the map is bounded: past `maxKeys` the least recently used go. `now` is injectable so
// tests can move the clock.

export function createBuckets({ capacity, perMs, maxKeys = 10_000, now = () => Date.now() }) {
  const windows = new Map();
  return {
    /** Spend one take for `key`: `{ ok: true }`, or `{ ok: false, retryAfter }` in whole seconds. */
    take(key, at = now()) {
      // a take exactly `perMs` old has left the window
      const stamps = (windows.get(key) ?? []).filter((ts) => at - ts < perMs);
      windows.delete(key); // re-insert so the Map's order is least-recently-used first
      windows.set(key, stamps);
      if (windows.size > maxKeys) {
        for (const k of windows.keys()) {
          if (windows.size <= maxKeys) break;
          windows.delete(k);
        }
      }
      if (stamps.length >= capacity) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((stamps[0] + perMs - at) / 1000)) };
      }
      stamps.push(at);
      return { ok: true, retryAfter: 0 };
    },
    size: () => windows.size
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

/** One window set per rule; `check(rule, key)` is `{ ok, retryAfter }`. */
export function createLimiter(limits = DEFAULT_LIMITS, { now = () => Date.now() } = {}) {
  const sets = Object.fromEntries(Object.entries(limits).map(([name, spec]) => [name, createBuckets({ now, ...spec })]));
  return {
    check(rule, key, at = now()) {
      return sets[rule] ? sets[rule].take(String(key), at) : { ok: true, retryAfter: 0 };
    },
    /** Several rules at once; the first refusal wins. */
    checkAll(pairs, at = now()) {
      for (const [rule, key] of pairs) {
        const r = this.check(rule, key, at);
        if (!r.ok) return r;
      }
      return { ok: true, retryAfter: 0 };
    }
  };
}
