CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  custom_context TEXT,
  cv_path TEXT,
  artifact_path TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  title TEXT,
  seniority TEXT,
  email TEXT NOT NULL,
  linkedin_url TEXT,
  source_file TEXT,
  selected INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, email)
);
CREATE INDEX idx_contacts_company ON contacts(company_id);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  seniority TEXT,
  sequence_step INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES templates(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  attachments_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  llm_input_tokens INTEGER,
  llm_output_tokens INTEGER,
  quality_warnings_json TEXT,
  generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME,
  sent_at DATETIME,
  error_message TEXT
);
CREATE INDEX idx_drafts_company ON drafts(company_id);
CREATE INDEX idx_drafts_status ON drafts(status);

CREATE TABLE sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  gmail_message_id TEXT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  sequence_step INTEGER NOT NULL DEFAULT 0,
  replied INTEGER NOT NULL DEFAULT 0,
  replied_at DATETIME,
  bounced INTEGER NOT NULL DEFAULT 0,
  bounce_reason TEXT
);
CREATE INDEX idx_sends_sent_at ON sends(sent_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
