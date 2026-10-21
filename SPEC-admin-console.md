# Spec: Admin Console (`admin-console`)

## Objective

Provide a Zimbra-like, responsive HTMX System & Tenant Administration Console (`/admin`) that lets system administrators manage domains, DKIM keys, TLS certificates, user accounts, quotas, addresses/aliases, domain aliases, audit logs, and system health/upgrades through a fast web interface backed by WildDuck's REST API.

## Tech Stack

- **Server Routing:** Fastify route plugin under `lib/suite/admin/` mounted at `/admin`.
- **Backend Integration:** Calls WildDuck REST API endpoints (`/users`, `/addresses`, `/domainaliases`, `/dkim`, `/certs`, `/acme`, `/audit`, `/settings`, `/health`) via `lib/suite/api-client.js` and reads Prometheus metrics from `lib/metrics.js`.
- **Frontend Interactivity:** HTMX partial swaps (`hx-get`, `hx-post`, `hx-put`, `hx-delete`, `hx-target`, `hx-swap`), modal dialogs, inline search/pagination, and live health polling (`hx-trigger="every 15s"`).

## Commands

```bash
# Lint Admin Console files
NODE_ENV=test ./node_modules/.bin/eslint lib/suite/admin/**/*.js test/suite/admin-console-test.js

# Run Admin Console integration tests
NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/admin-console-test.js
```

## Project Structure

```text
lib/suite/admin/routes.js          -> Fastify routes for /admin/* guarded by admin role check
lib/suite/admin/views/dashboard.js -> System health status (IMAP, POP3, LMTP, API, MongoDB, Redis), active counters, and version/upgrade card
lib/suite/admin/views/users.js     -> User directory table, search/filter, create/edit user modal, quota & recipients/forwards limits, 2FA reset, and address/alias management
lib/suite/admin/views/domains.js   -> Domain management, DKIM key generation/rotation, domain aliases, domain access allow/block lists, and DNS record helper modal
lib/suite/admin/views/certs.js     -> TLS certificate & ACME Let's Encrypt management UI
lib/suite/admin/views/audit.js     -> Authentication log viewer (/users/:user/authlog) and message audit export interface
lib/suite/admin/views/system.js    -> Global settings, language configuration, and Safe Version Upgrade runner UI (shows current WildDuck v1.55.1 and upgrade controls)
test/suite/admin-console-test.js   -> Mocha/Chai/Supertest suite verifying admin role enforcement and CRUD flows against WildDuck API
```

## Code Style

```javascript
'use strict';

const { escapeHtml } = require('../html');

function renderUserRow(user, t) {
    let usedMb = Math.round(((user.limits && user.limits.quota && user.limits.quota.used) || 0) / (1024 * 1024));
    let allowedMb = Math.round(((user.limits && user.limits.quota && user.limits.quota.allowed) || 0) / (1024 * 1024));

    return `<tr id="user-row-${escapeHtml(user.id)}">
        <td><strong>${escapeHtml(user.username)}</strong></td>
        <td>${escapeHtml(user.name || '-')}</td>
        <td>${escapeHtml(user.address || '-')}</td>
        <td>${usedMb} / ${allowedMb} MB</td>
        <td class="actions">
            <button class="btn btn-sm" hx-get="/admin/users/${escapeHtml(user.id)}/edit" hx-target="#modal-container">${escapeHtml(t('admin.users.edit'))}</button>
            <button class="btn btn-sm btn-danger" hx-delete="/admin/users/${escapeHtml(user.id)}" hx-confirm="${escapeHtml(t('admin.users.confirmDelete'))}" hx-target="#user-row-${escapeHtml(user.id)}" hx-swap="outerHTML">${escapeHtml(t('admin.users.delete'))}</button>
        </td>
    </tr>`;
}

module.exports = {
    renderUserRow
};
```

## Testing Strategy

- **Framework:** Mocha (`12.0.3`), Chai (`4.3.10`), and `test/api/_inprocess.js` + `createSuiteApp()` for full end-to-end API-backed verification.
- **Location:** `test/suite/admin-console-test.js`.
- **Coverage Areas:**
  - Non-admin users attempting to access `/admin/*` receive `403 Forbidden` or redirect to `/login`.
  - Admin can create a new user with a selected default language (passing `language` to `POST /users` so default mailbox folders are localized via `lib/translations.js`), update quotas, add alias addresses, and delete users via HTMX endpoints.
  - Admin can create/rotate DKIM keys for a domain (`POST /dkim`) and view formatted DNS TXT records.
  - System dashboard displays live service status and current WildDuck version (`1.55.1`).

## Boundaries

- **Always:**
  - Verify admin role (`role === 'admin'` or master access token) on every `/admin/*` route before executing any API call.
  - Pass the selected user language when creating new users so WildDuck automatically localizes their default folders (`lib/translations.js`).
- **Ask first:**
  - Exposing destructive bulk operations (such as deleting all users in a domain at once).
- **Never:**
  - Display raw user password hashes, master tokens, or DKIM private keys in the Admin UI after creation.

## Success Criteria

- Admin dashboard renders service status, storage usage, and version (`1.55.1`) in `< 200ms` over local API loopback.
- Complete HTMX CRUD workflows work without full page reloads for: Users, User Addresses/Aliases, Domains/Domain Aliases, DKIM keys, Domain Access lists (whitelist/blacklist), and TLS Certificates.
- Creating a user with locale `vi` provisions localized default mailbox folders and allows immediate login in Webmail.

## Open Questions

- None for `admin-console`.
