'use strict';

const express = require('express');

const { getDb } = require('../db');
const cost = require('../services/cost');

const router = express.Router();

/**
 * Aggregated dashboard data for the home page: 6 KPI tiles, recent activity,
 * paused campaigns, and an "any campaign sending right now?" flag for the
 * STOP ALL button visibility.
 */
router.get('/dashboard', (_req, res) => {
  const db = getDb();

  const companies_tracked = db.prepare('SELECT COUNT(*) AS c FROM companies').get().c;
  const contacts_loaded = db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c;
  const drafts_ready = db
    .prepare("SELECT COUNT(*) AS c FROM drafts WHERE status IN ('draft','approved')")
    .get().c;
  const sent_today = db
    .prepare(
      "SELECT COUNT(*) AS c FROM sends WHERE date(sent_at) = date('now')"
    )
    .get().c;
  const replies_received = db.prepare('SELECT COUNT(*) AS c FROM sends WHERE replied = 1').get().c;
  const suppressed = db.prepare('SELECT COUNT(*) AS c FROM suppressions').get().c;

  const recent = db
    .prepare(
      `SELECT id, event_type, entity_type, entity_id, created_at, metadata_json
       FROM audit_log
       ORDER BY id DESC
       LIMIT 10`
    )
    .all()
    .map((r) => ({
      ...r,
      metadata: r.metadata_json ? safeJSON(r.metadata_json) : null,
    }));

  const paused = db
    .prepare("SELECT id, slug, name, status, updated_at FROM companies WHERE status = 'paused'")
    .all();
  const sending = db
    .prepare("SELECT id, slug, name FROM companies WHERE status = 'sending'")
    .all();

  res.json({
    kpis: {
      companies_tracked,
      contacts_loaded,
      drafts_ready,
      sent_today,
      replies_received,
      suppressed,
    },
    recent_activity: recent,
    paused_campaigns: paused,
    sending_campaigns: sending,
    any_sending: sending.length > 0,
    cost: cost.summarise(),
  });
});

function safeJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = router;
