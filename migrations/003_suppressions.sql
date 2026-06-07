CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  reason TEXT NOT NULL,
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);
CREATE INDEX idx_suppressions_email ON suppressions(email);
