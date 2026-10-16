# Repository Guidelines

This is the working guide for coding agents and contributors. Follow the repository's established patterns and verify behavior against the current code. Keep this guide current when development changes its commands, runtime requirements, architecture, or conventions.

Verified against the local WildDuck 1.52.0 checkout on 2026-10-12. `package.json`, `Gruntfile.js`, configuration, and implementation are the source of truth when this snapshot becomes stale.

## Agent Workflow and Delegation

- Inspect nearby code and `git status --short` before editing. Preserve unrelated local changes, untracked files, and generated artifacts owned by other work.
- Use `rg` and bounded reads. Batch independent searches and tool calls; return relevant excerpts instead of dumping entire files or test logs.
- **Use cheaper subagents for independent, bounded routine work when it saves time or tokens.** This is a standing request to delegate suitable work; no additional user confirmation is needed within the authorized task.
- Default routine subagents to `gpt-6-luna` with `low` reasoning when available. Suitable tasks include locating call sites, checking paths and scripts, summarizing focused test failures, mechanical edits with explicit instructions, and checking documentation against code. If unavailable, select an available low-cost model capable of the task; do not invent model IDs.
- When the tool supports it, use `fork_turns="none"` for routine jobs and pass only the goal, relevant repository rules, allowed files, acceptance criteria, and necessary context. Request a concise result with file/line evidence and checks run. Avoid copying the full conversation or repeatedly delegating the same inspection.
- Keep architecture decisions, ambiguous debugging, authentication/security changes, concurrency and data integrity reasoning, and final integration/review with the primary agent or an appropriately capable model. Escalate a routine subtask when its assumptions prove unclear.
- Assign non-overlapping write scopes, with one writer per file at a time. Agents share a workspace; coordinate dependent edits and tests that share MongoDB, Redis, or listening ports. Prefer parallel reads when write scopes overlap.
- Delegate only when the work outweighs spawning and coordination overhead. Avoid unnecessary agents, recursive delegation, and duplicate work. The primary agent reviews changes and remains responsible for verification and the final result.

Model selection and delegation guidance: [official OpenAI subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Project and Repository Map

WildDuck is a Node.js IMAP/POP3 mail server and REST API backed by MongoDB and Redis. It runs as a standalone server and as a shared library imported through `@zone-eu/wildduck/lib/*` by other mail components. The current engine requirement is **Node.js >=22.19.0**; check `package.json` before changing runtime assumptions. The project uses CommonJS.

| Location | Responsibility |
| --- | --- |
| `server.js`, `worker.js` | Main launcher and worker service startup |
| `api.js`, `lib/api/` | Restify API wiring and resource routes |
| `imap.js`, `pop3.js`, `lmtp.js` | Protocol services; LMTP is commonly used for local/testing delivery |
| `mcp.js`, `lib/mcp-*.js` | Independent read-only MCP service, API client, tools, and credentials |
| `prometheus.js`, `lib/metrics.js`, `lib/metrics-config.js` | Metrics listener, instrumentation, and configuration |
| `tasks.js`, `lib/task-handler.js`, `lib/tasks/` | Durable MongoDB tasks and their implementations |
| `webhooks.js`, `lib/events.js` | BullMQ event matching and webhook delivery |
| `indexer.js` | Search indexing queues; separate from the MIME indexer |
| `lib/*-handler.js` | User, message, mailbox, storage, filter, audit, settings, DKIM, certificate, and BIMI business logic |
| `lib/label-handler.js` | Persistent label identity, allocation, and IMAP flag mapping |
| `lib/attachment-storage.js`, `lib/attachments/` | Attachment catalog, GridFS/S3 backends, locks, and base64 codec |
| `lib/handlers/on-*.js` | Factories adapting IMAP callbacks to application handlers |
| `lib/schemas.js`, `lib/schemas/`, `lib/roles.js` | Shared/request/response Joi schemas and access control |
| `lib/lua/`, `lib/counters.js` | Redis scripts and registered counter/lock helpers |
| `imap-core/lib/`, `imap-core/test/` | Reusable protocol implementation, MIME indexer, and protocol tests |
| `test/`, `test/api/`, `test/fixtures/` | Application units, API/integration tests, and deliberate fixtures |
| `config/`, `indexes.yaml`, `migrations/` | TOML configuration, MongoDB indexes, database/user migrations |
| `scripts/migrate-attachments-to-s3.js` | Attachment migration, verification, and separate cleanup operations |
| `bin/access-tokens`, `bin/mcp-tokens` | Token administration CLIs |
| `docs/`, `plugins/`, `assets/`, `graphics/`, `public/` | Documentation, plugins, and static/public assets |

Production incoming mail normally flows through Haraka and `haraka-plugin-wildduck` into filtering and message storage. Submitted outbound mail enters the MongoDB `zone-queue` and is processed by ZoneMTA integrations. Ordinary IMAP APPEND stores a message; do not assume every APPEND submits outbound mail. Handler changes must remain compatible with library consumers such as `zonemta-wildduck`.

## Code Style

Use **`lib/api/messages.js` as a concrete style reference**, along with the code immediately surrounding the change. Its API handlers show the current schema, validation, permission, database, and response patterns. Follow maintained patterns; check for deprecation before copying older code.

- Use `'use strict';`, `require()`, and `module.exports`. Keep imports near the top, destructure related helpers where useful, and follow nearby dependency ordering. Do not migrate files to ESM as an incidental change.
- Use dependency-injected factories/classes rather than introducing global dependencies. API modules receive handlers and database connections from their caller.
- Match `.prettierrc.js`: 4-space indentation, single quotes, LF, no trailing commas, `printWidth: 160`, and `arrowParens: 'avoid'`. ESLint extends `nodemailer` and `prettier` through `.eslintrc`.
- Use camelCase for variables/functions, PascalCase for classes, and the existing uppercase convention for shared constants. Use descriptive names such as `messageData`, `mailboxData`, `requestBody`, and `pathParams`.
- Use `const` for imports and fixed bindings and `let` for reassigned values; respect surrounding conventions without rewriting unrelated declarations. Do not introduce `var`.
- Use object shorthand, destructuring, template literals, and spread where they make the code clearer. Split large schemas, queries, and response objects into readable blocks; preserve the surrounding field order and formatting.
- Prefer small helpers and early returns for invalid input, missing records, and errors. Comments should explain behavior or constraints, especially protocol quirks, races, and compatibility requirements.
- Use `async`/`await` for promise-based logic and database operations. Keep required public callback signatures, including IMAP command handlers and adapters. A callback interface is not automatically deprecated.
- Reuse existing promise wrappers or native async methods. For a callback-only handler, bind its receiver when using `util.promisify()`, as `messages.js` does for `messageHandler.put` and `messageHandler.update`. Do not promisify a method that already returns a promise.
- Handler naming varies: some have `asyncX` wrappers and others use `XAsync`. Inspect the handler rather than guessing its method name or return shape. Preserve error-first callbacks, multiple callback results, and exactly-once completion.
- Catch errors where they can be translated or handled, preserve stable error codes, and return after sending an error response or completing a callback. Do not silently swallow failures or report a partially completed operation as successful.
- Use targeted MongoDB projections and existing pagination helpers (`mongopagingFindWrapper`, `mongopagingAggregateWrapper`) where applicable. Preserve user/mailbox scoping, shared `DB_MAX_TIME_*` limits, and index-friendly queries. Avoid loading unbounded collections with `toArray()`.
- Keep large message and attachment paths streaming. Reuse `pipeline` or `stream/promises` and the existing teardown/error handling; release storage reads when clients disconnect. Preserve byte counts, backpressure, and failure propagation.
- Tests use `*-test.js`; IMAP adapters use `on-*.js`; API route modules follow resource names. Keep commits and formatting scoped to the requested work.

### Avoid Deprecated APIs

- Do not introduce or expand usage of deprecated Node.js, MongoDB, dependency, or WildDuck APIs. Check local JSDoc, installed dependency types/docs, and maintained call sites for a supported replacement. Verify against the installed version instead of assuming a newer library's behavior.
- Use `messageHandler.encryptMessageAsync()` for new encryption calls. `messageHandler.encryptMessage()` is explicitly deprecated and retained for external consumers; its compatibility wrapper is not the pattern for new code.
- Use promise-based MongoDB calls in new code; driver callback overloads are deprecated. Preserve callback-based WildDuck interfaces by adapting at their boundary instead of adding deprecated driver calls.
- Use explicit MongoDB methods such as `updateOne`/`updateMany`, `deleteOne`/`deleteMany`, `countDocuments` or `estimatedDocumentCount` as appropriate, and `createIndex`. Do not add legacy `update`, `remove`, `count`, or `ensureIndex` collection APIs. These restrictions concern the driver, not similarly named WildDuck handlers or `Map`/`Set` methods.
- Use `ObjectId`, `Buffer.from()`, and `Buffer.alloc()` rather than legacy aliases or `new Buffer()`. Preserve the intended encoding and allocation semantics.
- Configure metrics through top-level `[metrics]`; `[api.metrics]` is a deprecated compatibility path.
- When replacing deprecated behavior, preserve signatures and semantics needed by callers and verify the affected behavior. Keep external compatibility wrappers until a deliberate migration removes them; do not undertake unrelated mass migrations.

## REST API Conventions

Follow the route pattern in `lib/api/messages.js`:

1. Define route `path`, `name`, `summary`, `description`, `tags`, and `validationObjs` as applicable. Include `requestBody`, `pathParams`, `queryParams`, and status-keyed response schemas. Reuse `lib/schemas.js` and the request/response schema modules.
2. Wrap async routes with `tools.responseWrapper()`. Follow nearby JSON handlers' `res.charSet('utf-8')` and `res.json(...)` convention.
3. Build the Joi object from `req.route.spec.validationObjs` and validate `req.params` with the route's conversion/unknown-field policy. Typically `abortEarly: false` and `convert: true` are used. Operate on `result.value`, and construct `ObjectId` values only after validation.
4. On validation failure, set status 400 and return `{ error: result.error.message, code: 'InputValidationError', details: tools.validationErrors(result) }`.
5. Enforce access with `req.validate(roles.can(req.role)...)`, distinguishing own/any permissions using the authenticated user and validated target user. Include ownership in database queries and apply permission-based response filtering where required by the resource.
6. Keep response shapes and error codes stable: success objects commonly use `{ success: true, id: '...' }`; failures use `{ error, code }` with `details` when relevant. Use the appropriate HTTP status and return immediately after sending a response.
7. Update generated API documentation for public route/schema changes. `npm run generate-api-docs` uses current route specs and `config/apigeneration.json` to write `docs/api/openapidocs.json`; `docs/api/index.html` is the static viewer for that spec. `npm run apidoc` invokes a separate source-comment CLI that is not declared in the current package dependencies. Review generated diffs and use the generator appropriate to the docs being changed.

## Behavior and Compatibility Constraints

### IMAP and MIME

- `imap-core/lib/commands/` modules declare state, schema, and a handler bound to the connection. `imap.js` wires callbacks to factories in `lib/handlers/`. Preserve selected mailbox state, UID/sequence semantics, flags, notifications, and callback contracts.
- Parser/compiler behavior lives under `imap-core/lib/handler/`; connections, input, and output are managed by `imap-connection.js`, `imap-stream.js`, and `imap-composer.js`.
- MIME parsing/rebuilding lives under `imap-core/lib/indexer/`, including `parse-mime-tree.js`, `tree-walker.js`, `indexer.js`, `body-structure.js`, and `create-envelope.js`. New trees use v2; persisted trees without `v` are v1 and retain legacy rendering behavior.
- Preserve exact RFC822 bytes, CRLF handling, MIME boundaries, preambles/epilogues, literal lengths, partial FETCH ranges, BODYSTRUCTURE, and ENVELOPE output. Size calculations must agree with the bytes emitted.
- Treat `imap-core/test/fixtures/legacy-v1/` and `legacy-v1-trees.json` as frozen references. Do not edit or regenerate them from current code. A deliberate legacy behavior change needs a documented reason in its regression tests.
- Preserve literal admission checks and the `maxMB`, `maxLineLength`, and `maxLiterals` limits in `config/imap.toml`. Cover synchronizing/non-synchronizing literals and command-line boundaries when changing parsing.

### Attachments, Labels, and Notifications

- Attachments can live in GridFS, S3, or both. `config/attachments.toml` selects the preferred backend for new hashes; existing records determine their read backend through catalog metadata. `attachments.files` remains the deduplication/reference catalog, even for S3 payloads.
- Preserve reference counts, checksums, lock ownership, generation-specific S3 keys, and safe orphan collection. Backend-aware code/configuration must reach all readers and external library consumers before introducing S3 records. See `docs/in-depth/s3-attachment-storage.md` and `docs/in-depth/attachment-deduplication.md` for migration and storage details.
- Labels persist in the `labels` collection and messages store label IDs. Reuse `lib/label-handler.js`; preserve reserved names, allocation limits, deleting-state behavior, label counters, and the `$wdlabel$<id>` IMAP bridge. Label deletion uses `lib/tasks/label-delete.js`.
- Label counter APIs default to `searchable=true`; library helpers default to all mailboxes. Keep searchable/all and total/unseen caches separate. Update streams emit `FLAG_COUNTERS` for flagged and unread. `LABEL_COUNTERS` uses searchable counts and includes the active user-owned `labelId` alongside the name, preserving IDs across renames and excluding deleting labels from ID lookup.
- Flag counters use `/users/:user/flag-counters/:flag` with lowercase `seen`, `answered`, `flagged`, `deleted`, `draft` or `unread`, returning `flag`, `total`, and `unseen`. For `unread`, total and unseen are equal; for `seen`, unseen is always zero. `/users/:user/flagged-counter` remains a compatibility alias for `flagged` with its original response shape. Both endpoints default to `searchable=true`, excluding Junk, Trash, and messages without `searchable: true`; `searchable=false` counts all user mailboxes. Account counter caches must be invalidated for message additions, removals, mailbox deletion, and flag updates.
- Message/mailbox changes must keep flags, quota, counters, Redis notifications, and published webhook events consistent. Inspect `lib/imap-notifier.js`, `lib/events.js`, and the relevant handler before adding a direct database update.
- Apple push uses XAPPLEPUSHSERVICE, `lib/apn-client.js`, notifier integration, and push-subscription API routes. Preserve validation, subscription ownership, and notification behavior when changing these paths.

### MCP and Metrics

- MCP is an independent, disabled-by-default, read-only Streamable HTTP service. Tools access the REST API through `lib/mcp-api-client.js`; preserve its validation, permission, audit, and scope checks instead of introducing direct MongoDB reads. See `docs/in-depth/mcp.md`.
- MCP credentials use the `wdmcp_` prefix, `lib/mcp-token-handler.js`, the `mcptokens` users-database collection, and dedicated Redis sessions. Preserve bearer-only transport, user binding, expiry, revocation, 2FA, and MCP-only authentication behavior.
- Metrics run on their own listener through `prometheus.js` and top-level `[metrics]`. Preserve startup/service status instrumentation and bounded metric label cardinality; avoid user IDs, addresses, or message IDs as metric labels.

## State, Queues, and Configuration

MongoDB connection roles can differ: `lib/db.js` exports `database`, `users`, `senderDb`, and `gridfs`. Use the connection appropriate to the handler and data. Check `indexes.yaml` and `migrations/database/` or `migrations/users/` for document/query changes.

- Core collections include `users`, `addresses`, `addressregister`, `mailboxes`, `messages`, `threads`, `labels`, `filters`, and `autoreplies`.
- Auth/security includes `authlog`, `asps`, `mcptokens`, and `audits`; archival data includes `archived` and `deletedusers`. GridFS buckets include `audit.files`, `storage.files`, and `attachments.files`; outbound mail uses `zone-queue`.
- Durable jobs use `tasks.js` and `lib/task-handler.js`: `add`, `ensure`, `getNext`, `release`, and `keepAlive`. Types include `user-delete`, `restore`, `quota`, `audit`, `acme`, `acme-update`, `clear-folder`, `search-apply`, `user-indexing`, `run-migrations`, `mailbox-retention`, and `label-delete`.
- BullMQ webhook queues are `webhooks` (matching) and `webhooks_post` (delivery/retry). Search queues are `live_indexing` and `backlog_indexing`; inspect their feature gating before adding synchronization.
- Redis key names and TTLs are runtime contracts. Important families include `cached:<userId>`, `total:<mailboxId>`, `unseen:<mailboxId>`, `idw:<userId>`, `iup:<userId>`, `wdr:<userId>`, `wda:<senderId>`, `wdf:<visitorId>`, `lim:<service>`, `auth_user:<tokenId>`, `totp:<userId>`, WebAuthn `challenge:*`, `feature:indexing`, and notification channel `wd_events`. Inspect existing label and MCP key helpers before adding keys.

Configuration uses TOML through `@zone-eu/wild-config`: `config/default.toml`, `config/dbs.toml`, the service files, `config/attachments.toml`, `config/mcp.toml`, `config/metrics.toml`, and `config/plugins/*.toml`. Check shared settings and effective configuration when changing defaults. `npm run printconf` prints effective configuration and can include secrets; do not paste it wholesale into logs or reports.

## Commands and Verification

Use focused checks while iterating, then the relevant broader suite. Do not run expensive corpus, coverage, or mutation checks repeatedly unless the change or a failure warrants them.

| Command | Purpose / requirements |
| --- | --- |
| `npm start` | Start `server.js` with configured services |
| `npm run printconf` | Print effective configuration with `NODE_CONFIG_ONLY=true` |
| `NODE_ENV=test ./node_modules/.bin/eslint lib/api/messages.js` | Focused lint; substitute the changed JavaScript files |
| `NODE_ENV=test ./node_modules/.bin/mocha imap-core/test/imap-parser-test.js` | Focused in-process protocol test |
| `NODE_ENV=test ./node_modules/.bin/mocha test/api/messages-test.js` | Focused API test; needs a test server and MongoDB/Redis |
| `npm run test:proto` | Selected in-process IMAP, POP3, and application unit tests; no MongoDB/Redis server required |
| `npm run test:indexer` | MIME parser/rebuilder, fidelity, ranges, legacy, corpus, and attachment-codec suites |
| `npm run test:indexer-coverage` | Indexer/codec/length-limiter coverage |
| `npm run test:attachments` | Attachment and COPY/UID suites; includes integration tests needing MongoDB/Redis and optional S3 |
| `npm run test:attachments-coverage` | Storage/backend and S3 migration coverage |
| `npm run test:mutation` | MIME/indexer/codec mutation checks; see `imap-core/test/mutation/run.js` |
| `npm run runtest` | Full Grunt workflow without an initial database/Redis reset; tests still modify test state |
| `npm test` | Drop `wildduck-test`, flush Redis DB 13, then run `runtest` |
| `npm run runci` | Print configuration, then run `runtest` |
| `npm run generate-api-docs` | Generate API docs using route/schema specs through `server.js` |
| `npm run apidoc` | Separate source-comment doc generator; requires the `apidoc` CLI to be installed |

`npm test` destroys test state. Verify the target databases and configuration before using it; do not use production connections for testing. Avoid `npm run update` for routine development: it removes `node_modules` and `package-lock.json` and upgrades dependencies.

The current Grunt default runs ESLint, starts the server, waits 12 seconds, runs `shell:mocha-imap`, `shell:mocha-pop3`, `shell:mocha-unit`, and `shell:mocha-api`, then stops the server. `testonly` skips lint; `proto` runs `shell:mocha-imap-unit`, `shell:mocha-pop3`, and `shell:mocha-unit`. ESLint covers root JavaScript, `lib/`, `imap-core/`, `test/`, `examples/`, and `bin/*`.

Test defaults in `config/test.toml`: MongoDB `mongodb://127.0.0.1:27017/wildduck-test`, Redis `redis://127.0.0.1:6379/13`, API 8080, IMAP 9993, LMTP 2424, and metrics 9998. Check overrides and existing listeners before starting another test server. CI's services and Node matrix are defined in `.github/workflows/test.yml`.

- Bugs need the smallest relevant regression test. Protocol changes should cover relevant literals, CRLF, MIME boundaries, partial ranges, mailbox state, and limits. API tests use Mocha/Chai/Supertest with cleanup, stable error assertions, and own/any permission cases.
- Attachment suites combine unit tests and MongoDB/Redis integration tests. S3 cases use `S3_TEST_ENDPOINT` and skip when unset; GridFS integration still needs its services. See `docs/in-depth/s3-attachment-storage.md` for service/credential setup. Report skipped integration coverage rather than treating it as exercised.
- See `imap-core/test/INDEXER-TESTING.md` for corpus/fuzz/mutation instructions. External corpora use `MIME_CORPUS_DIR` or `MIME_CORPUS_LIST`; use `FUZZ_SEED`/`FUZZ_ITERATIONS` to reproduce or expand indexer fuzz runs. Private mail must remain outside committed fixtures.
- If required services are unavailable, run the nearest focused checks and report the unverified behavior. For documentation-only changes, validate paths, scripts, configuration references, and consistency; do not start the full service test suite.

## Security, Maintenance, and Review

- Never commit credentials, production certificates/private keys, real mail, MongoDB/Redis dumps, or local configuration containing secrets. `.eml`, keys, certificates, and dumps outside deliberate fixture directories are sensitive. Do not log message bodies, passwords, tokens, or full authentication payloads.
- Preserve lockout/rate-limit TTLs, 2FA semantics, token scopes, ownership checks, and sensitive response filtering.
- Update this guide in the same task when changing scripts, test targets, Node requirements, service/handler structure, storage formats, deprecations, or documented conventions. Verify against `package.json`, `Gruntfile.js`, `.eslintrc`, `.prettierrc.js`, configuration, code, and relevant docs. Keep durable instructions here; leave detailed implementation history in tests/docs and release history in `CHANGELOG.md`.
- Use focused conventional-style commits such as `fix: ZMS-123: Correct message behavior`; reference the relevant issue when available. Do not stage unrelated workspace files.
- PRs/final reports should state the behavior changed, checks run, unverified areas, and material compatibility/migration risks. Explain generated documentation or lockfile changes. Include screenshots only for visible changes.
