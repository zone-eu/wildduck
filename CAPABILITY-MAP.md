# Capability Map: WildDuck HTMX Mail Suite

This document defines the module boundaries, dependency direction, and build order for the WildDuck HTMX Mail Suite and Smart Installer built on WildDuck `v1.55.1`.

| Module id | Responsibility | Depends on | Spec File |
|---|---|---|---|
| `suite-core` | Zero-Touch Fastify listener (`suite.js`), internal loopback API client (`lib/suite/api-client.js`), session & CSRF management, i18n locale engine (`en`, `vi`, ...), and shared HTMX layout/component rendering | - | `SPEC-suite-core.md` |
| `smart-installer` | Multi-language CLI bootstrap (`setup/`) + Web Setup Wizard (`/setup`): pre-flight hardware/OS/port checks, zero-config service provisioning (MongoDB, Redis, Haraka, ZoneMTA, WildDuck), live DNS/DKIM/SSL verification, idempotent step resume, and safe version upgrade runner | `suite-core` | `SPEC-smart-installer.md` |
| `admin-console` | HTMX System & Tenant Administration UI (`/admin`): server health & metrics dashboard, domain & DKIM/SSL management, user/quota/address management, domain aliases, audit logs, and 1-click system upgrade UI | `suite-core`, `smart-installer` | `SPEC-admin-console.md` |
| `webmail` | HTMX End-User Email Client UI (`/webmail` or `/`): real-time mailbox & folder navigation (via SSE updates), thread/message reader with safe HTML sanitization, rich email composer & attachments, full-text search, filters, autoreply/forwarding, and user profile/2FA settings | `suite-core` | `SPEC-webmail.md` |

Build order: `suite-core` -> `smart-installer` -> `admin-console` -> `webmail`
