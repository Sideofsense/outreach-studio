<div align="center">

# Outreach Studio

**Self-hosted, AI-assisted outreach automation for individuals running personalized professional outreach at depth, not breadth.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Features](#features) · [Quick Start](#quick-start) · [How it Works](#how-it-works) · [Architecture](#architecture)

</div>

---

## What this is

Outreach Studio is a **local desktop tool** that helps you run high-quality, personalized outreach campaigns from your own machine.

You upload four things per company — a contacts file, a CV, an artifact (memo, project doc, deck), and a company-context note. The tool uses Claude to draft a personalized email for each contact. You review every draft. You send through your own Gmail account, one email at a time, with built-in throttling. Everything is tracked in a local SQLite database with a dashboard timeline.

It is designed for people who care about reputation more than volume.

## What this is NOT

- Not a SaaS — runs locally, your data stays with you
- Not a cold-email blaster — daily caps and throttles enforced
- Not a LinkedIn scraper — you upload contacts manually
- Not multi-user — single user by design
- Not a CRM — tracks outreach, not pipeline

If you need any of those, this is the wrong tool. That is by design.

## Who it is for

- Product managers running focused job searches
- Founders approaching investors, design partners, or early hires
- Consultants building targeted client pipelines
- Researchers reaching out to potential collaborators
- Anyone who values quality of outreach over quantity

## Features

- **Upload-based workflow** — you provide contacts (Excel/CSV), CV (PDF), artifact (PDF) per company
- **Smart file parser** — handles varied column names ("Name" / "Full Name" / "Contact"; "Email" / "Email ID" / "Email Address")
- **LLM-drafted emails** — Claude generates one personalized email per contact using your profile, their role, and the company context
- **Seniority-aware templates** — different templates for peer (PM/Sr PM), senior (Head/Director/VP), and executive (CXO)
- **Quality checks** — banned-word filter, length limits, name-substitution check; flags drafts that need attention
- **Auto-attach assets** — your uploaded CV and artifact attached to every email for that campaign
- **Review dashboard** — see every draft, edit in place, approve before send
- **Gmail send** — one-by-one through your account via SMTP with App Password
- **Smart throttling** — 90 sec between sends, max 2/hour per domain, daily cap of 100, working-hours only
- **Reply detection** — IMAP polls your inbox, auto-marks replies, cancels pending follow-ups
- **STOP detection** — STOP replies auto-added to suppression list; opt-out footer on every email
- **Timeline dashboard** — see outreach activity across companies and over time
- **Dark mode** — built for long review sessions
- **Keyboard shortcuts** — j/k/a/e/s/r for power users
- **Cost tracking** — Anthropic API spend visible per campaign

## Quick Start

### Prerequisites

| Requirement | Why | Time to get |
|---|---|---|
| Node.js 20+ | Runtime | 5 min ([nodejs.org](https://nodejs.org)) |
| Anthropic API key | LLM drafting | 2 min ([console.anthropic.com](https://console.anthropic.com)) |
| Gmail App Password | Send + receive | 5 min — see [email setup](#email-setup) |

### Install

```bash
git clone https://github.com/Sideofsense/outreach-studio.git
cd outreach-studio
npm install
cp .env.example .env
# Edit .env with your keys
npm start
```

Visit `http://localhost:3000`.

### First campaign

```
1. Click "New campaign" → enter company name
2. Add a context note (e.g. "AI talent intelligence; recently launched agentic workflows")
3. Upload contacts file (Excel or CSV with name, title, email columns)
4. Upload your personalized CV (PDF)
5. Upload your artifact (PDF — could be a 1-page memo, project doc, or relevant work sample)
6. Review parsed contacts; deselect any you don't want emailed
7. Click "Generate drafts" — Claude drafts one personalized email per contact
8. Review each draft; edit, approve, or skip
9. Click "Send campaign" — watch live progress as emails go out one by one
```

For 50 contacts at 90-second throttle, sending takes ~75 minutes. Plan accordingly.

## How it Works

```
+-----------------------------------------------------------+
|                   YOUR LAPTOP                             |
|                                                           |
|   +-----------+    +-----------+    +------------------+  |
|   | Web UI    |--->| Express   |--->| Service layer    |  |
|   | localhost |    | + SQLite  |    | + queue + IMAP   |  |
|   +-----------+    +-----------+    +--------+---------+  |
+--------------------------------------------+--------------+
                                             |
                +----------------------------+---------------------+
                v                            v                     v
          Anthropic API                Gmail SMTP            Gmail IMAP
        (email drafting)            (sending emails)      (detecting replies)
```

### What happens per campaign

```
[Upload files] → [Parse + preview] → [LLM drafts] → [You review] → [Throttled send]
                                                                          |
                                                                          v
                                                                  [IMAP poll for replies]
                                                                          |
                                                                          v
                                                                  [Update dashboard]
```

The three external services this tool talks to:

1. **Anthropic** — when drafting emails (your prompts plus the responses)
2. **Gmail SMTP** — when sending emails (your account, your authority)
3. **Gmail IMAP** — when polling for replies (read-only access to your inbox)

Nothing else is sent anywhere. No telemetry. No cloud dashboard.

## Email setup

### Gmail (recommended)

1. Enable 2-Step Verification: [myaccount.google.com/security](https://myaccount.google.com/security)
2. Generate an App Password: search "App Passwords" → Generate → name it "Outreach Studio"
3. Copy the 16-character password (no spaces) → paste into `SMTP_PASSWORD` and `IMAP_PASSWORD` in `.env`
4. Set `SMTP_USER` and `IMAP_USER` to your Gmail address

### Other email providers

v1 supports Gmail only. Outlook, custom SMTP, and ProtonMail Bridge are planned for v3.

## File format requirements

### Contacts file (Excel or CSV)

Required: at least one column matching each canonical field (name and email).

| Canonical field | Acceptable column names (case-insensitive) |
|---|---|
| Name | "name", "full name", "fullname", "contact name", "candidate name" |
| Title | "title", "designation", "role", "job title", "position" |
| Email | "email", "e-mail", "email address", "email id", "work email" |
| LinkedIn | "linkedin", "linkedin url", "linkedin profile", "li url", "profile url" |

If your file has columns named differently, rename them before upload.

### CV file

Standard PDF. Will be attached to every email in the campaign.

### Artifact file

A 1-page PDF — could be a memo, project doc, deck excerpt, or work sample. Attached to every email in the campaign.

### User profile

Drop `user-profile.json` into `/data/` during setup:

```json
{
  "name": "Your Name",
  "first_name": "Your",
  "current_role": "Your Role",
  "current_company": "Your Company",
  "location": "Your City",
  "summary": "2-3 sentence positioning",
  "key_achievements": [
    "Achievement 1",
    "Achievement 2",
    "Achievement 3"
  ],
  "links": {
    "linkedin": "linkedin.com/in/your-handle",
    "email": "you@email.com"
  }
}
```

A `user-profile.example.json` is included.

## Configuration

All configuration via `.env`. See `.env.example` for the full list. Defaults are conservative:

```env
THROTTLE_GLOBAL_SECONDS=90              # 90s between any two sends
THROTTLE_PER_DOMAIN_PER_HOUR=2          # max 2 emails/hour to the same domain
THROTTLE_DAILY_CAP=100                  # max 100 sends per day
THROTTLE_WORKING_HOURS_START=09         # only send between 9am and 6pm
THROTTLE_WORKING_HOURS_END=18
THROTTLE_TIMEZONE=Asia/Kolkata          # your timezone
```

You can adjust these in `/settings` or directly in `.env`. Recommendation: do not loosen the defaults until you have sent 100+ emails and observed deliverability.

## Architecture

```
outreach-studio/
├── src/
│   ├── server.js                  # Entry point
│   ├── config.js                  # Env validation via Zod
│   ├── db.js                      # SQLite + migrations
│   ├── routes/                    # HTTP endpoints
│   ├── services/                  # Business logic
│   │   ├── file-parser.js
│   │   ├── llm/                   # Anthropic
│   │   ├── email/                 # SMTP + IMAP
│   │   ├── personalization-engine.js
│   │   ├── seniority-classifier.js
│   │   ├── throttle.js
│   │   ├── send-queue.js
│   │   └── suppressions.js
│   ├── templates/                 # Email templates (markdown)
│   └── utils/
├── migrations/                    # SQL files (immutable once shipped)
├── public/                        # Frontend (vanilla JS + HTMX + Tailwind CDN)
├── tests/                         # Vitest unit tests
└── data/                          # User data (gitignored)
    ├── outreach.db
    ├── user-profile.json
    └── uploads/
```

**No build step.** Frontend is plain HTML + JS + Tailwind via CDN. Clone, install, run.

**Provider abstractions.** LLM is behind an interface. Adding OpenAI is a single new file.

For full architectural detail, see [CLAUDE.md](CLAUDE.md) — the spec used to build this.

## Security and privacy

- **All data is local.** Nothing leaves your machine except calls to Anthropic and your Gmail
- **No telemetry.** This tool does not phone home
- **API keys in `.env`** (gitignored, never logged)
- **Audit log** — every business event recorded in local SQLite
- **Suppression list** — once a contact opts out, they cannot receive emails again
- **Open source** — read the code

Report security issues per [SECURITY.md](SECURITY.md).

## Compliance

You are responsible for complying with the laws of your jurisdiction. This tool is designed to make compliance easier, not to absolve you of responsibility.

**What the tool enforces:**

- Unsubscribe footer on every email
- STOP / UNSUBSCRIBE replies auto-honored
- Suppression list checked before every send
- Daily send caps to prevent accidental bulk sending
- Audit log of every send for your records

**What you must handle:**

- Have a legitimate basis to contact each person
- Comply with local data protection laws (GDPR / DPDP / CAN-SPAM / CASL etc.)
- Do not use this tool for spam, fraud, harassment, or any unlawful purpose

The MIT license disclaims all warranty. Use at your own risk.

## Roadmap

### v0.1 (current — alpha)
- [x] Core upload-driven workflow
- [x] Smart contact-file parser
- [x] Anthropic LLM drafting with seniority templates
- [x] Quality checks on every draft
- [x] Gmail send with throttling
- [x] IMAP reply detection
- [x] STOP / suppression handling
- [x] Audit log
- [x] Timeline dashboard

### v0.2 (planned)
- [ ] Follow-up scheduler (7-day / 14-day, conditional on no reply)
- [ ] Apollo.io API integration (optional contact source)
- [ ] Hunter.io provider
- [ ] OpenAI LLM provider
- [ ] Template A/B testing
- [ ] Improved reply-thread grouping

### v0.3 (later)
- [ ] Outlook + custom SMTP
- [ ] LinkedIn DM text generator (manual copy-paste; no scraping)
- [ ] Calendar integration for proposing meeting times
- [ ] Cost-optimization mode (smaller context, cheaper model fallback)

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

Areas where help is most useful:
- Apollo / Hunter / Lusha contact providers
- OpenAI / Gemini / local model (Ollama) LLM providers
- Additional email templates for specific outreach types
- Personalization-engine improvements
- Integration tests

## FAQ

**Q: Will this get my Gmail account banned?**
A: Not if you respect the defaults. 90-second throttle + 100/day cap is well within Gmail's tolerance for personal accounts. Do not loosen the throttle until you have observed your own deliverability.

**Q: How much does it cost to run?**
A: For 500 emails (10 companies × 50 contacts): roughly $1-2 in Anthropic costs. No subscription fees.

**Q: Can I use this for sales outreach?**
A: Technically yes, but this is designed for individual professional outreach. If you send 1,000+ emails per week, use a dedicated sales tool. Do not use this for spam.

**Q: Can I use a local LLM via Ollama?**
A: Not in v0.1. The LLM provider abstraction makes it straightforward to add. PRs welcome.

**Q: Is there a hosted version?**
A: No, and there are no plans for one. This tool exists specifically to keep your data local.

**Q: Why uploads instead of Apollo integration?**
A: To keep v1 simple and provider-agnostic. You may already have contacts from Apollo, Hunter, LinkedIn Sales Navigator, manual research, referrals, or any combination. Uploads work for all of these. Apollo integration is planned for v0.2.

## License

MIT — see [LICENSE](LICENSE).

You are free to use, modify, and distribute this code. Acknowledgement appreciated but not required.

## Acknowledgements

Built end-to-end with [Claude Code](https://claude.com/claude-code) following the spec in [CLAUDE.md](CLAUDE.md).

---

<div align="center">

**If this helped you land an interview, an investor meeting, or a great conversation — that is the entire point. Good luck.**

</div>
