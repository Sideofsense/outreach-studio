'use strict';

const { getDb } = require('../db');
const { recordEvent } = require('../utils/audit');
const logger = require('../utils/logger');

const STOP_WORD_RE = /\b(STOP|UNSUBSCRIBE)\b/i;

function normalize(email) {
  return String(email || '').trim().toLowerCase();
}

function isSuppressed(email, db = getDb()) {
  if (!email) return false;
  return Boolean(db.prepare('SELECT 1 FROM suppressions WHERE lower(email) = ?').get(normalize(email)));
}

/**
 * Insert a suppression. No-op if email is already suppressed (UNIQUE) —
 * the existing reason wins.
 */
function addSuppression(email, reason, { notes = null, db = getDb() } = {}) {
  if (!email) return { added: false, reason: 'no_email' };
  const normalized = normalize(email);
  const before = db.prepare('SELECT * FROM suppressions WHERE lower(email) = ?').get(normalized);
  if (before) {
    return { added: false, existing: before };
  }
  const info = db
    .prepare('INSERT INTO suppressions (email, reason, notes) VALUES (?, ?, ?)')
    .run(normalized, reason, notes);
  recordEvent('suppression_added', {
    entityType: 'suppression',
    entityId: info.lastInsertRowid,
    metadata: { email: normalized, reason, notes },
  });
  logger.info({ email: normalized, reason }, 'suppression added');
  return { added: true, id: info.lastInsertRowid };
}

function removeSuppression(email, db = getDb()) {
  if (!email) return { removed: 0 };
  const info = db.prepare('DELETE FROM suppressions WHERE lower(email) = ?').run(normalize(email));
  return { removed: info.changes };
}

function listSuppressions({ limit = 500, db = getDb() } = {}) {
  return db.prepare('SELECT * FROM suppressions ORDER BY added_at DESC LIMIT ?').all(limit);
}

// Our own compliance footer (curly or straight apostrophe). It contains the
// word "STOP", so it must NEVER be what triggers a suppression — otherwise our
// outreach footer, echoed back in a quoted reply, suppresses the recipient.
const OWN_FOOTER_RE = /Reply STOP and I won['’]?t reach out again\.?/gi;

/**
 * Reduce an incoming email body to just the text the human actually typed:
 * drop quoted reply history and our own footer, so neither can trigger a STOP.
 */
function stripQuotedText(body = '') {
  let t = String(body);
  // Cut everything from the first reply-history marker onward.
  const markers = [
    /^\s*On .+wrote:\s*$/m,                 // Gmail / Apple Mail attribution
    /^\s*-{2,}\s*Original Message\s*-{2,}/im, // Outlook
    /^\s*_{5,}\s*$/m,                        // Outlook divider
  ];
  let cut = t.length;
  for (const re of markers) {
    const m = t.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  // Drop ">"-quoted lines.
  t = t
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  // Neutralise our own compliance footer wherever it appears.
  return t.replace(OWN_FOOTER_RE, '');
}

/**
 * Check whether an incoming message's text triggers a STOP/UNSUBSCRIBE
 * suppression. The subject is matched verbatim; the body is first reduced to
 * the human-typed text (quoted history and our own footer removed) so the
 * compliance footer or a quoted original can't self-trigger a suppression.
 */
function detectStopRequest({ subject = '', body = '' } = {}) {
  return STOP_WORD_RE.test(subject) || STOP_WORD_RE.test(stripQuotedText(body));
}

module.exports = {
  isSuppressed,
  addSuppression,
  removeSuppression,
  listSuppressions,
  detectStopRequest,
  stripQuotedText,
  STOP_WORD_RE,
  normalize,
};
