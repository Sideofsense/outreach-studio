-- Phase 1: setup-once CV text + detailed summary. Single-row profile_extras table.
CREATE TABLE profile_extras (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cv_path TEXT,
  cv_text TEXT,
  cv_uploaded_at DATETIME,
  detailed_summary TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO profile_extras (id) VALUES (1);
