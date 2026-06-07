# Outreach Studio — Build Specification

You are Claude Code running in a local terminal inside an empty directory. Your job is to build Outreach Studio — a local, AI-assisted outreach automation tool — following this specification exactly.

Read this entire document before writing any code. Then build in 12 milestones. At each milestone, complete the work, run the verification, and ASK ME for confirmation before proceeding. Do not skip ahead.

## What we are building

A local desktop tool that:

1. Accepts uploaded files per company: company-info Excel/CSV, contacts Excel/CSV, CV PDF, artifact PDF
2. Smart-parses contacts files (handles varied column names)
3. Uses Anthropic Claude API to draft personalized emails per contact
4. Presents drafts in a review dashboard for the user to approve/edit
5. Sends through user's Gmail (App Password + SMTP) one by one with throttling
6. Tracks all outreach in local SQLite with a timeline dashboard
7. Detects replies via Gmail IMAP and pauses follow-ups
8. Auto-handles compliance (STOP detection, suppression list, opt-out footer)

## Non-goals (do not build these in v1)

- Contact fetching from Apollo / Hunter / Lusha (manual upload only)
- CV generation (user uploads PDF)
- Artifact generation (user uploads PDF)
- Multi-user / teams
- Cloud hosting
- LinkedIn scraping
- React or any build-step frontend

## Tech stack (locked)

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Web framework | Express 4 |
| Database | better-sqlite3 |
| Frontend | Vanilla JS + HTMX 2 + Tailwind CDN (NO build step) |
| LLM | Anthropic SDK (@anthropic-ai/sdk), model: claude-sonnet-4-5 |
| Email send | Nodemailer + Gmail SMTP |
| Email receive | node-imap + mailparser |
| File upload parsing | papaparse (CSV), xlsx (Excel) |
| PDF reading | pdf-parse |
| Logging | Pino with secrets redaction |
| Validation | Zod |
| Testing | Vitest |
| Env | dotenv |

Do not substitute these. Do not add a React build step.

## Folder structure (create exactly this)

```
outreach-studio/
├── README.md
├── LICENSE                                  # MIT
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
├── CLAUDE.md                                # This spec, saved into the repo
├── .env.example
├── .gitignore
├── .editorconfig
├── package.json
├── package-lock.json
├── vitest.config.js
│
├── migrations/
│   ├── 001_initial_schema.sql
│   ├── 002_audit_log.sql
│   └── 003_suppressions.sql
│
├── src/
│   ├── server.js
│   ├── config.js
│   ├── db.js
│   │
│   ├── routes/
│   │   ├── index.js
│   │   ├── health.js
│   │   ├── companies.js
│   │   ├── uploads.js
│   │   ├── contacts.js
│   │   ├── drafts.js
│   │   ├── send.js
│   │   ├── log.js
│   │   ├── settings.js
│   │   └── events.js
│   │
│   ├── services/
│   │   ├── file-parser.js
│   │   ├── llm/
│   │   │   ├── index.js
│   │   │   └── anthropic.js
│   │   ├── email/
│   │   │   ├── smtp.js
│   │   │   └── imap.js
│   │   ├── personalization-engine.js
│   │   ├── seniority-classifier.js
│   │   ├── throttle.js
│   │   ├── send-queue.js
│   │   ├── scheduler.js
│   │   └── suppressions.js
│   │
│   ├── templates/
│   │   ├── system-prompt.md
│   │   ├── peer-email.md
│   │   ├── senior-email.md
│   │   ├── executive-email.md
│   │   └── follow-up.md
│   │
│   └── utils/
│       ├── logger.js
│       ├── slug.js
│       ├── errors.js
│       └── audit.js
│
├── public/
│   ├── index.html
│   ├── companies.html
│   ├── campaign.html
│   ├── log.html
│   ├── settings.html
│   ├── styles.css
│   ├── app.js
│   └── assets/logo.svg
│
├── tests/
│   ├── file-parser.test.js
│   ├── seniority-classifier.test.js
│   ├── personalization-engine.test.js
│   ├── throttle.test.js
│   └── suppressions.test.js
│
└── data/                                    # gitignored
    ├── outreach.db
    ├── user-profile.json
    ├── uploads/
    │   ├── cvs/
    │   ├── artifacts/
    │   └── contacts/
    └── logs/
```

## Database schema (these migrations are immutable once shipped)

### migrations/001_initial_schema.sql

```sql
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
```

### migrations/002_audit_log.sql

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  metadata_json TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_event_type ON audit_log(event_type);
CREATE INDEX idx_audit_created_at ON audit_log(created_at);
```

### migrations/003_suppressions.sql

```sql
CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  reason TEXT NOT NULL,
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);
CREATE INDEX idx_suppressions_email ON suppressions(email);
```

## .env.example

```env
# === Server ===
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# === Anthropic ===
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-5

# === Gmail SMTP (sending) ===
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=your_16_char_app_password
SMTP_FROM_NAME=Your Name

# === Gmail IMAP (reply detection) ===
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=you@gmail.com
IMAP_PASSWORD=your_16_char_app_password
IMAP_POLL_INTERVAL_SECONDS=300

# === Throttle ===
THROTTLE_GLOBAL_SECONDS=90
THROTTLE_PER_DOMAIN_PER_HOUR=2
THROTTLE_DAILY_CAP=100
THROTTLE_WORKING_HOURS_START=09
THROTTLE_WORKING_HOURS_END=18
THROTTLE_TIMEZONE=Asia/Kolkata
```

## User profile schema

The user drops `user-profile.json` into `/data/` during setup. Schema:

```json
{
  "name": "Your Full Name",
  "first_name": "Your",
  "current_role": "Your current job title",
  "current_company": "Your current company",
  "location": "Your city, country",
  "summary": "2-3 sentences positioning yourself. What you do, what makes you distinctive. The LLM uses this to write authentically.",
  "key_achievements": [
    "Specific, concrete achievement 1 (with a number if possible)",
    "Specific, concrete achievement 2",
    "Specific, concrete achievement 3",
    "Specific, concrete achievement 4"
  ],
  "links": {
    "linkedin": "linkedin.com/in/your-handle",
    "email": "you@email.com"
  }
}
```

Provide a `user-profile.example.json` with placeholder values.

## File parsing requirements (critical for v1)

The file parser must be smart about column-name variants. When user uploads a contacts file, normalize headers to canonical fields.

### Canonical fields and synonyms

| Canonical | Acceptable variants (case-insensitive) |
|---|---|
| full_name | "name", "full name", "fullname", "contact name", "person", "candidate name" |
| first_name | "first name", "firstname", "given name", "first" |
| last_name | "last name", "lastname", "surname", "family name", "last" |
| title | "title", "designation", "role", "job title", "position", "current title" |
| email | "email", "e-mail", "email address", "email id", "emailid", "work email" |
| linkedin_url | "linkedin", "linkedin url", "linkedin profile", "linkedin link", "li url", "profile url" |

Logic:

- If `full_name` is present but `first_name`/`last_name` are not, split `full_name` on first space
- If `first_name` + `last_name` are present but `full_name` is not, concatenate
- `email` is required; rows without valid email are flagged and shown to user before commit
- Accept `.csv`, `.xlsx`, `.xls`
- Strip whitespace, lowercase emails for dedup

After parsing, show user a preview: "Detected X rows. Y rows have valid email. Z rows have issues." User confirms before commit to DB.

## Seniority classification

`src/services/seniority-classifier.js` takes a title string and returns a seniority bucket. Use case-insensitive substring matching with order-based precedence (check most specific first).

```js
function classifySeniority(title) {
  if (!title) return 'other';
  const t = title.toLowerCase();

  // CXOs first (most specific)
  if (/\b(ceo|chief executive|founder|co-?founder)\b/.test(t)) return 'cxo';
  if (/\b(cto|coo|chro|cmo|cfo|cpo|chief)\b/.test(t)) return 'cxo';

  // VPs
  if (/\bvp\b|vice president/.test(t)) return 'vp';

  // Heads / Directors
  if (/head of|director of|director,|director\b/.test(t)) return 'head';

  // Staff / Principal / Lead / Group
  if (/staff (product|pm)|principal (product|pm)|lead pm|lead product|group product|gpm/.test(t)) return 'staff_pm';

  // Senior PM
  if (/(senior|sr\.?)\s*(product|pm)/.test(t)) return 'sr_pm';

  // Technical PM
  if (/technical product|tpm/.test(t)) return 'sr_pm';  // TPM treated as senior peer

  // APM
  if (/associate product|apm|assistant product/.test(t)) return 'apm';

  // PM (catch-all for product manager)
  if (/product manager|\bpm\b/.test(t)) return 'pm';

  return 'other';
}
```

Write Vitest unit tests covering at least 30 title variants including edge cases.

## Personalization engine

`src/services/personalization-engine.js` is the heart of the product.

### Input

```js
{
  user_profile: { /* from user-profile.json */ },
  contact: { full_name, first_name, title, seniority, linkedin_url, company },
  company: { name, custom_context },
  template: { seniority_bucket, subject_template, body_template, sequence_step }
}
```

### Process

1. Load `src/templates/system-prompt.md`
2. Build user message with the input above
3. Call Anthropic API: `claude-sonnet-4-5`, max_tokens 600, temperature 0.7
4. Expect JSON response: `{ "subject": "...", "body": "..." }`
5. Run quality checks on output
6. Auto-append compliance footer to body
7. Return `{ subject, body, quality_warnings: [], tokens: { input, output } }`

### System prompt (`src/templates/system-prompt.md`)

```
You are an expert at writing personalized cold outreach emails for professional networking. Your job: take the user's profile, the recipient's details, and the company context, and write ONE specific, non-generic email that the recipient would actually want to reply to.

Hard rules — violations make the email worse:
1. NEVER use the words: synergy, leverage, innovative, cutting-edge, rockstar, ninja, passionate, game-changer, disrupting, revolutionary
2. NEVER write more than 130 words in the body (peer template), 150 (senior), 100 (executive)
3. NEVER use exclamation marks or emojis
4. NEVER pitch yourself broadly. Reference ONE specific thing about the recipient or their company
5. The opening line must reference something specific about THEM, not about yourself
6. The ask must be small and clear: a 15-minute conversation, a specific question, or a piece of feedback
7. End with the user's first name only
8. Do not include the compliance footer — it is added automatically

Output JSON only, no preamble:
{ "subject": "...", "body": "..." }
```

### Quality checks (in same file)

```js
function runQualityChecks(draft, contact, company) {
  const warnings = [];
  const banned = ['synergy', 'leverage', 'innovative', 'cutting-edge', 'rockstar', 'ninja', 'passionate', 'game-changer', 'disrupting', 'revolutionary'];
  const bodyLower = draft.body.toLowerCase();

  for (const word of banned) {
    if (bodyLower.includes(word)) warnings.push(`banned_word:${word}`);
  }
  if (draft.body.includes('!')) warnings.push('exclamation_mark');
  if (/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]/u.test(draft.body)) warnings.push('emoji_detected');
  if (draft.subject.length > 60) warnings.push('subject_too_long');

  const wordCount = draft.body.split(/\s+/).filter(Boolean).length;
  if (wordCount > 150) warnings.push(`too_long:${wordCount}`);

  if (/\{[a-z_]+\}/i.test(draft.body) || /\{[a-z_]+\}/i.test(draft.subject)) {
    warnings.push('unsubstituted_variable');
  }
  if (company.name && !draft.body.includes(company.name) && !draft.subject.includes(company.name)) {
    warnings.push('company_name_missing');
  }
  if (contact.first_name && !draft.body.includes(contact.first_name)) {
    warnings.push('first_name_missing');
  }

  return warnings;
}
```

If `quality_warnings` is non-empty, draft is still saved (`status='draft'`) but warnings are surfaced in UI. User can click "Regenerate" to try again.

## Email templates

`src/templates/peer-email.md`, `senior-email.md`, `executive-email.md`.

### peer-email.md

```
Subject: {one_specific_topic} — quick note from {user_company}

Hi {first_name},

{one_specific_thing_about_their_work_or_company}.

I'm {user_short_intro}. {one_concrete_achievement_relevant_to_them}.

{specific_question_or_ask}. Open to a 15-min chat if useful?

— {user_first_name}
```

### senior-email.md

```
Subject: {company} {role_area} — interest from {user_role}

Hi {first_name},

{one_specific_observation_about_their_team_or_work}.

I'm {user_short_intro} — {one_concrete_outcome_metric}.

Looking at {company} as my next chapter given {their_strategic_bet}. Attached: brief memo with my read on {their_product_area}.

Open to a 20-min conversation about where the team is going?

— {user_first_name}
```

### executive-email.md

```
Subject: {user_role} → {company}?

{first_name}, brief and direct.

{user_short_intro}. {one_outcome_metric}.

Interested in {company} because of {their_strategic_bet}. If a senior {role_type} role is in the works, I'd value 15 min.

Attached: CV + 1-page memo on {their_product_area}.

— {user_first_name}
```

The LLM fills the `{variables}` based on input context. Do not literally substitute these as code — pass the template text to the LLM and let it intelligently fill.

## Throttle service

`src/services/throttle.js`. Rules enforced before every send.

```js
async function canSendNow(recipient_email) {
  const now = new Date();

  // 1. Working hours
  const hour = now.getHours();  // in configured timezone
  if (hour < config.WORKING_HOURS_START || hour >= config.WORKING_HOURS_END) {
    return { allowed: false, reason: 'outside_working_hours', retry_at: nextWorkingHourStart() };
  }

  // 2. Global throttle
  const last_send = db.prepare('SELECT sent_at FROM sends ORDER BY sent_at DESC LIMIT 1').get();
  if (last_send) {
    const seconds_since = (now - new Date(last_send.sent_at)) / 1000;
    if (seconds_since < config.GLOBAL_SECONDS) {
      return { allowed: false, reason: 'global_throttle', retry_at: new Date(now.getTime() + (config.GLOBAL_SECONDS - seconds_since) * 1000) };
    }
  }

  // 3. Per-domain throttle
  const domain = recipient_email.split('@')[1];
  const last_hour = new Date(now.getTime() - 3600_000);
  const domain_count = db.prepare("SELECT COUNT(*) as c FROM sends WHERE sent_at > ? AND recipient LIKE ?")
    .get(last_hour.toISOString(), `%@${domain}`).c;
  if (domain_count >= config.PER_DOMAIN_PER_HOUR) {
    return { allowed: false, reason: 'per_domain_throttle' };
  }

  // 4. Daily cap
  const today_start = new Date(now.toDateString());
  const today_count = db.prepare("SELECT COUNT(*) as c FROM sends WHERE sent_at > ?")
    .get(today_start.toISOString()).c;
  if (today_count >= config.DAILY_CAP) {
    return { allowed: false, reason: 'daily_cap' };
  }

  // 5. Per-contact cap (max 3 sends per contact ever)
  const contact_count = db.prepare("SELECT COUNT(*) as c FROM sends WHERE recipient = ?")
    .get(recipient_email).c;
  if (contact_count >= 3) {
    return { allowed: false, reason: 'per_contact_cap' };
  }

  // 6. Suppressions
  const suppressed = db.prepare("SELECT 1 FROM suppressions WHERE email = ?").get(recipient_email);
  if (suppressed) {
    return { allowed: false, reason: 'suppressed' };
  }

  return { allowed: true };
}
```

Write unit tests for each rule.

## Dashboard UI requirements

Vanilla JS + HTMX + Tailwind via CDN. No build step. Dark mode by default.

### Color palette (Tailwind utilities)

```
Background: slate-950 (dark) / slate-50 (light)
Surface:    slate-900 / white
Border:     slate-800 / slate-200
Text:       slate-100 / slate-900
Muted:      slate-400 / slate-600
Accent:     emerald-500 (success, approve, send)
Warning:    amber-500
Danger:     rose-500 (stop, errors)
Brand:      indigo-400 / indigo-600
```

### Pages

1. **/** — Home. KPI tiles, recent activity, paused campaigns, STOP ALL button.
2. **/companies** — Table of all companies with status, contact counts, send counts.
3. **/companies/:slug** — Company detail. Three tabs: Files / Contacts / Drafts.
4. **/companies/:slug/campaign** — Drafts review. Two columns: list + editor.
5. **/sending/:campaign_id** — Live send view with SSE updates.
6. **/log** — Outreach log, searchable + exportable.
7. **/settings** — All configuration.

### Keyboard shortcuts (on drafts review page)

- `j` / `k`: next / prev draft
- `a`: approve current
- `e`: edit subject/body inline
- `r`: regenerate
- `s`: skip
- `Cmd/Ctrl+Enter`: send all approved
- `?`: show shortcuts help

### Real-time progress (live send view)

Use Server-Sent Events. Endpoint: `GET /events/sends`. Streams JSON events:

- `{ type: 'send_started', draft_id, recipient }`
- `{ type: 'send_success', draft_id, sent_at }`
- `{ type: 'send_failed', draft_id, error }`
- `{ type: 'next_in', seconds }`

Frontend listens and updates UI live.

## Compliance auto-append

After LLM generates body, before saving the draft, append this footer to the body:

```
---
Reply STOP and I won't reach out again.
```

This is non-optional. There is no UI toggle to disable it. The footer is appended in `personalization-engine.js` after quality checks pass.

## STOP detection in IMAP

`src/services/email/imap.js`. Polls every 5 minutes. For each new email:

1. Check if it's a reply to a tracked send (match by `In-Reply-To` header or `References` header against `gmail_message_id`)
2. If matched: `UPDATE sends SET replied=1, replied_at=NOW() WHERE id = ?`
3. If matched and follow-ups are pending for this contact: cancel them
4. Scan body and subject for "STOP" or "UNSUBSCRIBE" (case-insensitive, word boundary): if found, `INSERT INTO suppressions`
5. Write to `audit_log`

## Tests required

Vitest. Run with `npm test`. Must complete in <5 seconds.

Required test files:

- `tests/file-parser.test.js` — column-name variants, edge cases, malformed files
- `tests/seniority-classifier.test.js` — 30+ title variants
- `tests/personalization-engine.test.js` — quality checks (mock LLM call)
- `tests/throttle.test.js` — each throttle rule
- `tests/suppressions.test.js` — STOP detection, dedup

## SECURITY — non-negotiable

1. All API keys in `.env`. `.env` in `.gitignore`.
2. Pino logger redacts: `ANTHROPIC_API_KEY`, `SMTP_PASSWORD`, `IMAP_PASSWORD`, any field named "password" or "api_key"
3. All SQL via better-sqlite3 prepared statements. No string concatenation.
4. HTML escaping in template helper for any user-provided text rendered in pages
5. CSRF protection: reject POST requests whose `Origin` header is not `http://localhost:PORT`
6. Path traversal prevention: validate uploaded file paths stay within `/data/uploads`
7. Rate limit local API at 100 req/min (prevent accidental loops)
8. Never log full email bodies (truncate to 100 chars in logs)
9. Never log full contact lists (log counts only)
10. SECURITY.md file with disclosure policy

## OBSERVABILITY

1. Pino structured logs (JSON)
2. Correlation ID on every request
3. Audit log in DB for every business event
4. Health endpoint `/health` returns `{ db, anthropic, smtp, imap }` status
5. Cost counter: Anthropic input/output tokens per draft, summed per campaign in dashboard

## BUILD MILESTONES — execute these in order, asking for confirmation at each

### Milestone 1 — Scaffold

Create the full folder structure. Create:

- `package.json` with all dependencies listed
- `.gitignore` (`node_modules`, `.env`, `data/`, `*.log`, `.DS_Store`)
- `.env.example`
- `.editorconfig` (2-space, LF, UTF-8)
- `LICENSE` (MIT, ask me for copyright holder name)
- `README.md` (placeholder, will be filled in M12)
- `CONTRIBUTING.md`
- `SECURITY.md`
- `CHANGELOG.md` (Keep-a-Changelog format)
- `CLAUDE.md` (save this prompt into the repo)
- `vitest.config.js`

**Verify:** I run `npm install` — zero errors. `ls -la` shows everything.

Ask: "Milestone 1 done. Proceed to 2?"

### Milestone 2 — DB + config + minimal server

- All three migration SQL files
- `src/db.js` (connects, runs migrations in order)
- `src/config.js` (loads `.env`, validates via Zod, fails fast on missing keys)
- `src/utils/logger.js` (Pino with secrets redaction)
- `src/server.js` (Express, serves `/public`, mounts `/health`)
- `src/routes/health.js`
- `public/index.html` ("Outreach Studio is running. Configure in settings.")

**Verify:** `cp .env.example .env` (fill dummy values), `npm start`. Server starts on 3000. Migration logs visible. `/health` returns JSON.

Ask for confirmation.

### Milestone 3 — Companies CRUD + dashboard skeleton

- `src/routes/companies.js` (GET/POST/PUT/DELETE)
- `public/companies.html` — table view + "New campaign" button + add-company modal
- `public/app.js` with HTMX integration
- `public/styles.css` with Tailwind dark-mode setup

**Verify:** Add a company in UI. Refresh. Company persists. Delete it. Persists.

### Milestone 4 — File upload + smart parser

- `src/services/file-parser.js` (papaparse + xlsx, smart column detection)
- `src/services/seniority-classifier.js`
- `src/routes/uploads.js` (POST `/uploads/contacts`, POST `/uploads/cv`, POST `/uploads/artifact`)
- UI: company detail page — three upload zones (contacts, CV, artifact)
- After contact upload: preview table showing parsed data + warnings

**Verify:** Upload a `contacts.xlsx` with weird headers ("Name", "Email Id", "Job Title"). Tool detects columns correctly. Preview shows X valid contacts.

Run `tests/file-parser.test.js` — pass.

### Milestone 5 — LLM service + system prompt

- `src/services/llm/anthropic.js` (wraps SDK)
- `src/services/llm/index.js` (factory)
- All template files in `src/templates/`
- `src/services/personalization-engine.js`
- Standalone test: call `generateDraft()` for ONE contact, print result to console

**Verify:** A real personalized email comes back, with the contact's name and company referenced specifically.

### Milestone 6 — Draft generation in UI

- `src/routes/drafts.js` (POST `/drafts/generate` for one contact, POST `/drafts/generate-batch` for company)
- UI: company detail page — Drafts tab — "Generate all drafts" button — drafts appear in review grid
- Draft editor: subject + body editable, attachments visible, approve/regenerate/skip buttons
- Quality warnings displayed as amber chips on each draft

**Verify:** Generate drafts for 5 contacts of one company. Review each. Approve 3. Edit 1. Skip 1.

### Milestone 7 — SMTP send

- `src/services/email/smtp.js` (Nodemailer)
- `src/services/throttle.js` (all rules)
- `src/services/suppressions.js` (check before send)
- `src/routes/send.js` (POST `/send/draft/:id` sends one)
- UI: "Send" button on approved drafts
- Audit log entry on every send

**Verify:** Send ONE test email to your own email address. Arrives in inbox (check spam folder). Audit log row created. `sends` table has row.

### Milestone 8 — Send queue + SSE live progress

- `src/services/send-queue.js` (background loop, picks queued drafts, sends respecting throttle, updates DB)
- `src/routes/events.js` (Server-Sent Events at `/events/sends`)
- UI: `/sending/:campaign_id` page — live counters, log feed, pause button, STOP ALL button
- Send queue resumes on server restart (read queued drafts from DB)

**Verify:** Approve 3 drafts. Click Send Campaign. Live progress shows. 3 emails arrive at ~90 sec intervals.

### Milestone 9 — IMAP reply detection

- `src/services/email/imap.js` (polls every 5 min)
- Reply matching via `In-Reply-To` / `References` headers
- STOP detection
- UI: drafts list shows "REPLIED" badge when detected
- Audit log entries

**Verify:** Reply to your test email from another address. Within 5 min, dashboard shows reply detected.

### Milestone 10 — Outreach log + search

- `src/routes/log.js`
- `/log` page: searchable table, filters (company / status / date / contains text)
- CSV export endpoint
- Pagination

**Verify:** `/log` shows your sends. Filter by company. Export to CSV.

### Milestone 11 — Settings page

- `/settings` page with all config: API keys (set/unset status), email config (with test buttons), throttle config, user profile editor, template editor, theme toggle
- POST endpoints for each
- Test SMTP button actually attempts a connection
- Test IMAP button actually attempts a connection

**Verify:** Change throttle to 60 sec. Send campaign. Verify 60-sec spacing. Change back.

### Milestone 12 — Tests, polish, README, final

- Complete all unit tests in `/tests/`. `npm test` passes in <5 sec.
- Fill out `README.md` with the content I will provide separately
- Add CHANGELOG entry for v0.1.0
- Add keyboard shortcuts to drafts page
- Add cost-tracking display (Anthropic tokens × pricing)
- Final pass: any TODO comments? Any `console.log` left? Any missing error handling? Fix.
- Run through full happy path: add company → upload files → generate drafts → review → send → see in log

**Verify:** I can run the full flow end to end without errors. `npm test` passes. README is complete.

## START HERE

You have read this entire spec. Now begin Milestone 1.

1. Create the folder structure
2. Create all the scaffold files listed in Milestone 1
3. When done, tell me exactly what to run to verify
4. Wait for my confirmation before proceeding to Milestone 2

Do not skip ahead. Do not build everything at once. Confirm at each milestone.

If anything in this spec is unclear, ASK ME before guessing.

Go.
