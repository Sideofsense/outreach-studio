'use strict';

const { getDb } = require('../db');
const config = require('../config');

/**
 * Anthropic pricing (USD per million tokens), as published for
 * claude-sonnet-4-5 at the time of v0.1 ship. Update if Anthropic changes the
 * price tiers. Source of truth: anthropic.com/pricing.
 */
const PRICING = {
  'claude-sonnet-4-5': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  // Other models can be added here. Unknown models fall back to sonnet rates.
};

/**
 * Providers that bill per token. Anything not listed (e.g. 'ollama') runs
 * locally and is free — its drafts contribute $0 no matter how many tokens
 * they report.
 */
const PAID_PROVIDERS = new Set(['anthropic']);

function isPaidProvider(provider) {
  return PAID_PROVIDERS.has(provider);
}

function ratesFor(model) {
  return PRICING[model] || PRICING['claude-sonnet-4-5'];
}

function tokensCost(model, inputTokens, outputTokens) {
  const r = ratesFor(model);
  return (inputTokens / 1_000_000) * r.inputPerMTok + (outputTokens / 1_000_000) * r.outputPerMTok;
}

/**
 * Describe how the active provider prices drafts, for the UI's basis line.
 */
function basisFor(provider) {
  if (isPaidProvider(provider)) {
    const model = config.anthropic.model;
    const r = ratesFor(model);
    return {
      provider,
      model,
      inputPerMTok: r.inputPerMTok,
      outputPerMTok: r.outputPerMTok,
      label: `${model}: $${r.inputPerMTok}/M in, $${r.outputPerMTok}/M out`,
    };
  }
  // Local / free provider (e.g. Ollama).
  const model = config.ollama.model;
  return {
    provider,
    model,
    inputPerMTok: 0,
    outputPerMTok: 0,
    label: `Local model (${model}) — no API cost`,
  };
}

/**
 * Sum LLM input + output tokens across drafts and price them per provider.
 * Each draft records the provider that generated it (migration 008); only
 * paid providers accrue cost, so local Ollama drafts are correctly $0.
 * Legacy rows with no recorded provider are attributed to the currently
 * configured provider.
 *
 * @param {object} [opts]
 * @param {number} [opts.companyId] - scope to one company
 */
function summarise(opts = {}) {
  const db = getDb();
  const active = config.llm.provider;
  const where = opts.companyId ? 'WHERE company_id = ?' : '';
  // Param order matches the SQL: SELECT-COALESCE, [WHERE], GROUP BY-COALESCE.
  const params = opts.companyId ? [active, opts.companyId, active] : [active, active];

  const rows = db
    .prepare(
      `SELECT
         COALESCE(llm_provider, ?) AS provider,
         COUNT(*) AS draft_count,
         COALESCE(SUM(llm_input_tokens), 0) AS input_tokens,
         COALESCE(SUM(llm_output_tokens), 0) AS output_tokens
       FROM drafts ${where}
       GROUP BY COALESCE(llm_provider, ?)`
    )
    .all(...params);

  let draftCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usd = 0;
  const byProvider = [];

  for (const r of rows) {
    draftCount += r.draft_count;
    inputTokens += r.input_tokens;
    outputTokens += r.output_tokens;
    const paid = isPaidProvider(r.provider);
    const rowUsd = paid ? tokensCost(config.anthropic.model, r.input_tokens, r.output_tokens) : 0;
    usd += rowUsd;
    byProvider.push({
      provider: r.provider,
      draft_count: r.draft_count,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      estimated_usd: Number(rowUsd.toFixed(4)),
      paid,
    });
  }

  return {
    draft_count: draftCount,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_usd: Number(usd.toFixed(4)),
    local: usd === 0,
    pricing_basis: basisFor(active),
    by_provider: byProvider,
  };
}

module.exports = { summarise, tokensCost, basisFor, isPaidProvider, PRICING, PAID_PROVIDERS, ratesFor };
