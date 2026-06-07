'use strict';

const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Ollama provider — talks to a local Ollama daemon (default http://localhost:11434).
 * No API key required; the user runs `ollama serve` and pulls a model with
 * `ollama pull <model>`. See https://ollama.com.
 *
 * Quality vs Claude Sonnet: lower. Adequate for getting started, especially with
 * larger models (llama3.1:70b, qwen2.5:32b). 8B models will sometimes ignore
 * the "output JSON only" rule — the personalization engine's tolerant
 * extractFirstJsonObject() handles preamble + markdown wrappers.
 */
async function complete({ system, user, maxTokens = 600, temperature = 0.7 }) {
  const host = config.ollama.host.replace(/\/$/, '');
  const model = config.ollama.model;

  let response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        options: {
          temperature,
          num_predict: maxTokens,
        },
      }),
      // 5-minute hard ceiling for slow local generation
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
      throw new Error(`Ollama timed out at ${host}. Is \`ollama serve\` running and is the model loaded?`);
    }
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Ollama not reachable at ${host}. Start it with \`ollama serve\` or open the Ollama app.`);
    }
    throw err;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 404 && /model.*not found/i.test(text)) {
      throw new Error(`Ollama model "${model}" not found. Run: ollama pull ${model}`);
    }
    throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data?.message?.content ?? '';

  // Ollama returns `prompt_eval_count` (input) and `eval_count` (output).
  const tokens = {
    input: Number(data.prompt_eval_count || 0),
    output: Number(data.eval_count || 0),
  };

  logger.debug({ model, host, tokens, done_reason: data.done_reason }, 'ollama.chat');

  return { text, tokens, model };
}

/**
 * Lightweight reachability check used by /api/settings/test/llm.
 * Returns the list of installed models so the user can pick the right name.
 */
async function ping() {
  const host = config.ollama.host.replace(/\/$/, '');
  let response;
  try {
    response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Ollama not reachable at ${host}. Start it with \`ollama serve\` or open the Ollama app.`);
    }
    throw err;
  }
  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status} on /api/tags`);
  }
  const data = await response.json();
  const models = (data.models || []).map((m) => m.name);
  return { host, model: config.ollama.model, available_models: models };
}

module.exports = { complete, ping, name: 'ollama' };
