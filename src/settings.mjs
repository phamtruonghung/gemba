// src/settings.mjs — the numbers an operator can change without a deploy.
//
// They were module constants in `src/pricing.mjs`, which is a fine way to write them and a bad way to
// live with them: changing the platform's share meant editing code, running the tests, and shipping.
//
// Three rules, each with a reason:
//
//  * **Integer VND, integer percent.** Money in this product is never a float (see `src/pricing.mjs`),
//    and a share typed as `1.5` or `20%` is a person mistyping, not a value. Trim, then digits only.
//  * **The old constants stay the defaults.** A key that has never been written falls back to the
//    constant in `src/pricing.mjs`, so an instance that predates this file keeps behaving exactly as it
//    did — the constant is the fallback, not a second source of truth.
//  * **Range is checked, not clamped.** Silently clamping 90% to 50% would mean the operator's saved
//    value is not the value they typed. Refuse and say what the range is.

import { tx } from './db.mjs';
import { PLATFORM_TAKE_RATE, MIN_MINUTES, DEFAULT_MINUTES } from './pricing.mjs';

export const SETTING_SPECS = {
  platform_take_rate: {
    label: 'Platform share',
    unit: '%',
    min: 0, max: 50,
    fallback: Math.round(PLATFORM_TAKE_RATE * 100),
    hint: 'What the platform keeps from each session. The practitioner receives the rest.'
  },
  min_minutes: {
    label: 'Shortest session',
    unit: 'minutes',
    min: 15, max: 240,
    fallback: MIN_MINUTES,
    hint: 'A session below this is not offered.'
  },
  default_minutes: {
    label: 'Default session',
    unit: 'minutes',
    min: 15, max: 240,
    fallback: DEFAULT_MINUTES,
    hint: 'What the booking form proposes.'
  },
  default_rate_vnd: {
    label: 'Default rate',
    unit: 'VND/hour',
    min: 0, max: 20_000_000,
    fallback: 600000,
    hint: 'Used when a new practitioner has no rate of their own yet.'
  }
};

export const SETTING_KEYS = Object.keys(SETTING_SPECS);

/**
 * The stored settings, with every spec filled in. One query, no caching: it is one small table read on
 * a request that is about to hash a password or call a model, and a cache is a thing to get wrong.
 */
export function loadSettings(db) {
  const out = {};
  for (const key of SETTING_KEYS) out[key] = SETTING_SPECS[key].fallback;
  let rows = [];
  try {
    rows = db.prepare('select key, value from settings').all();
  } catch {
    return out; // an older database without the table behaves like an instance with no settings
  }
  for (const row of rows) {
    if (!SETTING_KEYS.includes(row.key)) continue;
    const n = Number(row.value);
    if (Number.isInteger(n)) out[row.key] = n;
  }
  return out;
}

/** A strict integer field: trimmed, digits only, then in range. Returns {ok, value} or {ok:false,error}. */
export function checkInt(raw, spec) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: `Enter a value for the ${spec.label.toLowerCase()}.` };
  if (!/^\d+$/.test(text)) return { ok: false, error: `${spec.label} must be a whole number (no decimals, no units — just the number).` };
  const value = Number(text);
  if (!Number.isInteger(value)) return { ok: false, error: `${spec.label} must be a whole number.` };
  if (value < spec.min || value > spec.max) {
    return { ok: false, error: `${spec.label} must be between ${spec.min} and ${spec.max}${spec.unit ? ` ${spec.unit}` : ''}.` };
  }
  return { ok: true, value };
}

/**
 * Validate a whole settings form. All-or-nothing: a form with one bad field changes nothing, so the
 * operator's mental model ("save" means saved) survives contact with a typo.
 */
export function checkSettings(form) {
  const values = {};
  const errors = {};
  const provided = SETTING_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(form ?? {}, k));
  const keys = provided.length ? provided : SETTING_KEYS;
  for (const key of keys) {
    const check = checkInt(form?.[key], SETTING_SPECS[key]);
    if (check.ok) values[key] = check.value;
    else errors[key] = check.error;
  }
  // Cross-field: a default session shorter than the shortest session is not a coherent pair.
  const min = values.min_minutes;
  const def = values.default_minutes;
  if (Number.isInteger(min) && Number.isInteger(def) && def < min) {
    errors.default_minutes = `The default session (${def} minutes) cannot be shorter than the shortest session (${min} minutes).`;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** Write validated settings. Only called with the output of a passing `checkSettings`. */
export function saveSettings(db, values, { actor = '' } = {}) {
  const at = new Date().toISOString();
  const stmt = db.prepare(
    'insert into settings (key, value, updated_at) values (?, ?, ?) ' +
      'on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at'
  );
  const changed = [];
  tx(db, () => {
    for (const [key, value] of Object.entries(values)) {
      const was = db.prepare('select value from settings where key = ?').get(key)?.value;
      if (String(was) === String(value)) continue;
      stmt.run(key, String(value), at);
      changed.push(`${key} ${was ?? SETTING_SPECS[key].fallback}→${value}`);
    }
  });
  return changed;
}
