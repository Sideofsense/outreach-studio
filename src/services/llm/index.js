'use strict';

/**
 * LLM provider factory. Provider is chosen via env `LLM_PROVIDER`:
 *  - 'anthropic' (default) — Claude Sonnet via the official SDK, requires API key
 *  - 'ollama'              — local Ollama daemon, free, no API key
 *
 * Callers should use `getProvider()` with no args to get the configured one.
 */
const config = require('../../config');
const anthropic = require('./anthropic');
const ollama = require('./ollama');

const providers = {
  anthropic,
  ollama,
};

function getProvider(name) {
  const resolved = name || config.llm.provider || 'anthropic';
  const provider = providers[resolved];
  if (!provider) {
    throw new Error(`unknown LLM provider "${resolved}"; available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

function listProviders() {
  return Object.keys(providers);
}

module.exports = { getProvider, listProviders };
