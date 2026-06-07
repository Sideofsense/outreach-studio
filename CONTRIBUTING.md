# Contributing to Outreach Studio

Thanks for your interest in contributing. Outreach Studio is a small, opinionated tool with a deliberately narrow scope. PRs are welcome — please read this first.

## Scope and philosophy

This is a **local, single-user** tool that values:

- Quality of outreach over volume
- User control over every email sent
- Local-only data (no cloud, no telemetry)
- A small, readable codebase (no build step, vanilla JS frontend)

Features that broaden scope beyond this (multi-user, SaaS hosting, mass-blasting, LinkedIn scraping) will not be accepted.

## Where help is most useful

- Additional LLM providers (OpenAI, Gemini, local via Ollama) behind the existing provider interface
- Additional contact-source providers (Apollo, Hunter, Lusha) behind a new provider interface
- New email templates for specific outreach scenarios
- Improvements to the personalization engine and quality checks
- Integration tests
- Documentation improvements

## Development setup

```bash
git clone https://github.com/Sideofsense/outreach-studio.git
cd outreach-studio
npm install
cp .env.example .env
# Fill in your keys
npm start
```

Run tests:

```bash
npm test
```

## Code style

- 2-space indent, LF line endings, UTF-8 (`.editorconfig` enforces)
- CommonJS modules (`require` / `module.exports`)
- No build step on the frontend — vanilla JS + HTMX + Tailwind via CDN
- SQL via `better-sqlite3` prepared statements only — never string-concatenate user input
- All secrets in `.env` — never log them, never commit them

## Pull-request checklist

- [ ] `npm test` passes locally
- [ ] No new dependencies added without discussion (the locked tech stack is intentional)
- [ ] No `console.log` left in committed code
- [ ] Audit-log entries added for any new business events
- [ ] Documentation updated if behavior changed

## Reporting bugs

Open a GitHub issue. Include:

- Node version (`node --version`)
- OS
- Steps to reproduce
- Relevant log output (with secrets redacted)

## Security issues

Do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree your contributions are licensed under the MIT License.
