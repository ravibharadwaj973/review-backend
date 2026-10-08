import { env, groqConfigured } from '../../config/env.js';

export class AiUnavailableError extends Error {}

/**
 * Minimal Groq client (OpenAI-compatible chat completions).
 * Returns { text, model } or throws AiUnavailableError so callers can fall back.
 */
export async function chat(opts, attempt = 0) {
  try {
    return await chatOnce(opts);
  } catch (err) {
    // One polite retry on rate limiting
    if (err.retryAfterMs && attempt === 0 && err.retryAfterMs <= 8000) {
      await new Promise((r) => setTimeout(r, err.retryAfterMs));
      return chat(opts, 1);
    }
    // Groq retires models from time to time. If the configured one is gone, pick an available one once.
    if (err.modelMissing && attempt === 0 && (await resolveReplacementModel(opts.fast))) {
      return chat(opts, 1);
    }
    // JSON mode can fail (e.g. the model ran out of room while thinking). Try once more without
    // strict JSON mode and with more room; chatJSON still pulls the JSON out of the reply.
    if (err.jsonFailed && opts.json && !opts.relaxed) {
      return chat({ ...opts, json: false, relaxed: true, maxTokens: (opts.maxTokens || 700) * 2 }, attempt);
    }
    throw err;
  }
}

// Runtime overrides when a configured model has been retired
const override = { main: null, fast: null };
const PREFERRED = {
  main: ['openai/gpt-oss-120b', 'qwen3.8', 'gpt-oss', 'qwen', 'llama'],
  fast: ['openai/gpt-oss-20b', 'gpt-oss', 'qwen', 'llama'],
};

/**
 * Reasoning models (gpt-oss, qwen) think before answering, and that thinking uses the same
 * token budget as the answer. Keep the thinking short, hide it, and leave room for the answer.
 */
function modelOptions(model, maxTokens) {
  if (/gpt-oss/i.test(model)) {
    return { reasoning_effort: 'low', include_reasoning: false, max_completion_tokens: maxTokens + 2048 };
  }
  if (/qwen/i.test(model)) {
    return { reasoning_format: 'hidden', max_completion_tokens: maxTokens + 2048 };
  }
  return { max_tokens: maxTokens };
}

async function resolveReplacementModel(fast) {
  try {
    const res = await fetch(`${env.groq.baseUrl}/models`, { headers: { Authorization: `Bearer ${env.groq.apiKey}` } });
    if (!res.ok) return false;
    const ids = ((await res.json()).data || [])
      .filter((m) => m.active !== false && !/whisper|tts|guard|embed|vision|playai|orpheus/i.test(m.id))
      .map((m) => m.id);
    const key = fast ? 'fast' : 'main';
    for (const pref of PREFERRED[key]) {
      const hit = ids.find((id) => id.includes(pref));
      if (hit) {
        console.warn(`[ai] configured Groq model unavailable — using ${hit}. Set GROQ_${fast ? 'FAST_' : ''}MODEL to choose one.`);
        override[key] = hit;
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function chatOnce({ system, user, json = false, relaxed = false, temperature = 0.5, maxTokens = 700, fast = false }) {
  if (!groqConfigured()) throw new AiUnavailableError('GROQ_API_KEY is not set');
  const model = fast ? override.fast || env.groq.fastModel : override.main || env.groq.model;

  const body = {
    model,
    temperature,
    ...modelOptions(model, maxTokens),
    messages: [
      { role: 'system', content: relaxed ? `${system}\nReply with only the JSON object — no other text.` : system },
      { role: 'user', content: user },
    ],
  };
  if (json) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(`${env.groq.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.groq.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AiUnavailableError(`Groq request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new AiUnavailableError(`Groq returned ${res.status}: ${detail.slice(0, 300)}`);
    if (res.status === 429) error.retryAfterMs = Math.ceil(Number(res.headers.get('retry-after') || 2) * 1000);
    if ((res.status === 404 || res.status === 400) && /model/i.test(detail) && /(not exist|not found|decommission|deprecat|no longer)/i.test(detail)) error.modelMissing = true;
    if (res.status === 400 && /json_validate_failed/.test(detail)) error.jsonFailed = true;
    throw error;
  }
  const data = await res.json();
  // Strip any <think> block some reasoning models emit
  const text = (data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) {
    const error = new AiUnavailableError('Groq returned an empty reply');
    if (json) error.jsonFailed = true;
    throw error;
  }
  return { text, model: `groq:${data.model || model}` };
}

export async function chatJSON(opts) {
  const { text, model } = await chat({ ...opts, json: true });
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return { data: JSON.parse(cleaned), model };
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return { data: JSON.parse(match[0]), model };
      } catch {
        /* fall through */
      }
    }
    throw new AiUnavailableError('Groq returned invalid JSON');
  }
}
