'use strict';

const express = require('express');

const { getDb } = require('../db');
const { recordEvent } = require('../utils/audit');
const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { canSendNow } = require('../services/throttle');
const { isSuppressed, addSuppression } = require('../services/suppressions');
const { attachmentsFor } = require('../services/attachments');
const smtp = require('../services/email/smtp');

const router = express.Router();

function getDraftById(id) {
  return getDb().prepare('SELECT * FROM drafts WHERE id = ?').get(id);
}
function getContactById(id) {
  return getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}
function getCompanyById(id) {
  return getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

// True if the text still has template tokens that should have been filled in:
// `{some_var}` style variables, or the `[…]` / `[...]` blank-draft placeholder.
function hasUnresolvedPlaceholders(text) {
  if (!text) return false;
  return /\{[a-z_]+\}/i.test(text) || text.includes('[…]') || text.includes('[...]');
}

async function sendDraft(draft, { req, force = false } = {}) {
  const contact = getContactById(draft.contact_id);
  const company = getCompanyById(draft.company_id);
  if (!contact || !company) throw new NotFoundError('contact or company');
  if (draft.status === 'sent') throw new ValidationError('draft already sent');
  if (!force && draft.status !== 'approved') {
    throw new ValidationError(`draft must be approved before sending (current: ${draft.status})`);
  }

  // Never send an email that still has unsubstituted template tokens. The local
  // LLM (or the blank-draft fallback) can leave behind `{first_name}` style
  // variables or the `[…]` placeholder. Sending those verbatim is broken output.
  if (hasUnresolvedPlaceholders(draft.subject) || hasUnresolvedPlaceholders(draft.body)) {
    const message =
      'Draft still contains placeholders ({…} or […]). Edit or regenerate it before sending.';
    // The send queue marks the draft 'sending' before calling us with force=true.
    // Move it to 'failed' so the campaign can complete instead of stalling on a
    // draft stuck in 'sending'. A manual single send (no force) leaves the
    // approved draft as-is so the user can just edit and retry.
    if (force) {
      getDb()
        .prepare("UPDATE drafts SET status = 'failed', error_message = ? WHERE id = ?")
        .run(message, draft.id);
    }
    recordEvent('send_blocked', {
      entityType: 'draft',
      entityId: draft.id,
      metadata: { reason: 'unsubstituted_placeholder' },
    });
    throw new AppError(message, { status: 422, code: 'PLACEHOLDER' });
  }

  if (isSuppressed(contact.email)) {
    recordEvent('send_blocked', {
      entityType: 'draft',
      entityId: draft.id,
      metadata: { reason: 'suppressed', email: contact.email },
    });
    throw new AppError('recipient is suppressed', { status: 422, code: 'SUPPRESSED' });
  }

  const throttle = canSendNow(contact.email);
  if (!throttle.allowed) {
    throw new AppError(`throttled: ${throttle.reason}`, {
      status: 429,
      code: 'THROTTLED',
    });
  }

  // Resolve attachments from the LIVE company at send time, not from the
  // snapshot taken when the draft was generated. A CV / cover letter / artifact
  // attached AFTER drafting would otherwise never be sent.
  const attachments = attachmentsFor(company);
  // Keep the draft record in sync with what is actually being sent.
  if (JSON.stringify(attachments) !== (draft.attachments_json || '[]')) {
    getDb()
      .prepare('UPDATE drafts SET attachments_json = ? WHERE id = ?')
      .run(JSON.stringify(attachments), draft.id);
  }
  const log = req?.log || console;

  let info;
  try {
    info = await smtp.sendOne({
      to: contact.email,
      subject: draft.subject,
      body: draft.body,
      attachments,
    });
  } catch (err) {
    const kind = smtp.classifyError(err);
    log.error?.({ err: err.message, kind, draft_id: draft.id }, 'smtp send failed');

    // Provider daily-sending / rate limit (e.g. Gmail 550-5.4.5). This is a
    // block on OUR account, not a problem with the recipient. Do NOT mark the
    // draft failed (it's still good to send once the limit resets) and never
    // suppress the recipient. Surface a clear, retryable 429 instead.
    if (kind === 'rate_limit') {
      recordEvent('send_rate_limited', {
        entityType: 'draft',
        entityId: draft.id,
        metadata: { error: err.message.slice(0, 200), recipient: contact.email },
      });
      throw new AppError(
        'Email provider daily sending limit reached. Your account is temporarily blocked by the provider (Gmail resets this within ~24h). Nothing was sent and no contacts were changed — try again after the limit resets.',
        { status: 429, code: 'RATE_LIMIT' }
      );
    }

    getDb()
      .prepare("UPDATE drafts SET status = 'failed', error_message = ? WHERE id = ?")
      .run(err.message, draft.id);

    recordEvent('email_failed', {
      entityType: 'draft',
      entityId: draft.id,
      metadata: { error: err.message, kind, recipient: contact.email },
    });

    if (kind === 'bounce') {
      addSuppression(contact.email, 'bounced', { notes: `auto: ${err.message.slice(0, 200)}` });
      recordEvent('email_bounced', {
        entityType: 'contact',
        entityId: contact.id,
        metadata: { reason: err.message, code: err.responseCode },
      });
    }

    throw new AppError(`smtp send failed: ${err.message}`, {
      status: kind === 'bounce' ? 502 : 500,
      code: kind === 'bounce' ? 'BOUNCE' : 'SMTP_ERROR',
    });
  }

  const db = getDb();
  const sendInsert = db.prepare(
    `INSERT INTO sends (draft_id, contact_id, company_id, gmail_message_id, recipient, subject, sequence_step)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const sequence = draft.sequence_step ?? 0;
  const sendResult = sendInsert.run(
    draft.id,
    contact.id,
    company.id,
    info.messageId,
    contact.email,
    draft.subject,
    sequence
  );

  db.prepare("UPDATE drafts SET status = 'sent', sent_at = CURRENT_TIMESTAMP, error_message = NULL WHERE id = ?").run(draft.id);

  recordEvent('email_sent', {
    entityType: 'draft',
    entityId: draft.id,
    metadata: {
      send_id: sendResult.lastInsertRowid,
      message_id: info.messageId,
      recipient: contact.email,
      company_id: company.id,
    },
  });

  return {
    draft_id: draft.id,
    send_id: sendResult.lastInsertRowid,
    message_id: info.messageId,
    recipient: contact.email,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}

router.post('/draft/:id(\\d+)', async (req, res, next) => {
  try {
    const draft = getDraftById(Number(req.params.id));
    if (!draft) throw new NotFoundError('draft');
    const result = await sendDraft(draft, { req });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/sends', (req, res) => {
  const companyId = req.query.company_id ? Number(req.query.company_id) : null;
  const sql = companyId
    ? 'SELECT * FROM sends WHERE company_id = ? ORDER BY sent_at DESC LIMIT 500'
    : 'SELECT * FROM sends ORDER BY sent_at DESC LIMIT 500';
  const rows = companyId ? getDb().prepare(sql).all(companyId) : getDb().prepare(sql).all();
  res.json(rows);
});

// --- campaign-level queue control (M8) ---
// Lazy-require the queue to avoid a circular import at module load.
function queue() { return require('../services/send-queue'); }

router.post('/start-campaign', (req, res) => {
  const companyId = Number(req.body?.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new ValidationError('company_id is required');
  }
  const company = getCompanyById(companyId);
  if (!company) throw new NotFoundError('company');
  const queued = queue().enqueueApproved(companyId);
  res.status(202).json({ company_id: companyId, queued });
});

router.post('/pause-campaign', (req, res) => {
  const companyId = Number(req.body?.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new ValidationError('company_id is required');
  }
  queue().pauseCompany(companyId);
  res.json({ company_id: companyId, paused: true });
});

router.post('/resume-campaign', (req, res) => {
  const companyId = Number(req.body?.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new ValidationError('company_id is required');
  }
  queue().resumeCompany(companyId);
  res.json({ company_id: companyId, paused: false });
});

router.post('/stop-all', (_req, res) => {
  const result = queue().stopAll();
  res.json(result);
});

router.get('/campaign/:company_id(\\d+)/status', (req, res) => {
  const companyId = Number(req.params.company_id);
  const company = getCompanyById(companyId);
  if (!company) throw new NotFoundError('company');
  const snap = queue().statusSnapshot(companyId);
  res.json({ ...snap, company });
});

module.exports = { router, sendDraft };
