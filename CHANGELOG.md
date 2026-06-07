# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-27

First public alpha. Complete upload → draft → review → send → log → reply-detect loop, single-user, local-only.

### Added

#### Core workflow
- Per-company upload of contacts (CSV / XLSX / XLS) with smart column-name detection, name splitting, email validation, dedup
- Per-company CV and artifact PDF upload (path-traversal guarded)
- Seniority classification (CXO / VP / Head / Staff / Senior / Technical / APM / PM / other)
- Anthropic Claude personalization engine with quality checks (banned words, length caps per bucket, emoji / exclamation / unsubstituted-variable / name-missing detection)
- Three seniority-aware email templates (peer / senior / executive) seeded from `.md` files into a versioned DB table, editable via the settings page
- Auto-appended compliance footer (`Reply STOP and I won't reach out again.`) on every draft body

#### Sending
- Nodemailer + Gmail SMTP with pooled transport, attachment path guard, smart error classification (auth vs bounce vs transient)
- Throttle service with all 6 rules: timezone-aware working hours, global cooldown, per-domain/hour, daily cap, per-contact lifetime cap (3), suppression check
- DB-backed runtime throttle config (Settings UI changes take effect without restart)
- Send queue with per-campaign pause/resume + global STOP ALL, orphan recovery on boot
- Server-Sent Events stream at `/api/events/sends` for the live `/sending/:slug` view
- Approval-gated single send + bulk campaign send

#### Reply detection
- IMAP poller (configurable interval, default 300s) with UID watermark — never re-processes history
- Reply matching by `In-Reply-To` / `References` headers against `gmail_message_id`
- STOP / UNSUBSCRIBE word-boundary detection on any inbound message → auto-suppress
- Follow-up cancellation hook (joins via template `sequence_step >= 1`)

#### UI
- Pages: home dashboard, companies list, company detail (Files / Contacts / Drafts tabs), sending live view, log with filters + CSV export, settings
- Vanilla JS + HTMX + Tailwind via CDN — **no build step**
- Dark mode by default; light-mode toggle persisted in localStorage
- Keyboard shortcuts on Drafts tab: `j/k` (nav), `a` (approve), `e` (edit), `r` (regenerate), `s` (skip), `Cmd/Ctrl+Enter` (send campaign), `?` (help)
- Cost-tracking tile (Anthropic tokens × pricing) on home page, lifetime totals

#### Security / observability
- Same-origin CSRF guard on all writes
- In-memory rate limit (100 req/min) on the `/api` namespace
- Pino structured logs with secret redaction (`ANTHROPIC_API_KEY`, `SMTP_PASSWORD`, `IMAP_PASSWORD`, any `*.password` / `*.api_key`)
- Correlation IDs on every request
- `audit_log` table with the full spec event vocabulary (`campaign_*`, `contacts_*`, `cv_*`, `artifact_*`, `draft_*`, `email_*`, `reply_detected`, `unsubscribe_received`, `suppression_added`, plus `settings_*` events)
- `/health` endpoint reporting db / anthropic / smtp / imap status with placeholder-credential detection
- Live test buttons on Settings page for SMTP, IMAP, and Anthropic

### Testing

- 119 Vitest unit tests covering: file parser (CSV + XLSX, weird headers, edge cases, dedup), seniority classifier (41 title variants), personalization engine (quality checks, JSON extractor, bucket mapping, footer), throttle (all 6 rules), suppressions (STOP detection, normalization), IMAP (header parsing, message matching, follow-up cancellation, UID watermark)
- `npm test` completes in <600 ms

### Known limitations / planned for later

- **No follow-up scheduler in v0.1** — the cancel-pending-follow-ups hook is in place, but the 7-day / 14-day scheduler that *creates* follow-up drafts is deferred to v0.2 (Doc 01 §G2)
- Gmail-only SMTP / IMAP — Outlook + custom SMTP planned for v0.3 (Doc 01 §4.3)
- Manual contact upload only — Apollo / Hunter integrations planned for v0.2
- Anthropic-only LLM — provider abstraction is in place; OpenAI / Gemini / Ollama planned for v0.2
