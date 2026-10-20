// src/gate.mjs — the publishability gate.
//
// This is the fix to the flaw the project's own check found: a production expert's
// working notes are written about the employer's plant, so a corpus of raw notes is a
// corpus of someone else's confidential information. The gate is therefore a rule the
// platform enforces *before* a note can enter the corpus, and every note carries the
// author's attestation alongside the machine verdict.
//
// Four severities:
//   block   — never publishable (someone else's name, contract, order or document)
//   attest  — publishable only with the author's explicit per-note attestation (a figure
//             the author declares to be general craft knowledge, not their plant's data)
//   lint    — private-vault metadata ([[wiki links]], ISO dates, `src:` paths, "at this plant"):
//             reported, never blocks a person's note, but the seed loader refuses it
//   note    — advisory, never blocks (style, length, house shape)

export const ATTESTATION_TEXT =
  'I confirm this is my own craft knowledge: it holds no figures, no customer or supplier names, ' +
  'no drawings, no part codes, no prices and no contract terms belonging to any plant.';

// A document code must carry an actual value: at least one digit. "part number" on its own is a
// phrase in a craft note ("write the part number on the traveller"); "part no 4417-B" is a leak.
const VALUE = '(?=[A-Z0-9-]*\\d)[A-Z0-9][A-Z0-9-]*';

export const DEFAULT_RULES = {
  // Names that must never reach the corpus. Extend per deployment in data/gate.rules.json.
  block_terms: ['relats', 'vi-prod', 'vi prod'],
  // Vietnamese family names, in both spellings (with and without diacritics: people type both).
  // "Nguyễn Văn A" is a person, not a craft term. A token must match one of these EXACTLY: "nguyên"
  // (as in "nguyên nhân", root cause) is not folded onto "nguyễn".
  family_names: [
    'nguyễn', 'huỳnh', 'hoàng', 'phan', 'đặng', 'bùi', 'trịnh', 'trương', 'phùng', 'quách', 'nghiêm',
    'diệp', 'doãn', 'khổng', 'ngụy', 'mạc', 'trần', 'lê', 'phạm', 'vũ', 'võ', 'đỗ', 'hồ', 'ngô', 'dương',
    'lý', 'đinh', 'lâm', 'đào', 'mai', 'hà', 'hạ', 'cao', 'châu', 'chu', 'giang', 'kim', 'lương', 'lưu',
    'mã', 'la', 'lại', 'lục', 'lò', 'tô', 'tôn', 'tống', 'từ', 'tạ', 'thái', 'thân', 'sơn', 'văn',
    'thi', 'thịnh', 'ninh', 'viên', 'vi', 'xa', 'yên', 'hứa', 'triệu', 'kiều', 'tăng', 'ông', 'nông',
    'quản', 'thạch', 'tiêu', 'vương', 'lữ', 'đoàn', 'trác', 'sầm', 'lăng', 'bạch', 'ân', 'cung', 'dư',
    'nguyen', 'huynh', 'hoang', 'bui', 'trinh', 'truong', 'phung', 'quach', 'nghiem', 'diep', 'doan',
    'khong', 'nguy', 'mac', 'tran', 'le', 'pham', 'vu', 'vo', 'do', 'ho', 'ngo', 'duong', 'ly', 'dinh',
    'lam', 'dao', 'ha', 'chau', 'luong', 'luu', 'ma', 'lai', 'luc', 'lo', 'to', 'ton', 'tong', 'tu',
    'ta', 'thai', 'than', 'son', 'van', 'thinh', 'vien', 'yen', 'hua', 'trieu', 'kieu', 'tang', 'ong',
    'nong', 'quan', 'thach', 'tieu', 'vuong', 'lu', 'trac', 'sam', 'lang', 'bach', 'an', 'dang'
  ],
  // The short surnames that are also ordinary words ("Do Not run it dry", "Hồ sơ", "Làm đúng",
  // "Lý do", "Lưu ý", "Kim loại", "Phạm vi", "Mã hàng"). Folding makes it worse (Đỗ -> do, Hồ -> ho,
  // Lâm -> lam), so these are matched as exact tokens and only count as a person when the text says
  // so: a kinship or title word in front ("chị Mai") or a middle name behind ("Mai Thị Dung").
  ambiguous_family_names: [
    'đỗ', 'do', 'mai', 'hà', 'ha', 'hạ', 'lý', 'ly', 'lâm', 'lam', 'lê', 'le', 'hồ', 'ho', 'vũ', 'vu',
    'võ', 'vo', 'đào', 'dao', 'đinh', 'dinh', 'đặng', 'dang', 'ngô', 'ngo', 'phạm', 'pham', 'trần', 'tran',
    'dương', 'duong', 'cao', 'châu', 'chau', 'chu', 'giang', 'kim', 'lương', 'luong', 'lưu', 'luu', 'mã',
    'ma', 'la', 'lại', 'lai', 'lục', 'luc', 'lò', 'lo', 'tô', 'to', 'tôn', 'ton', 'tống', 'tong', 'từ', 'tu',
    'tạ', 'ta', 'thái', 'thai', 'thân', 'than', 'sơn', 'son', 'văn', 'van', 'thi', 'thịnh', 'thinh', 'ninh',
    'viên', 'vien', 'vi', 'xa', 'yên', 'yen', 'hứa', 'hua', 'triệu', 'trieu', 'kiều', 'kieu', 'tăng', 'tang',
    'ông', 'ong', 'nông', 'nong', 'quản', 'quan', 'thạch', 'thach', 'tiêu', 'tieu', 'vương', 'vuong', 'lữ',
    'lu', 'đoàn', 'doan', 'trác', 'trac', 'sầm', 'sam', 'lăng', 'lang', 'bạch', 'bach', 'ân', 'an', 'cung',
    'dư', 'mạc', 'mac', 'truong', 'bui', 'khong', 'nguy', 'ngụy'
  ],
  // Family-name companions: a kinship or title word right before a name, and the middle names that
  // make "<ambiguous surname> Văn/Thị ..." unmistakably a person.
  kinship_words: ['anh', 'chị', 'chi', 'ông', 'bà', 'cô', 'chú', 'bác', 'cậu', 'thầy', 'em', 'mr', 'mrs', 'ms', 'miss'],
  middle_names: ['văn', 'van', 'thị', 'thi', 'hữu', 'huu', 'đình', 'dinh'],
  // Documents and identifiers belonging to an employer. Every pattern here needs an actual VALUE.
  document_patterns: [
    'PO\\s*[:#]?\\s*\\d+',
    'LSX\\s*[:#]?\\s*\\d+',
    `(part|item)\\s*(no\\.?|number|#)\\s*[:#]?\\s*${VALUE}`,
    `mã\\s+(hàng|vật\\s+tư|linh\\s+kiện)\\s*[:#]?\\s*${VALUE}`,
    '(đơn\\s+giá|giá\\s+nhập|giá\\s+bán|chiết\\s+khấu)(?:[^\\n\\d]{0,40}?(?:là|:|=|khoảng|tầm))?\\s*\\d[\\d.,]*',
    'hợp\\s+đồng\\s+(số|ngày)\\s*[:#]?\\s*\\d+',
    `(bản\\s+vẽ|drawing)\\s*(no\\.?|number|#)?\\s*[:#]?\\s*${VALUE}`,
    '(tài\\s+liệu\\s+nội\\s+bộ|mật|confidential|internal\\s+use)',
    // English forms of the same things. The corpus may hold either language — the notes are
    // published in English now, but a Vietnamese note with an employer's part number is still
    // someone else's information and still has to be blocked.
    '(unit\\s+price(?:\\s+per\\s+(?:unit|piece))?|price\\s+per\\s+(?:unit|piece))\\s*(is|of|at|:|=)?\\s*[$₫]?\\s*\\d[\\d.,]*',
    `invoice\\s*(no\\.?|number|#)\\s*[:#]?\\s*${VALUE}`,
    `(supplier|customer|vendor)\\s+(code|no\\.?|number)\\s*[:#]?\\s*${VALUE}`,
    '(Mr|Mrs|Ms|Dr)\\.?\\s+\\p{Lu}\\p{Ll}+'
  ],
  // Ways to reach a person: email, Vietnamese mobile numbers (spaces, dots or dashes between the
  // groups, 0 or +84), landlines with an area code, and Zalo / phone labels followed by a number.
  contact_patterns: [
    '[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.\\p{L}{2,}',
    '(?:\\+?84|0)[\\s.-]?[35789](?:[\\s.-]?\\d){8}',
    '(?:\\+?84|0)[\\s.-]?\\(?2\\d{1,2}\\)?(?:[\\s.-]?\\d){7,8}',
    '(?:zalo|viber|sđt|sdt|đt|tel|phone|hotline|điện\\s+thoại|liên\\s+hệ)\\s*[:#]?\\s*\\+?\\d[\\d\\s.-]{5,}\\d'
  ],
  // Customers and suppliers named in the text. Extend per deployment. "Toyota" and "Honda" are not
  // here on purpose: lean literature is full of them as case studies, so a deployment that sells
  // to them adds them. The names below block wherever they appear; the context patterns below
  // catch any other "khách hàng <Name>" / "nhà cung cấp <Name>".
  customer_names: [
    'Bosch', 'Samsung', 'Foxconn', 'Hyundai', 'Denso', 'Panasonic', 'Yamaha', 'Pegatron', 'Luxshare',
    'Sony', 'Siemens', 'Nike', 'Adidas', 'Schaeffler', 'Canon', 'Hitachi', 'Mitsubishi', 'Daikin',
    'Komatsu', 'Jabil', 'Flex', 'Intel'
  ],
  // Vietnamese context words followed by a capitalised name; English ones followed by a capitalised
  // name only when the context word itself is lowercase (so "Customer Complaints" as a heading
  // is not a customer).
  customer_context_patterns: [
    '(khách\\s+hàng|nhà\\s+cung\\s+cấp|đối\\s+tác|nhà\\s+thầu)\\s*[:\\-]?\\s*\\p{Lu}[\\p{L}&-]*(?:\\s+\\p{Lu}[\\p{L}&-]*)?'
  ],
  customer_context_patterns_cased: [
    '\\b(?:customer|client|supplier|vendor|OEM)\\s+\\p{Lu}[\\p{L}&-]*(?:\\s+\\p{Lu}[\\p{L}&-]*)?'
  ],
  // Plant identifiers: a line, shift, lot, station or machine serial named by its code. Case- and
  // diacritic-insensitive on the keyword; the code must contain a digit (or be one capital letter),
  // so "the line stops" and "ca đêm" stay clean while "Chuyền 3", "Ca 2", "Lô 45", "số hiệu 88-2041" block.
  plant_identifier_words: ['line', 'chuyền', 'ca', 'lô', 'lot', 'trạm', 'serial', 'số hiệu'],
  // Private-vault metadata. Not the employer's secret, but it is the vault's own bookkeeping and has
  // no business in front of a reader (or quoted back by an extractive answer): wiki links, ISO dates,
  // `src:` provenance paths, and first-person deixis that names the author's employer without naming it.
  lint_patterns: [
    { kind: 'wiki_link', pattern: '\\[\\[[^\\]\\n]+\\]\\]' },
    { kind: 'iso_date', pattern: '\\d{4}-\\d{2}-\\d{2}' },
    { kind: 'src_path', pattern: 'src:\\s*[^\\s`]+' },
    { kind: 'employer_deixis', pattern: '(?:(?:at|in)\\s+this|our)\\s+(?:plant|factory|company)|this\\s+plant' },
    { kind: 'employer_deixis', pattern: '(?:nhà\\s+máy|xưởng|công\\s+ty)\\s+(?:của\\s+)?mình' }
  ],
  // No \b anywhere in these: \b is defined on ASCII \w, so a boundary next to a Vietnamese
  // letter never matches. checkNote() wraps each pattern in unicode letter/number lookarounds.
  figure_patterns: [
    '\\d[\\d.,]*\\s?(%|phần\\s*trăm)',
    '\\d[\\d.,]*\\s?(vnđ|vnd|đồng|triệu|tỷ|usd|\\$)',
    '\\d[\\d.,]*\\s?(ppm|pcs|cái|chiếc|bộ|kg|tấn|tấn/giờ|m2|mét)',
    '\\d[\\d.,]*\\s?(phút|giờ|giây)\\s*(dừng|ngừng|chạy|máy)',
    'OEE[^\\n]{0,20}\\d',
    '\\d[\\d.,]*\\s*(lần|suất)\\s*/\\s*(tuần|tháng|ngày)',
    '\\d[\\d.,]*\\s?(pcs|units|pairs|sets|kg|tons?|metres?|meters?|percent)',
    '\\d[\\d.,]*\\s?(minutes?|hours?|seconds?)\\s*(down|stopped|idle|running|changeover)'
  ],
  // Instruction-shaped text: a sentence addressed to a language model rather than to a reader. A note
  // is shown to the answering model as evidence, so text that tries to give it orders is a defect in
  // the note, not craft knowledge. Block-class: it never publishes. Patterns are phrases, not single
  // words, and "output" needs an object that is something to leak ("output the salary table"), so
  // ordinary craft sentences ("check the output of the press") stay clean. Vietnamese is given with
  // and without tone marks, as people type both.
  injection_patterns: [
    '(?:ignore|disregard|forget|override)\\s+(?:all\\s+|any\\s+|the\\s+|your\\s+|these\\s+|those\\s+)?(?:previous|prior|above|earlier|preceding|system)\\s+(?:instructions?|rules?|prompts?|messages?|context)',
    '(?:ignore|disregard)\\s+(?:everything|all)\\s+(?:above|before)',
    'you\\s+are\\s+now\\s+(?:a|an|the|in|my|free|no\\s+longer)',
    '(?:new|updated)\\s+instructions?\\s*:',
    '(?:system|developer)\\s+prompt',
    '(?:reveal|print|repeat|show|leak)\\s+(?:your|the)\\s+(?:instructions?|prompt|rules)',
    '(?:output|print|reveal|return|dump|list)\\s+(?:the|all|every|your)\\s+(?:\\p{L}+\\s+){0,2}(?:table|salary|salaries|password|passwords|secrets?|keys?|prompt|instructions?|database|credentials?|contents?)',
    '(?:pretend|act)\\s+(?:to\\s+be|as\\s+if\\s+you\\s+(?:are|were))',
    '(?:bỏ\\s+qua|phớt\\s+lờ|quên)\\s+(?:hết\\s+|tất\\s+cả\\s+|mọi\\s+|các\\s+)?(?:chỉ\\s+dẫn|hướng\\s+dẫn|chỉ\\s+thị|lệnh|quy\\s+tắc)(?:\\s+(?:trước|ở\\s+trên|phía\\s+trên))?',
    '(?:bo\\s+qua|phot\\s+lo|quen)\\s+(?:het\\s+|tat\\s+ca\\s+|moi\\s+|cac\\s+)?(?:chi\\s+dan|huong\\s+dan|chi\\s+thi|lenh|quy\\s+tac)',
    '(?:từ\\s+(?:giờ|bây\\s+giờ)|bây\\s+giờ)\\s+(?:bạn|em|mày)\\s+(?:là|sẽ\\s+là)',
    '(?:tu\\s+(?:gio|bay\\s+gio)|bay\\s+gio)\\s+(?:ban|em|may)\\s+(?:la|se\\s+la)',
    '(?:lời\\s+nhắc|chỉ\\s+thị|prompt)\\s+hệ\\s+thống',
    '(?:in\\s+ra|xuất\\s+ra|hiển\\s+thị|tiết\\s+lộ|cho\\s+tôi\\s+xem)\\s+(?:toàn\\s+bộ\\s+|tất\\s+cả\\s+)?(?:bảng\\s+lương|mật\\s+khẩu|chỉ\\s+dẫn|hướng\\s+dẫn|prompt|dữ\\s+liệu|cơ\\s+sở\\s+dữ\\s+liệu)',
    '(?:in\\s+ra|xuat\\s+ra|hien\\s+thi|tiet\\s+lo)\\s+(?:toan\\s+bo\\s+|tat\\s+ca\\s+)?(?:bang\\s+luong|mat\\s+khau|chi\\s+dan|huong\\s+dan|co\\s+so\\s+du\\s+lieu)'
  ],
  min_chars: 300,
  max_chars: 12000
};

const LIST_KEYS = [
  'block_terms', 'family_names', 'ambiguous_family_names', 'kinship_words', 'middle_names',
  'document_patterns', 'contact_patterns', 'customer_names', 'customer_context_patterns',
  'customer_context_patterns_cased', 'plant_identifier_words', 'lint_patterns', 'figure_patterns', 'injection_patterns'
];

export function loadRules(extra) {
  const rules = { ...DEFAULT_RULES, ...(extra ?? {}) };
  for (const key of LIST_KEYS) rules[key] = [...DEFAULT_RULES[key], ...((extra && extra[key]) || [])];
  return rules;
}

function snippet(text, match) {
  const i = match.index ?? 0;
  const start = Math.max(0, i - 40);
  return text.slice(start, Math.min(text.length, i + match[0].length + 40)).replace(/\s+/g, ' ').trim();
}

/**
 * Lowercase and strip tones, one output character per input character, so an index in the folded
 * text is an index in the original (the plant-identifier rule matches on the folded text).
 */
function foldKeepLength(text) {
  let out = '';
  for (const ch of text) {
    const f = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    out += f.length === ch.length ? f : ch;
  }
  return out;
}

/**
 * \b is defined on ASCII \w, so `\bđơn\s+giá\b` never matched "Đơn giá" — the boundary is
 * tested against a non-word character on both sides. Unicode letter/number lookarounds are
 * the form that works for Vietnamese.
 */
function documentRe(pattern) {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'giu');
}

const isCap = (w) => /^\p{Lu}/u.test(w);
const adjacent = (text, a, b) => /^[ \t]+$/.test(text.slice(a.index + a.word.length, b.index));

/**
 * A person's name, decided token by token. Three shapes:
 *   1. an unambiguous family name followed by a capitalised word ("Nguyễn Văn", "TRẦN THỊ LAN");
 *   2. the same after a kinship word, in any case ("chị nguyễn thị hoa");
 *   3. an ambiguous surname (Do, Mai, Hồ, Lý, Lam, ...) only with a kinship word in front
 *      ("chị Mai") or a middle name behind ("Mai Thị Dung"). "Do Not run it dry" stays clean.
 * Case and surname are decided separately, which is what keeps "nghi phạm đầu tiên" (evidence,
 * first suspect) out of the results while "anh Nguyễn Văn Anh" is caught. Exact tokens, never
 * folded: Đỗ folded is "do", and a block on every sentence starting "Do" is the bug this fixes.
 */
function personNameFindings(text, rules) {
  const lc = (list) => new Set(list.map((x) => String(x).toLowerCase()));
  const ambiguous = lc(rules.ambiguous_family_names ?? []);
  const families = lc(rules.family_names);
  const kinship = lc(rules.kinship_words ?? []);
  const middle = lc(rules.middle_names ?? []);
  const out = [];
  const words = [...text.matchAll(/\p{L}+/gu)].map((m) => ({ word: m[0], lower: m[0].toLowerCase(), index: m.index }));
  for (let i = 0; i < words.length; i += 1) {
    const cur = words[i];
    if (!families.has(cur.lower) && !ambiguous.has(cur.lower)) continue;
    const prev = words[i - 1];
    const kin = Boolean(prev && kinship.has(prev.lower) && adjacent(text, prev, cur));
    const n1 = words[i + 1] && adjacent(text, cur, words[i + 1]) ? words[i + 1] : null;
    const n2 = n1 && words[i + 2] && adjacent(text, n1, words[i + 2]) ? words[i + 2] : null;
    const n1Middle = Boolean(n1 && middle.has(n1.lower));
    let hit;
    if (ambiguous.has(cur.lower)) {
      hit = (kin && (isCap(cur.word) || n1Middle)) || (isCap(cur.word) && n1Middle && isCap(n1.word) && n2 && isCap(n2.word));
    } else {
      hit = (isCap(cur.word) && n1 && isCap(n1.word)) || kin;
    }
    if (!hit) continue;
    const taken = [cur];
    if (n1 && (isCap(n1.word) || n1Middle)) taken.push(n1);
    if (taken.length === 2 && n2 && (isCap(n2.word) || n1Middle)) taken.push(n2);
    const last = taken[taken.length - 1];
    const match = text.slice(cur.index, last.index + last.word.length);
    out.push({ rule: 'person_name', severity: 'block', match, hint: snippet(text, { index: kin ? prev.index : cur.index, 0: match }) });
    i += taken.length - 1;
  }
  return out;
}

function plantIdentifierFindings(text, rules) {
  const folded = foldKeepLength(text);
  const words = rules.plant_identifier_words
    .map((w) => foldKeepLength(String(w)).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[ \\t]+'))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!words.length) return [];
  // The keyword must end where the code starts ("lot 45", "ca: 2", "line3"), or "lot" would be read as "lo" + "t".
  const re = new RegExp(`(?<![a-z0-9])(?:${words.join('|')})(?:[ \\t]*[:#][ \\t]*|[ \\t]+|(?=\\d))([a-z0-9][a-z0-9-]*)(?![a-z0-9])`, 'g');
  const out = [];
  for (const m of folded.matchAll(re)) {
    const code = m[1];
    const codeAt = m.index + m[0].length - code.length;
    const original = text.slice(codeAt, codeAt + code.length);
    const oneCapital = code.length === 1 && /\p{Lu}/u.test(original);
    if (!/\d/.test(code) && !oneCapital) continue;
    // "ca 8 tiếng", "line 2 hours": a number followed by a duration or headcount is a quantity, not a code.
    if (/^[ \t]*(?:tieng|gio|h|hours?|hrs?|phut|minutes?|mins?|ngay|days?|nguoi|people)(?![a-z0-9])/.test(folded.slice(m.index + m[0].length))) continue;
    const match = text.slice(m.index, m.index + m[0].length);
    out.push({ rule: 'plant_identifier', severity: 'block', match, hint: snippet(text, { index: m.index, 0: match }) });
  }
  return out;
}

function customerFindings(text, rules) {
  const out = [];
  const push = (m) => out.push({ rule: 'customer_name', severity: 'block', match: m[0], hint: snippet(text, m) });
  for (const name of rules.customer_names ?? []) {
    if (!name) continue;
    for (const m of text.matchAll(documentRe(String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))) push(m);
  }
  for (const p of rules.customer_context_patterns ?? []) for (const m of text.matchAll(documentRe(p))) push(m);
  // Case-sensitive on purpose: only a lowercase "customer Acme" is a customer, not a heading.
  for (const p of rules.customer_context_patterns_cased ?? []) {
    for (const m of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${p})(?![\\p{L}\\p{N}])`, 'gu'))) push(m);
  }
  return out;
}

function lintFindings(text, rules) {
  const out = [];
  for (const { kind, pattern } of rules.lint_patterns ?? []) {
    for (const m of text.matchAll(documentRe(pattern))) {
      out.push({ rule: 'corpus_lint', kind, severity: 'lint', match: m[0], hint: `${kind.replace(/_/g, ' ')}: ${snippet(text, m)}` });
    }
  }
  return out;
}

/**
 * Run the gate over a note.
 * @returns {{ok: boolean, needs_attestation: boolean, findings: Array, checked_chars: number}}
 * `ok` is the machine verdict only: it says the text carries nothing another party owns.
 * Publication additionally requires `attested === true` when `needs_attestation`.
 * Severities: `block` (never publishable), `attest` (publishable only with the author's
 * attestation), `lint` (private-vault metadata: reported, never blocks a person's note, but a
 * seeded note must be free of it), `note` (advisory style).
 */
export function checkNote(note, rules = DEFAULT_RULES) {
  const title = String(note.title ?? '');
  const body = String(note.body ?? '');
  // NFC first: the rules are written with precomposed Vietnamese letters, and the person-name and
  // plant-identifier checks index into this text.
  const text = `${title}\n${body}`.normalize('NFC');
  const findings = [];

  for (const term of rules.block_terms) {
    if (!term) continue;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (const m of text.matchAll(re)) findings.push({ rule: 'block_term', severity: 'block', match: m[0], hint: snippet(text, m) });
  }

  // Person names are checked token by token rather than by one big regex, because the family-name
  // list is lowercase and the text is not: a character-class range such as [A-ZÀ-Ỹ] also matches
  // lowercase accented letters (so "nghi phạm đầu tiên" read as the person "Phạm Đầu").
  findings.push(...personNameFindings(text, rules));
  findings.push(...plantIdentifierFindings(text, rules));
  findings.push(...customerFindings(text, rules));

  for (const p of rules.document_patterns) {
    for (const m of text.matchAll(documentRe(p))) findings.push({ rule: 'document', severity: 'block', match: m[0], hint: snippet(text, m) });
  }
  for (const p of rules.contact_patterns ?? []) {
    for (const m of text.matchAll(documentRe(p))) findings.push({ rule: 'contact', severity: 'block', match: m[0], hint: snippet(text, m) });
  }

  for (const p of rules.injection_patterns ?? []) {
    for (const m of text.matchAll(documentRe(p))) findings.push({ rule: 'instruction_text', severity: 'block', match: m[0], hint: snippet(text, m) });
  }

  for (const p of rules.figure_patterns) {
    for (const m of text.matchAll(documentRe(p))) findings.push({ rule: 'figure', severity: 'attest', match: m[0].trim(), hint: snippet(text, m) });
  }

  findings.push(...lintFindings(text, rules));

  if (body.trim().length < rules.min_chars) {
    findings.push({
      rule: 'too_short',
      severity: 'note',
      match: `${body.trim().length} chars`,
      hint: `Body under ${rules.min_chars} characters — a reader cannot use it.`
    });
  }
  if (body.length > rules.max_chars) {
    findings.push({ rule: 'too_long', severity: 'note', match: `${body.length} chars`, hint: `Over ${rules.max_chars} characters — split it into two notes.` });
  }
  if (!/^#|\n##\s/.test(body) && !/^-\s/m.test(body)) {
    findings.push({ rule: 'no_shape', severity: 'note', match: '', hint: 'No subheadings and no bullets — two sections is the minimum for a usable note.' });
  }

  const blocking = findings.filter((f) => f.severity === 'block');
  const attest = findings.filter((f) => f.severity === 'attest');
  return {
    ok: blocking.length === 0,
    needs_attestation: attest.length > 0,
    lint: findings.filter((f) => f.severity === 'lint').length,
    findings,
    checked_chars: text.length,
    verdict: blocking.length ? 'blocked' : attest.length ? 'needs_attestation' : 'clean'
  };
}

/**
 * The whole publication decision, including the human attestation. There is no default that
 * attests for the author: `attested` is true only when a person ticked the box for this very text.
 */
export function decidePublication(note, { attested = false, rules = DEFAULT_RULES } = {}) {
  const report = checkNote(note, rules);
  if (!report.ok) return { publish: false, report, reason: 'blocked' };
  if (report.needs_attestation && attested !== true) return { publish: false, report, reason: 'attestation_required' };
  return { publish: true, report, reason: 'ok' };
}
