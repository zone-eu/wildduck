# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WildDuck is a scalable, no-SPOF IMAP/POP3 mail server built with Node.js. It uses MongoDB for storage (with sharding/replication support), Redis for pubsub/caching, and provides a comprehensive REST API for management.

**Dual Role**: WildDuck serves as both a standalone application AND a library. External mail components (Haraka, ZoneMTA) import WildDuck's handlers via `@zone-eu/wildduck/lib/*` to share the same database and business logic.

## Common Commands

```bash
# Run all tests (drops test DB, flushes Redis, then runs tests)
npm test

# Run protocol tests only (no MongoDB required)
npm run test:proto

# Run tests without DB cleanup
npm run runtest

# Show effective configuration
npm run printconf

# Start the server
npm start

# Generate API documentation
npm run apidoc
```

### Running Individual Tests

```bash
# Unit tests (no server needed)
NODE_ENV=test ./node_modules/.bin/mocha imap-core/test/imap-parser-unit.js

# API tests (requires server running separately: node server.js)
NODE_ENV=test ./node_modules/.bin/mocha test/api-test.js
```

## Architecture

### Entry Points

- `server.js` - Main application, starts all services
- `api.js` - REST API server (Restify-based)
- `imap.js` - IMAP protocol server
- `pop3.js` - POP3 protocol server
- `lmtp.js` - LMTP handler for incoming mail
- `worker.js` - Background worker processes
- `tasks.js` - MongoDB-based task queue processor
- `webhooks.js` - Webhook delivery service (BullMQ)
- `indexer.js` - ElasticSearch indexing service (BullMQ)

### Core Handlers (lib/)

- **UserHandler** (`lib/user-handler.js`) - User management, authentication, 2FA (TOTP, WebAuthn)
- **MessageHandler** (`lib/message-handler.js`) - Message storage, parsing, PGP encryption
- **MailboxHandler** (`lib/mailbox-handler.js`) - Mailbox CRUD operations
- **StorageHandler** (`lib/storage-handler.js`) - Attachment/file storage with deduplication
- **FilterHandler** (`lib/filter-handler.js`) - Email filtering rules engine
- **AuditHandler** (`lib/audit-handler.js`) - Audit logging
- **SettingsHandler** (`lib/settings-handler.js`) - System-wide settings (quotas, limits)
- **DkimHandler** (`lib/dkim-handler.js`) - DKIM key management
- **CertHandler** (`lib/cert-handler.js`) - TLS certificate management, ACME
- **TaskHandler** (`lib/task-handler.js`) - MongoDB-based task queue management

### Handler Async Pattern

Handlers support dual callback/promise API:
```javascript
// Callback style
handler.resolveAddress(address, options, callback);
// Promise style (prefix with 'async')
await handler.asyncResolveAddress(address, options);
```

### API Routes

REST API routes in `lib/api/` (23 modules): users, addresses, mailboxes, messages, filters, 2fa (totp, webauthn, custom), webhooks, storage, submit, audit, settings, health, acme, dkim, certs, asps, domainaccess, domainaliases, autoreply, updates.

### IMAP Core (`imap-core/lib/`)

Modular IMAP4rev1 protocol implementation with stream-based design.

**Core Files**:
- `imap-server.js` - Server setup, TLS/SNI, socket handling
- `imap-connection.js` - Per-connection state, session, notifications
- `imap-stream.js` - Incoming command parser (writable stream)
- `imap-composer.js` - Response formatter (transform stream, DEFLATE support)
- `imap-command.js` - Command dispatcher
- `search.js` - SEARCH query matching (20+ criteria)
- `imap-tools.js` - Utilities, system flags

**Handler** (`handler/`):
- `imap-parser.js` - Tokenizes commands → `{tag, command, attributes[]}`
- `imap-compiler.js` - Objects → IMAP wire format
- `imap-formal-syntax.js` - Protocol validation rules

**Indexer** (`indexer/`):
- `indexer.js` - Message size calc, RFC822 rebuilding, body extraction
- `parse-mime-tree.js` - MIME structure parsing
- `body-structure.js` - BODYSTRUCTURE response generation
- `create-envelope.js` - ENVELOPE response generation

**Commands** (`commands/`) - 36 implementations:
- Auth: LOGIN, AUTHENTICATE, STARTTLS, LOGOUT
- Mailbox: LIST, LSUB, CREATE, DELETE, RENAME, SELECT, EXAMINE, STATUS
- Messages: FETCH, STORE, COPY, MOVE, APPEND, EXPUNGE, SEARCH (+ UID variants)
- Other: IDLE, COMPRESS, GETQUOTA, NAMESPACE, ID, XAPPLEPUSHSERVICE

**Command Handler Pattern**:
```javascript
module.exports = {
    state: 'Selected',           // Required: 'Not Authenticated'|'Authenticated'|'Selected'
    schema: [{name, type}],      // Parameter validation
    handler(command, callback) { // this = IMAPConnection
        this._server.onFetch(mailbox, options, this.session, callback);
    }
};
```

**Server Callbacks** (set on IMAPServer, called by commands):
- `onAuth(login, session, cb)` - LOGIN/AUTHENTICATE
- `onList/onLsub(ref, path, session, cb)` - LIST/LSUB
- `onOpen(path, session, cb)` - SELECT/EXAMINE
- `onFetch/onSearch/onStore(mailbox, options, session, cb)` - Message ops
- `onCopy/onMove/onExpunge(mailbox, options, session, cb)` - Message manipulation
- `onCreate/onRename/onDelete(path, session, cb)` - Mailbox ops
- `onAppend(path, flags, date, session, cb)` - Message upload
- `onSubscribe/onUnsubscribe(path, session, cb)` - Subscriptions
- `onGetQuota/onGetQuotaRoot(path, session, cb)` - Quota
- `onConnect/onClose(session, cb)` - Lifecycle

**Session Object** (available in callbacks):
```javascript
session = {
    id, remoteAddress, user: {id, username},
    selected: {mailbox, uidList, modifyIndex, readOnly},
    formatResponse(), getQueryResponse(), matchSearchQuery()
}
```

**Constants**:
- Socket timeout: 5min 37sec
- Max bad commands: 50 (then disconnect)
- Max literal size: 1MB
- Max parser depth: 25 levels

### Data Flow

**Incoming Mail** (production):
```
Internet → Haraka (SMTP) → haraka-plugin-wildduck → FilterHandler → MongoDB
```
- Haraka plugin validates recipients, performs SPF/DKIM/DMARC/ARC verification
- Stores messages via `filterHandler.storeMessage()`
- Handles forwarding/autoreplies by queuing to `zone-queue` collection
- LMTP (`lmtp.js`) is for testing only, not production

**Outgoing Mail**:
```
IMAP APPEND / API submit → MongoDB (zone-queue) → ZoneMTA → zonemta-wildduck → Internet
```
- Messages queued to `zone-queue` collection (GridFS-backed)
- ZoneMTA plugin validates From: address, enforces recipient rate limits
- Signs with DKIM keys from WildDuck database
- Uploads sent messages to user's Sent folder

**Client Access**:
- IMAP/POP3 clients → authenticate via UserHandler → access mailboxes/messages
- REST API → handlers modify MongoDB → Redis pubsub notifies connected IMAP clients

### Related Repositories (use WildDuck as library)

Both plugins import WildDuck handlers via `@zone-eu/wildduck/lib/*`, instantiate them with shared MongoDB/Redis connections, and operate on the same database:

**haraka-plugin-wildduck** - Incoming mail delivery:
```javascript
const FilterHandler = require('@zone-eu/wildduck/lib/filter-handler');
const UserHandler = require('@zone-eu/wildduck/lib/user-handler');
const Maildropper = require('@zone-eu/wildduck/lib/maildropper');
// Stores messages via: filterHandler.storeMessage(userData, options)
```

**zonemta-wildduck** - Outgoing mail processing:
```javascript
const MessageHandler = require('@zone-eu/wildduck/lib/message-handler');
const UserHandler = require('@zone-eu/wildduck/lib/user-handler');
const DkimHandler = require('@zone-eu/wildduck/lib/dkim-handler');
// Uploads to Sent folder, retrieves DKIM keys, validates users
```

### IMAP Handler Integration (`imap.js`)

WildDuck implements imap-core callbacks as handler factories in `lib/imap-handler/`:
```javascript
// Handler factory pattern - returns callback function
server.onFetch = require('./lib/imap-handler/on-fetch')(server, messageHandler, userCache);
server.onAuth = require('./lib/imap-handler/on-auth')(server, userHandler);
// ... etc for all callbacks
```

Key handler files: `on-auth.js`, `on-fetch.js`, `on-store.js`, `on-copy.js`, `on-move.js`, `on-append.js`, `on-create.js`, `on-delete.js`, `on-list.js`, `on-open.js`, `on-search.js`, `on-expunge.js`

## Background Job Systems

WildDuck uses **three distinct job systems**:

### 1. MongoDB Task Queue (`tasks.js`, `lib/task-handler.js`)

Custom task queue using MongoDB for persistence and Redis (`ioredfour`) for distributed locking. Handles long-running, critical operations that must survive restarts.

**Task Types**: `user-delete`, `restore`, `quota`, `audit`, `acme`, `acme-update`, `clear-folder`, `search-apply`, `user-indexing`, `run-migrations`

**Key Methods**:
```javascript
taskHandler.add(type, data, options)       // Add new task
taskHandler.ensure(type, matchQuery, data) // Upsert (deduplicate)
taskHandler.getNext()                      // Get and lock next task
taskHandler.release(task, completed)       // Complete or requeue
taskHandler.keepAlive(task)                // Refresh lock TTL
```

**Task States**: `waiting` → `active` → completed/requeued

### 2. BullMQ Webhook Queues (`webhooks.js`, `lib/events.js`)

Redis-based queues for event-driven webhook delivery:

- **`webhooks` queue** - Receives events from `lib/events.js`, matches against webhook configurations
- **`webhooks_post` queue** - Actual HTTP POST delivery with exponential backoff retry

**Event Flow**: Handler calls `events.publish()` → `webhooks` queue → lookup matching webhooks → `webhooks_post` queue → HTTP POST

### 3. BullMQ Indexing Queues (`indexer.js`)

Redis-based queues for ElasticSearch synchronization:

- **`live_indexing`** - Real-time indexing triggered by MongoDB change streams on `journal` collection
- **`backlog_indexing`** - Bulk historical indexing triggered by `user-indexing` task

**Feature-gated**: Requires user in Redis set `feature:indexing`

## MongoDB Collections

**Core**: `users`, `addresses`, `addressregister`, `mailboxes`, `messages`, `threads`, `filters`, `autoreplies`

**Auth/Security**: `authlog` (TTL indexed), `asps` (app-specific passwords), `audits`

**System**: `settings`, `tasks`, `dkim`, `certs`, `domainaccess`, `domainaliases`, `journal`, `webhooks`

**Archival**: `archived` (deleted messages), `deletedusers`

**Outgoing Mail**: `zone-queue` (ZoneMTA queue for outbound messages, forwards, autoreplies)

**GridFS Buckets**: `audit.files`, `storage.files`, `attachments.files`

## Redis Usage

### Key Patterns

**Caching**:
- `cached:<userId>` - User profile hash (1hr TTL, via `lib/user-cache.js`)
- `total:<mailboxId>` / `unseen:<mailboxId>` - Mailbox message counts (24hr TTL)

**Rate Limiting**:
- `idw:<userId>` / `iup:<userId>` - IMAP download/upload counters (24hr window)
- `wdr:<userId>` - Outgoing recipients counter (24hr window, used by ZoneMTA plugin)
- `wda:<senderId>` - Autoreply frequency counter
- `wdf:<visitorId>` - Forward rate limit counter (used by Haraka plugin)
- `lim:<service>` - Connection limits hash (per-user counts for IMAP, POP3, etc.)
- `rl:rcpt:<visitorId>` - Incoming recipient rate limit (Haraka plugin)
- `auth_user:<tokenId>` - Auth failure counter (120s window)
- `totp:<userId>` - TOTP failure counter (180s window)

**2FA/WebAuthn**:
- `challenge:<userId>:reg:<challenge>` - Registration challenge (1hr TTL)
- `challenge:<userId>:auth:<challenge>` - Authentication challenge (1hr TTL)
- `totp:<userId>:<token>` - Used TOTP token tracker (180s TTL)

**Feature Flags**:
- `feature:indexing` - Set of users with ElasticSearch enabled

**Distributed Locks** (via `ioredfour`):
- `d:lock:op:<domain>` - ACME certificate operation lock (10min hold)
- `d:lock:safe:<domain>` - Failsafe block after renewal error (1hr TTL)

**Pub/Sub**:
- `wd_events` - IMAP notification channel (JSON: `{e: "userId", p: {...}}`)

**BullMQ Queues** (prefix `wd:bull`):
- `webhooks`, `webhooks_post`, `live_indexing`, `backlog_indexing`

### Lua Scripts (`lib/lua/`, registered in `lib/counters.js`)

**ttlcounter** - Sliding window rate limiter
```javascript
redis.ttlcounter(key, increment, limit, windowSeconds)
// Returns [success (0/1), currentValue, ttlRemaining]
```

**cachedcounter** - Counter with TTL extension (deletes if negative)
```javascript
redis.cachedcounter(key, increment, ttlSeconds)
// Returns currentSum or nil
```

**limitedcounter** - Per-entry hash counter with client versioning (handles restarts)
```javascript
redis.limitedcounter(hashKey, entryId, increment, limit, clientVersion)
// Returns [success (0/1), currentCount]
```

**processlock** - Distributed lock with identifier matching
```javascript
redis.processlock(key, identifier, ttlSeconds)
// Returns 1 (renewed), 2 (created), or nil (held by other)
```

## Key Constants and Limits

From `lib/consts.js` and settings:
- Message size: 64 MB max
- Attachment size: 25 MB max
- Mailboxes: 1500 max per user, 128 levels deep
- Storage: 1 GB default per user
- Recipients: 2000/day, 400 per message
- Forwards: 2000/day
- Auth lockout: 12 failures in 120s
- TOTP lockout: 6 failures in 180s
- Archive retention: 25 days
- Autoreply interval: 4 hours between same-sender

## API Development Patterns

### Route Structure
```javascript
server.post({
    path: '/users/:user/mailboxes',
    summary: 'Create Mailbox',
    tags: ['Mailboxes'],
    validationObjs: {
        requestBody: { /* Joi schema */ },
        pathParams: { /* Joi schema */ },
        queryParams: { /* Joi schema */ },
        response: { /* Joi schema */ }
    }
}, tools.responseWrapper(async (req, res) => { ... }));
```

### Key Conventions
- Always wrap handlers with `tools.responseWrapper()` for error handling
- Validate with Joi schemas in `validationObjs`
- Use `roles.can(req.role).readOwn('resource')` for permissions
- Apply `permission.filter(data)` to sensitive response data
- Success: `{ success: true, id: "..." }`
- Error: `{ error: "message", code: "ErrorCode", details: {...} }`

### Schemas Location
- Request schemas: `lib/schemas/request/`
- Response schemas: `lib/schemas/response/`
- Common schemas: `lib/schemas/index.js` (`sessSchema`, `booleanSchema`, `metaDataSchema`)

## Utilities

- `lib/tools.js` - `normalizeAddress()`, `responseWrapper()`, `validationErrors()`, `getWildcardAddresses()`
- `lib/counters.js` - Redis Lua scripts for rate limiting
- `lib/user-cache.js` - Redis-backed user profile caching
- `lib/imap-notifier.js` - Event aggregation (100ms batching)
- `lib/events.js` - Webhook event publishing (`events.publish()`)
- `lib/consts.js` - System constants and limits
- `lib/redis-url.js` - Redis URL parser for connection strings

## Configuration

Uses TOML configuration via `@zone-eu/wild-config`. Files in `config/`:
- `default.toml` - Base configuration
- `development.toml` / `test.toml` - Environment overrides
- Separate configs: `dbs.toml`, `imap.toml`, `pop3.toml`, `api.toml`, `tls.toml`, `lmtp.toml`

Environment variables can override config values.

## Code Style

- ESLint with `nodemailer` + `prettier` configs
- Prettier: 160 char width, 4-space tabs, single quotes, no trailing commas
- Conventional commits with ticket refs (e.g., `fix(imap): ZMSA-67: description`)

## Testing

Framework: Mocha + Chai + Supertest

### Test Commands

```bash
npm test          # Full: drop DB + flush Redis + lint + server + all tests
npm run runtest   # Run tests without DB cleanup (NODE_ENV=test grunt)
npm run test:proto # Protocol tests only - no server/DB needed (fast)
```

### Grunt Test Workflow

The default Grunt task runs this sequence:
1. **eslint** - Lint all source files
2. **shell:server** - Start WildDuck server in background (`node server.js`)
3. **wait:server** - Wait 12 seconds for server initialization
4. **mochaTest** - Run all test suites sequentially
5. **shell:server:kill** - Terminate background server (SIGKILL)

### Test Suites (Grunt mochaTest targets)

| Target | Files | Requires Server |
|--------|-------|-----------------|
| `imap` | `imap-core/test/**/*-test.js` | Yes |
| `imap-unit` | Parser, compiler, indexer, search tests | No |
| `pop3` | `test/pop3-*-test.js` | No |
| `api` | `test/**/*-test.js` | Yes |

**`grunt proto`** runs only `imap-unit` + `pop3` (no server needed, fast).

### Test Configuration (`config/test.toml`)

- MongoDB: `mongodb://127.0.0.1:27017/wildduck-test`
- Redis: `redis://127.0.0.1:6379/13`
- API port: 8080
- IMAP port: 9993
- LMTP port: 2424

### Test Locations

- API/integration: `test/api-test.js`, `test/filtering-test.js`
- POP3 protocol: `test/pop3-*.js`
- IMAP protocol: `imap-core/test/`
- Unit tests: `imap-core/test/*-unit.js`, `test/filtering-tools-test.js`
- Fixtures: `test/fixtures/`, `imap-core/test/fixtures/`
- Global hooks: `test/_globals-test.js` (collects test metadata for coverage report)

### Test Naming Convention

API tests use format: `"METHOD /path expect success"` or `"METHOD /path expect failure"`

### Writing Tests

**API tests** (require running server):
```javascript
const supertest = require('supertest');
const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Users API', function() {
    this.timeout(10000);
    let userId;

    before(async () => {
        // Create test data
        const res = await server.post('/users').send({...}).expect(200);
        userId = res.body.id;
    });

    after(async () => {
        // Cleanup
        await server.delete(`/users/${userId}`).expect(200);
    });

    it('should GET /users/:user expect success', async () => {
        const response = await server.get(`/users/${userId}`).expect(200);
        expect(response.body.success).to.be.true;
    });
});
```

**Unit tests** (no server):
```javascript
const expect = require('chai').expect;
const parser = require('../lib/handler/imap-parser');

describe('IMAP Parser', () => {
    it('should parse command', () => {
        const result = parser('A1 LOGIN user pass');
        expect(result.command).to.equal('LOGIN');
    });
});
```
