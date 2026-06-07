'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');
const logger = require('./utils/logger');

function ensureDataDirs() {
  const dirs = [
    config.paths.dataDir,
    config.paths.uploadsDir,
    config.paths.cvsDir,
    config.paths.artifactsDir,
    config.paths.contactsDir,
    config.paths.logsDir,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function openDatabase() {
  ensureDataDirs();
  const db = new Database(config.paths.dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function runMigrations(db) {
  ensureMigrationsTable(db);

  const dir = config.paths.migrationsDir;
  if (!fs.existsSync(dir)) {
    logger.warn({ dir }, 'migrations directory missing — skipping');
    return { applied: [], skipped: [] };
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = [];
  const skipped = [];

  const isApplied = db.prepare('SELECT 1 FROM _migrations WHERE filename = ?');
  const recordApplied = db.prepare('INSERT INTO _migrations (filename) VALUES (?)');

  for (const file of files) {
    if (isApplied.get(file)) {
      skipped.push(file);
      logger.debug({ file }, 'migration already applied');
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      recordApplied.run(file);
    });
    tx();
    applied.push(file);
    logger.info({ file }, 'migration applied');
  }

  return { applied, skipped };
}

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = openDatabase();
    runMigrations(dbInstance);
  }
  return dbInstance;
}

function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

module.exports = {
  getDb,
  closeDb,
  runMigrations,
  openDatabase,
};
