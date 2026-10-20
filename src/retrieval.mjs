// src/retrieval.mjs — BM25-lite retrieval over the published corpus.
// Folding: tokens are folded (diacritics stripped, đ→d) so "chuyền" and "chuyen" match, which is how people actually type.
// Queries (not notes) additionally pass through the Vietnamese→English bridge in ./lexicon.mjs.
//
// Ported from the unmerged improve/retrieval branch (3e0ffe2, 9bb9d08): the lexicon, unit-based coverage and
// chunking. What was added on top for #29 and what was measured is in eval/README.md. Every switch that
// was an experiment lives in TUNING, so a sweep is a flag, not an edit.

import { LEXICON, KNOWN_TOPIC_WORDS } from './lexicon.mjs';

export const TUNING = {
  englishStops: true, // drop how/my/does/please/our/for ... from what a question is about
  stem: false, // light English suffix normalisation (-s/-es/-ing/-ed): true = on both sides, 'fallback' = only a question word the corpus has never seen is retried as another inflection
  acronyms: true, // OEE <-> overall equipment effectiveness, SMED, TPM, 5S, OPL ... canonicalised on both sides
  scoring: 'share', // 'share' (idf share of all units) | 'distinctive' (idf share of the rare units only)
  missPower: 1, // missing units are pooled as an L-p norm: 1 = sum (verbosity counts), larger = the worst miss counts, not the number of them
  unknownWeightEn: 1, // the same, in a question that is plainly English: there an unseen word is padding ("plastics", "crew"), not a missed topic
  unknownWeight: 1, // weight of a word that is neither in the corpus nor in the lexicon (padding, names)
  minTop: 2.2,
  minShare: 0.5,
  distinctShare: 0.25,
  exactTerms: true, // diacritic-sensitive index: an accented word is also indexed (and asked) under its exact spelling, so mã != ma
  margin: 0, // required relative gap between the top two scores (0 = off)
  clauseShare: 0, // a question may also be covered if one clause of it is (0 = off): length must not decide
  chunkRank: false
};

export function fold(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

// Spellings of the same thing that must agree on both sides (notes and questions). Written for
// lower-case, diacritic-free text. The tokenizer drops 1-char tokens, so "5 why" would otherwise lose
// its "5"; a fused token keeps it. Acronyms are expanded in one direction only (long form -> acronym)
// because notes write "OEE" and askers sometimes spell it out.
// Spellings of the same thing that must agree on both sides (notes and questions). Written for
// lower-case, diacritic-free text. The tokenizer drops 1-char tokens, so "5 why" would otherwise lose
// its "5"; a fused token keeps it.
const PHRASES = [
  [/\b(?:5|five)[\s-]*whys?\b/g, '5why'],
  [/\b(?:5|five)[\s-]+s\b/g, '5s'],
  [/\bone[\s-]*point\b/g, 'onepoint'],
  [/\bopl\b/g, 'onepoint lesson'],
  [/\bchange[\s-]*overs?\b/g, 'changeover'],
  [/\bset[\s-]*ups?\b/g, 'setup'],
  [/\broot[\s-]*causes?\b/g, 'root cause'],
  [/\bmid[\s-]*shift\b/g, 'mid shift'],
  [/\bkan[\s-]*ban\b/g, 'kanban'],
  [/\bkai[\s-]*zen\b/g, 'kaizen'],
  [/\ban[\s-]*don\b/g, 'andon'],
  [/\bmold(s|ing)?\b/g, 'mould$1'],
  [/\bstandardi[sz](e|ed|ing|ation)\b/g, 'standardis$1'],
  [/\bwhys\b/g, '5why'],
  [/\b(?:in )?the middle of (?:the|a|my|our|your|each|every) shifts?\b/g, 'mid shift']
];

// Acronyms and their long forms are one thing. Both spellings are rewritten to the acronym on the note
// side and on the question side, so a question that spells it out reaches a note that abbreviates it,
// and the other way round. Long forms are matched with optional hyphens/plurals.
const ACRONYMS = [
  ['oee', 'overall equipment effectiveness'],
  ['tpm', 'total productive maintenance'],
  ['smed', 'single minute exchange of dies?'],
  ['smed', 'single[\\s-]digit minute exchange of dies?'],
  ['5s', 'sort[,\\s]+set in order[,\\s]+shine[,\\s]+standardi[sz]e[,\\s]+sustain'],
  ['jipm', 'japan institute of plant maintenance'],
  ['capa', 'corrective and preventive action'],
  ['pdsa', 'plan[\\s-]do[\\s-]study[\\s-]act'],
  ['twi', 'training within industry'],
  ['kpi', 'key performance indicators?'],
  ['sop', 'standard operating procedures?'],
  ['mttr', 'mean time to repair'],
  ['mtbf', 'mean time between failures?'],
  ['fmea', 'failure modes? and effects analysis']
].map(([short, long]) => [new RegExp(`\\b${long.replace(/ /g, '[\\s-]+')}\\b`, 'g'), short]);

export function normalizePhrases(s) {
  let out = s;
  for (const [re, to] of PHRASES) out = out.replace(re, to);
  if (TUNING.acronyms) for (const [re, to] of ACRONYMS) out = out.replace(re, to);
  return out;
}

// Light English suffix normalisation. Off by default: measured neutral-to-harmful (eval/README.md).
function stem(t) {
  if (!/^[a-z]+$/.test(t) || t.length <= 4) return t;
  if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3);
  if (t.endsWith('ied')) return `${t.slice(0, -3)}y`;
  if (t.endsWith('ed') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.endsWith('es') && /(?:ch|sh|ss|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) return t.slice(0, -1);
  return t;
}

// The other inflections a word might be written in: stops/stopped/stopping -> stop, whys -> why.
function inflections(t) {
  if (!/^[a-z]+$/.test(t) || t.length <= 3) return [];
  const out = [];
  const base = (b) => { out.push(b); if (/(.)\1$/.test(b)) out.push(b.slice(0, -1)); out.push(`${b}e`); };
  if (t.endsWith('ing') && t.length > 5) base(t.slice(0, -3));
  if (t.endsWith('ied')) out.push(`${t.slice(0, -3)}y`);
  else if (t.endsWith('ed') && t.length > 4) base(t.slice(0, -2));
  if (t.endsWith('ies')) out.push(`${t.slice(0, -3)}y`);
  else if (t.endsWith('es')) { out.push(t.slice(0, -2)); out.push(t.slice(0, -1)); }
  else if (t.endsWith('s') && !t.endsWith('ss')) out.push(t.slice(0, -1));
  else out.push(`${t}s`, `${t}es`);
  return out;
}

export function tokenize(s) {
  const toks = (normalizePhrases(fold(s)).match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
  return TUNING.stem ? toks.map(stem) : toks;
}

const nfc = (s) => String(s).normalize('NFC').toLowerCase();
const hasMarks = (w) => w !== fold(w);

/** Terms a note is indexed under: every folded token, plus the exact spelling of each accented word. */
export function indexTerms(s) {
  if (!TUNING.exactTerms) return tokenize(s);
  const exact = (nfc(s).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && hasMarks(w));
  return [...tokenize(s), ...exact];
}

// Vietnamese stopwords. Short and diacritic-folded: without this list every question shares
// a handful of tokens with every note, every score clears the threshold, and the AI tier
// claims coverage it does not have — measured before adding it: an HR question scored 12.3
// against a note about machine stoppages.
export const STOPWORDS = new Set([
  'va', 'cua', 'la', 'co', 'cho', 'khi', 'nao', 'gi', 'mot', 'cac', 'nhung', 'de', 'voi', 'thi', 'ma',
  'neu', 'khong', 'duoc', 'nay', 'do', 'kia', 'ai', 'tai', 'trong', 'ngoai', 'tren', 'duoi', 'ra', 'vao',
  // 'xuong' here is the Vietnamese stopword (xưởng, folded to ASCII by the diacritic pass), not the
  // product name. It stays — a rename that swept this line would silently change what retrieval drops.
  'len', 'xuong', 'roi', 'da', 'se', 'dang', 'bi', 'do', 'vi', 'nen', 'hay', 'hoac', 'cung', 'nhu', 'sao',
  'the', 'chi', 'con', 'phai', 've', 'theo', 'lam', 'bang', 'toi', 'minh', 'ban', 'ho', 'no', 'rat', 'qua',
  'nhieu', 'it', 'moi', 'tu', 'den', 'sau', 'truoc', 'giua', 'thu', 'lam', 'sao', 'bao', 'nhieu'
]);

// "ca" is not in the list above on purpose: bare it is a shift (the function word is "cả", accented),
// and the lexicon translates it.

// English function words and request padding: "how do I ... please", "for our plant in ..." say nothing
// about the topic, but each one used to count as a content word the note was missing.
export const ENGLISH_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'done', 'doing',
  'have', 'has', 'had', 'how', 'what', 'whats', 'why', 'when', 'where', 'who', 'whom', 'which', 'whose',
  'can', 'could', 'should', 'would', 'will', 'shall', 'might', 'must', 'it', 'its', 'we', 'us', 'our', 'ours',
  'you', 'your', 'yours', 'my', 'me', 'mine', 'he', 'she', 'his', 'her', 'they', 'them', 'their', 'this', 'that',
  'these', 'those', 'to', 'of', 'in', 'on', 'at', 'for', 'from', 'by', 'with', 'about', 'into', 'as', 'and',
  'or', 'but', 'if', 'so', 'not', 'no', 'any', 'some', 'there', 'here', 'please', 'pls', 'tell', 'give',
  'show', 'explain', 'need', 'want', 'get', 'let', 'just', 'also', 'very', 'much', 'many', 'more', 'most',
  'than', 'then', 'up', 'out', 'help', 'know', 'like', 'thanks', 'thank', 'hello', 'hi', 'ok', 'okay',
  'while', 'after', 'before', 'again', 'ever', 'still', 'really', 'every', 'each', 'one',
  // the shape of a question, not its topic
  'difference', 'different', 'between', 'versus', 'vs', 'compare', 'mean', 'means', 'meaning', 'example',
  'way', 'ways', 'ignore', 'above', 'previous', 'instructions', 'passages', 'passage',
  // the place the asker stands is context, not the topic
  'plant', 'factory', 'company', 'site', 'workplace'
]);

/**
 * True for a word that says nothing about the topic. `w` is NFC lower-case, as typed. This is only asked
 * of a word the lexicon did not translate: the lexicon is where a word that merely *folds* to a stopword
 * says what it is (mã = code, đèn = lamp, ca = shift, thử = trial), because it is matched on the exact
 * spelling first. Bare "ma" is ambiguous (ma/má/mà/mã) and stays a stopword.
 */
export function isStopWord(w) {
  if (TUNING.englishStops && ENGLISH_STOPWORDS.has(w)) return true;
  return STOPWORDS.has(fold(w));
}

// English function words that are not a Vietnamese word typed without marks: seeing one means English.
const ENGLISH_ONLY_MARKERS = new Set(
  ['how', 'what', 'whats', 'why', 'when', 'where', 'who', 'which', 'does', 'did', 'should', 'would', 'could', 'my', 'our', 'your', 'we', 'you', 'i', 'please', 'pls', 'tell', 'is', 'are', 'was', 'were', 'have', 'has', 'about', 'with', 'from', 'there', 'their', 'they', 'this', 'that']
);

// --- Vietnamese -> English bridge ---------------------------------------------------------------
// Compiled once. Phrase-first, longest match wins; see src/lexicon.mjs for the matching rules.
const words = (s) => normalizePhrases(nfc(s)).match(/[\p{L}\p{N}]+/gu) ?? [];
const BRIDGE = new Map(); // folded first word -> entries [{ key: [words], en, strict }]
let BRIDGE_MAX = 1;
for (const [vi, en] of LEXICON) {
  const strictMark = vi.startsWith('=');
  const key = words(vi.replace(/^=/, ''));
  if (!key.length) continue;
  const strict = strictMark || (key.length === 1 && STOPWORDS.has(fold(key[0])));
  const first = fold(key[0]);
  if (!BRIDGE.has(first)) BRIDGE.set(first, []);
  BRIDGE.get(first).push({ key, folded: key.map(fold), en, strict });
  BRIDGE_MAX = Math.max(BRIDGE_MAX, key.length);
}
// Longest phrase first within each bucket; stable for equal lengths (earlier entry wins).
for (const list of BRIDGE.values()) list.sort((a, b) => b.key.length - a.key.length);
// Every English token the bridge can produce: the words the system knows a question may be about.
const LEXICON_VOCAB = new Set(LEXICON.flatMap(([, en]) => tokenize(en)));

function bridgeMatch(ws, i) {
  const list = BRIDGE.get(fold(ws[i]));
  if (!list) return null;
  for (const e of list) {
    if (i + e.key.length > ws.length) continue;
    let ok = true;
    for (let j = 0; j < e.key.length && ok; j++) {
      const w = ws[i + j];
      const exact = w === e.key[j];
      const bare = w === fold(w) && fold(e.key[j]) === w;
      // A word that carries diacritics must match exactly; a bare word matches its folded form,
      // except for strict single-word keys, where bare input is ambiguous (ma/mà/mã) and must not translate.
      ok = exact || (bare && !(e.strict && e.key.length === 1));
    }
    if (ok) return e;
  }
  return null;
}

/**
 * Rewrite a Vietnamese (or mixed) question into "units": one unit per source word or matched phrase,
 * each holding the tokens it became (a bridged phrase yields several English tokens that are
 * alternatives for one concept, so coverage counts the unit once, not once per token). Words that say
 * nothing about the topic are dropped here. An unbridged word that keeps its diacritics stays exact
 * ("mã"), so it cannot match "ma", "má" or "mà"; a bare word is folded and matches all of them.
 */
const isEnglishWords = (ws) => TUNING.englishStops && ws.some((w) => ENGLISH_ONLY_MARKERS.has(w));

/** True when the question is plainly English (it holds a function word no Vietnamese word is spelled like). */
export function isEnglishQuestion(s) {
  return isEnglishWords(words(s));
}

export function queryUnits(s, index = null) {
  const units = queryUnitsRaw(s);
  if (TUNING.stem !== 'fallback' || !index) return units;
  // Only a word the corpus has never seen is retried as another inflection; a word it knows is left alone.
  return units.map((u) => u.map((t) => (index.df.get(t) ? t : inflections(t).find((v) => index.df.get(v)) ?? t)));
}

function queryUnitsRaw(s) {
  const ws = words(s);
  const units = [];
  // Some English function words are also bare Vietnamese words ("on" = ồn, "may" = máy, "to" = tổ). In a
  // question that is plainly English they are function words; in Vietnamese typed without marks they
  // are not, so only an English-only marker word decides.
  const english = isEnglishWords(ws);
  for (let i = 0; i < ws.length; ) {
    if (english && ENGLISH_STOPWORDS.has(ws[i])) {
      i += 1;
      continue;
    }
    const e = bridgeMatch(ws, i);
    if (e) {
      units.push(tokenize(e.en).filter((t) => !isStopWord(t)));
      i += e.key.length;
      continue;
    }
    const w = ws[i];
    i += 1;
    if (isStopWord(w)) continue;
    const toks = tokenize(w);
    units.push(TUNING.exactTerms && hasMarks(w) && w.length > 1 && toks.length === 1 ? [w] : toks.filter((t) => !isStopWord(t)));
  }
  return units.filter((u) => u.length);
}

/** Tokens of a question: bridged to English, then tokenised like a note. */
export function queryTokens(s, index = null) {
  return queryUnits(s, index).flat();
}

/** Content units (stopwords removed, repeats collapsed): what a question is actually about. */
export function contentUnits(s, index = null) {
  const seen = new Set();
  const out = [];
  for (const u of queryUnits(s, index)) {
    const c = [...new Set(u)];
    const key = c.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Content tokens only: what a question is actually about. */
export function contentTokens(s, index = null) {
  return [...new Set(contentUnits(s, index).flat())];
}

const K1 = 1.2;
const B = 0.75;

// --- chunks ------------------------------------------------------------------------------------
// Notes are still ranked as a whole; chunks only pick which passage the model is shown. Ranking or
// judging coverage on the best chunk was measured and lost (eval/README.md): recall fell from 0.77 to
// 0.50, because a supervisor's question spans sections. Sending the first 1400 chars, though, dropped
// the answering section whenever it sat past the cut.
const WINDOW_LINES = 6;
const MAX_SECTION_LINES = 8;
const MAX_CHUNK_CHARS = 1200;

/** Split a note body into passages: markdown sections, long sections cut into 6-line windows. */
export function chunkBody(body) {
  const lines = String(body ?? '').split('\n');
  const sections = [];
  let cur = { heading: '', lines: [] };
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (cur.lines.some((l) => l.trim())) sections.push(cur);
      cur = { heading: line.replace(/^#+\s*/, '').trim(), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.some((l) => l.trim())) sections.push(cur);
  const chunks = [];
  for (const sec of sections) {
    const body = sec.lines.filter((l) => l.trim());
    if (body.length <= MAX_SECTION_LINES && body.join('\n').length <= MAX_CHUNK_CHARS) {
      chunks.push({ heading: sec.heading, text: sec.lines.join('\n').trim() });
      continue;
    }
    // A long section is cut into windows of at most 6 lines and ~1200 chars, so a passage always fits the prompt.
    let win = [];
    let size = 0;
    let first = true;
    const flush = () => {
      if (!win.length) return;
      // later windows repeat the heading so a passage still says which section it belongs to
      const text = first || !sec.heading ? win.join('\n') : `## ${sec.heading}\n${win.join('\n')}`;
      first = false;
      chunks.push({ heading: sec.heading, text });
      win = [];
      size = 0;
    };
    for (const line of body) {
      if (win.length && (win.length >= WINDOW_LINES || size + line.length > MAX_CHUNK_CHARS)) flush();
      win.push(line);
      size += line.length + 1;
    }
    flush();
  }
  return chunks;
}

export function buildIndex(notes) {
  const docs = notes.map((n) => {
    const titleTokens = indexTerms(n.title);
    const bodyTokens = indexTerms(n.body);
    // Title terms count five times: a note about 5S should win over one that mentions it.
    const tokens = [...titleTokens, ...titleTokens, ...titleTokens, ...titleTokens, ...titleTokens, ...bodyTokens];
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { note: n, tf, len: tokens.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);

  const chunks = [];
  docs.forEach((d, di) => {
    for (const c of chunkBody(d.note.body)) {
      const toks = indexTerms(`${c.heading} ${c.text}`);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      chunks.push({ doc: di, heading: c.heading, text: c.text, tf, len: toks.length });
    }
  });
  const cdf = new Map();
  for (const c of chunks) for (const t of c.tf.keys()) cdf.set(t, (cdf.get(t) ?? 0) + 1);
  const cavgdl = chunks.reduce((a, c) => a + c.len, 0) / (chunks.length || 1);
  return { docs, df, avgdl, n: docs.length, chunks, cdf, cavgdl, cn: chunks.length };
}

function bm25(qTokens, tf, len, df, n, avgdl) {
  let score = 0;
  for (const t of qTokens) {
    const f = tf.get(t) ?? 0;
    if (!f) continue;
    const d = df.get(t) ?? 0;
    const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
    score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / (avgdl || 1))));
  }
  return score;
}

export function search(query, index, k = 5) {
  const qTokens = [...new Set(queryTokens(query, index))];
  if (!qTokens.length || !index.n) return [];
  const bestByDoc = new Map(); // doc -> chunks ranked by score
  for (const c of index.chunks ?? []) {
    const sc = bm25(qTokens, c.tf, c.len, index.cdf, index.cn, index.cavgdl);
    if (sc <= 0) continue;
    if (!bestByDoc.has(c.doc)) bestByDoc.set(c.doc, []);
    bestByDoc.get(c.doc).push({ heading: c.heading, text: c.text, score: Number(sc.toFixed(4)) });
  }
  const scored = index.docs.map((d, di) => {
    const noteScore = bm25(qTokens, d.tf, d.len, index.df, index.n, index.avgdl);
    const chunks = (bestByDoc.get(di) ?? []).sort((a, b) => b.score - a.score);
    return { note: d.note, score: Number(noteScore.toFixed(4)), chunk: chunks[0] ?? null, chunks: chunks.slice(0, 3) };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.note.id - b.note.id)
    .slice(0, k);
}

/**
 * Coverage verdict for one question against the corpus.
 * `thin` is the escalation trigger: the AI tier refuses to guess, and the platform
 * offers to put the question to a practitioner instead.
 *
 * `hard` marks the signals retrieval is sure of on its own: nothing matched, the question is too short,
 * the best score is weak, or the only words shared with the note are everyday ones. A thin verdict
 * without `hard` (the share or margin rule) is a soft vote, which a configured model may overrule.
 *
 * Decided on the idf-weighted share of the question's content words that the closest note
 * actually contains — i.e. whether the corpus holds the question's *distinctive* words, not
 * its common ones. Measured why the two cheaper rules fail (see test/unit.test.mjs):
 * a raw score threshold passes everything, because BM25 rewards long documents (an HR
 * question scored 12.3 against a note about machine stoppages); and an unweighted word share
 * cannot separate an off-corpus question at 0.44–0.55 from an on-corpus one at 1.00, because
 * Vietnamese questions share their common words ("dừng", "vấn", "thường", "nhà") with
 * everything. Weighting each missing word by how rare it is separates them cleanly.
 */
export function coverage(question, hits, index, opts = {}) {
  const o = { ...TUNING, ...opts };
  const thin = (why, extra = {}) => ({ verdict: 'thin', why, share: 0, top: hits[0]?.score ?? 0, hard: true, ...extra });
  const units = contentUnits(question, index);
  if (units.length < 2) return thin('the question is too short to search on');
  if (!hits.length) return thin('no note matched');
  const top = hits[0];
  if (top.score < o.minTop) return thin(`top match is weak (${top.score} < ${o.minTop})`);

  const dfOf = (t) => index?.df?.get(t) ?? 0;
  const idf = (t) => {
    const n = index?.n ?? 1;
    return Math.log(1 + (n - dfOf(t) + 0.5) / (dfOf(t) + 0.5));
  };
  const inTop = new Set(indexTerms(`${top.note.title} ${top.note.body}`));
  // A word the corpus has never seen and the lexicon cannot translate is padding or a name, not a topic.
  const uw = isEnglishQuestion(question) ? o.unknownWeightEn : o.unknownWeight;
  const known = (t) => dfOf(t) > 0 || KNOWN_TOPIC_WORDS.has(t) || LEXICON_VOCAB.has(t);
  // A unit is one concept. It weighs what its rarest token weighs, and is covered by the rarest of its
  // tokens that the note contains (so "root cause" present only as "cause" earns partial credit, and
  // bridged alternatives like "operator worker" are not each charged as missing).
  let have = 0;
  const misses = [];
  // Sharing only everyday words (new, operator, machine, line, time) is not coverage: at least one covered
  // unit must be a distinctive term, i.e. present in no more than `distinctShare` of the notes.
  const maxDf = Math.max(1, Math.floor(o.distinctShare * (index?.n ?? 1)));
  let distinct = false;
  const missing = [];
  for (const u of units) {
    const present = u.filter((t) => inTop.has(t));
    const rare = (t) => dfOf(t) <= maxDf;
    if (present.length) {
      const w = Math.max(...present.map(idf));
      if (present.some(rare)) distinct = true;
      if (o.scoring === 'distinctive' && !present.some(rare)) continue;
      have += w;
    } else {
      const w = Math.max(...u.map(idf)) * (u.some(known) ? 1 : uw);
      if (o.scoring === 'distinctive' && u.some((t) => dfOf(t) > maxDf)) continue;
      misses.push(w);
      missing.push(u[0]);
    }
  }
  // How much the note lacks: with missPower 1 every miss adds up, so a long question that mentions a plant,
  // a crew and a month is refused for its length. A larger power lets the single worst miss decide.
  const lack = o.missPower === 1 ? misses.reduce((a, b) => a + b, 0) : misses.length ? misses.reduce((a, b) => a + b ** o.missPower, 0) ** (1 / o.missPower) : 0;
  const total = have + lack;
  const share = total ? have / total : 0;
  if (!distinct) {
    return thin('the question only shares everyday words with the closest note, nothing distinctive', { share });
  }
  let rescued = false;
  if (share < o.minShare && o.clauseShare > 0) {
    // A long question mentions the plant, the crew and last night. Judge each clause on its own; if one of
    // them is covered by the note, the rest was context.
    const clauses = String(question).split(/[,;:.!?\n]+|\b(?:and|but|so|while|because|và|nhưng|nên|vì)\b/i).map((c) => contentUnits(c)).filter((u) => u.length >= 2);
    if (clauses.length > 1) {
      for (const cu of clauses) {
        let h = 0;
        let m = 0;
        for (const u of cu) {
          const present = u.filter((t) => inTop.has(t));
          if (present.length) h += Math.max(...present.map(idf));
          else m += Math.max(...u.map(idf)) * (u.some(known) ? 1 : uw);
        }
        if (h + m > 0 && h / (h + m) >= o.clauseShare) rescued = true;
      }
    }
  }
  if (share < o.minShare && !rescued) {
    return thin(
      `the closest note covers only ${(share * 100).toFixed(0)}% of the question's key terms; missing: ${missing.slice(0, 5).join(', ')}`,
      { share, hard: false }
    );
  }
  if (o.margin > 0 && hits.length > 1 && top.score < hits[1].score * (1 + o.margin)) {
    return thin(`two notes match about equally (${top.score} vs ${hits[1].score}); the question is ambiguous`, { share, hard: false });
  }
  return { verdict: 'ok', why: `matched ${hits.length} notes, ${(share * 100).toFixed(0)}% of the key terms, top score ${top.score}`, share, top: top.score, hard: false };
}

/** Extractive answer used when no LLM key is configured, or when the model's JSON is unusable. */
export function extractiveAnswer(question, hits, maxSentences = 4) {
  const qTokens = new Set(tokenize(question));
  const picked = [];
  for (const h of hits.slice(0, 2)) {
    const sentences = h.note.body
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?])\s+/))
      .map((s) => s.replace(/^[#>*\-\s]+/, '').trim())
      .filter((s) => s.length > 40);
    const ranked = sentences
      .map((s) => ({ s, n: tokenize(s).filter((t) => qTokens.has(t)).length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 2)
      .filter((x) => x.n > 0);
    for (const r of ranked) picked.push({ text: r.s, note: h.note });
  }
  const lines = picked.slice(0, maxSentences).map((p) => `- ${p.text} [${p.note.id}]`);
  if (!lines.length && hits.length) {
    // Never hand back an empty answer: show the opening of the closest note, labelled as such.
    const n = hits[0].note;
    const opening = n.body
      .split(/\n+/)
      .map((s) => s.replace(/^[#>*\-\s]+/, '').trim())
      .filter((s) => s.length > 40)
      .slice(0, 2)
      .map((s) => `- ${s} [${n.id}]`);
    return { text: `No passage matched directly. Closest note:\n${opening.join('\n')}`, citations: [n.id] };
  }
  return { text: lines.join('\n'), citations: [...new Set(picked.slice(0, maxSentences).map((p) => p.note.id))] };
}
