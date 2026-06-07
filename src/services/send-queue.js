'use strict';

const { getDb } = require('../db');
const logger = require('../utils/logger');
const { recordEvent } = require('../utils/audit');
const { canSendNow } = require('./throttle');
const { emit } = require('./event-bus');

// routes/send.js requires this file (lazy-required at the bottom), so we
// resolve sendDraft on first use to avoid a load-time circular import.
let _sendDraft = null;
function getSendDraft() {
  if (_sendDraft) return _sendDraft;
  const mod = require('../routes/send');
  _sendDraft = mod.sendDraft;
  if (!_sendDraft) throw new Error('sendDraft not exported from routes/send.js');
  return _sendDraft;
}

const TICK_MS = 5_000;
const pausedCompanies = new Set();
let stopAllUntil = 0; // global hard stop expiry timestamp
let timer = null;
let inflight = false;
let started = false;

function broadcast(event) {
  emit({ ...event, ts: new Date().toISOString() });
}

function queuedDraftsForCompany(companyId) {
  return getDb()
    .prepare(
      "SELECT * FROM drafts WHERE company_id = ? AND status IN ('queued','sending') ORDER BY id"
    )
    .all(companyId);
}

function nextQueuedDraft() {
  return getDb()
    .prepare(
      "SELECT * FROM drafts WHERE status = 'queued' ORDER BY approved_at, id LIMIT 1"
    )
    .get();
}

function enqueueApproved(companyId) {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE drafts SET status = 'queued' WHERE company_id = ? AND status = 'approved'"
    )
    .run(companyId);
  if (result.changes > 0) {
    db.prepare(
      "UPDATE companies SET status = 'sending', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(companyId);
  }
  recordEvent('campaign_started', {
    entityType: 'company',
    entityId: companyId,
    metadata: { queued: result.changes },
  });
  broadcast({ type: 'campaign_started', company_id: companyId, queued: result.changes });
  pausedCompanies.delete(companyId);
  return result.changes;
}

function pauseCompany(companyId) {
  pausedCompanies.add(companyId);
  getDb()
    .prepare("UPDATE companies SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(companyId);
  recordEvent('campaign_paused', { entityType: 'company', entityId: companyId });
  broadcast({ type: 'campaign_paused', company_id: companyId });
}

function resumeCompany(companyId) {
  pausedCompanies.delete(companyId);
  getDb()
    .prepare("UPDATE companies SET status = 'sending', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(companyId);
  recordEvent('campaign_resumed', { entityType: 'company', entityId: companyId });
  broadcast({ type: 'campaign_resumed', company_id: companyId });
}

function stopAll() {
  // Hard stop: revert all queued drafts back to 'approved' so they don't get
  // sent. In-flight 'sending' drafts will finish their current attempt (we
  // cannot abort an open SMTP connection cleanly) but no new sends start.
  const db = getDb();
  const reverted = db
    .prepare("UPDATE drafts SET status = 'approved' WHERE status = 'queued'")
    .run();
  stopAllUntil = Date.now() + 60_000; // refuse to start new sends for 60s
  pausedCompanies.clear();
  db.prepare(
    "UPDATE companies SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE status = 'sending'"
  ).run();
  recordEvent('campaign_stopped_all', {
    entityType: 'system',
    metadata: { reverted: reverted.changes },
  });
  broadcast({ type: 'stop_all', reverted: reverted.changes });
  return { reverted: reverted.changes };
}

function statusSnapshot(companyId) {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM drafts WHERE company_id = ?`
    )
    .get(companyId);
  const lastSend = db
    .prepare(
      "SELECT s.sent_at, s.recipient FROM sends s WHERE s.company_id = ? ORDER BY s.sent_at DESC LIMIT 1"
    )
    .get(companyId);
  return {
    company_id: companyId,
    paused: pausedCompanies.has(companyId),
    stop_all_active: Date.now() < stopAllUntil,
    counts,
    last_send: lastSend,
  };
}

async function processNext() {
  if (inflight) return;
  if (Date.now() < stopAllUntil) return;

  const draft = nextQueuedDraft();
  if (!draft) return;
  if (pausedCompanies.has(draft.company_id)) return;

  const contact = getDb().prepare('SELECT email FROM contacts WHERE id = ?').get(draft.contact_id);
  if (!contact) {
    logger.warn({ draft_id: draft.id }, 'queued draft has no contact — marking failed');
    getDb()
      .prepare("UPDATE drafts SET status = 'failed', error_message = 'contact missing' WHERE id = ?")
      .run(draft.id);
    return;
  }

  const throttle = canSendNow(contact.email);
  if (!throttle.allowed) {
    broadcast({
      type: 'next_in',
      draft_id: draft.id,
      recipient: contact.email,
      reason: throttle.reason,
      retry_at: throttle.retry_at ? throttle.retry_at.toISOString() : null,
      seconds:
        throttle.retry_at instanceof Date
          ? Math.max(0, Math.ceil((throttle.retry_at.getTime() - Date.now()) / 1000))
          : null,
    });
    return;
  }

  inflight = true;
  getDb().prepare("UPDATE drafts SET status = 'sending' WHERE id = ?").run(draft.id);
  broadcast({
    type: 'send_started',
    draft_id: draft.id,
    company_id: draft.company_id,
    recipient: contact.email,
  });

  try {
    const result = await getSendDraft()(draft, { force: true });
    broadcast({
      type: 'send_success',
      draft_id: draft.id,
      company_id: draft.company_id,
      send_id: result.send_id,
      recipient: result.recipient,
      sent_at: new Date().toISOString(),
    });
  } catch (err) {
    broadcast({
      type: 'send_failed',
      draft_id: draft.id,
      company_id: draft.company_id,
      recipient: contact.email,
      error: err.message,
    });
    // Provider daily-sending / rate limit: an account-wide block we cannot beat
    // by retrying. Stop hammering — put this draft back to 'queued' (it was NOT
    // sent) and pause the campaign so the rest are held, not marked failed.
    if (err && err.code === 'RATE_LIMIT') {
      getDb()
        .prepare("UPDATE drafts SET status = 'queued' WHERE id = ? AND status = 'sending'")
        .run(draft.id);
      pauseCompany(draft.company_id);
      broadcast({
        type: 'rate_limited',
        company_id: draft.company_id,
        recipient: contact.email,
        error: err.message,
      });
    }
  } finally {
    inflight = false;
  }

  // Completion check fires regardless of success/failure — once no drafts remain
  // queued/sending for this company, mark it done.
  const remaining = getDb()
    .prepare("SELECT COUNT(*) AS c FROM drafts WHERE company_id = ? AND status IN ('queued','sending')")
    .get(draft.company_id).c;
  if (remaining === 0) {
    const company = getDb().prepare("SELECT status FROM companies WHERE id = ?").get(draft.company_id);
    if (company && company.status === 'sending') {
      getDb()
        .prepare(
          "UPDATE companies SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(draft.company_id);
      recordEvent('campaign_completed', {
        entityType: 'company',
        entityId: draft.company_id,
      });
      broadcast({ type: 'campaign_completed', company_id: draft.company_id });
    }
  }
}

function resumeOrphans() {
  // Server died mid-send — bring stuck rows back to 'queued' so the queue
  // can retry.
  const db = getDb();
  const result = db.prepare("UPDATE drafts SET status = 'queued' WHERE status = 'sending'").run();
  if (result.changes > 0) {
    logger.info({ recovered: result.changes }, 'send-queue: recovered orphaned sending drafts');
  }
  // Bring companies that were sending back to sending state if they have queued work.
  const stalled = db
    .prepare(
      "SELECT DISTINCT company_id FROM drafts WHERE status = 'queued'"
    )
    .all();
  for (const row of stalled) {
    db.prepare(
      "UPDATE companies SET status = 'sending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'paused'"
    ).run(row.company_id);
  }
}

function start() {
  if (started) return;
  started = true;
  resumeOrphans();
  timer = setInterval(() => {
    processNext().catch((err) => logger.error({ err }, 'send-queue tick error'));
  }, TICK_MS);
  timer.unref();
  logger.info({ tickMs: TICK_MS }, 'send-queue: started');
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
  enqueueApproved,
  pauseCompany,
  resumeCompany,
  stopAll,
  statusSnapshot,
  queuedDraftsForCompany,
  processNext, // exposed for tests
};
