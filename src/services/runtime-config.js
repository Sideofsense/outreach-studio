'use strict';

const { getDb } = require('../db');
const config = require('../config');

/**
 * Layered config: .env defaults are the baseline, the `settings` DB table can
 * override at runtime so the UI can change throttle behaviour without a restart.
 */

const THROTTLE_KEYS = [
  'globalSeconds',
  'perDomainPerHour',
  'dailyCap',
  'workingHoursStart',
  'workingHoursEnd',
  'timezone',
];

const settingKey = (group, key) => `${group}.${key}`;

function readSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function writeSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    )
    .run(key, String(value));
}

function coerce(key, value) {
  if (key === 'timezone') return String(value);
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`${key}: not a number`);
  return num;
}

function throttleConfig() {
  const base = { ...config.throttle };
  for (const key of THROTTLE_KEYS) {
    const raw = readSetting(settingKey('throttle', key));
    if (raw === null) continue;
    try {
      base[key] = coerce(key, raw);
    } catch {
      /* malformed override — fall back to .env */
    }
  }
  return base;
}

function updateThrottle(partial) {
  const updated = {};
  for (const key of THROTTLE_KEYS) {
    if (!(key in partial)) continue;
    const value = coerce(key, partial[key]);
    writeSetting(settingKey('throttle', key), value);
    updated[key] = value;
  }
  return updated;
}

function resetThrottleOverrides() {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
  for (const key of THROTTLE_KEYS) {
    stmt.run(settingKey('throttle', key));
  }
}

module.exports = {
  throttleConfig,
  updateThrottle,
  resetThrottleOverrides,
  THROTTLE_KEYS,
};
