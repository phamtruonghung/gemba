// src/gate.mjs — the publishability gate.
//
// This is the fix to the flaw the project's own check found: a production expert's
// working notes are written about the employer's plant, so a corpus of raw notes is a
// corpus of someone else's confidential information. The gate is therefore a rule the
// platform enforces *before* a note can enter the corpus, and every note carries the
// author's attestation alongside the machine verdict.
//
// Three severities:
//   block   — never publishable (someone else's name, contract, order or document)
//   attest  — publishable only with the author's explicit per-note attestation (a figure
//             the author declares to be general craft knowledge, not their plant's data)
//   note    — advisory, never blocks (style, length, house shape)

export const ATTESTATION_TEXT =
  'Tôi xác nhận nội dung này là kiến thức nghề của tôi: không có số liệu, tên khách hàng/nhà cung cấp, ' +
  'bản vẽ, mã hàng, giá hay điều khoản hợp đồng của bất kỳ nhà máy nào.';

export const DEFAULT_RULES = {
  // Names that must never reach the corpus. Extend per deployment in data/gate.rules.json.
  block_terms: ['relats', 'vi-prod', 'vi prod'],
  // Vietnamese family names: "Nguyễn Văn A" is a person, not a craft term.
  family_names: [
    'nguyễn', 'nguyen', 'trần', 'tran', 'lê', 'le', 'phạm', 'pham', 'hoàng', 'hoang', 'huỳnh', 'huynh',
    'phan', 'vũ', 'vu', 'võ', 'vo', 'đặng', 'dang', 'bùi', 'bui', 'đỗ', 'do', 'hồ', 'ho', 'ngô', 'ngo',
    'dương', 'duong', 'lý', 'ly', 'đinh', 'dinh', 'trịnh', 'trinh', 'trương', 'truong', 'lâm', 'lam'
  ],
  // Documents and identifiers belonging to an employer.
  document_patterns: [
    'PO\\s*[:#]?\\s*\\d+',
    'LSX\\s*[:#]?\\s*\\d+',
    '(part|item)\\s*(no|number|#)',
    'mã\\s+(hàng|vật tư|linh kiện)',
    '(đơn\\s+giá|giá\\s+nhập|giá\\s+bán|chiết\\s+khấu)',
    'hợp\\s+đồng\\s+(số|ngày)',
    '(bản\\s+vẽ|drawing)\\s+[A-Z0-9-]{4,}',
    '(tài\\s+liệu\\s+nội\\s+bộ|mật|confidential|internal\\s+use)'
  ],
  // No \b anywhere in these: \b is defined on ASCII \w, so a boundary next to a Vietnamese
  // letter never matches. checkNote() wraps each pattern in unicode letter/number lookarounds.
  figure_patterns: [
    '\\d[\\d.,]*\\s?(%|phần\\s*trăm)',
    '\\d[\\d.,]*\\s?(vnđ|vnd|đồng|triệu|tỷ|usd|\\$)',
    '\\d[\\d.,]*\\s?(ppm|pcs|cái|chiếc|bộ|kg|tấn|tấn/giờ|m2|mét)',
    '\\d[\\d.,]*\\s?(phút|giờ|giây)\\s*(dừng|ngừng|chạy|máy)',
    'OEE[^\\n]{0,20}\\d',
    '\\d[\\d.,]*\\s*(lần|suất)\\s*/\\s*(tuần|tháng|ngày)'
  ],
  min_chars: 300,
  max_chars: 12000
};

export function loadRules(extra) {
  return {
    ...DEFAULT_RULES,
    ...(extra ?? {}),
    block_terms: [...DEFAULT_RULES.block_terms, ...((extra && extra.block_terms) || [])],
    family_names: [...DEFAULT_RULES.family_names, ...((extra && extra.family_names) || [])],
    document_patterns: [...DEFAULT_RULES.document_patterns, ...((extra && extra.document_patterns) || [])],
    figure_patterns: [...DEFAULT_RULES.figure_patterns, ...((extra && extra.figure_patterns) || [])]
  };
}

function snippet(text, match) {
  const i = match.index ?? 0;
  const start = Math.max(0, i - 40);
  return text.slice(start, Math.min(text.length, i + match[0].length + 40)).replace(/\s+/g, ' ').trim();
}

function foldToken(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * \b is defined on ASCII \w, so `\bđơn\s+giá\b` never matched "Đơn giá" — the boundary is
 * tested against a non-word character on both sides. Unicode letter/number lookarounds are
 * the form that works for Vietnamese.
 */
function documentRe(pattern) {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * A person's name, decided token by token: a family name followed by a capitalised word.
 * Deciding case and surname separately is what keeps "nghi phạm đầu tiên" (evidence, first
 * suspect) out of the results while "anh Nguyễn Văn Anh" is caught.
 */
function personNameFindings(text, rules) {
  const families = new Set(rules.family_names.map(foldToken));
  const out = [];
  const re = /\p{L}+/gu;
  const words = [...text.matchAll(re)].map((m) => ({ word: m[0], index: m.index }));
  for (let i = 0; i < words.length - 1; i += 1) {
    const cur = words[i];
    const next = words[i + 1];
    // Both words must be capitalised. Two collisions forced this: folding makes short
    // surnames collide with ordinary words ("phạm" in "nghi phạm đầu tiên", "đỗ"/"đó" in
    // "...thứ tự đó.\n## Dùng được ở đâu..."), and real names are written capitalised while
    // those are lowercase. Known limit, deliberate: an all-lowercase name slips through —
    // the gate is the floor, and the author's per-note attestation is the real control.
    if (!/^\p{Lu}/u.test(cur.word)) continue;
    if (!families.has(foldToken(cur.word))) continue;
    if (!/^\p{Lu}/u.test(next.word)) continue;
    let match = `${cur.word} ${next.word}`;
    if (words[i + 2] && /^\p{Lu}/u.test(words[i + 2].word)) match += ` ${words[i + 2].word}`;
    out.push({ rule: 'person_name', severity: 'block', match, hint: snippet(text, { index: cur.index, 0: match }) });
  }
  return out;
}

/**
 * Run the gate over a note.
 * @returns {{ok: boolean, needs_attestation: boolean, findings: Array, checked_chars: number}}
 * `ok` is the machine verdict only: it says the text carries nothing another party owns.
 * Publication additionally requires `attested === true` when `needs_attestation`.
 */
export function checkNote(note, rules = DEFAULT_RULES) {
  const title = String(note.title ?? '');
  const body = String(note.body ?? '');
  const text = `${title}\n${body}`;
  const findings = [];

  for (const term of rules.block_terms) {
    if (!term) continue;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const m = re.exec(text);
    if (m) findings.push({ rule: 'block_term', severity: 'block', match: m[0], hint: snippet(text, m) });
  }

  // Person names: a Vietnamese family name followed by a capitalised word. Checked token by
  // token rather than by one big regex, because the family-name list is lowercase and the
  // text is not: a character-class range such as [A-ZÀ-Ỹ] also matches lowercase accented
  // letters (so "nghi phạm đầu tiên" read as the person "Phạm Đầu"), and /i with \p{Lu}
  // is caseless too. Tokens keep the two decisions separate and correct.
  findings.push(...personNameFindings(text, rules));

  for (const p of rules.document_patterns) {
    const m = documentRe(p).exec(text);
    if (m) findings.push({ rule: 'document', severity: 'block', match: m[0], hint: snippet(text, m) });
  }

  for (const p of rules.figure_patterns) {
    const m = documentRe(p).exec(text);
    if (m) findings.push({ rule: 'figure', severity: 'attest', match: m[0].trim(), hint: snippet(text, m) });
  }

  if (body.trim().length < rules.min_chars) {
    findings.push({
      rule: 'too_short',
      severity: 'note',
      match: `${body.trim().length} chars`,
      hint: `Nội dung dưới ${rules.min_chars} ký tự — người đọc khó dùng được.`
    });
  }
  if (body.length > rules.max_chars) {
    findings.push({ rule: 'too_long', severity: 'note', match: `${body.length} chars`, hint: `Trên ${rules.max_chars} ký tự — nên tách thành hai ghi chú.` });
  }
  if (!/^#|\n##\s/.test(body) && !/^-\s/m.test(body)) {
    findings.push({ rule: 'no_shape', severity: 'note', match: '', hint: 'Chưa có tiêu đề phụ hay gạch đầu dòng — nên có ít nhất hai mục.' });
  }

  const blocking = findings.filter((f) => f.severity === 'block');
  const attest = findings.filter((f) => f.severity === 'attest');
  return {
    ok: blocking.length === 0,
    needs_attestation: attest.length > 0,
    findings,
    checked_chars: text.length,
    verdict: blocking.length ? 'blocked' : attest.length ? 'needs_attestation' : 'clean'
  };
}

/** The whole publication decision, including the human attestation. */
export function decidePublication(note, { attested = false, rules = DEFAULT_RULES } = {}) {
  const report = checkNote(note, rules);
  if (!report.ok) return { publish: false, report, reason: 'blocked' };
  if (report.needs_attestation && !attested) return { publish: false, report, reason: 'attestation_required' };
  return { publish: true, report, reason: 'ok' };
}
