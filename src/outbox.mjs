// src/outbox.mjs — the one place a message leaves the system. Zero dependencies.
//
// Every email the product promises (a question reached practitioners, an answer is ready, a time was
// confirmed, payment was received, an answer is late) is a row in the `outbox` table first, written in the
// same transaction as the fact it reports. A runner then sends the pending rows through a transport and
// marks each one sent or failed, so the operator can read what was promised and what actually went out.
//
// Transports (GEMBA_MAIL_TRANSPORT):
//   sendmail  pipe the message to the local MTA: `sendmail -i -- <recipient>`, never `-t`
//   file      write <dataDir>/mail-sink/<id>.eml; the local sink the tests and a demo use
//   none      the default: delivery is not configured, so rows stay `pending` and the operator can see it
// Anything else (Zalo ZNS, an SMTP relay) is a function: createApp({ transport: async (msg) => {...} }).
// `msg` is { id, kind, to, subject, body, from, raw } and the function resolves when the message is out.

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as dbm from './db.mjs';
import { checkEmail } from './auth.mjs';
import { formatVnd } from './pricing.mjs';
import { formatLocal } from './when.mjs';

// --- the message itself --------------------------------------------------------------------------------

const hasLineBreak = (s) => /[\r\n\0]/.test(String(s));

/** RFC 2047 encoded-words for a header that is not plain ASCII, split so no word passes 75 characters. */
export function encodeHeader(text) {
  const s = String(text);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 42) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

/**
 * The RFC 5322 text for one row. Headers are built only from a validated address and a subject with no
 * line break in it: `contact` is free text from a public form, and a CR/LF in it would otherwise be a way
 * to add headers (a Bcc) to a message the product sends under its own name.
 */
export function buildMessage({ id, to, subject, body, from }) {
  const addr = checkEmail(to);
  if (!addr.ok || hasLineBreak(to) || /[<>,;"]/.test(String(to))) throw new Error('refusing to send: not a plain email address');
  if (hasLineBreak(subject) || hasLineBreak(from)) throw new Error('refusing to send: line break in a header');
  const text = String(body).replace(/\r\n|\r|\n/g, '\r\n');
  return [
    `From: ${from}`,
    `To: ${addr.value}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <outbox-${id}.${Date.now().toString(36)}@gemba.invalid>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',
    '',
    text,
    ''
  ].join('\r\n');
}

// --- transports ------------------------------------------------------------------------------------------

/** The transport the config asks for, or null when delivery is not configured. */
export function transportFrom(config = {}, injected = null) {
  if (typeof injected === 'function') return injected;
  if (config.mailTransport === 'sendmail') {
    const path = config.sendmailPath || '/usr/sbin/sendmail';
    return (msg) => new Promise((resolve, reject) => {
      // argv, no shell, and no `-t`: the recipient is the validated address, not whatever the headers say.
      const child = execFile(path, ['-i', '--', msg.to], { timeout: 30_000 }, (err, _out, stderr) => {
        if (err) reject(new Error(`sendmail: ${String(stderr || err.message).trim().slice(0, 200)}`));
        else resolve();
      });
      child.stdin.on('error', () => { /* the exit callback reports it */ });
      child.stdin.end(msg.raw);
    });
  }
  if (config.mailTransport === 'file') {
    const dir = join(config.dataDir || 'data', 'mail-sink');
    return async (msg) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${msg.id}.eml`), msg.raw);
    };
  }
  return null;
}

/**
 * Send what is pending. Each row is claimed first (see claimPending), then sent, then marked; a transport
 * that throws puts the row back to `pending` until it has used its attempts, then it is `failed`.
 */
export async function deliver(db, transport, { limit = 20, from = 'Gemba <gemba@localhost>', leaseMs } = {}) {
  const out = { claimed: 0, sent: 0, failed: 0, retry: 0 };
  if (!transport) return out;
  for (const row of dbm.claimPending(db, limit, leaseMs === undefined ? {} : { leaseMs })) {
    out.claimed += 1;
    try {
      const raw = buildMessage({ id: row.id, to: row.to_addr, subject: row.subject, body: row.body, from });
      await transport({ id: row.id, kind: row.kind, to: row.to_addr, subject: row.subject, body: row.body, from, raw });
      dbm.markSent(db, row.id);
      out.sent += 1;
    } catch (err) {
      dbm.markFailed(db, row.id, err);
      if (row.attempts >= dbm.OUTBOX_MAX_ATTEMPTS) out.failed += 1; else out.retry += 1;
    }
  }
  return out;
}

// --- what is said, and to whom -------------------------------------------------------------------------

const local = (iso) => `${formatLocal(iso)} (UTC+7)`;
// The buyer is written to in the language the question was asked in.
const pick = (lang, vi, en) => (lang === 'vi' ? vi : en);

/** The address to write to: the contact if it is an email, else the account's email, else the raw contact (which will fail honestly). */
function buyerAddress(db, row) {
  if (checkEmail(row.contact).ok) return row.contact;
  const account = row.user_id ? db.prepare('select email from users where id = ?').get(row.user_id) : null;
  return account?.email || row.contact || '';
}

const link = (publicUrl, path) => `${String(publicUrl).replace(/\/+$/, '')}${path}`;

/** A question was routed: tell each practitioner who has an account, and tell the asker what was promised. */
export function queueRouted(db, q, routed, { publicUrl }) {
  const url = link(publicUrl, `/q/${encodeURIComponent(q.ref)}`);
  for (const e of routed) {
    const to = dbm.expertEmail(db, e.id);
    dbm.enqueue(db, {
      kind: 'question_routed', ref: q.ref, to: to || `(no email: ${e.slug})`, dedupe: `question_routed:${q.ref}:${e.slug}:${q.due_at}`,
      subject: `A question for you (${q.topic}), due ${local(q.due_at)}`,
      body: `A supervisor asked:\n\n${q.text}\n\nOpen your desk to answer: ${link(publicUrl, `/c/${e.token}`)}\nPlease answer by ${local(q.due_at)}.\n`
    });
  }
  dbm.enqueue(db, {
    kind: 'question_ack', ref: q.ref, to: buyerAddress(db, q), dedupe: `question_ack:${q.ref}:${q.due_at}`,
    subject: pick(q.lang, `Câu hỏi của bạn đã được gửi tới ${routed.length} chuyên gia`, `Your question went to ${routed.length} practitioner${routed.length === 1 ? '' : 's'}`),
    body: pick(q.lang,
      `Câu hỏi của bạn đã được chuyển tới ${routed.length} chuyên gia. Hạn trả lời: ${local(q.due_at)}.\nTheo dõi tại: ${url}\n`,
      `Your question was sent to ${routed.length} practitioner${routed.length === 1 ? '' : 's'}. The answer is due ${local(q.due_at)}.\nFollow it here: ${url}\n`)
  });
}

export function queueAnswered(db, q, { publicUrl }) {
  const url = link(publicUrl, `/q/${encodeURIComponent(q.ref)}`);
  dbm.enqueue(db, {
    kind: 'question_answered', ref: q.ref, to: buyerAddress(db, q),
    subject: pick(q.lang, 'Câu hỏi của bạn đã có câu trả lời', 'Your question has an answer'),
    body: pick(q.lang, `Một chuyên gia đã trả lời câu hỏi của bạn: ${url}\n`, `A practitioner answered your question: ${url}\n`)
  });
}

/** Booking transitions that say something to someone. The server calls this after every successful transition. */
export function afterTransition(db, b, to, { publicUrl }) {
  if (!b) return;
  const url = link(publicUrl, `/b/${encodeURIComponent(b.ref)}`);
  if (to === 'awaiting_payment') {
    dbm.enqueue(db, {
      kind: 'time_confirmed', ref: b.ref, to: buyerAddress(db, b),
      subject: pick(b.lang, `Chuyên gia đã xác nhận giờ ${local(b.starts_at)}`, `Your session is confirmed for ${local(b.starts_at)}`),
      body: pick(b.lang,
        `Chuyên gia đã xác nhận buổi ${b.minutes} phút lúc ${local(b.starts_at)}.\nSố tiền: ${formatVnd(b.price_vnd)}. Mã tham chiếu chuyển khoản: ${b.ref}\nHướng dẫn thanh toán: ${url}\n`,
        `The practitioner confirmed a ${b.minutes}-minute session at ${local(b.starts_at)}.\nAmount: ${formatVnd(b.price_vnd)}. Transfer reference: ${b.ref}\nHow to pay: ${url}\n`)
    });
  }
  if (to === 'paid') {
    const join = b.meeting_url ? `Join: ${b.meeting_url}\n` : '';
    const ics = b.meeting_url ? `Add to calendar: ${link(publicUrl, `/b/${encodeURIComponent(b.ref)}/session.ics`)}\n` : '';
    dbm.enqueue(db, {
      kind: 'payment_confirmed', ref: b.ref, to: buyerAddress(db, b),
      subject: pick(b.lang, `Đã nhận thanh toán — buổi tư vấn lúc ${local(b.starts_at)}`, `Payment received — your session at ${local(b.starts_at)}`),
      body: pick(b.lang,
        `Đã nhận thanh toán cho buổi tư vấn ${b.minutes} phút lúc ${local(b.starts_at)}.\n${join ? `Tham gia: ${b.meeting_url}\n` : ''}${ics ? `Thêm vào lịch: ${link(publicUrl, `/b/${encodeURIComponent(b.ref)}/session.ics`)}\n` : ''}Chi tiết: ${url}\n`,
        `Payment was received for your ${b.minutes}-minute session at ${local(b.starts_at)}.\n${join}${ics}Details: ${url}\n`)
    });
    dbm.enqueue(db, {
      kind: 'payment_confirmed', ref: b.ref, to: dbm.expertEmail(db, b.expert_id) || `(no email: expert ${b.expert_id})`, dedupe: `payment_confirmed:${b.ref}:expert`,
      subject: `Payment received — session at ${local(b.starts_at)}`,
      body: `${b.asker} paid for a ${b.minutes}-minute session at ${local(b.starts_at)}.\n${join}Details: ${url}\n`
    });
  }
}

// --- the 48-hour promise -------------------------------------------------------------------------------

/**
 * Flag every routed question that passed its due time without an answer, once each: log a `breach` event,
 * tell the operator, and tell the asker it is late and what they can do (send it to others, or book a
 * paid session). A question is free, so there is nothing to refund; the offer is a re-route.
 */
export function sweep(db, { now = dbm.nowIso(), publicUrl, operatorEmails = [] } = {}) {
  const out = { breached: 0, queued: 0 };
  const operators = operatorEmails.length ? operatorEmails : dbm.adminEmails(db);
  for (const q of dbm.overdueRouted(db, now)) {
    dbm.tx(db, () => {
      if (!dbm.setBreach(db, q.ref, now)) return;
      out.breached += 1;
      dbm.logEvent(db, 'breach', q.ref, `due ${q.due_at}`);
      const url = link(publicUrl, `/q/${encodeURIComponent(q.ref)}`);
      for (const to of operators.length ? operators : ['']) {
        if (dbm.enqueue(db, {
          kind: 'question_overdue_operator', ref: q.ref, to, dedupe: `question_overdue_operator:${q.ref}:${to || 'nobody'}`,
          subject: `Overdue: ${q.ref} passed its 48-hour promise`,
          body: `Question ${q.ref} (${q.topic}) was due ${local(q.due_at)} and has no answer.\n${url}\nBreaches: ${link(publicUrl, '/admin/outbox')}\n`
        })) out.queued += 1;
      }
      if (dbm.enqueue(db, {
        kind: 'question_overdue', ref: q.ref, to: buyerAddress(db, q),
        subject: pick(q.lang, 'Câu trả lời đang bị trễ', 'Your answer is late'),
        body: pick(q.lang,
          `Chúng tôi đã hứa trả lời trước ${local(q.due_at)} nhưng chưa có câu trả lời. Xin lỗi bạn.\nBạn có thể gửi lại cho chuyên gia khác hoặc đặt một buổi tư vấn 1:1 có phí: ${url}\n`,
          `We promised an answer by ${local(q.due_at)} and it has not come. We are sorry.\nYou can send it to other practitioners, or book a paid 1:1 session: ${url}\n`)
      })) out.queued += 1;
    });
  }
  return out;
}

/** Sweep, then deliver. The timer and `scripts/sweep.mjs` both call this. */
export async function runOnce(db, { transport, publicUrl, operatorEmails = [], from, now, limit, leaseMs } = {}) {
  const swept = sweep(db, { now, publicUrl, operatorEmails });
  const delivered = await deliver(db, transport, { limit, from, leaseMs });
  return { ...swept, ...delivered, pending: dbm.outboxCounts(db).pending, delivery: transport ? 'configured' : 'not configured (GEMBA_MAIL_TRANSPORT)' };
}

// --- the calendar file ---------------------------------------------------------------------------------

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Fold a content line at 75 octets (not characters), continuing with a single space, never inside a UTF-8 sequence. */
export function foldLine(line) {
  const out = [];
  let cur = '';
  let limit = 75;
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > limit) { out.push(cur); cur = ' '; limit = 75; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** The .ics for a paid session, or null when it cannot be made honestly (no link, or a legacy free-text time). */
export function icsFor(b, { publicUrl = '', now = new Date() } = {}) {
  if (!b || !b.meeting_url || !ISO_UTC.test(String(b.starts_at ?? '')) || Number.isNaN(Date.parse(b.starts_at))) return null;
  const url = publicUrl ? link(publicUrl, `/b/${encodeURIComponent(b.ref)}`) : '';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gemba//Session//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.ref}@gemba`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(b.starts_at)}`,
    `DURATION:PT${Math.max(1, Math.round(b.minutes))}M`,
    `SUMMARY:${icsEscape(`Gemba session with ${b.expert_name || 'a practitioner'}`)}`,
    `LOCATION:${icsEscape(b.meeting_url)}`,
    `URL:${b.meeting_url}`,
    `DESCRIPTION:${icsEscape(`Join: ${b.meeting_url}${url ? `\nBooking: ${url}` : ''}\nReference: ${b.ref}`)}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
