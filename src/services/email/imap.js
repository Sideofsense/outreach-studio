'use strict';

const Imap = require('node-imap');
const { simpleParser } = require('mailparser');

const config = require('../../config');
const { getDb } = require('../../db');
const logger = require('../../utils/logger');
const { recordEvent } = require('../../utils/audit');
const {
  addSuppression,
  detectStopRequest,
  normalize,
} = require('../suppressions');

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

function stripBrackets(s) {
  if (!s) return '';
  return String(s).trim().replace(/^<|>$/g, '');
}

/**
 * Normalise In-Reply-To / References headers to a flat list of message-id
 * strings (without angle brackets, lower-case).
 */
function extractMessageIds({ inReplyTo, references } = {}) {
  const out = new Set();
  const push = (raw) => {
    if (!raw) return;
    String(raw)
      .split(/\s+/)
      .map(stripBrackets)
      .map((s) => s.toLowerCase())
      .filter(Boolean)
      .forEach((id) => out.add(id));
  };
  if (Array.isArray(inReplyTo)) inReplyTo.forEach(push);
  else push(inReplyTo);
  if (Array.isArray(references)) references.forEach(push);
  else push(references);
  return Array.from(out);
}

function findSenderEmail(parsed) {
  const list = parsed?.from?.value || [];
  if (list.length === 0) return null;
  return normalize(list[0].address || '');
}

function isKnownContact(email, db = getDb()) {
  if (!email) return false;
  return Boolean(
    db.prepare('SELECT 1 FROM contacts WHERE lower(email) = ?').get(normalize(email))
  );
}

function findRepliedSends(messageIds, db = getDb()) {
  if (messageIds.length === 0) return [];
  // gmail_message_id is stored verbatim from Nodemailer (e.g. "<abc@gmail.com>") —
  // strip brackets on both sides for matching.
  const stmt = db.prepare(
    `SELECT * FROM sends
     WHERE lower(REPLACE(REPLACE(gmail_message_id, '<', ''), '>', '')) = ?`
  );
  const results = [];
  for (const id of messageIds) {
    const row = stmt.get(id);
    if (row) results.push(row);
  }
  return results;
}

function markReplied(sendIds, db = getDb()) {
  if (sendIds.length === 0) return 0;
  const stmt = db.prepare("UPDATE sends SET replied = 1, replied_at = CURRENT_TIMESTAMP WHERE id = ? AND replied = 0");
  let changed = 0;
  for (const id of sendIds) {
    changed += stmt.run(id).changes;
  }
  return changed;
}

function cancelPendingFollowUps(contactId, db = getDb()) {
  // Any follow-up draft (linked to a template with sequence_step >= 1) still
  // in 'approved' or 'queued' for this contact gets skipped — they replied,
  // no further follow-ups.
  const result = db
    .prepare(
      `UPDATE drafts SET status = 'skipped'
       WHERE contact_id = ?
         AND status IN ('approved','queued')
         AND template_id IN (SELECT id FROM templates WHERE sequence_step >= 1)`
    )
    .run(contactId);
  return result.changes;
}

function getLastUid(db = getDb()) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'imap_last_uid'").get();
  return row ? Number(row.value) || 0 : 0;
}

function setLastUid(uid, db = getDb()) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('imap_last_uid', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(String(uid));
}

// ---------------------------------------------------------------------------
// Side-effecting processing of one incoming message
// ---------------------------------------------------------------------------

async function processMessage(parsed, { uid, log = logger } = {}) {
  const db = getDb();
  const sender = findSenderEmail(parsed);
  const messageIds = extractMessageIds({
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
  });

  const matchedSends = findRepliedSends(messageIds, db);
  if (matchedSends.length > 0) {
    const sendIds = matchedSends.map((s) => s.id);
    const updated = markReplied(sendIds, db);
    // Cancel any pending follow-ups for each affected contact.
    const contactIds = [...new Set(matchedSends.map((s) => s.contact_id))];
    let cancelled = 0;
    for (const cid of contactIds) {
      cancelled += cancelPendingFollowUps(cid, db);
    }
    recordEvent('reply_detected', {
      entityType: 'send',
      entityId: sendIds[0],
      metadata: {
        send_ids: sendIds,
        contact_ids: contactIds,
        sender,
        updated,
        followups_cancelled: cancelled,
        subject: (parsed.subject || '').slice(0, 200),
      },
    });
    log.info(
      { sendIds, contactIds, sender, cancelled, uid },
      'reply detected'
    );
  }

  // STOP / UNSUBSCRIBE detection. Only act on people we're actually reaching
  // out to — a matched reply to a tracked send, or a known contact. This stops
  // unrelated marketing mail (whose own footer says "unsubscribe") from
  // suppressing addresses we never email. detectStopRequest already ignores
  // quoted history and our own compliance footer.
  const stop = detectStopRequest({
    subject: parsed.subject || '',
    body: parsed.text || parsed.textAsHtml || '',
  });
  const inOutreachRelationship =
    matchedSends.length > 0 || isKnownContact(sender, db);
  if (stop && sender && inOutreachRelationship) {
    const result = addSuppression(sender, 'unsubscribed', {
      notes: `IMAP STOP/UNSUB from "${(parsed.subject || '').slice(0, 80)}"`,
      db,
    });
    if (result.added) {
      recordEvent('unsubscribe_received', {
        entityType: 'suppression',
        entityId: result.id,
        metadata: { email: sender, subject: (parsed.subject || '').slice(0, 200) },
      });
      log.info({ sender, uid }, 'STOP request received');
    }
  }
}

// ---------------------------------------------------------------------------
// IMAP connection lifecycle
// ---------------------------------------------------------------------------

function isPlaceholderCreds() {
  return (
    !config.imap.password ||
    config.imap.password.startsWith('your_16_char') ||
    config.imap.password === 'your_16_char_app_password'
  );
}

function newClient() {
  return new Imap({
    user: config.imap.user,
    password: config.imap.password,
    host: config.imap.host,
    port: config.imap.port,
    tls: true,
    tlsOptions: { servername: config.imap.host },
    authTimeout: 15_000,
    connTimeout: 15_000,
  });
}

function openInbox(client) {
  return new Promise((resolve, reject) => {
    client.openBox('INBOX', false, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

function searchUids(client, criteria) {
  return new Promise((resolve, reject) => {
    client.search(criteria, (err, uids) => {
      if (err) reject(err);
      else resolve(uids || []);
    });
  });
}

function fetchUids(client, uids) {
  return new Promise((resolve, reject) => {
    const results = [];
    if (uids.length === 0) return resolve(results);
    const f = client.fetch(uids, { bodies: '', struct: false });
    f.on('message', (msg, seqno) => {
      const chunks = [];
      let uid;
      msg.on('body', (stream) => {
        stream.on('data', (d) => chunks.push(d));
      });
      msg.once('attributes', (attrs) => {
        uid = attrs.uid;
      });
      msg.once('end', () => {
        results.push({ uid, buffer: Buffer.concat(chunks) });
      });
    });
    f.once('error', reject);
    f.once('end', () => resolve(results));
  });
}

async function pollOnce({ log = logger } = {}) {
  if (isPlaceholderCreds()) {
    log.debug('imap poll skipped — credentials are placeholders');
    return { skipped: true };
  }
  const client = newClient();
  let opened = false;

  const stats = { fetched: 0, replied: 0, suppressed: 0, errors: 0 };

  try {
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect();
    });
    const box = await openInbox(client);
    opened = true;
    const lastUid = getLastUid();
    // If we have no prior watermark, jump to the current head so we don't
    // process the entire history on first run.
    if (lastUid === 0) {
      setLastUid(box.uidnext - 1);
      log.info({ uidnext: box.uidnext }, 'imap poll: initialised watermark');
      return { initialised: true, uidnext: box.uidnext };
    }

    const uids = await searchUids(client, [['UID', `${lastUid + 1}:*`]]);
    if (uids.length === 0) {
      return stats;
    }

    const messages = await fetchUids(client, uids);
    let highestUid = lastUid;
    for (const { uid, buffer } of messages) {
      try {
        const parsed = await simpleParser(buffer);
        await processMessage(parsed, { uid, log });
        stats.fetched += 1;
        if (uid > highestUid) highestUid = uid;
      } catch (err) {
        stats.errors += 1;
        log.error({ err, uid }, 'imap: failed to process message');
      }
    }
    setLastUid(highestUid);
    log.info({ ...stats, highestUid }, 'imap poll complete');
    return stats;
  } finally {
    try {
      if (opened) await new Promise((resolve) => client.closeBox(true, () => resolve()));
    } catch { /* ignore */ }
    try { client.end(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

let timer = null;
let busy = false;
let started = false;

function start() {
  if (started) return;
  if (isPlaceholderCreds()) {
    logger.warn('imap poller: IMAP_PASSWORD looks like a placeholder — reply detection disabled');
    return;
  }
  started = true;
  const tickMs = (config.imap.pollIntervalSeconds || 300) * 1000;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await pollOnce(); }
    catch (err) { logger.error({ err: err.message }, 'imap poll failed'); }
    finally { busy = false; }
  };
  // Run a poll soon after boot (5s) to settle the watermark, then on interval.
  setTimeout(() => tick().catch(() => {}), 5_000).unref();
  timer = setInterval(() => tick().catch(() => {}), tickMs);
  timer.unref();
  logger.info({ tickMs }, 'imap poller started');
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

module.exports = {
  start,
  stop,
  pollOnce,
  processMessage,
  // pure helpers
  stripBrackets,
  extractMessageIds,
  findSenderEmail,
  isKnownContact,
  findRepliedSends,
  markReplied,
  cancelPendingFollowUps,
  getLastUid,
  setLastUid,
  isPlaceholderCreds,
};
