// src/retrieval.mjs — BM25-lite retrieval over the published corpus.
// Folding: tokens are folded (diacritics stripped, đ→d) so "chuyền" and "chuyen" match, which is how people actually type.

export function fold(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function tokenize(s) {
  return (fold(s).match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
}

// Vietnamese stopwords. Short and diacritic-folded: without this list every question shares
// a handful of tokens with every note, every score clears the threshold, and the AI tier
// claims coverage it does not have — measured before adding it: an HR question scored 12.3
// against a note about machine stoppages.
export const STOPWORDS = new Set([
  'va', 'cua', 'la', 'co', 'cho', 'khi', 'nao', 'gi', 'mot', 'cac', 'nhung', 'de', 'voi', 'thi', 'ma',
  'neu', 'khong', 'duoc', 'nay', 'do', 'kia', 'ai', 'tai', 'trong', 'ngoai', 'tren', 'duoi', 'ra', 'vao',
  'len', 'xuong', 'roi', 'da', 'se', 'dang', 'bi', 'do', 'vi', 'nen', 'hay', 'hoac', 'cung', 'nhu', 'sao',
  'the', 'chi', 'con', 'phai', 've', 'theo', 'lam', 'bang', 'toi', 'minh', 'ban', 'ho', 'no', 'rat', 'qua',
  'nhieu', 'it', 'moi', 'tu', 'den', 'sau', 'truoc', 'giua', 'ca', 'thu', 'lam', 'sao', 'bao', 'nhieu'
]);

/** Content tokens only: what a question is actually about. */
export function contentTokens(s) {
  return tokenize(s).filter((t) => !STOPWORDS.has(t));
}

const K1 = 1.2;
const B = 0.75;

export function buildIndex(notes) {
  const docs = notes.map((n) => {
    const titleTokens = tokenize(n.title);
    const bodyTokens = tokenize(n.body);
    // Title terms count five times: a note about 5S should win over one that mentions it.
    const tokens = [...titleTokens, ...titleTokens, ...titleTokens, ...titleTokens, ...titleTokens, ...bodyTokens];
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { note: n, tf, len: tokens.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
  return { docs, df, avgdl, n: docs.length };
}

export function search(query, index, k = 5) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length || !index.n) return [];
  const scored = index.docs.map((d) => {
    let score = 0;
    for (const t of qTokens) {
      const f = d.tf.get(t) ?? 0;
      if (!f) continue;
      const df = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / (index.avgdl || 1))));
    }
    return { note: d.note, score: Number(score.toFixed(4)) };
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
 * Decided on the idf-weighted share of the question's content words that the closest note
 * actually contains — i.e. whether the corpus holds the question's *distinctive* words, not
 * its common ones. Measured why the two cheaper rules fail (see test/unit.test.mjs):
 * a raw score threshold passes everything, because BM25 rewards long documents (an HR
 * question scored 12.3 against a note about machine stoppages); and an unweighted word share
 * cannot separate an off-corpus question at 0.44–0.55 from an on-corpus one at 1.00, because
 * Vietnamese questions share their common words ("dừng", "vấn", "thường", "nhà") with
 * everything. Weighting each missing word by how rare it is separates them cleanly.
 */
export function coverage(question, hits, index, { minTop = 2.2, minShare = 0.5 } = {}) {
  const thin = (why) => ({ verdict: 'thin', why });
  const asked = [...new Set(contentTokens(question))];
  if (asked.length < 2) return thin('the question is too short to search on');
  if (!hits.length) return thin('no note matched');
  const top = hits[0];
  if (top.score < minTop) return thin(`top match is weak (${top.score} < ${minTop})`);

  const idf = (t) => {
    const df = index?.df?.get(t) ?? 0;
    const n = index?.n ?? 1;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  };
  const inTop = new Set(tokenize(`${top.note.title} ${top.note.body}`));
  let total = 0;
  let have = 0;
  const missing = [];
  for (const t of asked) {
    const w = idf(t);
    total += w;
    if (inTop.has(t)) have += w;
    else missing.push(t);
  }
  const share = total ? have / total : 0;
  if (share < minShare) {
    return thin(
      `the closest note covers only ${(share * 100).toFixed(0)}% of the question's key terms; missing: ${missing.slice(0, 5).join(', ')}`
    );
  }
  return { verdict: 'ok', why: `matched ${hits.length} notes, ${(share * 100).toFixed(0)}% of the key terms, top score ${top.score}` };
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
