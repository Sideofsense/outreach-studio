'use strict';

const { getDb } = require('../db');
const config = require('../config');
const { throttleConfig } = require('./runtime-config');

const HOUR_MS = 60 * 60 * 1000;

function hourInTimezone(date, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: tz,
    });
    return Number(fmt.format(date));
  } catch {
    return date.getHours();
  }
}

function startOfDayInTimezone(date, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(date).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    // Midnight at the user's timezone, expressed as a Date in UTC equivalent.
    // For SQL comparison we don't need exact tz arithmetic — using the local-day
    // boundary derived from the formatter is close enough for daily-cap rollover.
    return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  } catch {
    return new Date(new Date(date).setHours(0, 0, 0, 0));
  }
}

/**
 * Check whether a send to `recipient_email` is allowed right now. Rules are
 * evaluated in order: global → per-domain → daily cap → suppression.
 *
 * @param {string} recipient_email
 * @param {object} [opts]
 * @param {Date}   [opts.now]    - override "now" (for tests)
 * @param {object} [opts.db]     - inject a db handle (for tests)
 * @param {object} [opts.cfg]    - override throttle config
 * @returns {{ allowed: boolean, reason?: string, retry_at?: Date }}
 */
function canSendNow(recipient_email, opts = {}) {
  const now = opts.now || new Date();
  const db = opts.db || getDb();
  // Read live throttle config from the DB (with .env defaults) each tick so
  // /settings changes take effect without a server restart.
  const cfg = opts.cfg || throttleConfig();

  if (!recipient_email || typeof recipient_email !== 'string' || !recipient_email.includes('@')) {
    return { allowed: false, reason: 'invalid_recipient' };
  }

  // 1. Global throttle
  const last = db.prepare('SELECT sent_at FROM sends ORDER BY sent_at DESC LIMIT 1').get();
  if (last) {
    const secondsSince = (now.getTime() - new Date(last.sent_at + 'Z').getTime()) / 1000;
    if (secondsSince < cfg.globalSeconds) {
      return {
        allowed: false,
        reason: 'global_throttle',
        retry_at: new Date(now.getTime() + (cfg.globalSeconds - secondsSince) * 1000),
      };
    }
  }

  // 2. Per-domain throttle
  const domain = recipient_email.split('@')[1].toLowerCase();
  const lastHour = new Date(now.getTime() - HOUR_MS);
  const domainCount = db
    .prepare("SELECT COUNT(*) as c FROM sends WHERE sent_at > ? AND lower(recipient) LIKE ?")
    .get(lastHour.toISOString().replace('T', ' ').slice(0, 19), `%@${domain}`).c;
  if (domainCount >= cfg.perDomainPerHour) {
    return { allowed: false, reason: 'per_domain_throttle' };
  }

  // 3. Daily cap
  const dayStart = startOfDayInTimezone(now, cfg.timezone);
  const dayCount = db
    .prepare('SELECT COUNT(*) as c FROM sends WHERE sent_at > ?')
    .get(dayStart.toISOString().replace('T', ' ').slice(0, 19)).c;
  if (dayCount >= cfg.dailyCap) {
    return { allowed: false, reason: 'daily_cap' };
  }

  // 4. Suppressions
  const suppressed = db
    .prepare('SELECT 1 FROM suppressions WHERE lower(email) = ?')
    .get(recipient_email.toLowerCase());
  if (suppressed) {
    return { allowed: false, reason: 'suppressed' };
  }

  return { allowed: true };
}

module.exports = {
  canSendNow,
  hourInTimezone,
};
