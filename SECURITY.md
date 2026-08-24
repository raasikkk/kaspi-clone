# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do NOT open a public GitHub issue.**

Instead, send an email to: **admin@everything.kz**

Please include:

- A description of the vulnerability.
- Steps to reproduce the issue.
- Any relevant logs or screenshots.

We will acknowledge your report within **48 hours** and aim to provide a fix or mitigation within **7 days**.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Security Best Practices

- Never commit `.env`, `keypair.json`, `device.json`, or `*.bak` files.
- Always set `TOKEN_SECRET_KEY` via environment variable — the app will refuse to start without it.
- Rotate keys periodically using `npm run regen:keypair` and `npm run regen:device`.
- Keep dependencies up to date (`npm audit`).
