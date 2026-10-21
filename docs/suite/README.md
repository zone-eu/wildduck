# WildDuck HTMX Mail Suite & Smart Installer (`v1.55.1`)

## Overview

The WildDuck HTMX Mail Suite is a unified, server-rendered Webmail Client, Admin Console, and Multi-Language Smart Installer built directly on top of WildDuck `v1.55.1`.
It delivers a complete Zimbra-like email suite experience without requiring any heavy Single-Page Application (SPA) frontend build pipeline or external admin dashboard repository.

## Zero-Touch Core Architecture

All Suite functionality is isolated so that upstream updates from `zone-eu/wildduck` merge cleanly without conflicts:

- `suite.js` and `config/suite.toml`: Fastify server listener (`127.0.0.1:8090` by default) registered in `worker.js` using the exact same lifecycle pattern as `mcp.js`.
- `lib/suite/api-client.js`: Internal loopback HTTP client powered by `undici` that forwards every Admin and Webmail operation to the local WildDuck REST API (`127.0.0.1:8080`).
- `lib/suite/session.js`: Redis-backed session store (`wd_suite:sess:<id>`) with `HttpOnly` signed cookies and double-submit CSRF verification (`X-CSRF-Token` / `_csrf`).
- `lib/suite/html.js` and `lib/mcp-html.js`: Safe HTML tagged template literals (`he.escape`) and strict untrusted email HTML sanitization (`webSafeHtml`).
- `public/suite/`: Vendored `htmx.min.js`, responsive CSS design system (`suite.css`), and progressive enhancement helpers (`suite-client.js`).

## Multi-Language Smart Installer & Web Setup Wizard

### 1. CLI Bootstrap (`setup/install-suite.sh`)

Run the interactive multi-language installer on a fresh Linux host or existing WildDuck node:

```bash
bash setup/install-suite.sh --lang en
# or Vietnamese:
bash setup/install-suite.sh --lang vi
```

To check and run a safe version upgrade:

```bash
bash setup/install-suite.sh --upgrade
```

### 2. 5-Step Web Setup Wizard (`/setup`)

When starting an unconfigured node, the Suite automatically redirects browsers to `/setup`:

1. **Language Selection:** Choose English (`en`) or Vietnamese (`vi`).
2. **Pre-Flight Check:** Inspect CPU, RAM, disk space, and port availability (`25`, `143`, `587`, `993`, `8080`, `8090`).
3. **Zero-Config Provisioning:** Generate cryptographic secrets, write `suite.toml`, create the initial Administrator account with localized default mailbox folders, and generate a 2048-bit RSA DKIM keypair.
4. **Live DNS, DKIM & SSL Verification:** Query live DNS for `MX`, `SPF`, `DKIM`, `DMARC`, and `PTR` records with copy-ready BIND/Cloudflare snippets.
5. **Finalize & Lock:** Permanently lock `/setup` once installation is complete.

## HTMX Admin Console (`/admin`)

- **System Health & Metrics (`/admin`):** Live status badges for IMAP, POP3, LMTP, API, MongoDB, and Redis, plus total user and quota counters.
- **Users & Quotas (`/admin/users`):** Search, create, edit quotas/limits, manage forwarding and alias addresses, and delete users via instant HTMX drawer updates.
- **Domains & DKIM (`/admin/domains`):** Manage domain aliases, generate or rotate DKIM keys, and copy formatted DNS records.
- **TLS Certificates (`/admin/certs`):** Upload custom PEM certificates or trigger Let's Encrypt ACME orders.
- **Audit Logs (`/admin/audit`):** Inspect authentication events by user or action type.
- **System & 1-Click Safe Upgrade (`/admin/system`):** Change default suite language and run pre-checked upgrades with automatic configuration snapshots and rollback protection.

## HTMX Webmail Client (`/webmail`)

- **Three-Pane Responsive Workspace:** Mailbox tree with unread badges and storage quota bar on the left, cursor-paginated message list and full-text search in the center, and XSS-safe reading pane on the right.
- **Real-Time SSE Updates (`/webmail/events`):** Automatically refreshes mailbox counters and message lists when new messages arrive.
- **Rich Composer:** Reply, Reply All, Forward, save drafts, attach files, and submit messages via `POST /users/:user/submit`.
- **User Self-Service Settings (`/webmail/settings`):** Profile & UI language, Vacation Autoreply, Forwarding targets, Mail Filters, Password change, TOTP 2FA enrollment with QR code generation, and Application-Specific Passwords (ASPs).

## Contributing Translations (i18n)

UI translations live in `lib/suite/locales/<lang>.json` as flat key-value JSON dictionaries.
To add a new language:

1. Copy `lib/suite/locales/en.json` to `lib/suite/locales/<lang>.json`.
2. Translate all keys while keeping `{placeholder}` tokens intact.
3. Register the language code in `SUPPORTED_LOCALES` in `lib/suite/i18n.js`.
4. Run `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/suite-core-test.js` to verify key parity.
