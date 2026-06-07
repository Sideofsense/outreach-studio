'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { z } = require('zod');

const config = require('../config');
const { getDb } = require('../db');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { recordEvent } = require('../utils/audit');
const {
  throttleConfig,
  updateThrottle,
  resetThrottleOverrides,
} = require('../services/runtime-config');
const smtp = require('../services/email/smtp');

const router = express.Router();

function parseBody(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) throw new ValidationError('invalid body', r.error.flatten());
  return r.data;
}

function configuredStatus(value, placeholderPrefixes = []) {
  if (!value) return 'not_configured';
  for (const p of placeholderPrefixes) {
    if (String(value).startsWith(p)) return 'placeholder';
  }
  return 'configured';
}

function llmConnectionInfo() {
  if (config.llm.provider === 'ollama') {
    return {
      provider: 'ollama',
      status: 'configured',
      host: config.ollama.host,
      model: config.ollama.model,
      note: 'free, local — install from ollama.com',
    };
  }
  return {
    provider: 'anthropic',
    status: configuredStatus(config.anthropic.apiKey, ['sk-ant-...']),
    model: config.anthropic.model,
  };
}

router.get('/', (_req, res) => {
  const tc = throttleConfig();
  const profilePath = path.resolve(config.paths.userProfile);
  const profileExamplePath = path.resolve('data/user-profile.example.json');
  res.json({
    connections: {
      llm: llmConnectionInfo(),
      // Kept for backwards compat with older UI fields:
      anthropic: {
        status: configuredStatus(config.anthropic.apiKey, ['sk-ant-...']),
        model: config.anthropic.model,
      },
      smtp: {
        status: configuredStatus(config.smtp.password, ['your_16_char']),
        host: config.smtp.host,
        port: config.smtp.port,
        user: config.smtp.user,
        from_name: config.smtp.fromName,
      },
      imap: {
        status: configuredStatus(config.imap.password, ['your_16_char']),
        host: config.imap.host,
        port: config.imap.port,
        user: config.imap.user,
        poll_interval_seconds: config.imap.pollIntervalSeconds,
      },
    },
    throttle: tc,
    user_profile: {
      exists: fs.existsSync(profilePath),
      path: config.paths.userProfile,
      example_exists: fs.existsSync(profileExamplePath),
    },
    default_cv: defaultCvStatus(),
  });
});

// Status of the "set once, reuse everywhere" default CV (profile_extras row 1).
// Attached to every campaign that has no per-campaign CV of its own.
function defaultCvStatus() {
  const row = getDb()
    .prepare('SELECT cv_path, cv_uploaded_at, cv_text FROM profile_extras WHERE id = 1')
    .get();
  return {
    configured: Boolean(row && row.cv_path),
    filename: row && row.cv_path ? row.cv_path.split('/').pop() : null,
    uploaded_at: (row && row.cv_uploaded_at) || null,
    text_extracted: Boolean(row && row.cv_text),
  };
}

const throttleSchema = z.object({
  globalSeconds: z.coerce.number().int().min(0).max(86_400).optional(),
  perDomainPerHour: z.coerce.number().int().min(1).max(100).optional(),
  dailyCap: z.coerce.number().int().min(1).max(10_000).optional(),
  workingHoursStart: z.coerce.number().int().min(0).max(23).optional(),
  workingHoursEnd: z.coerce.number().int().min(1).max(24).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

router.put('/throttle', (req, res) => {
  const data = parseBody(throttleSchema, req.body);
  if (
    data.workingHoursStart !== undefined &&
    data.workingHoursEnd !== undefined &&
    data.workingHoursEnd <= data.workingHoursStart
  ) {
    throw new ValidationError('workingHoursEnd must be greater than workingHoursStart');
  }
  const updated = updateThrottle(data);
  recordEvent('settings_throttle_updated', {
    entityType: 'settings',
    metadata: { updated },
  });
  res.json({ updated, effective: throttleConfig() });
});

router.post('/throttle/reset', (_req, res) => {
  resetThrottleOverrides();
  recordEvent('settings_throttle_reset', { entityType: 'settings' });
  res.json({ effective: throttleConfig() });
});

router.get('/user-profile', (_req, res) => {
  const p = path.resolve(config.paths.userProfile);
  if (!fs.existsSync(p)) {
    const example = path.resolve('data/user-profile.example.json');
    if (fs.existsSync(example)) {
      return res.json({ exists: false, contents: JSON.parse(fs.readFileSync(example, 'utf8')) });
    }
    return res.json({ exists: false, contents: null });
  }
  res.json({ exists: true, contents: JSON.parse(fs.readFileSync(p, 'utf8')) });
});

const profileSchema = z.object({
  name: z.string().min(1).max(120),
  first_name: z.string().min(1).max(60),
  current_role: z.string().max(120).optional().default(''),
  current_company: z.string().max(120).optional().default(''),
  location: z.string().max(120).optional().default(''),
  summary: z.string().max(2000).optional().default(''),
  key_achievements: z.array(z.string().max(500)).max(20).optional().default([]),
  links: z.record(z.string(), z.string().max(500)).optional().default({}),
}).strict();

router.put('/user-profile', (req, res) => {
  const data = parseBody(profileSchema, req.body);
  const p = path.resolve(config.paths.userProfile);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  recordEvent('settings_user_profile_updated', {
    entityType: 'settings',
    metadata: { name: data.name },
  });
  res.json({ saved: true, path: config.paths.userProfile });
});

router.get('/templates', (_req, res) => {
  const rows = getDb()
    .prepare(
      'SELECT id, name, seniority, sequence_step, version, subject_template, body_template, active, created_at FROM templates ORDER BY seniority NULLS LAST, sequence_step, id'
    )
    .all();
  res.json(rows);
});

const templateUpdateSchema = z.object({
  subject_template: z.string().min(1).max(500),
  body_template: z.string().min(1).max(20_000),
  active: z.boolean().optional(),
}).strict();

router.put('/templates/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  const existing = getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id);
  if (!existing) throw new NotFoundError('template');
  const data = parseBody(templateUpdateSchema, req.body);
  getDb()
    .prepare(
      `UPDATE templates SET subject_template = ?, body_template = ?, version = version + 1${data.active !== undefined ? ', active = ?' : ''}
       WHERE id = ?`
    )
    .run(
      ...(data.active !== undefined
        ? [data.subject_template, data.body_template, data.active ? 1 : 0, id]
        : [data.subject_template, data.body_template, id])
    );
  recordEvent('settings_template_updated', {
    entityType: 'template',
    entityId: id,
    metadata: { name: existing.name, version: existing.version + 1 },
  });
  const updated = getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id);
  res.json(updated);
});

// --- Test buttons ---
router.post('/test/smtp', async (_req, res, next) => {
  try {
    await smtp.verifyConnection();
    res.json({ ok: true, message: `connected to ${config.smtp.host}:${config.smtp.port} as ${config.smtp.user}` });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message, code: err.code || err.responseCode });
  } finally {
    // Tear down so the next test re-validates fresh creds.
    try { smtp.closeTransport(); } catch { /* ignore */ }
  }
});

router.post('/test/imap', async (_req, res) => {
  if (
    !config.imap.password ||
    config.imap.password.startsWith('your_16_char')
  ) {
    return res.status(400).json({ ok: false, error: 'IMAP_PASSWORD looks like a placeholder' });
  }
  let Imap;
  try {
    Imap = require('node-imap');
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
  const client = new Imap({
    user: config.imap.user,
    password: config.imap.password,
    host: config.imap.host,
    port: config.imap.port,
    tls: true,
    authTimeout: 15_000,
    connTimeout: 15_000,
  });
  let opened = false;
  let total = null;
  try {
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect();
    });
    await new Promise((resolve, reject) => {
      client.openBox('INBOX', true, (err, box) => {
        if (err) reject(err);
        else { opened = true; total = box.messages.total; resolve(); }
      });
    });
    res.json({ ok: true, message: `connected to ${config.imap.host}:${config.imap.port}, INBOX has ${total} messages` });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  } finally {
    try { client.end(); } catch { /* ignore */ }
  }
});

async function testAnthropic() {
  if (!config.anthropic.apiKey || config.anthropic.apiKey.startsWith('sk-ant-...')) {
    return { status: 400, body: { ok: false, error: 'ANTHROPIC_API_KEY looks like a placeholder' } };
  }
  try {
    const { complete } = require('../services/llm/anthropic');
    const r = await complete({
      system: 'Respond with exactly one word: ok',
      user: 'ping',
      maxTokens: 10,
      temperature: 0,
    });
    return {
      status: 200,
      body: { ok: true, provider: 'anthropic', model: r.model, sample: r.text.slice(0, 60), tokens: r.tokens },
    };
  } catch (err) {
    return { status: 502, body: { ok: false, error: err.message } };
  }
}

async function testOllama() {
  try {
    const ollama = require('../services/llm/ollama');
    const ping = await ollama.ping();
    if (!ping.available_models.includes(config.ollama.model)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `Model "${config.ollama.model}" not found locally. Run: ollama pull ${config.ollama.model}`,
          available_models: ping.available_models,
        },
      };
    }
    const r = await ollama.complete({
      system: 'Respond with exactly one word: ok',
      user: 'ping',
      maxTokens: 10,
      temperature: 0,
    });
    return {
      status: 200,
      body: {
        ok: true,
        provider: 'ollama',
        host: config.ollama.host,
        model: r.model,
        sample: r.text.slice(0, 60),
        tokens: r.tokens,
        available_models: ping.available_models,
      },
    };
  } catch (err) {
    return { status: 502, body: { ok: false, error: err.message } };
  }
}

router.post('/test/anthropic', async (_req, res) => {
  const r = await testAnthropic();
  res.status(r.status).json(r.body);
});

router.post('/test/ollama', async (_req, res) => {
  const r = await testOllama();
  res.status(r.status).json(r.body);
});

// Tests whichever provider is currently configured via LLM_PROVIDER.
router.post('/test/llm', async (_req, res) => {
  const result = config.llm.provider === 'ollama' ? await testOllama() : await testAnthropic();
  res.status(result.status).json({ ...result.body, configured_provider: config.llm.provider });
});

module.exports = router;
