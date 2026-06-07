'use strict';

const fs = require('node:fs');
const logger = require('../utils/logger');

/**
 * Extract readable text from a PDF file path. Uses pdf-parse (already in deps).
 * Soft-fails: returns null + error string if extraction fails.
 */
async function extractPdfText(pathOrBuffer) {
  try {
    const pdfParse = require('pdf-parse');
    const buffer = Buffer.isBuffer(pathOrBuffer)
      ? pathOrBuffer
      : fs.readFileSync(pathOrBuffer);
    const parsed = await pdfParse(buffer);
    let text = (parsed.text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 50) {
      return { text: null, error: 'too_little_text' };
    }
    // Cap at 8000 chars — plenty for personalization, doesn't blow the context window.
    if (text.length > 8000) text = text.slice(0, 8000);
    return { text, error: null };
  } catch (err) {
    logger.warn({ err: err.message }, 'PDF extract failed');
    return { text: null, error: err.message.slice(0, 120) };
  }
}

module.exports = { extractPdfText };
