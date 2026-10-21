# Spec: HTMX Webmail (`webmail`)

## Objective

Build a super-smooth, modern, accessible HTMX Webmail client (`/webmail` and default root `/`) that delivers a desktop-class email experience (three-pane layout, keyboard navigation, real-time Server-Sent Events folder/message updates, thread & message reading with strict HTML sanitization, rich composition with attachments, instant search, filters, autoreply, forwarding, and user security/2FA settings) using WildDuck's existing REST API.

## Tech Stack

- **Server Routing:** Fastify route plugin under `lib/suite/webmail/` mounted at `/webmail` (and `/` when logged in as a user).
- **Real-Time Updates:** HTMX Server-Sent Events bridge proxying WildDuck's `/users/:user/updates` SSE stream to trigger instant badge/message list refreshes when new mail arrives.
- **HTML Sanitization:** `webSafeHtml()` from `lib/mcp-html.js` (`sanitize-html`) rendered inside a sandboxed/isolated container with safe inline attachment resolution (`cid:` / `attachment:`).
- **Attachments & Streaming:** `@fastify/multipart` for streaming attachment uploads to WildDuck (`POST /users/:user/storage` or draft attachments) and streaming downloads (`GET /users/:user/mailboxes/:mailbox/messages/:message/attachments/:attachment`).

## Commands

```bash
# Lint Webmail files
NODE_ENV=test ./node_modules/.bin/eslint lib/suite/webmail/**/*.js test/suite/webmail-test.js

# Run Webmail integration tests
NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/webmail-test.js
```

## Project Structure

```text
lib/suite/webmail/routes.js            -> Fastify routes for authentication (/login, /logout) and webmail actions (/webmail/*)
lib/suite/webmail/views/shell.js       -> Three-pane responsive workspace (Sidebar folders + Quota bar, Message list + Search bar, Reading pane / Composer modal)
lib/suite/webmail/views/mailboxes.js   -> Mailbox tree with unread badges, custom folder creation/rename/delete, and empty trash/junk actions
lib/suite/webmail/views/messages.js    -> Cursor-paginated message list, bulk selection toolbar (mark seen/unseen, flag/star, move, delete), and sanitized message reader pane
lib/suite/webmail/views/composer.js    -> Email composer (To/Cc/Bcc, Reply/Reply All/Forward prefill, draft auto-save, attachment upload/remove, send via POST /users/:user/submit)
lib/suite/webmail/views/settings.js    -> User settings tabs: Profile & Language, Signatures/Identities, Autoreply, Forwarding, Mail Filters, Password & 2FA (TOTP QR code via `qrcode`), and App Passwords (ASPs)
test/suite/webmail-test.js             -> Mocha/Chai/Supertest suite covering login, folder navigation, message read/search/flag/move/delete, compose & submit, filters, and autoreply
```

## Code Style

```javascript
'use strict';

const { escapeHtml } = require('../html');
const { webSafeHtml } = require('../../mcp-html');

function renderMessageBody(messageData) {
    if (messageData.html && messageData.html.length) {
        let safeHtml = webSafeHtml(messageData.html);
        return `<div class="message-body-html">${safeHtml}</div>`;
    }
    let plainText = escapeHtml(messageData.text || '').replace(/\r?\n/g, '<br>');
    return `<div class="message-body-text">${plainText}</div>`;
}

module.exports = {
    renderMessageBody
};
```

## Testing Strategy

- **Framework:** Mocha (`12.0.3`), Chai (`4.3.10`), and in-process WildDuck API + Suite app (`test/api/_inprocess.js`).
- **Location:** `test/suite/webmail-test.js`.
- **Coverage Areas:**
  - User login (`POST /auth` via WildDuck API) with 2FA TOTP challenge support and session creation.
  - Listing mailboxes with unread counters, listing messages in Inbox, and reading a message verifies that malicious `<script>` or `<img onerror=...>` tags in HTML emails are stripped by `webSafeHtml()`.
  - Composing and submitting an email (`POST /users/:user/submit`) stores the sent message and enqueues delivery.
  - Updating user settings (autoreply, forwarding, filter rules, UI language preference) persists via WildDuck REST API.

## Boundaries

- **Always:**
  - Pass every HTML email body through `webSafeHtml()` (`lib/mcp-html.js`) before rendering to prevent XSS and tracking pixels.
  - Stream attachment downloads and uploads rather than buffering unbounded payloads in memory.
  - Scope every API request to the authenticated user's own session token (`req.session.accessToken`).
- **Ask first:**
  - Adding rich-text JS libraries if native HTML5 contenteditable/toolbar + plain-text/HTML toggle is insufficient.
- **Never:**
  - Render unsanitized email HTML or allow remote tracking images to load automatically without explicit user action.
  - Use an admin master token to execute end-user webmail requests.

## Success Criteria

- Navigating between folders, searching messages, opening emails, marking read/unread/flagged, moving to Trash, and composing/sending mail all occur via smooth HTMX partial swaps without full-page reloads.
- Malicious HTML payloads in incoming emails (`<script>`, `onload=`, `javascript:` URLs) are 100% stripped on render.
- Users can configure Autoreply, Forwarding, Mail Filters, TOTP 2FA, and Application-Specific Passwords (ASPs) directly from the Webmail Settings modal.
- Both English (`en`) and Vietnamese (`vi`) translations are complete across all Webmail screens.

## Open Questions

- None for `webmail`.
