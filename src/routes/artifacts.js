'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const { getDb } = require('../db');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { recordEvent } = require('../utils/audit');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function getCompany(id) {
  return getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

router.get('/', (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!Number.isInteger(companyId)) throw new ValidationError('company_id required');
  const rows = getDb()
    .prepare('SELECT * FROM artifacts WHERE company_id = ? ORDER BY id')
    .all(companyId);
  res.json(rows);
});

router.post('/', upload.single('file'), (req, res) => {
  const companyId = Number(req.body.company_id);
  const name = (req.body.name || '').toString().trim();
  if (!Number.isInteger(companyId)) throw new ValidationError('company_id required');
  if (!name) throw new ValidationError('artifact name required');
  if (!req.file) throw new ValidationError('file required');
  const company = getCompany(companyId);
  if (!company) throw new NotFoundError('company');

  const ext = path.extname(req.file.originalname || '').toLowerCase() || '.bin';
  const safeName = name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const dir = path.resolve(config.paths.artifactsDir);
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, `${company.slug}-${safeName}-${Date.now()}${ext}`);
  fs.writeFileSync(stored, req.file.buffer);
  const rel = path.relative(process.cwd(), stored);

  const result = getDb().prepare(
    `INSERT INTO artifacts (company_id, name, path, size_bytes) VALUES (?, ?, ?, ?)`
  ).run(companyId, name, rel, req.file.size);
  recordEvent('artifact_uploaded', {
    entityType: 'company', entityId: companyId,
    metadata: { kind: 'named_artifact', file: req.file.originalname, name, stored: rel },
  });
  res.status(201).json({ id: result.lastInsertRowid, name, path: rel, size: req.file.size });
});

router.delete('/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('artifact');
  try { fs.unlinkSync(path.resolve(row.path)); } catch { /* file may be gone */ }
  getDb().prepare('DELETE FROM artifacts WHERE id = ?').run(id);
  res.status(204).end();
});

router.post('/cover-letter', upload.single('file'), async (req, res, next) => {
  try {
    const companyId = Number(req.body.company_id);
    if (!Number.isInteger(companyId)) throw new ValidationError('company_id required');
    const company = getCompany(companyId);
    if (!company) throw new NotFoundError('company');

    let coverPath = null;
    let coverText = (req.body.text || '').toString().trim() || null;

    if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase() || '.pdf';
      const dir = path.resolve(config.paths.artifactsDir);
      fs.mkdirSync(dir, { recursive: true });
      coverPath = path.relative(process.cwd(), path.join(dir, `${company.slug}-coverletter${ext}`));
      fs.writeFileSync(path.resolve(coverPath), req.file.buffer);
      if (ext === '.pdf') {
        const { extractPdfText } = require('../services/cv-extractor');
        const { text } = await extractPdfText(req.file.buffer);
        if (text) coverText = text;
      }
    }

    getDb().prepare(
      'UPDATE companies SET cover_letter_path = ?, cover_letter_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(coverPath, coverText, companyId);
    recordEvent('cover_letter_uploaded', {
      entityType: 'company', entityId: companyId,
      metadata: { has_file: !!coverPath, chars: coverText?.length || 0 },
    });
    res.json({ ok: true, path: coverPath, chars: coverText?.length || 0 });
  } catch (err) { next(err); }
});

module.exports = router;
