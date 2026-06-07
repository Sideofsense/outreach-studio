'use strict';

const express = require('express');
const { z } = require('zod');

const config = require('../config');
const { getDb } = require('../db');
const { recordEvent } = require('../utils/audit');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { resolveTemplate, loadUserProfile } = require('../services/templates');
const { generateDraft, bucketFromSeniority } = require('../services/personalization-engine');
const { attachmentsFor } = require('../services/attachments');

const router = express.Router();

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

function getContactById(id) {
  return getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}

function getDraftById(id) {
  return getDb().prepare('SELECT * FROM drafts WHERE id = ?').get(id);
}

async function generateForContact({ companyId, contactId, replaceDraftId = null }) {
  const company = getCompanyById(companyId);
  if (!company) throw new NotFoundError('company');
  const contact = getContactById(contactId);
  if (!contact || contact.company_id !== company.id) {
    throw new NotFoundError('contact');
  }

  const userProfile = loadUserProfile();
  const globalSetup = getDb().prepare('SELECT cv_text, detailed_summary FROM profile_extras WHERE id = 1').get() || {};
  // Per-campaign CV text overrides the setup-once CV text when present
  const cvText = company.cv_text || globalSetup.cv_text;
  const bucket = bucketFromSeniority(contact.seniority);
  const templateRow = resolveTemplate(bucket, 0);

  // Last few openings already used for OTHER contacts at this company, so the
  // engine can vary the opening line and flag a repeat.
  const recentOpenings = getDb()
    .prepare(
      "SELECT body FROM drafts WHERE company_id = ? AND contact_id != ? AND body IS NOT NULL AND body != '' ORDER BY id DESC LIMIT 3"
    )
    .all(company.id, contact.id)
    .map((r) => r.body);

  const draft = await generateDraft({
    user_profile: userProfile,
    contact: {
      full_name: contact.full_name,
      first_name: contact.first_name,
      last_name: contact.last_name,
      title: contact.title,
      seniority: contact.seniority,
      linkedin_url: contact.linkedin_url,
      email: contact.email,
    },
    company: {
      name: company.name,
      custom_context: company.custom_context,
      company_link: company.company_link,
      industry: company.industry,
      key_products: company.key_products,
      fetched_text: company.fetched_text,
      cover_letter_text: company.cover_letter_text,
    },
    setup: {
      cv_text: cvText,
      detailed_summary: globalSetup.detailed_summary,
    },
    recent_openings: recentOpenings,
    template: {
      seniority_bucket: bucket,
      subject_template: templateRow.subject_template,
      body_template: templateRow.body_template,
      sequence_step: 0,
    },
  });

  // Surface "needs review" in the UI without a schema change by storing it as a
  // leading warning code alongside the real check codes.
  const warningsToStore = draft.needs_review
    ? ['needs_review', ...draft.quality_warnings]
    : draft.quality_warnings;

  const attachments = attachmentsFor(company);
  const db = getDb();

  if (replaceDraftId) {
    db.prepare(
      `UPDATE drafts SET
         template_id = ?, subject = ?, body = ?, attachments_json = ?,
         llm_input_tokens = ?, llm_output_tokens = ?, llm_provider = ?, llm_model = ?,
         quality_warnings_json = ?,
         status = 'draft', generated_at = CURRENT_TIMESTAMP,
         approved_at = NULL, sent_at = NULL, error_message = NULL
       WHERE id = ?`
    ).run(
      templateRow.id,
      draft.subject,
      draft.body,
      JSON.stringify(attachments),
      draft.tokens.input,
      draft.tokens.output,
      config.llm.provider,
      draft.model || null,
      JSON.stringify(warningsToStore),
      replaceDraftId
    );
    recordEvent('draft_regenerated', {
      entityType: 'draft',
      entityId: replaceDraftId,
      metadata: {
        contact_id: contact.id,
        company_id: company.id,
        tokens: draft.tokens,
        warnings: warningsToStore,
      },
    });
    return getDraftById(replaceDraftId);
  }

  const existing = db
    .prepare('SELECT id FROM drafts WHERE contact_id = ? ORDER BY id DESC LIMIT 1')
    .get(contact.id);
  if (existing) {
    return generateForContact({ companyId, contactId, replaceDraftId: existing.id });
  }

  const result = db
    .prepare(
      `INSERT INTO drafts
         (company_id, contact_id, template_id, subject, body, attachments_json,
          status, llm_input_tokens, llm_output_tokens, llm_provider, llm_model,
          quality_warnings_json)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`
    )
    .run(
      company.id,
      contact.id,
      templateRow.id,
      draft.subject,
      draft.body,
      JSON.stringify(attachments),
      draft.tokens.input,
      draft.tokens.output,
      config.llm.provider,
      draft.model || null,
      JSON.stringify(draft.quality_warnings)
    );
  const inserted = getDraftById(result.lastInsertRowid);
  recordEvent('draft_generated', {
    entityType: 'draft',
    entityId: inserted.id,
    metadata: {
      contact_id: contact.id,
      company_id: company.id,
      tokens: draft.tokens,
      warnings: draft.quality_warnings,
    },
  });
  return inserted;
}

// True if the text still has template tokens that should have been filled in:
// `{some_var}` style variables, or the `[…]` / `[...]` blank-draft placeholder.
function hasUnresolvedPlaceholders(text) {
  if (!text) return false;
  return /\{[a-z_]+\}/i.test(text) || text.includes('[…]') || text.includes('[...]');
}

function decorateDraft(row) {
  const contact = getContactById(row.contact_id);
  const repliedRow = getDb()
    .prepare(
      'SELECT id, replied_at FROM sends WHERE draft_id = ? AND replied = 1 ORDER BY replied_at DESC LIMIT 1'
    )
    .get(row.id);
  // Self-healing quality check: a stored draft (e.g. an old template-fallback from
  // before the LLM was working) can still contain unfilled {variables} or […] while
  // carrying no recorded warning. Surface it at read time so every editor and the
  // summary count flag it — and so the user knows to regenerate or edit before sending.
  const warnings = row.quality_warnings_json ? JSON.parse(row.quality_warnings_json) : [];
  if (
    (hasUnresolvedPlaceholders(row.subject) || hasUnresolvedPlaceholders(row.body)) &&
    !warnings.includes('unsubstituted_variable')
  ) {
    warnings.push('unsubstituted_variable');
  }
  return {
    ...row,
    attachments: row.attachments_json ? JSON.parse(row.attachments_json) : [],
    quality_warnings: warnings,
    replied: Boolean(repliedRow),
    replied_at: repliedRow?.replied_at || null,
    contact: contact
      ? {
          id: contact.id,
          full_name: contact.full_name,
          first_name: contact.first_name,
          title: contact.title,
          seniority: contact.seniority,
          email: contact.email,
        }
      : null,
  };
}

router.get('/', (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new ValidationError('company_id query param is required');
  }
  const rows = getDb()
    .prepare('SELECT * FROM drafts WHERE company_id = ? ORDER BY id')
    .all(companyId);
  res.json(rows.map(decorateDraft));
});

router.get('/:id(\\d+)', (req, res) => {
  const row = getDraftById(Number(req.params.id));
  if (!row) throw new NotFoundError('draft');
  res.json(decorateDraft(row));
});

const generateSchema = z.object({
  contact_id: z.number().int().positive(),
});

router.post('/generate', async (req, res, next) => {
  try {
    const data = parseBody(generateSchema, req.body);
    const contact = getContactById(data.contact_id);
    if (!contact) throw new NotFoundError('contact');
    const draft = await generateForContact({ companyId: contact.company_id, contactId: contact.id });
    res.status(201).json(decorateDraft(draft));
  } catch (err) {
    next(err);
  }
});

const batchSchema = z.object({
  company_id: z.number().int().positive(),
  only_missing: z.boolean().optional().default(false),
});

const blankBatchSchema = z.object({
  company_id: z.number().int().positive(),
  only_missing: z.boolean().optional().default(true),
});

/**
 * Substitute the easy variables in a template (contact + user + company names).
 * Creative variables like {one_specific_topic} are left as placeholders for the
 * user to fill in manually — this is the no-LLM path.
 */
function simpleSubstitute(text, ctx) {
  if (!text) return '';
  return text.replace(/\{([a-z_]+)\}/g, (m, key) => {
    // Known variables get substituted; unknown LLM-specific variables become an editable bracket placeholder
    if (Object.prototype.hasOwnProperty.call(ctx, key) && ctx[key]) return String(ctx[key]);
    return '[…]';
  });
}

function tryLoadUserProfile() {
  try {
    const { loadUserProfile } = require('../services/templates');
    return loadUserProfile();
  } catch {
    return {};
  }
}

function buildBlankDraft({ contact, company, templateRow, userProfile }) {
  const ctx = {
    first_name: contact.first_name || (contact.full_name || '').split(/\s+/)[0] || '',
    full_name: contact.full_name || '',
    company: company.name,
    user_first_name: userProfile.first_name || '',
    user_name: userProfile.name || '',
    user_company: userProfile.current_company || '',
    user_role: userProfile.current_role || '',
  };
  return {
    subject: simpleSubstitute(templateRow.subject_template, ctx),
    body: simpleSubstitute(templateRow.body_template, ctx),
  };
}

router.post('/generate-batch', async (req, res, next) => {
  try {
    const data = parseBody(batchSchema, req.body);
    const company = getCompanyById(data.company_id);
    if (!company) throw new NotFoundError('company');

    const contacts = getDb()
      .prepare('SELECT * FROM contacts WHERE company_id = ? AND selected = 1 ORDER BY id')
      .all(company.id);
    if (contacts.length === 0) {
      throw new ValidationError('no selected contacts for this company');
    }

    let candidates = contacts;
    if (data.only_missing) {
      const have = new Set(
        getDb()
          .prepare('SELECT DISTINCT contact_id FROM drafts WHERE company_id = ?')
          .all(company.id)
          .map((r) => r.contact_id)
      );
      candidates = candidates.filter((c) => !have.has(c.id));
    }

    const results = [];
    const errors = [];
    for (const contact of candidates) {
      try {
        const draft = await generateForContact({
          companyId: company.id,
          contactId: contact.id,
        });
        results.push(decorateDraft(draft));
      } catch (err) {
        req.log.error({ err, contact_id: contact.id }, 'draft generation failed');
        errors.push({ contact_id: contact.id, error: err.message });
      }
    }

    if (results.length > 0 && company.status === 'contacts_loaded') {
      getDb()
        .prepare("UPDATE companies SET status = 'drafts_ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(company.id);
    }

    res.json({
      company_id: company.id,
      generated: results.length,
      errors,
      drafts: results,
    });
  } catch (err) {
    next(err);
  }
});

// Wizard helper: returns the next undecided draft for a company, plus progress.
router.get('/next', (req, res) => {
  const companyId = Number(req.query.company_id);
  if (!Number.isInteger(companyId)) throw new ValidationError('company_id required');
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('draft') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
         COUNT(*) AS total
       FROM drafts WHERE company_id = ?`
    )
    .get(companyId);
  const next = db
    .prepare(
      `SELECT * FROM drafts WHERE company_id = ? AND status IN ('draft','approved') ORDER BY id LIMIT 1`
    )
    .get(companyId);
  let decoratedNext = null;
  if (next) {
    decoratedNext = decorateDraft(next);
    // Re-resolve attachments live so the preview shows exactly what send time
    // will attach — a CV/cover/artifact added after the draft was generated is
    // reflected here instead of the stale attachments_json snapshot.
    const company = getCompanyById(companyId);
    if (company) decoratedNext.attachments = attachmentsFor(company, db);
  }
  res.json({
    counts,
    next: decoratedNext,
  });
});

router.post('/blank-batch', (req, res) => {
  const data = parseBody(blankBatchSchema, req.body);
  const company = getCompanyById(data.company_id);
  if (!company) throw new NotFoundError('company');

  const contacts = getDb()
    .prepare('SELECT * FROM contacts WHERE company_id = ? AND selected = 1 ORDER BY id')
    .all(company.id);
  if (contacts.length === 0) {
    throw new ValidationError('no selected contacts for this company');
  }

  const haveDrafts = new Set(
    getDb()
      .prepare('SELECT DISTINCT contact_id FROM drafts WHERE company_id = ?')
      .all(company.id)
      .map((r) => r.contact_id)
  );
  const targets = data.only_missing ? contacts.filter((c) => !haveDrafts.has(c.id)) : contacts;
  if (targets.length === 0) {
    return res.json({ company_id: company.id, created: 0, drafts: [], message: 'No contacts need blank drafts.' });
  }

  const userProfile = tryLoadUserProfile();
  const attachments = attachmentsFor(company);
  const db = getDb();

  const insert = db.prepare(
    `INSERT INTO drafts
       (company_id, contact_id, template_id, subject, body, attachments_json,
        status, llm_input_tokens, llm_output_tokens, quality_warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', 0, 0, '[]')`
  );

  const created = [];
  const tx = db.transaction(() => {
    for (const contact of targets) {
      const bucket = bucketFromSeniority(contact.seniority);
      const templateRow = resolveTemplate(bucket, 0);
      const draft = buildBlankDraft({ contact, company, templateRow, userProfile });
      const result = insert.run(
        company.id,
        contact.id,
        templateRow.id,
        draft.subject,
        draft.body,
        JSON.stringify(attachments)
      );
      const row = getDraftById(result.lastInsertRowid);
      recordEvent('draft_generated', {
        entityType: 'draft',
        entityId: row.id,
        metadata: {
          contact_id: contact.id,
          company_id: company.id,
          mode: 'blank',
        },
      });
      created.push(row);
    }
  });
  tx();

  if (company.status === 'contacts_loaded') {
    db.prepare("UPDATE companies SET status = 'drafts_ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(company.id);
  }

  res.json({
    company_id: company.id,
    created: created.length,
    drafts: created.map(decorateDraft),
  });
});

router.post('/:id(\\d+)/regenerate', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = getDraftById(id);
    if (!existing) throw new NotFoundError('draft');
    const draft = await generateForContact({
      companyId: existing.company_id,
      contactId: existing.contact_id,
      replaceDraftId: id,
    });
    res.json(decorateDraft(draft));
  } catch (err) {
    next(err);
  }
});

const editSchema = z.object({
  subject: z.string().trim().min(1).max(500).optional(),
  body: z.string().trim().min(1).max(20000).optional(),
});

router.put('/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  const existing = getDraftById(id);
  if (!existing) throw new NotFoundError('draft');
  const data = parseBody(editSchema, req.body);
  const fields = [];
  const values = [];
  if (data.subject !== undefined) {
    fields.push('subject = ?');
    values.push(data.subject);
  }
  if (data.body !== undefined) {
    fields.push('body = ?');
    values.push(data.body);
  }
  if (fields.length === 0) {
    return res.json(decorateDraft(existing));
  }
  values.push(id);
  getDb().prepare(`UPDATE drafts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  recordEvent('draft_edited', {
    entityType: 'draft',
    entityId: id,
    metadata: {
      changed: Object.keys(data),
    },
  });
  res.json(decorateDraft(getDraftById(id)));
});

router.post('/:id(\\d+)/approve', (req, res) => {
  const id = Number(req.params.id);
  const existing = getDraftById(id);
  if (!existing) throw new NotFoundError('draft');
  if (existing.status === 'sent') {
    throw new ValidationError(`draft ${id} already sent`);
  }
  getDb()
    .prepare("UPDATE drafts SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(id);
  recordEvent('draft_approved', { entityType: 'draft', entityId: id });
  res.json(decorateDraft(getDraftById(id)));
});

router.post('/:id(\\d+)/unapprove', (req, res) => {
  const id = Number(req.params.id);
  const existing = getDraftById(id);
  if (!existing) throw new NotFoundError('draft');
  if (existing.status !== 'approved') {
    throw new ValidationError(`draft ${id} is not approved`);
  }
  getDb().prepare("UPDATE drafts SET status = 'draft', approved_at = NULL WHERE id = ?").run(id);
  res.json(decorateDraft(getDraftById(id)));
});

router.post('/:id(\\d+)/skip', (req, res) => {
  const id = Number(req.params.id);
  const existing = getDraftById(id);
  if (!existing) throw new NotFoundError('draft');
  getDb().prepare("UPDATE drafts SET status = 'skipped' WHERE id = ?").run(id);
  res.json(decorateDraft(getDraftById(id)));
});

module.exports = router;
