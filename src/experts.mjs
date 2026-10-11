// src/experts.mjs — what a practitioner record is allowed to be.
//
// Kept out of `src/server.mjs` because it is the part with rules in it: which topics exist, what a rate
// may be, and the two fields the rest of the system depends on — a practitioner with no topic can never
// be routed a question, and one whose rate is not a whole number of VND breaks the booking arithmetic
// that the whole money path is built on. Validation that lives next to the routes it guards is
// validation nobody tests directly; this file is tested on its own.

import { checkName, checkEmail } from './auth.mjs';

export const MAX_YEARS = 60;
export const MAX_RATE_VND = 20_000_000;

const intIn = (raw, { min, max, label, fallback = null }) => {
  const text = String(raw ?? '').trim();
  if (!text) return fallback === null ? { ok: false, error: `Enter the ${label}.` } : { ok: true, value: fallback };
  if (!/^\d+$/.test(text)) return { ok: false, error: `${label} must be a whole number.` };
  const value = Number(text);
  if (value < min || value > max) return { ok: false, error: `${label} must be between ${min} and ${max}.` };
  return { ok: true, value };
};

/** A comma or newline separated list of topics, filtered to the ones this product knows. */
export function parseTopics(raw, known) {
  const list = String(raw ?? '')
    .split(/[,\n]/)
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean);
  const canonical = new Map(known.map((t) => [t.toLowerCase(), t]));
  const kept = [];
  const unknown = [];
  for (const t of list) {
    const hit = canonical.get(t);
    if (hit && !kept.includes(hit)) kept.push(hit);
    else if (!hit) unknown.push(t);
  }
  return { topics: kept, unknown };
}

export function checkExpert(form, { topics = [], defaultRate = 600000 } = {}) {
  const errors = {};
  const values = {};

  const name = checkName(form?.name);
  if (name.ok) values.name = name.value;
  else errors.name = name.error;

  const parsed = parseTopics(form?.topics, topics);
  if (!parsed.topics.length) {
    errors.topics = parsed.unknown.length
      ? `None of those topics exist here. Known topics: ${topics.join(', ')}.`
      : 'Choose at least one topic — without one, no question can ever be routed to this practitioner.';
  } else {
    values.topics = parsed.topics;
    if (parsed.unknown.length) values.unknownTopics = parsed.unknown;
  }

  const years = intIn(form?.years, { min: 0, max: MAX_YEARS, label: 'Years of experience', fallback: 0 });
  if (years.ok) values.years = years.value;
  else errors.years = years.error;

  const rate = intIn(form?.rate_vnd, { min: 0, max: MAX_RATE_VND, label: 'Rate in VND per hour', fallback: defaultRate });
  if (rate.ok) values.rate_vnd = rate.value;
  else errors.rate_vnd = rate.error;

  const headline = String(form?.headline ?? '').trim();
  if (headline.length > 120) errors.headline = 'Keep the headline under 120 characters.';
  else values.headline = headline;

  const bio = String(form?.bio ?? '').trim();
  if (bio.length > 2000) errors.bio = 'Keep the bio under 2000 characters.';
  else values.bio = bio;

  // A checkbox: present means yes. Absent is a real answer ("stop sending me questions"), not a
  // missing field, so it is never an error.
  values.accept_questions = form?.accept_questions === 'on' || form?.accept_questions === '1' ? 1 : 0;

  return { ok: Object.keys(errors).length === 0, values, errors };
}

export function checkInvite(form, { fallbackName = '' } = {}) {
  const errors = {};
  const values = {};

  const email = checkEmail(form?.email);
  if (email.ok) values.email = email.value;
  else errors.email = 'Enter the email address this invitation is for.';

  const raw = String(form?.name ?? '').trim() || fallbackName;
  const name = checkName(raw);
  if (name.ok) values.name = name.value;
  else errors.name = 'Enter the name the practitioner should be greeted by.';

  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** The two fields on the invitation page, plus the confirmation that replaces password reset. */
export function checkInviteAcceptance(form) {
  const errors = {};
  const password = String(form?.password ?? '');
  const again = String(form?.password2 ?? '');

  if (password.length < 10) {
    errors.password = 'Use at least 10 characters — a sentence you can remember is stronger than a short one you cannot.';
  } else if (password.length > 200) {
    errors.password = 'That password is too long (200 characters maximum).';
  } else if (again !== password) {
    // There is no password-reset-by-email yet, so a typo here would lock the practitioner out of an
    // account the operator has to fix by hand. Asking twice is the cheap version of a reset link.
    errors.password2 = 'The two passwords do not match.';
  }

  const name = checkName(form?.name);
  if (!name.ok) errors.name = name.error;

  return {
    ok: Object.keys(errors).length === 0,
    values: name.ok ? { name: name.value, password } : { password },
    errors
  };
}
