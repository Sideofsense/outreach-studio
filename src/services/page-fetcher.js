'use strict';

const logger = require('../utils/logger');

const TIMEOUT_MS = 8_000;
const MAX_CHARS = 3_000;
const UA = 'Mozilla/5.0 (Outreach Studio; +https://github.com/Sideofsense/outreach-studio)';

/**
 * Simple page-text fetch. Strips scripts/styles/tags, collapses whitespace,
 * returns first MAX_CHARS chars. NOT a crawler — single URL only, soft fail.
 *
 * @param {string} url
 * @returns {Promise<{text: string|null, error: string|null}>}
 */
async function fetchPageText(url) {
  if (!url || typeof url !== 'string') return { text: null, error: 'no_url' };
  let target;
  try {
    target = new URL(url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`);
  } catch {
    return { text: null, error: 'invalid_url' };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { text: null, error: 'unsupported_protocol' };
  }

  try {
    const response = await fetch(target.href, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { text: null, error: `http_${response.status}` };
    }
    const ct = response.headers.get('content-type') || '';
    if (!/text\/html|xhtml|text\/plain/.test(ct)) {
      return { text: null, error: `unsupported_content_type:${ct.slice(0, 40)}` };
    }
    const raw = await response.text();

    // Strip the obvious noise then tags. Lightweight, no parser.
    let text = raw
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS).trim();
    if (text.length < 80) {
      return { text: null, error: 'too_little_text' };
    }
    return { text, error: null };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { text: null, error: 'timeout' };
    }
    logger.warn({ err: err.message, url: target.href }, 'page fetch failed');
    return { text: null, error: err.message.slice(0, 80) };
  }
}

module.exports = { fetchPageText };
