'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const config = require('./config');
const logger = require('./utils/logger');
const { getDb, closeDb } = require('./db');
const healthRoutes = require('./routes/health');
const companiesRoutes = require('./routes/companies');
const uploadsRoutes = require('./routes/uploads');
const contactsRoutes = require('./routes/contacts');
const draftsRoutes = require('./routes/drafts');
const { router: sendRoutes } = require('./routes/send');
const eventsRoutes = require('./routes/events');
const logRoutes = require('./routes/log');
const settingsRoutes = require('./routes/settings');
const indexRoutes = require('./routes/index');
const setupRoutes = require('./routes/setup');
const artifactsRoutes = require('./routes/artifacts');
const { seedTemplates } = require('./services/templates');
const sendQueue = require('./services/send-queue');
const imap = require('./services/email/imap');

function correlationId(req, res, next) {
  const id = req.headers['x-correlation-id'] || crypto.randomUUID();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  req.log = logger.child({ correlationId: id });
  next();
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    req.log.info(
      {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
      },
      'request'
    );
  });
  next();
}

function originGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const origin = req.headers.origin;
  if (!origin) {
    // Same-origin form posts and curl without -H Origin land here. Block by default —
    // browsers always send Origin on cross-origin writes, and our UI is same-origin.
    return res.status(403).json({
      error: { code: 'CSRF_BLOCKED', message: 'missing Origin header' },
    });
  }
  if (origin !== config.server.origin) {
    return res.status(403).json({
      error: { code: 'CSRF_BLOCKED', message: `origin ${origin} not allowed` },
    });
  }
  return next();
}

// Simple in-memory rate limiter — spec security req: 100 req/min for the local API.
// Single-process, sliding window, no external dep. Sized for accidental loops, not adversaries.
function makeRateLimiter({ windowMs = 60_000, max = 100 } = {}) {
  const buckets = new Map(); // key -> [timestamps]
  return function rateLimit(req, res, next) {
    const key = req.ip || 'local';
    const now = Date.now();
    const cutoff = now - windowMs;
    let arr = buckets.get(key) || [];
    arr = arr.filter((t) => t > cutoff);
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res
        .status(429)
        .json({ error: { code: 'RATE_LIMITED', message: `>${max} requests/min from ${key}` } });
    }
    arr.push(now);
    buckets.set(key, arr);
    return next();
  };
}
const apiRateLimit = makeRateLimiter({ windowMs: 60_000, max: 100 });

function errorHandler(err, req, res, _next) {
  const log = req.log || logger;
  log.error({ err }, 'unhandled error');
  const status = err.status || 500;
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Internal server error',
      ...(err.details ? { details: err.details } : {}),
    },
  });
}

function createApp() {
  getDb();
  seedTemplates();
  sendQueue.start();
  imap.start();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(correlationId);
  app.use(requestLogger);

  // API routes are mounted under /api so URLs like /companies/:slug
  // can serve the per-company HTML page without colliding.
  app.use('/api', apiRateLimit);
  app.use('/api/companies', originGuard, companiesRoutes);
  app.use('/api/uploads', originGuard, uploadsRoutes);
  app.use('/api/contacts', originGuard, contactsRoutes);
  app.use('/api/drafts', originGuard, draftsRoutes);
  app.use('/api/send', originGuard, sendRoutes);
  // SSE: GETs only, no Origin check (no state mutation)
  app.use('/api/events', eventsRoutes);
  app.use('/api/log', logRoutes);
  app.use('/api/settings', originGuard, settingsRoutes);
  app.use('/api/setup', originGuard, setupRoutes);
  app.use('/api/artifacts', originGuard, artifactsRoutes);
  app.use('/api', indexRoutes);
  app.use('/health', healthRoutes);

  // Pretty URL for the review wizard
  app.get('/companies/:slug/review', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', config.paths.publicDir, 'review.html'));
  });
  // People list view per campaign
  app.get('/companies/:slug/people', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', config.paths.publicDir, 'people.html'));
  });
  // Individual person detail
  app.get('/companies/:slug/people/:contactId(\\d+)', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', config.paths.publicDir, 'person.html'));
  });

  app.get('/companies/:slug', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', config.paths.publicDir, 'company.html'));
  });
  app.get('/sending/:slug', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', config.paths.publicDir, 'sending.html'));
  });
  // Project-root docs accessible from the Setup page footer.
  for (const doc of ['README.md', 'CLAUDE.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE']) {
    app.get(`/${doc}`, (_req, res) => {
      res.type('text/plain; charset=utf-8');
      res.sendFile(path.join(__dirname, '..', doc));
    });
  }

  app.use(express.static(path.join(__dirname, '..', config.paths.publicDir)));

  app.use(errorHandler);

  return app;
}

function start() {
  const app = createApp();
  const server = app.listen(config.server.port, () => {
    logger.info(
      {
        port: config.server.port,
        env: config.server.nodeEnv,
        url: config.server.origin,
      },
      'outreach-studio listening'
    );
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    sendQueue.stop();
    imap.stop();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start();
}

module.exports = { createApp, start };
