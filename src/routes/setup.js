'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { z } = require('zod');

const config = require('../config');
const { getDb } = require('../db');
const { ValidationError } = require('../utils/errors');
const { extractPdfText } = require('../services/cv-extractor');
const { recordEvent } = require('../utils/audit');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function getExtras() {
  return getDb().prepare('SELECT * FROM profile_extras WHERE id = 1').get();
}

router.get('/', (_req, res) => {
  res.json(getExtras() || {});
});

router.post('/cv', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new ValidationError('file required');
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (ext !== '.pdf') throw new ValidationError('CV must be a PDF');
    const dir = path.resolve('data/uploads/setup');
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, `cv${ext}`);
    fs.writeFileSync(stored, req.file.buffer);
    const rel = path.relative(process.cwd(), stored);
    const { text, error } = await extractPdfText(req.file.buffer);
    getDb().prepare(
      `UPDATE profile_extras SET cv_path = ?, cv_text = ?, cv_uploaded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
    ).run(rel, text);
    recordEvent('setup_cv_uploaded', { entityType: 'profile', metadata: { chars: text?.length || 0, error } });
    res.json({ ok: true, path: rel, chars: text?.length || 0, error });
  } catch (err) { next(err); }
});

const summarySchema = z.object({ detailed_summary: z.string().trim().max(20000) });

router.put('/summary', (req, res) => {
  const parsed = summarySchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('invalid body');
  getDb().prepare(
    `UPDATE profile_extras SET detailed_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
  ).run(parsed.data.detailed_summary);
  recordEvent('setup_summary_updated', { entityType: 'profile', metadata: { chars: parsed.data.detailed_summary.length } });
  res.json({ ok: true });
});

module.exports = router;
