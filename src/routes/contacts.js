'use strict';

const express = require('express');
const { z } = require('zod');

const { getDb } = require('../db');
const { recordEvent } = require('../utils/audit');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { classifySeniority } = require('../services/seniority-classifier');

const router = express.Router();

const rowSchema = z.object({
  full_name: z.string().trim().nullable().optional(),
  first_name: z.string().trim().nullable().optional(),
  last_name: z.string().trim().nullable().optional(),
  title: z.string().trim().nullable().optional(),
  email: z.string().trim().toLowerCase().email(),
  linkedin_url: z.string().trim().nullable().optional(),
  seniority: z.string().trim().nullable().optional(),
});

const commitSchema = z.object({
  company_id: z.number().int().positive(),
  source_file: z.string().trim().max(255).optional().nullable(),
  rows: z.array(rowSchema).min(1, 'at least one row required'),
});

function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError('invalid request body', result.error.flatten());
  }
  return result.data;
}

function getCompanyById(id) {
  return getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

router.get('/', (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new ValidationError('company_id query param is required');
  }
  const rows = getDb()
    .prepare(
      'SELECT id, company_id, full_name, first_name, last_name, title, seniority, email, linkedin_url, selected, source_file, created_at FROM contacts WHERE company_id = ? ORDER BY id'
    )
    .all(companyId);
  res.json(rows);
});

router.post('/commit', (req, res) => {
  const data = parseBody(commitSchema, req.body);
  const company = getCompanyById(data.company_id);
  if (!company) throw new NotFoundError('company');

  const insert = getDb().prepare(
    `INSERT INTO contacts (company_id, full_name, first_name, last_name, title, seniority, email, linkedin_url, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, email) DO UPDATE SET
       full_name=excluded.full_name,
       first_name=excluded.first_name,
       last_name=excluded.last_name,
       title=excluded.title,
       seniority=excluded.seniority,
       linkedin_url=excluded.linkedin_url,
       source_file=excluded.source_file`
  );

  let inserted = 0;
  let updated = 0;
  const tx = getDb().transaction((rows) => {
    for (const row of rows) {
      const seniority = row.seniority || classifySeniority(row.title);
      const before = getDb()
        .prepare('SELECT 1 FROM contacts WHERE company_id = ? AND email = ?')
        .get(company.id, row.email);
      insert.run(
        company.id,
        row.full_name || null,
        row.first_name || null,
        row.last_name || null,
        row.title || null,
        seniority,
        row.email,
        row.linkedin_url || null,
        data.source_file || null
      );
      if (before) updated += 1;
      else inserted += 1;
    }
  });
  tx(data.rows);

  if (company.status === 'not_started') {
    getDb()
      .prepare("UPDATE companies SET status = 'contacts_loaded', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(company.id);
  }

  recordEvent('contacts_uploaded', {
    entityType: 'company',
    entityId: company.id,
    metadata: {
      source_file: data.source_file,
      inserted,
      updated,
      total: data.rows.length,
    },
  });

  res.status(201).json({
    company_id: company.id,
    inserted,
    updated,
    total: data.rows.length,
  });
});

module.exports = router;
