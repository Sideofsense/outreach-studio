# Security Policy

## Supported versions

Only the latest released version receives security updates.

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

If you discover a security vulnerability, please **do not open a public GitHub issue**.

Instead, report it privately by emailing the maintainer (contact details on the GitHub profile listed in the repo). Include:

- A description of the vulnerability
- Steps to reproduce
- The impact you believe it has
- Any suggested mitigation

You will receive an acknowledgement within 7 days. Confirmed vulnerabilities will be patched and disclosed responsibly.

## Security model

Outreach Studio is a local-only tool. The trust boundary is your machine.

- The web UI binds to `localhost` only — it is not reachable from the network
- All data persists locally in SQLite (`data/outreach.db`) and the `data/uploads/` folder
- API keys and email credentials live in `.env` (gitignored)
- Logs redact configured secret fields (API keys, passwords)
- The tool communicates externally only with:
  - Anthropic API (for draft generation)
  - Your Gmail SMTP server (for sending)
  - Your Gmail IMAP server (for reply detection)

## What this tool does NOT protect you from

- A compromised local machine (anything reading your `.env`)
- A compromised Anthropic account
- A compromised Gmail account
- Misuse — sending unwanted email, harassment, fraud, or any unlawful activity. You alone are responsible for the content and recipients of every email sent through this tool.

## Hardening checklist for users

- Keep your `.env` permissions strict (`chmod 600 .env`)
- Use a dedicated Gmail App Password — revoke when no longer needed
- Do not commit `data/` to any git repository
- Run on a trusted machine — not shared / public hardware
