'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('../config');
const { getDb } = require('../db');
const logger = require('../utils/logger');

/**
 * Templates live in two places:
 *  - src/templates/*.md is the canonical source shipped with the repo
 *  - the `templates` DB table is the runtime store so the /settings editor
 *    can mutate them without changing files on disk.
 *
 * On first boot we seed the DB from the .md files. Edits afterwards happen
 * in DB; the .md files are never re-read once a row exists for that key.
 */

const SEEDS = [
  { name: 'peer-initial', seniority: 'peer', sequence_step: 0, file: 'peer-email' },
  { name: 'senior-initial', seniority: 'senior', sequence_step: 0, file: 'senior-email' },
  { name: 'executive-initial', seniority: 'executive', sequence_step: 0, file: 'executive-email' },
  { name: 'follow-up-1', seniority: null, sequence_step: 1, file: 'follow-up' },
];

function readMarkdownTemplate(name) {
  const p = path.join(__dirname, '..', 'templates', `${name}.md`);
  const text = fs.readFileSync(p, 'utf8');
  const [firstLine, ...rest] = text.split('\n');
  const subjectMatch = firstLine.match(/^Subject:\s*(.*)$/i);
  return {
    subject_template: subjectMatch ? subjectMatch[1] : '',
    body_template: rest.join('\n').replace(/^\s+/, ''),
  };
}

function seedTemplates() {
  const db = getDb();
  const select = db.prepare(
    "SELECT 1 FROM templates WHERE name = ? AND COALESCE(seniority, '') = COALESCE(?, '') AND sequence_step = ?"
  );
  const insert = db.prepare(
    `INSERT INTO templates (name, seniority, sequence_step, version, subject_template, body_template, active)
     VALUES (?, ?, ?, 1, ?, ?, 1)`
  );
  const tx = db.transaction(() => {
    for (const seed of SEEDS) {
      if (select.get(seed.name, seed.seniority, seed.sequence_step)) continue;
      const tmpl = readMarkdownTemplate(seed.file);
      insert.run(seed.name, seed.seniority, seed.sequence_step, tmpl.subject_template, tmpl.body_template);
      logger.info({ name: seed.name }, 'template seeded');
    }
  });
  tx();
}

function resolveTemplate(bucket, sequenceStep = 0) {
  const db = getDb();
  if (sequenceStep && sequenceStep >= 1) {
    const row = db
      .prepare(
        'SELECT * FROM templates WHERE active = 1 AND sequence_step = ? ORDER BY version DESC, id DESC LIMIT 1'
      )
      .get(sequenceStep);
    if (row) return row;
  }
  const row = db
    .prepare(
      'SELECT * FROM templates WHERE active = 1 AND seniority = ? AND sequence_step = 0 ORDER BY version DESC, id DESC LIMIT 1'
    )
    .get(bucket);
  if (!row) throw new Error(`no active template for bucket="${bucket}" step=${sequenceStep}`);
  return row;
}

function listTemplates() {
  return getDb().prepare('SELECT * FROM templates WHERE active = 1 ORDER BY seniority, sequence_step').all();
}

function loadUserProfile() {
  const p = path.resolve(config.paths.userProfile);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  const examplePath = path.resolve('data/user-profile.example.json');
  if (fs.existsSync(examplePath)) {
    logger.warn(
      { profile: p, example: examplePath },
      'user-profile.json missing — falling back to example. Drop your real profile into data/.'
    );
    return JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  }
  throw new Error(
    `user profile not found — drop data/user-profile.json (see data/user-profile.example.json)`
  );
}

module.exports = {
  seedTemplates,
  resolveTemplate,
  listTemplates,
  loadUserProfile,
};
