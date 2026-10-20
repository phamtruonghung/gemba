// src/when.mjs — one parser for the time a session starts.
// Vietnam has no DST, so a fixed +07:00 offset is exact. The form takes "YYYY-MM-DD HH:MM" and the
// database stores ISO UTC; nothing here reads the process timezone.

const OFFSET_HOURS = 7;
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
export const WHEN_ERROR = 'Enter the time as YYYY-MM-DD HH:MM, Vietnam time (UTC+7).';

/** `T` is accepted as well as a space: `<input type="datetime-local">` posts it with JavaScript off. */
export function parseLocal(text) {
  const m = SHAPE.exec(String(text ?? '').trim());
  if (!m) return { ok: false, error: WHEN_ERROR };
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h - OFFSET_HOURS, mi);
  const back = new Date(t + OFFSET_HOURS * 3600000);
  // Round-trip the fields: 2026-02-30 and 24:00 roll over into another day and fail here.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) {
    return { ok: false, error: WHEN_ERROR };
  }
  return { ok: true, iso: new Date(t).toISOString() };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** "YYYY-MM-DD HH:MM" at +07:00. Anything that is not a stored ISO string comes back as it was. */
export function formatLocal(iso) {
  const raw = String(iso ?? '');
  if (!ISO.test(raw)) return raw;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw;
  return new Date(t + OFFSET_HOURS * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}
