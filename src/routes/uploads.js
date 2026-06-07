'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const { getDb } = require('../db');
const { recordEvent } = require('../utils/audit');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { parseContactsFile } = require('../services/file-parser');
const { extractPdfText } = require('../services/cv-extractor');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

function getCompanyById(id) {
  return getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

function requireCompany(req) {
  const id = Number(req.body.company_id);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('company_id is required');
  const company = getCompanyById(id);
  if (!company) throw new NotFoundError('company');
  return company;
}

function safeExt(filename, allowed) {
  const ext = path.extname(filename || '').toLowerCase();
  if (!allowed.includes(ext)) {
    throw new ValidationError(`unsupported file type "${ext}"; allowed: ${allowed.join(', ')}`);
  }
  return ext;
}

function writeFileSafely(targetDir, filename, buffer) {
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.resolve(targetDir, filename);
  const resolvedDir = path.resolve(targetDir);
  if (!target.startsWith(resolvedDir + path.sep)) {
    throw new ValidationError('path traversal attempt blocked');
  }
  fs.writeFileSync(target, buffer);
  return path.relative(process.cwd(), target);
}

router.post('/contacts', upload.single('file'), (req, res) => {
  const company = requireCompany(req);
  if (!req.file) throw new ValidationError('file is required (field name: "file")');

  const ext = safeExt(req.file.originalname, ['.csv', '.xlsx', '.xls']);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stored = `${company.slug}-${timestamp}${ext}`;
  const storedPath = writeFileSafely(config.paths.contactsDir, stored, req.file.buffer);

  let parsed;
  try {
    parsed = parseContactsFile(req.file.buffer, req.file.originalname);
  } catch (err) {
    throw new ValidationError(err.message);
  }

  if (parsed.fatal) {
    return res.status(400).json({
      error: { code: 'PARSE_FATAL', message: parsed.fatal },
      headers: parsed.headers,
      columnMap: parsed.columnMap,
    });
  }

  req.log.info(
    {
      company_id: company.id,
      slug: company.slug,
      file: req.file.originalname,
      stored: storedPath,
      stats: parsed.stats,
    },
    'contacts file parsed'
  );

  res.json({
    company: { id: company.id, slug: company.slug, name: company.name },
    source_file: req.file.originalname,
    stored_path: storedPath,
    headers: parsed.headers,
    columnMap: parsed.columnMap,
    stats: parsed.stats,
    rows: parsed.rows,
  });
});

function uploadAssetHandler(kind, allowed, dirKey, pathColumn, auditEvent) {
  return (req, res) => {
    const company = requireCompany(req);
    if (!req.file) throw new ValidationError('file is required (field name: "file")');

    const ext = safeExt(req.file.originalname, allowed);
    const filename = `${company.slug}${ext}`;
    const storedPath = writeFileSafely(config.paths[dirKey], filename, req.file.buffer);

    getDb()
      .prepare(`UPDATE companies SET ${pathColumn} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(storedPath, company.id);

    recordEvent(auditEvent, {
      entityType: 'company',
      entityId: company.id,
      metadata: { kind, file: req.file.originalname, size: req.file.size, stored: storedPath },
    });

    res.json({
      company_id: company.id,
      kind,
      path: storedPath,
      size: req.file.size,
      original_name: req.file.originalname,
    });
  };
}

// CV upload — stores file + extracts text for LLM personalization context.
router.post('/cv', upload.single('file'), async (req, res, next) => {
  try {
    const company = requireCompany(req);
    if (!req.file) throw new ValidationError('file is required (field name: "file")');
    const ext = safeExt(req.file.originalname, ['.pdf']);
    const filename = `${company.slug}${ext}`;
    const storedPath = writeFileSafely(config.paths.cvsDir, filename, req.file.buffer);

    // Extract text for LLM context (soft-fail — if extraction fails, cv_text stays null)
    const { text: cvText, error: cvErr } = await extractPdfText(req.file.buffer);

    getDb()
      .prepare('UPDATE companies SET cv_path = ?, cv_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(storedPath, cvText || null, company.id);

    recordEvent('cv_uploaded', {
      entityType: 'company',
      entityId: company.id,
      metadata: {
        kind: 'cv',
        file: req.file.originalname,
        size: req.file.size,
        stored: storedPath,
        cv_text_chars: cvText?.length || 0,
        cv_text_error: cvErr || null,
      },
    });

    res.json({
      company_id: company.id,
      kind: 'cv',
      path: storedPath,
      size: req.file.size,
      original_name: req.file.originalname,
      cv_text_extracted: Boolean(cvText),
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/artifact',
  upload.single('file'),
  uploadAssetHandler('artifact', ['.pdf'], 'artifactsDir', 'artifact_path', 'artifact_uploaded')
);

// Default CV — uploaded ONCE in Settings, reused for every campaign that does
// not have its own per-campaign CV. Stored in the single-row profile_extras
// table; attachmentsFor() falls back to this when company.cv_path is null.
router.post('/default-cv', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new ValidationError('file is required (field name: "file")');
    const ext = safeExt(req.file.originalname, ['.pdf']);
    const storedPath = writeFileSafely(config.paths.cvsDir, `default${ext}`, req.file.buffer);

    // Extract text for LLM context (soft-fail — if extraction fails, cv_text stays null)
    const { text: cvText, error: cvErr } = await extractPdfText(req.file.buffer);

    getDb()
      .prepare(
        `INSERT INTO profile_extras (id, cv_path, cv_text, cv_uploaded_at, updated_at)
         VALUES (1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           cv_path = excluded.cv_path,
           cv_text = excluded.cv_text,
           cv_uploaded_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP`
      )
      .run(storedPath, cvText || null);

    recordEvent('default_cv_uploaded', {
      entityType: 'profile_extras',
      entityId: 1,
      metadata: {
        file: req.file.originalname,
        size: req.file.size,
        stored: storedPath,
        cv_text_chars: cvText?.length || 0,
        cv_text_error: cvErr || null,
      },
    });

    res.json({
      kind: 'default_cv',
      path: storedPath,
      size: req.file.size,
      original_name: req.file.originalname,
      cv_text_extracted: Boolean(cvText),
    });
  } catch (err) {
    next(err);
  }
});

// Paste / text endpoint — accepts raw CSV or TSV text instead of a file upload.
// Body: { company_id: number, csv_text: string }
router.post('/contacts-text', (req, res) => {
  const companyId = Number(req.body?.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new ValidationError('company_id is required');
  }
  const company = getDb().prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company) throw new NotFoundError('company');

  const rawText = (req.body?.csv_text || '').toString().trim();
  if (!rawText) throw new ValidationError('csv_text is required');
  if (rawText.length > 500_000) throw new ValidationError('pasted text too large (max 500 KB)');

  // Convert to buffer and reuse the existing file-parser (treats as .csv, PapaParse auto-detects delimiter so TSV also works)
  const buffer = Buffer.from(rawText, 'utf8');

  let parsed;
  try {
    parsed = parseContactsFile(buffer, 'pasted-contacts.csv');
  } catch (err) {
    throw new ValidationError(err.message);
  }

  if (parsed.fatal) {
    return res.status(400).json({
      error: { code: 'PARSE_FATAL', message: parsed.fatal },
      headers: parsed.headers,
      columnMap: parsed.columnMap,
    });
  }

  req.log.info(
    { company_id: company.id, slug: company.slug, source: 'paste', stats: parsed.stats },
    'contacts text parsed'
  );

  res.json({
    company: { id: company.id, slug: company.slug, name: company.name },
    source_file: 'pasted-contacts.csv',
    stored_path: null,
    headers: parsed.headers,
    columnMap: parsed.columnMap,
    stats: parsed.stats,
    rows: parsed.rows,
  });
});

router.use((err, _req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'file exceeds 25MB' } });
  }
  next(err);
});

module.exports = router;
