'use strict';

const pino = require('pino');
const config = require('../config');

const redactPaths = [
  'ANTHROPIC_API_KEY',
  'SMTP_PASSWORD',
  'IMAP_PASSWORD',
  '*.password',
  '*.api_key',
  '*.apiKey',
  '*.apikey',
  'password',
  'api_key',
  'apiKey',
  'req.headers.authorization',
  'req.headers.cookie',
];

const baseOptions = {
  level: config.server.logLevel,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  base: { app: 'outreach-studio' },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const transport =
  config.server.nodeEnv === 'production'
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,app',
        },
      };

const logger = pino({ ...baseOptions, transport });

module.exports = logger;
