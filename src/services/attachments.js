'use strict';

const { getDb } = require('../db');

/**
 * Resolve the list of file paths that should be attached to outreach for a
 * company, in priority order:
 *   1. Per-campaign CV  → falls back to the setup-once CV (profile_extras)
 *   2. Legacy single artifact (backward compat)
 *   3. Cover letter
 *   4. All named artifacts
 *
 * This is the single source of truth for both draft generation and send time,
 * so a CV/cover/artifact attached AFTER a draft was generated still goes out.
 */
function attachmentsFor(company, db = getDb()) {
  const paths = [];
  if (company.cv_path) {
    paths.push(company.cv_path);
  } else {
    const extras = db.prepare('SELECT cv_path FROM profile_extras WHERE id = 1').get();
    if (extras?.cv_path) paths.push(extras.cv_path);
  }
  if (company.artifact_path) paths.push(company.artifact_path);
  if (company.cover_letter_path) paths.push(company.cover_letter_path);
  const namedArtifacts = db
    .prepare('SELECT path FROM artifacts WHERE company_id = ? ORDER BY id')
    .all(company.id);
  for (const a of namedArtifacts) paths.push(a.path);
  return paths;
}

module.exports = { attachmentsFor };
