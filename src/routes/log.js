'use strict';

const express = require('express');
const { z } = require('zod');

const { getDb } = require('../db');
const { ValidationError } = require('../utils/errors');

const router = express.Router();

const statusValues = ['sent', 'replied', 'bounced', 'all'];

const filterSchema = z.object({
  company_id: z.coerce.number().int().positive().optional(),
  status: z.enum(statusValues).optional().default('all'),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be YYYY-MM-DD').optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be YYYY-MM-DD').optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  page_size: z.coerce.number().int().positive().max(200).optional().default(50),
});

function parseFilters(query) {
  const result = filterSchema.safeParse(query);
  if (!result.success) {
    throw new ValidationError('invalid filters', result.error.flatten());
  }
  return result.data;
}

function buildWhere(f) {
  const clauses = [];
  const params = [];
  if (f.company_id) {
    clauses.push('s.company_id = ?');
    params.push(f.company_id);
  }
  if (f.status && f.status !== 'all') {
    if (f.status === 'replied') clauses.push('s.replied = 1');
    else if (f.status === 'bounced') clauses.push('s.bounced = 1');
    else if (f.status === 'sent') clauses.push('s.replied = 0 AND s.bounced = 0');
  }
  if (f.date_from) {
    clauses.push('date(s.sent_at) >= date(?)');
    params.push(f.date_from);
  }
  if (f.date_to) {
    clauses.push('date(s.sent_at) <= date(?)');
    params.push(f.date_to);
  }
  if (f.q) {
    clauses.push('(lower(s.recipient) LIKE ? OR lower(s.subject) LIKE ?)');
    const like = `%${f.q.toLowerCase()}%`;
    params.push(like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return { where, params };
}

function rowsForFilters(f) {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.page_size;
  const sql = `
    SELECT
      s.id, s.sent_at, s.recipient, s.subject, s.sequence_step,
      s.gmail_message_id, s.replied, s.replied_at, s.bounced, s.bounce_reason,
      s.company_id, c.name AS company_name, c.slug AS company_slug,
      s.draft_id, s.contact_id,
      ct.full_name AS contact_name, ct.seniority AS contact_seniority
    FROM sends s
    LEFT JOIN companies c ON c.id = s.company_id
    LEFT JOIN contacts ct ON ct.id = s.contact_id
    ${where}
    ORDER BY s.sent_at DESC
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS c FROM sends s ${where}`;
  const db = getDb();
  const total = db.prepare(countSql).get(...params).c;
  const rows = db.prepare(sql).all(...params, f.page_size, offset);
  return { rows, total };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function deriveStatus(row) {
  if (row.replied) return 'replied';
  if (row.bounced) return 'bounced';
  return 'sent';
}

router.get('/', (req, res) => {
  const filters = parseFilters(req.query);
  const { rows, total } = rowsForFilters(filters);
  const decorated = rows.map((r) => ({ ...r, status: deriveStatus(r) }));
  res.json({
    rows: decorated,
    total,
    page: filters.page,
    page_size: filters.page_size,
    filters,
  });
});

router.get('/export.csv', (req, res) => {
  const filters = parseFilters({ ...req.query, page: 1, page_size: 200 });
  // Stream up to 10k rows in chunks of 200.
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="outreach-log-${new Date().toISOString().slice(0,10)}.csv"`);
  res.write(
    'id,sent_at,company,recipient,contact_name,seniority,subject,status,sequence_step,gmail_message_id,replied_at,bounce_reason\n'
  );

  let pageNum = 1;
  const MAX_PAGES = 50; // 50 * 200 = 10,000 rows hard cap
  while (pageNum <= MAX_PAGES) {
    const { rows } = rowsForFilters({ ...filters, page: pageNum, page_size: 200 });
    if (rows.length === 0) break;
    for (const r of rows) {
      res.write(
        [
          r.id,
          r.sent_at,
          r.company_name,
          r.recipient,
          r.contact_name,
          r.contact_seniority,
          r.subject,
          deriveStatus(r),
          r.sequence_step,
          r.gmail_message_id,
          r.replied_at,
          r.bounce_reason,
        ].map(csvEscape).join(',') + '\n'
      );
    }
    if (rows.length < 200) break;
    pageNum += 1;
  }
  res.end();
});

module.exports = router;
