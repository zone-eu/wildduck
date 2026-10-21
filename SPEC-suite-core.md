# Spec: Suite Core (`suite-core`)

## Objective

Build the foundational HTTP/HTMX server, internal REST API client, session authentication middleware, internationalization (i18n) engine, and shared UI shell for the WildDuck HTMX Mail Suite.
This module follows the exact service pattern established by `mcp.js` and `config/mcp.toml` in `zone-eu/wildduck` (`v1.55.1`), ensuring zero modifications to WildDuck's existing IMAP, POP3, LMTP, or REST API handlers (except registering the optional service entry in `worker.js`).
It serves system administrators, end users, and open-source contributors who need a fast, zero-build-step HTMX foundation with built-in multi-language support.

## Tech Stack

- **Runtime:** Node.js `>=22.19.0` (CommonJS `'use strict';`)
- **HTTP Server:** `fastify` (`^5.12.7`), `@fastify/static` (`^10.1.6`), `@fastify/multipart` (`10.1.3`) - already in `package.json`
- **Internal API Transport:** `undici` (`8.11.2`) keep-alive loopback client calling WildDuck REST API (`config.api`)
- **Config & Logging:** `@zone-eu/wild-config` (`1.7.7`), `npmlog` (`7.0.1`)
- **Security & Escaping:** `he` (`2.0.0`) for strict HTML escaping, `sanitize-html` (`2.18.0`) via `lib/mcp-html.js` for untrusted email HTML, Redis-backed HTTP-only session cookies with CSRF tokens
- **Frontend Assets:** Vendored `htmx.min.js` (v2.x) and custom modern CSS variables design system served from `public/suite/` with zero external build tools

## Commands

```bash
# Start full WildDuck server including Suite UI service
npm start

# Print effective merged TOML configuration
npm run printconf

# Lint Suite files with repository ESLint rules
NODE_ENV=test ./node_modules/.bin/eslint suite.js lib/suite/**/*.js test/suite/**/*-test.js

# Run focused Suite Core unit and integration tests
NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/suite-core-test.js

# Run protocol and unit test suite without resetting DB
npm run test:proto
```

## Project Structure

```text
suite.js                        -> Service starter exporting async listener (parallels mcp.js and api.js)
config/suite.toml               -> Suite configuration (enabled, port, host, defaultLocale, sessionTTL, setupMode)
lib/suite/api-client.js         -> Keep-alive Undici client wrapping WildDuck REST API (parallels lib/mcp-api-client.js)
lib/suite/i18n.js               -> Locale loader, translator helper t(locale, key, params), and language negotiation
lib/suite/session.js            -> Redis-backed session store (wdsuite:sess:<id>), cookie parser/signer, and CSRF guard
lib/suite/html.js               -> Server-side HTML template tag helper with automatic entity escaping via `he`
lib/suite/views/layout.js       -> Base HTML5/HTMX document shell, navigation bar, toast notifications, theme/locale switcher
lib/suite/locales/en.json       -> Default English language pack (100% key coverage)
lib/suite/locales/vi.json       -> Vietnamese language pack (100% key coverage)
public/suite/htmx.min.js        -> Self-hosted HTMX library
public/suite/suite.css          -> Design system stylesheet (responsive layout, dark/light mode, smooth transitions)
test/suite/suite-core-test.js   -> Mocha/Chai/Supertest suite verifying i18n, sessions, CSRF, and API client
```

## Code Style

All files must follow `.prettierrc.js` and `AGENTS.md`: CommonJS (`'use strict';`), 4-space indentation, single quotes, no trailing commas, `printWidth: 160`, and `arrowParens: 'avoid'`.

```javascript
'use strict';

const he = require('he');
const config = require('@zone-eu/wild-config');

function escapeHtml(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return he.encode(String(value), { useNamedReferences: true });
}

function resolveLocale(req, supportedLocales) {
    let cookieLocale = req.cookies && req.cookies.wd_locale;
    if (cookieLocale && supportedLocales.has(cookieLocale)) {
        return cookieLocale;
    }
    let defaultLocale = (config.suite && config.suite.defaultLocale) || 'en';
    return supportedLocales.has(defaultLocale) ? defaultLocale : 'en';
}

module.exports = {
    escapeHtml,
    resolveLocale
};
```

## Testing Strategy

- **Framework:** Mocha (`12.0.3`), Chai (`4.3.10`), and Fastify `app.inject()` / `supertest` (`7.3.1`).
- **Location:** `test/suite/suite-core-test.js`.
- **Test Levels:**
  - Unit tests for `lib/suite/i18n.js` (fallback to `en`, parameter interpolation, missing key handling, parity with `lib/translations.js` locales).
  - Unit tests for `lib/suite/html.js` ensuring all interpolated values are HTML-escaped by default to prevent XSS.
  - Integration tests for `suite.js` using `createSuiteApp()` with `app.inject()` verifying cookie session creation in Redis, CSRF validation on `POST`/`PUT`/`DELETE` HTMX requests, and `HX-Redirect` / `HX-Trigger` headers.

## Boundaries

- **Always:**
  - Keep all new logic inside `suite.js`, `lib/suite/`, `config/suite.toml`, `public/suite/`, and `test/suite/`.
  - Escape every dynamic string rendered into HTML unless explicitly passed through `webSafeHtml()` from `lib/mcp-html.js`.
  - Pass ESLint (`./node_modules/.bin/eslint`) before completing any task.
- **Ask first:**
  - Adding any new npm package to `package.json` (prefer existing dependencies in `package.json`).
  - Modifying any existing file outside `worker.js` (where `suite.js` is registered in `SERVICES`).
- **Never:**
  - Modify existing WildDuck IMAP, POP3, LMTP, or REST API handlers (`lib/*-handler.js`, `lib/api/*.js`).
  - Query MongoDB collections directly for mail/user operations that are already exposed by the WildDuck REST API.
  - Use client-side SPA bundlers (Webpack, Vite, Bower) or introduce build steps required to edit HTML/HTMX views.

## Success Criteria

- `suite.js` starts cleanly when `config.suite.enabled = true` and exports `createSuiteApp()` for in-process testing without opening a network socket.
- Switching language between English (`en`) and Vietnamese (`vi`) updates UI labels immediately via cookie/query param and falls back cleanly to `en` if a key is missing.
- All state-changing HTMX requests (`POST`, `PUT`, `DELETE`) enforce valid session and CSRF tokens, returning `403` when missing or invalid.
- Full page loads render the full HTML shell while requests with `HX-Request: true` return only the targeted HTML fragment.
- Zero ESLint errors across all created/modified files.

## Open Questions

- None for `suite-core`.
