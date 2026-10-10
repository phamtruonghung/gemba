// src/llm.mjs — the AI tier: an answer built only from the published corpus, with citations,
// and an explicit refusal when the corpus does not cover the question.
//
// The refusal is the product. A general chatbot answers everything; this one answers what
// practitioners have published and hands the rest to a human, which is the only honest way
// to sell an AI tier over a free general model.

import { extractiveAnswer } from './retrieval.mjs';

export function llmConfig(env = process.env) {
  const key = env.XUONG_LLM_KEY || env.OPENROUTER_API_KEY || env.OPENCODE_GO_API_KEY || '';
  const base = env.XUONG_LLM_BASE_URL || (env.OPENCODE_GO_API_KEY && !env.OPENROUTER_API_KEY ? 'https://opencode.ai/zen/go/v1' : 'https://openrouter.ai/api/v1');
  const model = env.XUONG_LLM_MODEL || 'deepseek/deepseek-v4-flash-0731';
  const timeoutMs = Number(env.XUONG_LLM_TIMEOUT_MS || 45000);
  return { key, base, model, timeoutMs, enabled: Boolean(key) };
}

export const NO_DATA_MARKER = 'THIEU_DU_LIEU';

const MAX_PASSAGES = 3;
const MAX_PASSAGE_CHARS = 1400;

export function buildPrompt({ question, hits, plantType = '' }) {
  const passages = hits
    .slice(0, MAX_PASSAGES)
    .map((h, i) => {
      const body = h.note.body.length > MAX_PASSAGE_CHARS ? `${h.note.body.slice(0, MAX_PASSAGE_CHARS)}…` : h.note.body;
      return `[${i + 1}] (id ${h.note.id}) ${h.note.title} — chủ đề: ${h.note.topic}\n${body}`;
    })
    .join('\n\n---\n\n');
  const system = [
    'Bạn là trợ lý của một nền tảng chia sẻ kiến thức sản xuất tại Việt Nam.',
    'Chỉ được trả lời bằng nội dung có trong các TRÍCH ĐOẠN bên dưới. Không dùng kiến thức ngoài, không suy đoán, không bịa.',
    'Mỗi khẳng định phải kèm số hiệu trích đoạn dạng [1], [2] đúng như đánh số.',
    'Nếu các trích đoạn không đủ để trả lời, hoặc câu hỏi cần số liệu/điều kiện riêng của nhà máy người hỏi, hãy trả lời đúng một từ ' + NO_DATA_MARKER + ' rồi nêu ngắn gọn còn thiếu gì.',
    'Giọng văn: như một kỹ sư già nói với đồng nghiệp. Tiếng Việt. Ngắn, cụ thể, có việc làm được ngay.',
    'Tối đa 150 từ. Trả về JSON ngay, không viết lời dẫn, không dùng khối mã.'
  ].join(' ');
  const user = [
    plantType ? `Người hỏi làm ở: ${plantType}.` : '',
    `Câu hỏi: ${question}`,
    '',
    'TRÍCH ĐOẠN:',
    passages,
    '',
    'Trả về JSON đúng định dạng, không thêm chữ nào ngoài JSON:',
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
        ? `${NO_DATA_MARKER}\nKho ghi chú chưa đủ cho câu này (${coverageVerdict?.why ?? 'không khớp ghi chú nào'}). Phần gần nhất:\n${ex.text}`
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
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
