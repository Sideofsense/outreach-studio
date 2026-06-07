import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import {
  stripBrackets,
  extractMessageIds,
  findSenderEmail,
  findRepliedSends,
  markReplied,
  cancelPendingFollowUps,
  getLastUid,
  setLastUid,
} from '../src/services/email/imap.js';

function buildSchema(db) {
  db.exec(fs.readFileSync(path.resolve('migrations/001_initial_schema.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve('migrations/002_audit_log.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve('migrations/003_suppressions.sql'), 'utf8'));
}

let db;
beforeEach(() => {
  db = new Database(':memory:');
  buildSchema(db);
});

describe('stripBrackets', () => {
  it('removes angle brackets', () => {
    expect(stripBrackets('<abc@gmail.com>')).toBe('abc@gmail.com');
    expect(stripBrackets('abc@gmail.com')).toBe('abc@gmail.com');
  });
  it('handles whitespace and empty', () => {
    expect(stripBrackets('  <x>  ')).toBe('x');
    expect(stripBrackets('')).toBe('');
    expect(stripBrackets(null)).toBe('');
  });
});

describe('extractMessageIds', () => {
  it('parses a single In-Reply-To header (with brackets, mixed case)', () => {
    expect(
      extractMessageIds({ inReplyTo: '<ABC@Gmail.COM>' })
    ).toEqual(['abc@gmail.com']);
  });

  it('parses array-form References', () => {
    expect(
      extractMessageIds({ references: ['<a@x>', '<b@x>'] })
    ).toEqual(['a@x', 'b@x']);
  });

  it('parses space-separated References string', () => {
    expect(
      extractMessageIds({ references: '<a@x> <b@x> <c@x>' })
    ).toEqual(['a@x', 'b@x', 'c@x']);
  });

  it('dedupes ids that appear in both fields', () => {
    expect(
      extractMessageIds({ inReplyTo: '<a@x>', references: '<a@x> <b@x>' })
    ).toEqual(['a@x', 'b@x']);
  });

  it('returns [] for empty input', () => {
    expect(extractMessageIds()).toEqual([]);
    expect(extractMessageIds({})).toEqual([]);
  });
});

describe('findSenderEmail', () => {
  it('extracts the first address (lowercased)', () => {
    expect(findSenderEmail({ from: { value: [{ address: 'Foo@BAR.com' }] } })).toBe('foo@bar.com');
  });
  it('handles missing fields', () => {
    expect(findSenderEmail({})).toBe(null);
    expect(findSenderEmail()).toBe(null);
  });
});

describe('findRepliedSends', () => {
  it('matches sends by message-id, case-insensitive, with or without brackets', () => {
    db.prepare("INSERT INTO companies (id, slug, name) VALUES (1, 'c1', 'C1')").run();
    db.prepare("INSERT INTO contacts (id, company_id, email) VALUES (1, 1, 'x@example.com')").run();
    db.prepare(
      "INSERT INTO drafts (id, company_id, contact_id, subject, body, status) VALUES (1, 1, 1, 's', 'b', 'sent')"
    ).run();
    db.prepare(
      `INSERT INTO sends (id, draft_id, contact_id, company_id, recipient, subject, gmail_message_id)
       VALUES (1, 1, 1, 1, 'x@example.com', 's', '<TheID@gmail.COM>')`
    ).run();

    const hits = findRepliedSends(['theid@gmail.com'], db);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe(1);
  });

  it('returns [] when nothing matches', () => {
    expect(findRepliedSends(['noone@here'], db)).toEqual([]);
  });
});

describe('markReplied', () => {
  it('flips replied flag and sets replied_at', () => {
    db.prepare("INSERT INTO companies (id, slug, name) VALUES (1, 'c1', 'C1')").run();
    db.prepare("INSERT INTO contacts (id, company_id, email) VALUES (1, 1, 'x@example.com')").run();
    db.prepare("INSERT INTO drafts (id, company_id, contact_id, subject, body, status) VALUES (1, 1, 1, 's', 'b', 'sent')").run();
    db.prepare(
      `INSERT INTO sends (id, draft_id, contact_id, company_id, recipient, subject, gmail_message_id, replied)
       VALUES (1, 1, 1, 1, 'x@x', 's', 'm1', 0)`
    ).run();

    const changed = markReplied([1], db);
    expect(changed).toBe(1);
    const row = db.prepare('SELECT replied, replied_at FROM sends WHERE id = 1').get();
    expect(row.replied).toBe(1);
    expect(row.replied_at).not.toBeNull();
  });

  it('does not double-flip already-replied rows', () => {
    db.prepare("INSERT INTO companies (id, slug, name) VALUES (1, 'c1', 'C1')").run();
    db.prepare("INSERT INTO contacts (id, company_id, email) VALUES (1, 1, 'x@x')").run();
    db.prepare("INSERT INTO drafts (id, company_id, contact_id, subject, body, status) VALUES (1, 1, 1, 's', 'b', 'sent')").run();
    db.prepare(
      `INSERT INTO sends (id, draft_id, contact_id, company_id, recipient, subject, replied)
       VALUES (1, 1, 1, 1, 'x@x', 's', 1)`
    ).run();
    expect(markReplied([1], db)).toBe(0);
  });
});

describe('cancelPendingFollowUps', () => {
  it('skips queued/approved drafts that use a follow-up template, leaves initial-template drafts alone', () => {
    db.prepare("INSERT INTO companies (id, slug, name) VALUES (1, 'c1', 'C1')").run();
    db.prepare("INSERT INTO contacts (id, company_id, email) VALUES (1, 1, 'x@x')").run();
    // Template 100: initial (step 0). Template 200: follow-up (step 1).
    db.prepare(
      "INSERT INTO templates (id, name, seniority, sequence_step, subject_template, body_template) VALUES (100, 'peer', 'peer', 0, 's', 'b'), (200, 'fu', NULL, 1, 's', 'b')"
    ).run();
    db.prepare(
      `INSERT INTO drafts (id, company_id, contact_id, template_id, subject, body, status) VALUES
       (1, 1, 1, 100, 's', 'b', 'sent'),
       (2, 1, 1, 200, 's', 'b', 'approved'),
       (3, 1, 1, 200, 's', 'b', 'queued'),
       (4, 1, 1, 200, 's', 'b', 'draft')`
    ).run();

    const changed = cancelPendingFollowUps(1, db);
    expect(changed).toBe(2);
    const statuses = db.prepare('SELECT id, status FROM drafts ORDER BY id').all();
    expect(statuses.map((s) => s.status)).toEqual(['sent', 'skipped', 'skipped', 'draft']);
  });
});

describe('UID watermark', () => {
  it('round-trips through the settings table', () => {
    expect(getLastUid(db)).toBe(0);
    setLastUid(123, db);
    expect(getLastUid(db)).toBe(123);
    setLastUid(456, db);
    expect(getLastUid(db)).toBe(456);
  });
});
