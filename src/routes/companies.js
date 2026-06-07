'use strict';

const express = require('express');
const { z } = require('zod');

const { getDb } = require('../db');
const { uniqueSlug } = require('../utils/slug');
const { recordEvent } = require('../utils/audit');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { fetchPageText } = require('../services/page-fetcher');
const logger = require('../utils/logger');

const router = express.Router();

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  custom_context: z.string().trim().max(4000).optional().nullable(),
  company_link: z.string().trim().max(500).optional().nullable(),
  industry: z.string().trim().max(120).optional().nullable(),
  key_products: z.string().trim().max(500).optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  custom_context: z.string().trim().max(4000).nullable().optional(),
  company_link: z.string().trim().max(500).nullable().optional(),
  industry: z.string().trim().max(120).nullable().optional(),
  key_products: z.string().trim().max(500).nullable().optional(),
  status: z
    .enum(['not_started', 'contacts_loaded', 'drafts_ready', 'sending', 'completed', 'paused'])
    .optional(),
});

function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError('invalid request body', result.error.flatten());
  }
  return result.data;
}

function listCompanies() {
  return getDb()
    .prepare(
      `SELECT
         c.id, c.slug, c.name, c.custom_context, c.cv_path, c.artifact_path,
         c.status, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM contacts WHERE company_id = c.id) AS contact_count,
         (SELECT COUNT(*) FROM drafts WHERE company_id = c.id) AS draft_count,
         (SELECT COUNT(*) FROM sends WHERE company_id = c.id) AS send_count,
         (SELECT COUNT(*) FROM sends WHERE company_id = c.id AND replied = 1) AS replied_count
       FROM companies c
       ORDER BY c.created_at DESC`
    )
    .all();
}

function getCompanyById(id) {
  return getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

function slugExists(slug) {
  return Boolean(getDb().prepare('SELECT 1 FROM companies WHERE slug = ?').get(slug));
}

router.get('/', (_req, res) => {
  res.json(listCompanies());
});

router.get('/by-slug/:slug', (req, res) => {
  const company = getDb().prepare('SELECT * FROM companies WHERE slug = ?').get(req.params.slug);
  if (!company) throw new NotFoundError('company');
  res.json(company);
});

router.get('/:id(\\d+)', (req, res) => {
  const company = getCompanyById(Number(req.params.id));
  if (!company) throw new NotFoundError('company');
  res.json(company);
});

// People-with-drafts: one row per contact, joined to latest draft + send.
// Powers the new /companies/:slug/people page.
router.get('/:id(\\d+)/people-with-drafts', (req, res) => {
  const id = Number(req.params.id);
  const company = getCompanyById(id);
  if (!company) throw new NotFoundError('company');
  const rows = getDb()
    .prepare(
      `SELECT
         ct.id AS contact_id, ct.full_name, ct.first_name, ct.title, ct.seniority, ct.email,
         d.id AS draft_id, d.subject AS draft_subject, d.body AS draft_body, d.status AS draft_status, d.quality_warnings_json,
         (SELECT s.sent_at FROM sends s WHERE s.draft_id = d.id ORDER BY s.id DESC LIMIT 1) AS sent_at,
         (SELECT s.replied FROM sends s WHERE s.draft_id = d.id ORDER BY s.id DESC LIMIT 1) AS replied
       FROM contacts ct
       LEFT JOIN drafts d ON d.contact_id = ct.id AND d.company_id = ct.company_id
       WHERE ct.company_id = ?
       ORDER BY ct.id`
    )
    .all(id);
  res.json({
    company: { id: company.id, slug: company.slug, name: company.name, industry: company.industry },
    people: rows.map((r) => ({
      ...r,
      quality_warnings: r.quality_warnings_json ? JSON.parse(r.quality_warnings_json) : [],
    })),
  });
});

router.post('/', async (req, res, next) => {
  try {
    const data = parseBody(createSchema, req.body);
    const slug = uniqueSlug(data.name, slugExists);
    const result = getDb()
      .prepare(
        `INSERT INTO companies (slug, name, custom_context, company_link, industry, key_products)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        slug,
        data.name,
        data.custom_context || null,
        data.company_link || null,
        data.industry || null,
        data.key_products || null
      );
    const company = getCompanyById(result.lastInsertRowid);
    recordEvent('campaign_created', {
      entityType: 'company',
      entityId: company.id,
      metadata: { slug: company.slug, name: company.name, has_link: !!data.company_link },
    });

    // Best-effort URL fetch. Don't block the response — log result back into the row.
    if (data.company_link) {
      fetchPageText(data.company_link)
        .then(({ text, error }) => {
          getDb()
            .prepare(
              `UPDATE companies SET fetched_text = ?, fetched_at = CURRENT_TIMESTAMP, fetch_error = ? WHERE id = ?`
            )
            .run(text, error, company.id);
          logger.info(
            { company_id: company.id, url: data.company_link, chars: text?.length || 0, error },
            'company link fetched'
          );
        })
        .catch((err) => {
          logger.error({ err, company_id: company.id }, 'company link fetch failed');
        });
    }

    res.status(201).json(company);
  } catch (err) {
    next(err);
  }
});

router.put('/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  const existing = getCompanyById(id);
  if (!existing) throw new NotFoundError('company');

  const data = parseBody(updateSchema, req.body);
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(data)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) {
    return res.json(existing);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  getDb().prepare(`UPDATE companies SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = getCompanyById(id);
  res.json(updated);
});

router.delete('/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  const existing = getCompanyById(id);
  if (!existing) throw new NotFoundError('company');
  getDb().prepare('DELETE FROM companies WHERE id = ?').run(id);
  recordEvent('campaign_deleted', {
    entityType: 'company',
    entityId: id,
    metadata: { slug: existing.slug, name: existing.name },
  });
  res.status(204).end();
});

module.exports = router;
