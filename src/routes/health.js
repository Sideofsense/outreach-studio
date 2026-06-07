'use strict';

const express = require('express');
const config = require('../config');
const { getDb } = require('../db');

const router = express.Router();

function checkDb() {
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get();
    return row && row.ok === 1 ? 'ok' : 'error';
  } catch (err) {
    return `error: ${err.message}`;
  }
}

function configured(value, placeholderPrefixes = []) {
  if (!value) return 'not_configured';
  for (const prefix of placeholderPrefixes) {
    if (value.startsWith(prefix)) return 'placeholder';
  }
  return 'configured';
}

// Report the status of the LLM provider that is actually in use. When
// LLM_PROVIDER=ollama the Anthropic key is intentionally a placeholder and
// unused, so checking it would wrongly mark the whole system "degraded".
function checkLlm() {
  if (config.llm.provider === 'ollama') {
    return config.ollama.host && config.ollama.model ? 'configured' : 'not_configured';
  }
  return configured(config.anthropic.apiKey, ['sk-ant-...']);
}

router.get('/', (_req, res) => {
  const status = {
    db: checkDb(),
    llm: checkLlm(),
    llm_provider: config.llm.provider,
    smtp: configured(config.smtp.password, ['your_16_char']),
    imap: configured(config.imap.password, ['your_16_char']),
  };
  const allOk =
    status.db === 'ok' &&
    status.llm === 'configured' &&
    status.smtp === 'configured' &&
    status.imap === 'configured';
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    checks: status,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
