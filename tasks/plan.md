# Implementation Plan: WildDuck HTMX Mail Suite & Smart Installer

## Overview

We are building an all-in-one, Zimbra-like HTMX Mail Suite and multi-language Smart Installer on top of WildDuck `v1.55.1` (`zone-eu/wildduck`).
All work follows the Zero-Touch Core architecture (`suite.js`, `lib/suite/`, `config/suite.toml`, `public/suite/`, `setup/install-suite.sh`, `test/suite/`) so that upstream WildDuck code remains untouched (except a single service registration line in `worker.js`).
Every task is vertically sliced, verified with Mocha/Chai tests and ESLint, and committed as a clean atomic Conventional Commit without agent co-author tags.

## Architecture Decisions

- **Zero-Touch Service Registration:** Mirror `mcp.js` and `config/mcp.toml` by creating `suite.js` and `config/suite.toml`, registering `['Suite UI server', suite]` in `worker.js`.
- **Internal Loopback API Client:** Mirror `lib/mcp-api-client.js` using `undici` keep-alive requests in `lib/suite/api-client.js` so all Admin and Webmail operations use WildDuck's official REST API validation, roles, and audit logging.
- **Built-in i18n Engine:** Load flat JSON language files (`lib/suite/locales/en.json`, `lib/suite/locales/vi.json`) with automatic fallback to `en` and integration with `lib/translations.js` for localized default mailbox creation.
- **Zero Frontend Build Step:** Serve vendored `htmx.min.js` and a modern responsive CSS design system (`public/suite/suite.css`) directly via `@fastify/static` with server-rendered HTML fragments escaped through `he` and `webSafeHtml()` (`lib/mcp-html.js`).
- **Idempotent Smart Installer & Safe Upgrader:** Provide a multi-language CLI bootstrap (`setup/install-suite.sh`) and 5-step Web Setup Wizard (`/setup`) featuring pre-flight hardware/port checks, zero-config TOML provisioning, live DNS/DKIM/SSL verification, step-by-step resume, and 1-click safe upgrades from `v1.55.1`.

## Task List

### Phase 1: Suite Core Foundation (`suite-core`)
- [ ] Task 1: Create `config/suite.toml`, HTML escaping/template helpers (`lib/suite/html.js`), and i18n engine (`lib/suite/i18n.js`) with English (`en.json`) and Vietnamese (`vi.json`) locales.
- [ ] Task 2: Build Redis-backed session & CSRF middleware (`lib/suite/session.js`) and internal loopback WildDuck API client (`lib/suite/api-client.js`).
- [ ] Task 3: Build shared HTMX layout & UI design system (`lib/suite/views/layout.js`, `public/suite/suite.css`, `public/suite/htmx.min.js`), `suite.js` server bootstrap, and `worker.js` registration.

### Checkpoint: Suite Core Foundation
- [ ] `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/suite-core-test.js` passes.
- [ ] `NODE_ENV=test ./node_modules/.bin/eslint suite.js worker.js lib/suite/**/*.js test/suite/**/*-test.js` passes with zero warnings/errors.

### Phase 2: Multi-Language Smart Installer & Web Setup Wizard (`smart-installer`)
- [ ] Task 4: Implement idempotent installer state machine (`lib/suite/installer/state.js`), hardware/OS/port pre-flight checker (`lib/suite/installer/preflight.js`), and live DNS/DKIM/SSL verifier (`lib/suite/installer/dns-verifier.js`).
- [ ] Task 5: Implement zero-config provisioner (`lib/suite/installer/provisioner.js`), safe version upgrade runner (`lib/suite/installer/upgrader.js`), HTMX 5-step Web Setup Wizard (`/setup`), and multi-language CLI script (`setup/install-suite.sh`).

### Checkpoint: Smart Installer
- [ ] `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/smart-installer-test.js` passes.
- [ ] Setup Wizard end-to-end flow (language selection -> preflight -> provisioning -> DNS check -> completion lock) verified.

### Phase 3: HTMX Admin Console (`admin-console`)
- [ ] Task 6: Implement Admin Dashboard (`/admin`), System Health & Metrics overview, and Safe Version Upgrade UI (`lib/suite/admin/views/dashboard.js`, `lib/suite/admin/views/system.js`).
- [ ] Task 7: Implement Admin User, Quota, Address/Alias, Domain, DKIM, TLS Certificate, and Audit Log management in HTMX (`lib/suite/admin/routes.js`, `lib/suite/admin/views/*.js`).

### Checkpoint: Admin Console
- [ ] `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/admin-console-test.js` passes.
- [ ] Admin CRUD flows for users, domains, DKIM, and certificates verified.

### Phase 4: HTMX Webmail Client (`webmail`)
- [ ] Task 8: Implement Webmail authentication (`/login`, `/logout`, 2FA TOTP challenge), three-pane responsive shell, mailbox folder management, and real-time SSE update bridge (`lib/suite/webmail/routes.js`, `lib/suite/webmail/views/shell.js`, `lib/suite/webmail/views/mailboxes.js`).
- [ ] Task 9: Implement Webmail message list, cursor pagination, full-text search, bulk actions, sanitized HTML message reader (`webSafeHtml`), and rich email composer with streaming attachments (`lib/suite/webmail/views/messages.js`, `lib/suite/webmail/views/composer.js`).
- [ ] Task 10: Implement Webmail User Settings in HTMX (Profile & Language, Autoreply, Forwarding, Mail Filters, Password, TOTP 2FA QR setup, and Application-Specific Passwords) and full E2E verification (`lib/suite/webmail/views/settings.js`, `test/suite/webmail-test.js`).

### Checkpoint: Complete Product Verification
- [ ] All Suite unit and integration tests (`test/suite/*-test.js`) and existing protocol tests (`npm run test:proto`) pass.
- [ ] ESLint passes across the entire repository with zero errors.
- [ ] Every task is committed cleanly with Conventional Commits (`feat(suite): ...`).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| XSS from untrusted HTML emails in Webmail | High | Always sanitize message HTML through `webSafeHtml()` (`lib/mcp-html.js`) and escape all metadata via `he.encode()`. |
| Upstream conflicts when upgrading WildDuck `1.55.1` | High | Keep all new code in `suite.js`, `lib/suite/`, `config/suite.toml`, `public/suite/`, and `test/suite/`, touching only 1 line in `worker.js`. |
| Unauthenticated access to `/setup` after install | High | Guard `/setup` with a one-time setup token and permanently lock `/setup` once state is marked `completed`. |
| Port or DB unavailability during automated tests | Medium | Use injectable system probes in `smart-installer` tests and in-process Fastify `app.inject()` with mocked/local test stores when needed. |

## Open Questions

- None.
