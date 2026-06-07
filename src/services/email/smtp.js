'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

const config = require('../../config');
const logger = require('../../utils/logger');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    requireTLS: config.smtp.port !== 465,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.password,
    },
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
  });
  return transporter;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render the plain-text body into a clean, minimal HTML email. Deliberately
 * understated — good typography and spacing, no logos or buttons — which is
 * what a 1:1 professional outreach email should look like (and keeps it out of
 * spam filters). The "---" compliance divider becomes a muted footer.
 */
function bodyToHtml(text) {
  const raw = String(text || '');
  let main = raw;
  let footer = '';
  const div = raw.indexOf('\n---\n');
  if (div !== -1) {
    main = raw.slice(0, div);
    footer = raw.slice(div + 5).trim();
  }
  const paras = main
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 16px;">${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`
    )
    .join('');
  const footerHtml = footer
    ? `<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;line-height:1.5;">${escapeHtml(
        footer
      ).replace(/\n/g, '<br>')}</p>`
    : '';
  return (
    '<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f9;">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 8px;' +
    'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;' +
    'font-size:15px;line-height:1.65;color:#1f2937;">' +
    paras +
    footerHtml +
    '</div></body></html>'
  );
}

function resolveAttachment(p) {
  const abs = path.resolve(p);
  const allowedRoot = path.resolve(config.paths.uploadsDir);
  if (!abs.startsWith(allowedRoot + path.sep)) {
    throw new Error(`refusing to attach file outside uploads dir: ${p}`);
  }
  if (!fs.existsSync(abs)) {
    return null;
  }
  return { filename: path.basename(abs), path: abs };
}

/**
 * Send one email. Throws on hard failure. Returns { messageId } on success.
 *
 * Sent as multipart/alternative: the plain-text body (with the compliance
 * footer the personalization engine already appended) plus a clean HTML
 * rendering for clients that prefer it.
 *
 * @param {object} args
 * @param {string} args.to       - recipient email
 * @param {string} args.subject
 * @param {string} args.body     - plain text body (footer already included)
 * @param {string[]} [args.attachments] - relative paths under data/uploads
 * @param {string} [args.replyTo]
 * @returns {Promise<{ messageId: string, response: string, accepted: string[] }>}
 */
async function sendOne({ to, subject, body, attachments = [], replyTo }) {
  const t = getTransporter();
  const safeAttachments = attachments
    .map((p) => {
      try { return resolveAttachment(p); }
      catch (err) {
        logger.warn({ p, err: err.message }, 'attachment rejected');
        return null;
      }
    })
    .filter(Boolean);

  if (attachments.length > 0 && safeAttachments.length < attachments.length) {
    logger.warn(
      { requested: attachments.length, attached: safeAttachments.length },
      'some attachments could not be resolved — proceeding without them'
    );
  }

  const from = `${config.smtp.fromName} <${config.smtp.user}>`;

  logger.info(
    { to, subjectLen: subject.length, bodyLen: body.length, attachments: safeAttachments.length },
    'smtp.sendOne'
  );

  const info = await t.sendMail({
    from,
    to,
    subject,
    text: body,
    html: bodyToHtml(body),
    attachments: safeAttachments,
    replyTo: replyTo || config.smtp.user,
  });

  return {
    messageId: info.messageId,
    response: info.response,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}

async function verifyConnection() {
  await getTransporter().verify();
  return true;
}

function closeTransport() {
  if (transporter) {
    transporter.close();
    transporter = null;
  }
}

function classifyError(err) {
  if (!err) return 'unknown';

  // Auth / configuration errors are sender-side, NOT a recipient bounce.
  // Don't suppress the recipient when login fails or our envelope is malformed.
  if (err.code === 'EAUTH' || err.code === 'EENVELOPE') return 'auth_error';
  if (err.responseCode === 535 || err.responseCode === 530) return 'auth_error';

  // Provider rate / daily-sending limit — a block on OUR account, NOT a problem
  // with the recipient. Gmail returns these with an enhanced status like 5.4.5
  // ("Daily user sending limit exceeded") — and crucially as a 5xx, so without
  // this check the generic 550 rule below would mis-read it as a bounce and
  // suppress a perfectly valid contact. The recipient address is fine; the limit
  // clears on its own (Gmail resets within ~24h). Match on the enhanced code and
  // message text since the numeric responseCode alone (550) is ambiguous.
  const text = `${err.response || ''} ${err.message || ''}`;
  if (
    /\b[45]\.4\.5\b/.test(text) || // Gmail daily user/relay sending limit exceeded
    /\b4\.7\.0\b/.test(text) || // temporary rate-limit / suspicious-activity throttle
    /\bdaily (?:user )?(?:sending|smtp relay) limit\b/i.test(text) ||
    /\bsending limit exceeded\b/i.test(text) ||
    /\b(?:user-?rate|rate[- ]limit(?:ed|ing)?)\b/i.test(text) ||
    /\btoo many (?:messages|recipients|login attempts)\b/i.test(text)
  ) {
    return 'rate_limit';
  }

  // Recipient-side 5xx — true bounces (mailbox unavailable, bad address, etc.)
  if (typeof err.responseCode === 'number' && err.responseCode >= 550 && err.responseCode < 600) {
    return 'bounce';
  }
  // Other 5xx (e.g. policy, oversize) — recipient might still exist; not a bounce.
  if (typeof err.responseCode === 'number' && err.responseCode >= 500 && err.responseCode < 550) {
    return 'permanent_other';
  }
  // 4xx — temporary failures
  if (typeof err.responseCode === 'number' && err.responseCode >= 400 && err.responseCode < 500) {
    return 'transient';
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION') return 'transient';
  return 'unknown';
}

module.exports = { sendOne, verifyConnection, closeTransport, classifyError, bodyToHtml };
