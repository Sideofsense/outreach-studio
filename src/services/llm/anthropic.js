'use strict';

const { Anthropic } = require('@anthropic-ai/sdk');

const config = require('../../config');
const logger = require('../../utils/logger');

let client = null;
function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return client;
}

/**
 * Call Claude with a system + user message and return the raw text content
 * plus token usage. Caller is responsible for parsing JSON or applying checks.
 *
 * @param {object} opts
 * @param {string} opts.system - system prompt text
 * @param {string} opts.user - user message text
 * @param {number} [opts.maxTokens=600]
 * @param {number} [opts.temperature=0.7]
 * @returns {Promise<{ text: string, tokens: { input: number, output: number }, model: string }>}
 */
async function complete({ system, user, maxTokens = 600, temperature = 0.7 }) {
  const response = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const tokens = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
  };

  logger.debug(
    { model: config.anthropic.model, tokens, stop_reason: response.stop_reason },
    'anthropic.messages.create'
  );

  return { text, tokens, model: config.anthropic.model };
}

module.exports = { complete, name: 'anthropic' };
