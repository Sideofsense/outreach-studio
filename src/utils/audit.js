'use strict';

const { getDb } = require('../db');
const logger = require('./logger');

const insertStmt = () =>
  getDb().prepare(
    'INSERT INTO audit_log (event_type, entity_type, entity_id, metadata_json) VALUES (?, ?, ?, ?)'
  );

function recordEvent(eventType, { entityType = null, entityId = null, metadata = null } = {}) {
  try {
    insertStmt().run(eventType, entityType, entityId, metadata ? JSON.stringify(metadata) : null);
  } catch (err) {
    logger.error({ err, eventType }, 'failed to write audit_log entry');
  }
}

module.exports = { recordEvent };
