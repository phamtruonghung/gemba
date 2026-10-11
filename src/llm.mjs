// src/llm.mjs — the AI tier: an answer built only from the published corpus, with citations,
// and an explicit refusal when the corpus does not cover the question.
//
// The refusal is the product. A general chatbot answers everything; this one answers what
// practitioners have published and hands the rest to a human, which is the only honest way
// to sell an AI tier over a free general model.

import { extractiveAnswer } from './retrieval.mjs';

// The gateway and the model id are one decision, not two: they must match, or the call 404s on a
// model the gateway does not serve. The OpenCode gateway (OpenAI-compatible, the same one this
// project's own agent runs on) serves `deepseek-v4.1-flash`; OpenRouter serves the `deepseek/...`
// namespaced id. So the default model is derived from the base URL rather than fixed, and an
// explicit GEMBA_LLM_MODEL always wins.
const GATEWAYS = [
  // `session: true` — this gateway wants the x-opencode-session header (see below).
  { match: 'opencode.ai', base: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash', session: true },
  { match: 'openrouter.ai', base: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash-0731', session: false }
];

// The OpenCode gateway is session-scoped: it routes and attributes a request by `x-opencode-session`,
// and refuses the call with "MissingSessionID" without it. A stable id per installation keeps this
// app's usage attributable; the installer writes a UUID into the env once.
const DEFAULT_SESSION = '00000000-0000-4000-8000-000000000000';

export function llmConfig(env = process.env) {
  const key = env.GEMBA_LLM_KEY || env.OPENCODE_GO_API_KEY || env.OPENROUTER_API_KEY || '';
  const base = env.GEMBA_LLM_BASE_URL
    || GATEWAYS[0].base;
  const gateway = GATEWAYS.find((g) => base.includes(g.match));
  const model = env.GEMBA_LLM_MODEL || gateway?.model || GATEWAYS[0].model;
  const timeoutMs = Number(env.GEMBA_LLM_TIMEOUT_MS || 45000);
  const session = gateway?.session ? (env.GEMBA_LLM_SESSION || DEFAULT_SESSION) : '';
  return { key, base, model, timeoutMs, session, enabled: Boolean(key) };
}

export const NO_DATA_MARKER = 'INSUFFICIENT_DATA';

const MAX_PASSAGES = 3;
const MAX_PASSAGE_CHARS = 1400;

export function buildPrompt({ question, hits, plantType = '' }) {
  const passages = hits
    .slice(0, MAX_PASSAGES)
    .map((h, i) => {
      const body = h.note.body.length > MAX_PASSAGE_CHARS ? `${h.note.body.slice(0, MAX_PASSAGE_CHARS)}…` : h.note.body;
      return `[${i + 1}] (id ${h.note.id}) ${h.note.title} — topic: ${h.note.topic}\n${body}`;
    })
    .join('\n\n---\n\n');
  const system = [
    'You are the assistant of a knowledge platform for factory production.',
    'Answer only from the PASSAGES below. No outside knowledge, no guessing, no invention.',
    'Every claim must carry its passage number as [1], [2], exactly as the passages are numbered.',
    'If the passages are not enough to answer, or the question needs figures or conditions specific to the asker\'s own plant, reply with exactly ' + NO_DATA_MARKER + ' and then state briefly what is missing.',
    'Voice: an experienced engineer talking to a colleague. English. Short, concrete, something they can act on today.',
    'At most 150 words. Return the JSON immediately: no preamble, no code fences.'
  ].join(' ');
  const user = [
    plantType ? `The asker works in: ${plantType}.` : '',
    `Question: ${question}`,
    '',
    'PASSAGES:',
    passages,
    '',
    'Return JSON in exactly this shape and nothing else:',
    '{"answer":"...","citations":[1,2],"coverage":"ok"|"thin","missing":"..."}'
  ]
    .filter(Boolean)
    .join('\n');
  return { system, user, passages };
}

function parseModelJson(text) {
  const cleaned = String(text).replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Ask the corpus. Always returns an answer object with `mode` telling the truth about how
 * it was produced: 'llm' (model, cited), 'extractive' (no key configured), 'llm-unusable'.
 */
export async function askFromCorpus({ question, hits, plantType = '', coverageVerdict, cfg = llmConfig(), fetchImpl = fetch }) {
  const fallback = () => {
    const ex = extractiveAnswer(question, hits);
    const thin = coverageVerdict?.verdict === 'thin';
    return {
      answer: thin
        ? `${NO_DATA_MARKER}\nThe note library does not cover this question (${coverageVerdict?.why ?? 'no note matched'}). Closest passage:\n${ex.text}`
        : ex.text,
      citations: ex.citations,
      coverage: thin ? 'thin' : 'ok',
      mode: cfg.enabled ? 'llm-unusable-fallback' : 'extractive',
      model: '',
      missing: thin ? coverageVerdict?.why ?? '' : ''
    };
  };

  if (!cfg.enabled || !hits.length) return fallback();

  const { system, user } = buildPrompt({ question, hits, plantType });
  const body = {
    model: cfg.model,
    temperature: 0.1,
    // The configured model is a reasoning model: it spends completion tokens thinking before
    // it writes the JSON, so a tight budget truncates the answer mid-object and the parse
    // fails silently. Measured: 900 tokens was not enough for five passages.
    max_tokens: Number(cfg.maxTokens ?? 1600),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };
  let text = '';
  let finish = '';
  try {
    const res = await fetchImpl(`${cfg.base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.key}`,
        // Only the OpenCode gateway needs this; sending it elsewhere is harmless but pointless.
        ...(cfg.session ? { 'x-opencode-session': cfg.session } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
    if (!res.ok) return { ...fallback(), mode: `llm-http-${res.status}` };
    const json = await res.json();
    text = json?.choices?.[0]?.message?.content ?? '';
    finish = json?.choices?.[0]?.finish_reason ?? '';
  } catch (err) {
    return { ...fallback(), mode: `llm-error:${String(err?.name ?? 'error')}` };
  }

  const parsed = parseModelJson(text);
  if (!parsed || typeof parsed.answer !== 'string') return { ...fallback(), mode: `llm-unparsed${finish ? `:${finish}` : ''}` };

  const cited = Array.isArray(parsed.citations) ? parsed.citations.map((c) => Number(c)).filter((n) => Number.isFinite(n)) : [];
  const citedIds = cited.map((n) => hits[n - 1]?.note?.id).filter(Boolean);
  const modelSaysThin = String(parsed.coverage) === 'thin' || parsed.answer.includes(NO_DATA_MARKER);
  const thin = modelSaysThin || coverageVerdict?.verdict === 'thin' || citedIds.length === 0;
  return {
    answer: parsed.answer,
    citations: citedIds.length ? citedIds : hits.slice(0, 1).map((h) => h.note.id),
    coverage: thin ? 'thin' : 'ok',
    mode: 'llm',
    model: cfg.model,
    missing: typeof parsed.missing === 'string' ? parsed.missing : ''
  };
}
