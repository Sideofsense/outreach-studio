-- Phase 3: cover letter + multiple named artifacts per campaign.
ALTER TABLE companies ADD COLUMN cover_letter_path TEXT;
ALTER TABLE companies ADD COLUMN cover_letter_text TEXT;

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_artifacts_company ON artifacts(company_id);
