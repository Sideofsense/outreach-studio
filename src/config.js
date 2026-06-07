'use strict';

// .env is the source of truth for local desktop config — override stale shell vars
// so a user with e.g. ANTHROPIC_API_KEY="" in their shell doesn't silently break the app.
require('dotenv').config({ override: true });
const { z } = require('zod');

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // LLM provider — 'anthropic' (paid, Sonnet) or 'ollama' (free, local)
  LLM_PROVIDER: z.enum(['anthropic', 'ollama']).default('anthropic'),

  // Anthropic (required only when LLM_PROVIDER=anthropic — checked at use time)
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-5'),

  // Ollama (used when LLM_PROVIDER=ollama)
  OLLAMA_HOST: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('llama3.1:8b'),

  // SMTP
  SMTP_HOST: z.string().min(1, 'SMTP_HOST is required'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().min(1, 'SMTP_USER is required'),
  SMTP_PASSWORD: z.string().min(1, 'SMTP_PASSWORD is required'),
  SMTP_FROM_NAME: z.string().min(1).default('Outreach Studio'),

  // IMAP
  IMAP_HOST: z.string().min(1, 'IMAP_HOST is required'),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_USER: z.string().min(1, 'IMAP_USER is required'),
  IMAP_PASSWORD: z.string().min(1, 'IMAP_PASSWORD is required'),
  IMAP_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),

  // Throttle
  THROTTLE_GLOBAL_SECONDS: z.coerce.number().int().nonnegative().default(90),
  THROTTLE_PER_DOMAIN_PER_HOUR: z.coerce.number().int().positive().default(2),
  THROTTLE_DAILY_CAP: z.coerce.number().int().positive().default(100),
  THROTTLE_WORKING_HOURS_START: z.coerce.number().int().min(0).max(23).default(9),
  THROTTLE_WORKING_HOURS_END: z.coerce.number().int().min(1).max(24).default(18),
  THROTTLE_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nConfig validation failed:\n${issues}\n\nCheck your .env file (see .env.example).\n`);
  process.exit(1);
}

const env = parsed.data;

const config = {
  env,

  server: {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    origin: `http://localhost:${env.PORT}`,
  },

  llm: {
    provider: env.LLM_PROVIDER,
  },

  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL,
  },

  ollama: {
    host: env.OLLAMA_HOST,
    model: env.OLLAMA_MODEL,
  },

  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    fromName: env.SMTP_FROM_NAME,
  },

  imap: {
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    user: env.IMAP_USER,
    password: env.IMAP_PASSWORD,
    pollIntervalSeconds: env.IMAP_POLL_INTERVAL_SECONDS,
  },

  throttle: {
    globalSeconds: env.THROTTLE_GLOBAL_SECONDS,
    perDomainPerHour: env.THROTTLE_PER_DOMAIN_PER_HOUR,
    dailyCap: env.THROTTLE_DAILY_CAP,
    workingHoursStart: env.THROTTLE_WORKING_HOURS_START,
    workingHoursEnd: env.THROTTLE_WORKING_HOURS_END,
    timezone: env.THROTTLE_TIMEZONE,
  },

  paths: {
    dataDir: 'data',
    dbFile: 'data/outreach.db',
    uploadsDir: 'data/uploads',
    cvsDir: 'data/uploads/cvs',
    artifactsDir: 'data/uploads/artifacts',
    contactsDir: 'data/uploads/contacts',
    logsDir: 'data/logs',
    userProfile: 'data/user-profile.json',
    migrationsDir: 'migrations',
    publicDir: 'public',
    templatesDir: 'src/templates',
  },
};

module.exports = config;
