# Task List: WildDuck HTMX Mail Suite & Smart Installer

## Task 1: Suite Configuration, HTML Escaping Helper, and Multi-Language i18n Engine

**Description:** Create `config/suite.toml`, safe HTML template/escaping utilities (`lib/suite/html.js`), and the internationalization module (`lib/suite/i18n.js`) with complete English (`lib/suite/locales/en.json`) and Vietnamese (`lib/suite/locales/vi.json`) translation catalogs covering Installer, Admin Console, and Webmail.

**Acceptance criteria:**
- [x] `config/suite.toml` defines `enabled`, `port`, `host`, `defaultLocale`, `sessionTTL`, and `apiUrl` settings.
- [x] `lib/suite/html.js` escapes dynamic values using `he.encode()` and supports marking pre-sanitized fragments safely.
- [x] `lib/suite/i18n.js` loads `en.json` and `vi.json`, interpolates named placeholders, negotiates locale from cookie/query/header, and falls back to `en`.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/suite-core-test.js`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint lib/suite/html.js lib/suite/i18n.js test/suite/suite-core-test.js`
- [x] Commit: `git commit -m "feat(suite): add suite config, html escaping, and i18n engine"`

**Dependencies:** None

**Files likely touched:**
- `config/suite.toml`
- `lib/suite/html.js`
- `lib/suite/i18n.js`
- `lib/suite/locales/en.json`
- `lib/suite/locales/vi.json`
- `test/suite/suite-core-test.js`

**Estimated scope:** Medium (3-5 files)

---

## Task 2: Redis Session/CSRF Middleware and Loopback WildDuck API Client

**Description:** Implement Redis-backed session and CSRF token management (`lib/suite/session.js`) with in-memory fallback for unit tests, and build the keep-alive Undici loopback client (`lib/suite/api-client.js`) wrapping WildDuck REST API calls for authentication, users, mailboxes, messages, DKIM, certs, filters, autoreply, and audit.

**Acceptance criteria:**
- [x] `lib/suite/session.js` creates HTTP-only session cookies, stores session state in Redis (`wdsuite:sess:<id>`), and validates CSRF tokens on state-changing requests (`POST`, `PUT`, `DELETE`).
- [x] `lib/suite/api-client.js` derives the default WildDuck API URL from `config.api`, forwards user access tokens or admin master tokens, and supports JSON and streaming requests.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/suite-core-test.js`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint lib/suite/session.js lib/suite/api-client.js test/suite/suite-core-test.js`
- [x] Commit: `git commit -m "feat(suite): add session csrf guard and loopback api client"`

**Dependencies:** Task 1

**Files likely touched:**
- `lib/suite/session.js`
- `lib/suite/api-client.js`
- `test/suite/suite-core-test.js`

**Estimated scope:** Small (2-3 files)

---

## Task 3: Suite UI Shell, Static Assets, and Fastify Service Bootstrap (`suite.js`)

**Description:** Build the shared HTMX layout (`lib/suite/views/layout.js`), responsive CSS design system (`public/suite/suite.css`), vendored HTMX script (`public/suite/htmx.min.js`), Fastify server factory (`suite.js`), and register the service in `worker.js`.

**Acceptance criteria:**
- [x] `suite.js` exports `createSuiteApp(options)` and starts listening when `config.suite.enabled` is true.
- [x] `lib/suite/views/layout.js` renders full HTML documents for standard requests and partial fragments when `HX-Request: true` is present, including language switcher (`en`/`vi`) and toast triggers.
- [x] `worker.js` registers `['Suite UI server', suite]` without altering any existing service behavior.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/suite-core-test.js`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint suite.js worker.js lib/suite/**/*.js test/suite/suite-core-test.js`
- [x] Commit: `git commit -m "feat(suite): bootstrap fastify htmx server and shared layout"`

**Dependencies:** Task 1, Task 2

**Files likely touched:**
- `suite.js`
- `worker.js`
- `lib/suite/views/layout.js`
- `public/suite/suite.css`
- `public/suite/htmx.min.js`
- `test/suite/suite-core-test.js`

**Estimated scope:** Medium (5 files)

---

## Checkpoint: After Tasks 1-3 (`suite-core`)
- [x] `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/suite-core-test.js` passes 100%.
- [x] `NODE_ENV=test ./node_modules/.bin/eslint suite.js worker.js lib/suite/**/*.js test/suite/**/*-test.js` passes cleanly.

---

## Task 4: Smart Installer Diagnostics (State Machine, Pre-flight Checks, and Live DNS Verifier)

**Description:** Implement the idempotent installation state tracker (`lib/suite/installer/state.js`), system hardware/OS/port pre-flight diagnostics (`lib/suite/installer/preflight.js`), and real-time DNS/DKIM/SPF/DMARC/PTR record generator and verifier (`lib/suite/installer/dns-verifier.js`).

**Acceptance criteria:**
- [x] `state.js` persists step statuses (`pending`, `running`, `completed`, `failed`), supports resuming from failed steps, and locks the wizard once `completed`.
- [x] `preflight.js` inspects CPU cores, total RAM, disk space, OS release, and port binding availability (`25`, `80`, `443`, `143`, `993`, `465`, `587`).
- [x] `dns-verifier.js` generates required DNS records (MX, A, SPF, DKIM, DMARC, PTR) and verifies live DNS resolution with pass/warn/fail statuses.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/smart-installer-test.js`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint lib/suite/installer/*.js test/suite/smart-installer-test.js`
- [x] Commit: `git commit -m "feat(installer): add state machine, preflight checks, and dns verifier"`

**Dependencies:** Task 3

**Files likely touched:**
- `lib/suite/installer/state.js`
- `lib/suite/installer/preflight.js`
- `lib/suite/installer/dns-verifier.js`
- `test/suite/smart-installer-test.js`

**Estimated scope:** Medium (4 files)

---

## Task 5: Zero-Config Provisioner, Safe Upgrader, Web Setup Wizard (`/setup`), and Multi-Language CLI Installer

**Description:** Build the zero-config service provisioner (`lib/suite/installer/provisioner.js`), safe version upgrade runner (`lib/suite/installer/upgrader.js`), 5-step HTMX Web Setup Wizard (`lib/suite/installer/routes.js`, `lib/suite/installer/views.js`), and multi-language CLI bootstrap (`setup/install-suite.sh`).

**Acceptance criteria:**
- [x] Web Setup Wizard (`/setup`) guides the admin through: (1) Language selection, (2) Pre-flight hardware/port check, (3) Domain & Admin account zero-config provisioning, (4) Live DNS/DKIM/SSL verification, and (5) Finalize & lock wizard.
- [x] `upgrader.js` snapshots config, checks current WildDuck version (`1.55.1`), runs migrations, triggers graceful reload, and supports rollback on failure.
- [x] `setup/install-suite.sh` prompts for installation language (`en`/`vi`), runs pre-checks, configures services, and outputs the Web Setup Wizard URL with a one-time setup token.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/smart-installer-test.js`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint lib/suite/installer/*.js test/suite/smart-installer-test.js`
- [x] Bash syntax check passes: `bash -n setup/install-suite.sh`
- [x] Commit: `git commit -m "feat(installer): implement web setup wizard, zero-config provisioner, and cli installer"`

**Dependencies:** Task 4

**Files likely touched:**
- `lib/suite/installer/provisioner.js`
- `lib/suite/installer/upgrader.js`
- `lib/suite/installer/routes.js`
- `lib/suite/installer/views.js`
- `setup/install-suite.sh`
- `test/suite/smart-installer-test.js`

**Estimated scope:** Medium (5-6 files)

---

## Checkpoint: After Tasks 4-5 (`smart-installer`)
- [x] `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/smart-installer-test.js` passes 100%.
- [x] `bash -n setup/install-suite.sh` and ESLint pass with zero errors.

---

## Task 6: HTMX Admin Console - Dashboard, System Health, and Safe Upgrade UI

**Description:** Build the Admin Console router (`lib/suite/admin/routes.js`), role guard, System Health & Metrics Dashboard (`lib/suite/admin/views/dashboard.js`), and System Settings / 1-Click Safe Upgrade screen (`lib/suite/admin/views/system.js`).

**Acceptance criteria:**
- [x] `/admin` enforces admin authentication and renders service health cards (IMAP, POP3, LMTP, API, MongoDB, Redis), active counters, and current WildDuck version (`1.55.1`).
- [x] `/admin/system` allows changing default suite language, inspecting system pre-flight status, and triggering/reviewing safe version upgrades.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/admin-console-test.js`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint lib/suite/admin/**/*.js test/suite/admin-console-test.js`
- [x] Commit: `git commit -m "feat(admin): add htmx admin dashboard, health monitor, and upgrade ui"`

**Dependencies:** Task 5

**Files likely touched:**
- `lib/suite/admin/routes.js`
- `lib/suite/admin/views/dashboard.js`
- `lib/suite/admin/views/system.js`
- `test/suite/admin-console-test.js`

**Estimated scope:** Medium (4 files)

---

## Task 7: HTMX Admin Console - Users, Quotas, Domains, DKIM, TLS Certs, and Audit Logs

**Description:** Implement complete HTMX CRUD views and endpoints in Admin Console for managing Users & Quotas/Addresses (`lib/suite/admin/views/users.js`), Domains/Aliases/DKIM/DNS helper (`lib/suite/admin/views/domains.js`), TLS Certificates (`lib/suite/admin/views/certs.js`), and Audit/Auth Logs (`lib/suite/admin/views/audit.js`).

**Acceptance criteria:**
- [x] Admin can list, search, create (with localized default mailbox folders via `language`), edit quotas/limits, manage alias addresses, and delete users via HTMX partial updates.
- [x] Admin can manage domains, domain aliases, domain access lists, generate/rotate DKIM keys with instant DNS TXT preview, manage TLS certificates, and inspect user authentication logs.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/admin-console-test.js`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint lib/suite/admin/**/*.js test/suite/admin-console-test.js`
- [x] Commit: `git commit -m "feat(admin): implement user, domain, dkim, cert, and audit management"`

**Dependencies:** Task 6

**Files likely touched:**
- `lib/suite/admin/routes.js`
- `lib/suite/admin/views/users.js`
- `lib/suite/admin/views/domains.js`
- `lib/suite/admin/views/certs.js`
- `lib/suite/admin/views/audit.js`
- `test/suite/admin-console-test.js`

**Estimated scope:** Medium (6 files)

---

## Checkpoint: After Tasks 6-7 (`admin-console`)
- [x] `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/admin-console-test.js` passes 100%.
- [x] ESLint passes cleanly.

---

## Task 8: HTMX Webmail - Authentication, Three-Pane Workspace, Folders, and Real-Time SSE Updates

**Description:** Build Webmail login/logout with 2FA TOTP challenge support, the responsive three-pane workspace (`lib/suite/webmail/views/shell.js`), mailbox folder tree with unread counters and folder CRUD (`lib/suite/webmail/views/mailboxes.js`), and the Server-Sent Events real-time update bridge (`lib/suite/webmail/routes.js`).

**Acceptance criteria:**
- [x] Users can log in at `/login` (with optional TOTP 2FA verification) and switch UI language (`en`/`vi`) from the login screen or workspace header.
- [x] Three-pane Webmail workspace renders mailbox folders with live unread badges, quota usage indicator, custom folder creation/rename/delete, and empty Trash/Junk actions.
- [x] `/webmail/events` streams real-time SSE notifications so HTMX refreshes mailbox counters and message lists automatically when new mail arrives.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/webmail-test.js`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint lib/suite/webmail/**/*.js test/suite/webmail-test.js`
- [x] Commit: `git commit -m "feat(webmail): add auth, three-pane shell, mailbox tree, and sse updates"`

**Dependencies:** Task 3

**Files likely touched:**
- `lib/suite/webmail/routes.js`
- `lib/suite/webmail/views/shell.js`
- `lib/suite/webmail/views/mailboxes.js`
- `test/suite/webmail-test.js`

**Estimated scope:** Medium (4 files)

---

## Task 9: HTMX Webmail - Message List, Search, Safe HTML Reader, and Rich Composer with Attachments

**Description:** Implement cursor-paginated message listing, full-text search, bulk actions (seen/unseen, flag/star, move, delete), XSS-safe HTML message reader using `webSafeHtml()` (`lib/suite/webmail/views/messages.js`), and email composer with Reply/Reply All/Forward, draft saving, streaming attachment upload/download, and message submission (`lib/suite/webmail/views/composer.js`).

**Acceptance criteria:**
- [x] Clicking a folder or executing a search updates the message list via HTMX partial swap; clicking a message renders the reading pane with sanitized HTML (`webSafeHtml()`), attachment download links, and quick reply actions.
- [x] Bulk and single message actions (star/flag, mark read/unread, move to folder, delete) update counters and UI smoothly.
- [x] Composer supports To/Cc/Bcc, subject, HTML/text body, attachment uploads, saving drafts, and sending mail via `POST /users/:user/submit`.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/webmail-test.js`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint lib/suite/webmail/**/*.js test/suite/webmail-test.js`
- [x] Commit: `git commit -m "feat(webmail): implement message list, safe html reader, search, and composer"`

**Dependencies:** Task 8

**Files likely touched:**
- `lib/suite/webmail/routes.js`
- `lib/suite/webmail/views/messages.js`
- `lib/suite/webmail/views/composer.js`
- `test/suite/webmail-test.js`

**Estimated scope:** Medium (4 files)

---

## Task 10: HTMX Webmail - User Settings (Autoreply, Forwarding, Filters, 2FA QR, ASPs) & Final E2E Suite

**Description:** Implement the Webmail Settings modal/views (`lib/suite/webmail/views/settings.js`) for Profile & Language, Autoreply, Forwarding targets, Mail Filters, Password change, TOTP 2FA QR code enrollment (using `qrcode`), and Application-Specific Passwords (ASPs), plus final end-to-end verification and documentation update in `AGENTS.md` / `docs/suite/README.md`.

**Acceptance criteria:**
- [x] Users can configure Autoreply, Forwarding addresses, Mail Filter rules, TOTP 2FA (with rendered SVG/DataURL QR code), and Application-Specific Passwords via HTMX forms.
- [x] Complete E2E test suite (`test/suite/*-test.js`) and existing WildDuck protocol tests (`npm run test:proto`) pass 100%.
- [x] `docs/suite/README.md` documents architecture, installation, i18n contribution guide, and safe upgrade workflow in English.

**Verification:**
- [x] Tests pass: `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/*-test.js && npm run test:proto`
- [x] Lint passes: `NODE_ENV=test ./node_modules/.bin/eslint suite.js worker.js lib/suite/**/*.js test/suite/**/*-test.js`
- [x] Commit: `git commit -m "feat(webmail): add user settings, 2fa qr, filters, and suite documentation"`

**Dependencies:** Task 9

**Files likely touched:**
- `lib/suite/webmail/routes.js`
- `lib/suite/webmail/views/settings.js`
- `docs/suite/README.md`
- `test/suite/webmail-test.js`

**Estimated scope:** Medium (4 files)

---

## Final Checkpoint: Release Readiness (`v1.55.1` Suite)
- [x] All 10 tasks in `tasks/todo.md` are checked off and committed with clean Conventional Commits.
- [x] `NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/*-test.js` passes 100%.
- [x] `npm run test:proto` passes.
- [x] `git status` is clean.
