import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { canSendNow, hourInTimezone } from '../src/services/throttle.js';

const baseCfg = {
  globalSeconds: 90,
  perDomainPerHour: 2,
  dailyCap: 100,
  workingHoursStart: 9,
  workingHoursEnd: 18,
  timezone: 'Asia/Kolkata',
};

function tzNoon(yyyyMmDd = '2026-05-27') {
  // 09:00 IST = 03:30 UTC → pick UTC time that lands in the middle of work hours.
  // 12:00 IST = 06:30 UTC. We use a non-DST timezone so this is stable.
  return new Date(`${yyyyMmDd}T06:30:00Z`);
}
function tz3am(yyyyMmDd = '2026-05-27') {
  // 03:00 IST = 21:30 UTC the day before
  return new Date(`${yyyyMmDd}T21:30:00Z`);
}

function buildSchema(db) {
  const sql = fs.readFileSync(path.resolve('migrations/001_initial_schema.sql'), 'utf8');
  db.exec(sql);
  db.exec(fs.readFileSync(path.resolve('migrations/002_audit_log.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve('migrations/003_suppressions.sql'), 'utf8'));
}

function insertSend(db, recipient, when, { draft_id = 1, contact_id = 1, company_id = 1 } = {}) {
  db.prepare('INSERT OR IGNORE INTO companies (id, slug, name) VALUES (?, ?, ?)').run(company_id, `c${company_id}`, `Company ${company_id}`);
  db.prepare('INSERT OR IGNORE INTO contacts (id, company_id, email) VALUES (?, ?, ?)').run(contact_id, company_id, recipient);
  db.prepare(
    `INSERT INTO drafts (id, company_id, contact_id, subject, body, status)
     VALUES (?, ?, ?, 'subj', 'body', 'sent')
     ON CONFLICT(id) DO NOTHING`
  ).run(draft_id, company_id, contact_id);
  db.prepare(
    `INSERT INTO sends (draft_id, contact_id, company_id, recipient, subject, sent_at)
     VALUES (?, ?, ?, ?, 'subj', ?)`
  ).run(draft_id, contact_id, company_id, recipient, when);
}

let db;
beforeEach(() => {
  db = new Database(':memory:');
  buildSchema(db);
});

describe('hourInTimezone', () => {
  it('returns the IST hour for a known UTC instant', () => {
    expect(hourInTimezone(new Date('2026-05-27T06:30:00Z'), 'Asia/Kolkata')).toBe(12);
    expect(hourInTimezone(new Date('2026-05-27T03:30:00Z'), 'Asia/Kolkata')).toBe(9);
  });
});

describe('canSendNow — time of day is not restricted', () => {
  // The working-hours limit was removed: a send is allowed at any hour as long
  // as the other rules (global / per-domain / daily cap / suppression) pass.
  it('allows at 3am IST (former before-hours block)', () => {
    const r = canSendNow('a@example.com', { now: tz3am(), db, cfg: baseCfg });
    expect(r.allowed).toBe(true);
  });

  it('allows at midday IST', () => {
    const r = canSendNow('a@example.com', { now: tzNoon(), db, cfg: baseCfg });
    expect(r.allowed).toBe(true);
  });

  it('allows at 18:00 IST (former end-of-window block)', () => {
    const end = new Date('2026-05-27T12:30:00Z'); // 18:00 IST
    const r = canSendNow('a@example.com', { now: end, db, cfg: baseCfg });
    expect(r.allowed).toBe(true);
  });
});

describe('canSendNow — global throttle', () => {
  it('blocks if last send was <90s ago', () => {
    const now = tzNoon();
    const fiveSecAgo = new Date(now.getTime() - 5_000).toISOString().replace('T', ' ').slice(0, 19);
    insertSend(db, 'prior@example.com', fiveSecAgo);
    const r = canSendNow('next@example.com', { now, db, cfg: baseCfg });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('global_throttle');
    expect(r.retry_at).toBeInstanceOf(Date);
  });

  it('allows after the throttle window passes', () => {
    const now = tzNoon();
    const twoMinAgo = new Date(now.getTime() - 120_000).toISOString().replace('T', ' ').slice(0, 19);
    insertSend(db, 'prior@example.com', twoMinAgo);
    const r = canSendNow('next@example.com', { now, db, cfg: baseCfg });
    expect(r.allowed).toBe(true);
  });
});

describe('canSendNow — per-domain throttle', () => {
  it('blocks after 2 sends to the same domain within the past hour', () => {
    const now = tzNoon();
    const past = (msAgo) => new Date(now.getTime() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
    // Two sends to example.com within last hour, both ≥90s ago to avoid global throttle.
    insertSend(db, 'a@example.com', past(50 * 60_000), { contact_id: 1, draft_id: 1 });
    insertSend(db, 'b@example.com', past(40 * 60_000), { contact_id: 2, draft_id: 2 });
    const r = canSendNow('c@example.com', { now, db, cfg: baseCfg });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('per_domain_throttle');
  });

  it('does not count sends to other domains', () => {
    const now = tzNoon();
    const past = (msAgo) => new Date(now.getTime() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
    insertSend(db, 'a@example.com', past(50 * 60_000), { contact_id: 1, draft_id: 1 });
    insertSend(db, 'b@other.com', past(40 * 60_000), { contact_id: 2, draft_id: 2 });
    const r = canSendNow('c@example.com', { now, db, cfg: baseCfg });
    expect(r.allowed).toBe(true);
  });
});

describe('canSendNow — daily cap', () => {
  it('blocks once daily cap is reached', () => {
    const now = tzNoon();
    const past = (msAgo) => new Date(now.getTime() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
    const cfg = { ...baseCfg, dailyCap: 3 };
    insertSend(db, 'a@a.com', past(5 * 60_000), { contact_id: 1, draft_id: 1 });
    insertSend(db, 'b@b.com', past(4 * 60_000), { contact_id: 2, draft_id: 2 });
    insertSend(db, 'c@c.com', past(3 * 60_000), { contact_id: 3, draft_id: 3 });
    const r = canSendNow('d@d.com', { now, db, cfg });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('daily_cap');
  });
});

describe('canSendNow — suppressions', () => {
  it('blocks if email is on the suppression list', () => {
    const now = tzNoon();
    db.prepare('INSERT INTO suppressions (email, reason) VALUES (?, ?)').run('opt-out@example.com', 'manual');
    const r = canSendNow('opt-out@example.com', { now, db, cfg: baseCfg });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('suppressed');
  });
});

describe('canSendNow — invalid input', () => {
  it('rejects empty/malformed email', () => {
    const now = tzNoon();
    expect(canSendNow('', { now, db, cfg: baseCfg }).reason).toBe('invalid_recipient');
    expect(canSendNow('no-at-sign', { now, db, cfg: baseCfg }).reason).toBe('invalid_recipient');
  });
});
