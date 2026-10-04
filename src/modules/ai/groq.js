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
    throw err;
  }
}

// Runtime overrides when a configured model has been retired
const override = { main: null, fast: null };
const PREFERRED = {
  main: ['llama-3.3-70b', 'openai/gpt-oss-120b', 'llama-4', 'qwen', 'gpt-oss', 'llama'],
  fast: ['llama-3.1-8b', 'openai/gpt-oss-20b', 'llama-4-scout', 'gemma', 'llama'],
};

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

async function chatOnce({ system, user, json = false, temperature = 0.5, maxTokens = 700, fast = false }) {
  if (!groqConfigured()) throw new AiUnavailableError('GROQ_API_KEY is not set');
  const model = fast ? override.fast || env.groq.fastModel : override.main || env.groq.model;

  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
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
    throw error;
  }
  const data = await res.json();
  // Strip any <think> block some reasoning models emit
  const text = (data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { text, model: `groq:${data.model || model}` };
}

export async function chatJSON(opts) {
  const { text, model } = await chat({ ...opts, json: true });
  try {
    return { data: JSON.parse(text), model };
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return { data: JSON.parse(match[0]), model };
    throw new AiUnavailableError('Groq returned invalid JSON');
  }
}
