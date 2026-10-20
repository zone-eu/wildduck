# Repository Guidelines

This is the working guide for coding agents and contributors. Follow the repository's established patterns and verify behavior against the current code. Keep this guide current when development changes its commands, runtime requirements, architecture, or conventions.

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
| `api.js`, `lib/api/` | Fastify API construction, startup, and resource routes |
| `lib/fastify/` | Shared HTTP bootstrap, merged request validation, route/OpenAPI compilation, and response contract checks |
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
| `lib/schemas/json-schemas.js`, `lib/schemas/request/`, `lib/schemas/response/`, `lib/roles.js` | Shared/request/response JSON Schemas and access control |
| `lib/lua/`, `lib/counters.js` | Redis scripts and registered counter/lock helpers |
| `imap-core/lib/`, `imap-core/test/` | Reusable protocol implementation, MIME indexer, and protocol tests |
| `test/`, `test/api/`, `test/fixtures/` | Application units, API/integration tests, and deliberate fixtures |
| `config/`, `indexes.yaml`, `migrations/` | TOML configuration, MongoDB indexes, database/user migrations |
| `scripts/migrate-attachments-to-s3.js` | Attachment migration, verification, and separate cleanup operations |
| `bin/access-tokens`, `bin/mcp-tokens` | Token administration CLIs |
| `test/api/_helpers.js`, `test/api/_fixtures.js`, `test/api/_inprocess.js`, `test/api/_route-requests.js` | Shared API setup, disposable fixtures, in-process application, and request/fuzz builders |
| `docs/`, `plugins/`, `assets/`, `graphics/`, `public/` | Documentation, plugins, and static/public assets |

Production incoming mail normally flows through Haraka and `haraka-plugin-wildduck` into filtering and message storage. Submitted outbound mail enters the MongoDB `zone-queue` and is processed by ZoneMTA integrations. Ordinary IMAP APPEND stores a message; do not assume every APPEND submits outbound mail. Handler changes must remain compatible with library consumers such as `zonemta-wildduck`.

## Code Style

Use **`lib/api/messages.js` as a concrete style reference**, along with the code immediately surrounding the change. Its API handlers show the current schema, permission, database, and response patterns; request validation runs centrally through `lib/fastify/`. See `docs/in-depth/api-validation.md` for the HTTP contract. Follow maintained patterns; check for deprecation before copying older code.

- Use `'use strict';`, `require()`, and `module.exports`. Keep imports near the top, destructure related helpers where useful, and follow nearby dependency ordering. Do not migrate files to ESM as an incidental change.
- Use dependency-injected factories/classes rather than introducing global dependencies. API modules receive handlers and database connections from their caller.
- Match `.prettierrc.js`: 4-space indentation, single quotes, LF, no trailing commas, `printWidth: 160`, and `arrowParens: 'avoid'`. ESLint extends `nodemailer` and `prettier` through `.eslintrc`.
- Use camelCase for variables/functions, PascalCase for classes, and the existing uppercase convention for shared constants. Use descriptive names such as `messageData`, `mailboxData`, `requestBody`, and `pathParams`.
- Use `const` for imports and fixed bindings and `let` for reassigned values; respect surrounding conventions without rewriting unrelated declarations. Do not introduce `var`.
- Use object shorthand, destructuring, template literals, and spread where they make the code clearer. Split large schemas, queries, and response objects into readable blocks; preserve the surrounding field order and formatting.
- Prefer small helpers and early returns for invalid input, missing records, and errors. Comments should explain behavior or constraints, especially protocol quirks, races, and compatibility requirements.
- Use `async`/`await` for promise-based logic and database operations. Keep required public callback signatures, including IMAP command handlers and adapters. A callback interface is not automatically deprecated.
- Reuse native async methods: message operations include `addAsync`, `putAsync`, `updateAsync`, `moveAsync`, and `delAsync`; mailbox operations include `createAsync`, `renameAsync`, `updateAsync`, and `delAsync`; notifier journaling uses `addEntriesAsync`. Their callback wrappers remain available for protocol adapters and external consumers.
- Handler naming varies: `userHandler.asyncGet()` and `asyncGetDeleted()` use a prefix, while storage methods such as `add()`, `get()`, and `delete()` already return promises. Inspect the handler rather than guessing its method name or return shape. Preserve error-first callbacks, multiple callback results, and exactly-once completion. Only promisify a callback-only method, binding its receiver; do not promisify an existing async method.
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
- Configure metrics through top-level `[metrics]`; `lib/metrics-config.js` still honors legacy `[api.metrics]` enablement and cache TTL when top-level metrics are not enabled.
- When replacing deprecated behavior, preserve signatures and semantics needed by callers and verify the affected behavior. Keep external compatibility wrappers until a deliberate migration removes them; do not undertake unrelated mass migrations.

## REST API Conventions

Follow `lib/api/messages.js` and `docs/in-depth/api-validation.md`:

1. Register native Fastify routes with `server.route({ method, url, schema, config, async handler(req, reply) { ... } })`. Put `summary`, `description`, and `tags` in `schema`, and `name` plus `validationObjs` in `config`. Use `schema.hide` for routes excluded from OpenAPI.
2. Declare plain JSON Schema fragments in `config.validationObjs`: `requestBody`, `pathParams`, `queryParams`, status-keyed `response`, and cross-field `conditions` where needed. Reuse `$ref: 'wd:...'` definitions and factories from `lib/schemas/json-schemas.js` and the request/response modules. For GET, DELETE, and HEAD, declare input fields as query/path params; the route compiler rejects `requestBody` on these methods.
3. `lib/fastify/routes.js` validates centrally before the handler. Path, query, and parsed body fields merge in that order; a truthy existing value wins, while a falsy value can be replaced. Operate on validated `req.params`; use `req.rawParams` for pre-validation presence/empty-value checks. Construct `ObjectId` values only after validation. Use `config.preValidate` for preprocessing and `rawBodyParam` for mapping a raw Buffer/string payload into a named field.
4. Ajv uses `allErrors: true`, `coerceTypes: false`, and defaults; the conversion pre-pass implements `wdType`, `wdEmpty`, `wdTrim`, `wdRequired`, and other `wd*` annotations. Unknown keys are rejected unless `config.allowUnknown` is set. Preserve these semantics instead of adding validation inside handlers or enabling Ajv coercion. Validation failures already return 400 `{ error, code: 'InputValidationError', details }`; assert status, code, and offending field paths in tests rather than exact message prose.
5. Enforce access with `req.validate(roles.can(req.role)...)`, distinguishing own/any permissions using the authenticated user and validated target user. Include ownership in database queries and apply permission-based response filtering where required by the resource. The central validator resolves `user: 'me'` after merging input.
6. Return `reply.send(payload)` or `reply.code(status).send(payload)`. JSON defaults to UTF-8; `config.charset: false` preserves routes that omit the charset parameter. Success objects commonly use `{ success: true, id: '...' }`. Throw handler errors with a string `code` and appropriate `responseCode` for translation by `lib/fastify/bootstrap.js`; unexpected handler faults become 500 with `InternalError` when no string code exists. Preserve existing inline error responses and the distinct pre-handler `{ code, message }` shape. Return immediately after sending a reply.
7. Response models activate fast-json-stringify. Declare every returned field or explicitly allow additional properties where the response contract requires it; undeclared properties can disappear during serialization. Keep nullable/mixed values compatible with actual stored data. The serializer strips response `required` constraints while the published OpenAPI retains them, so an older incomplete document does not break a listing.
8. Send downloads with `reply.send(stream)` and preserve stream teardown/error propagation and declared content lengths. Declare non-JSON response content types in `validationObjs.response`. SSE updates and data export use `server.beginRawResponse()` for raw writes, headers, logging, and metrics. `application/octet-stream` requests remain unconsumed for streaming imports; other uploads follow the body parsers in `api.js`.
9. Update generated API documentation for public route/schema changes. `npm run generate-api-docs` uses `@fastify/swagger`, route schemas, and `config/apigeneration.json` to write `docs/api/openapidocs.json`; `docs/api/index.html` is its static viewer. Review the generated diff; `test/api/openapi-spec-test.js` checks parity with the committed specification.

`api.js` exports an async service starter that returns the listening Fastify instance (or `false` when disabled), and exposes `createApp()` for constructing an application without listening. `tools.responseWrapper()` and `lib/schemas.js` have been removed; library consumers embedding the API must use its current async/Fastify interface.

## Behavior and Compatibility Constraints

### IMAP and MIME

- `imap-core/lib/commands/` modules declare state, schema, and a handler bound to the connection. `imap.js` wires callbacks to factories in `lib/handlers/`. Preserve selected mailbox state, UID/sequence semantics, flags, notifications, and callback contracts.
- Parser/compiler behavior lives under `imap-core/lib/handler/`; connections, input, and output are managed by `imap-connection.js`, `imap-stream.js`, and `imap-composer.js`.
- MIME parsing/rebuilding lives under `imap-core/lib/indexer/`, including `parse-mime-tree.js`, `tree-walker.js`, `indexer.js`, `body-structure.js`, and `create-envelope.js`. New trees use v2; persisted trees without `v` are v1 and retain legacy rendering behavior.
- Preserve exact RFC822 bytes, CRLF handling, MIME boundaries, preambles/epilogues, literal lengths, partial FETCH ranges, BODYSTRUCTURE, and ENVELOPE output. Size calculations must agree with the bytes emitted.
- Message date changes must keep `hdate`, MIME header data, cached ENVELOPE, stored size, and quota consistent. Reuse `messageHandler.getMessageDateUpdate()` and apply its `sizeDelta` where appropriate.
- Treat `imap-core/test/fixtures/legacy-v1/` and `legacy-v1-trees.json` as frozen references. Do not edit or regenerate them from current code. A deliberate legacy behavior change needs a documented reason in its regression tests.
- Preserve literal admission checks and the `maxMB`, `maxLineLength`, and `maxLiterals` limits in `config/imap.toml`. Cover synchronizing/non-synchronizing literals and command-line boundaries when changing parsing.

### Attachments, Labels, and Notifications

- Attachments can live in GridFS, S3, or both. `config/attachments.toml` selects the preferred backend for new hashes; existing records determine their read backend through `metadata.storage`, defaulting to GridFS when absent. `attachments.files` remains the deduplication/reference catalog, even for S3 payloads.
- Preserve reference counts, checksums, lock ownership, generation-specific S3 keys, and safe orphan collection. Backend-aware code/configuration must reach all readers and external library consumers before introducing S3 records. See `docs/in-depth/s3-attachment-storage.md` and `docs/in-depth/attachment-deduplication.md` for migration and storage details.
- Base64 attachments are stored decoded only when `lib/attachments/base64-codec.js` proves they can be reconstructed byte for byte; other bodies remain verbatim. Propagate missing, truncated, or overlong payload errors through streams. A database write error can occur after a message was stored: preserve the readback/rollback logic in `lib/message-handler.js` before releasing quota or attachment references.
- Labels persist in the `labels` collection and messages store label IDs. Reuse `lib/label-handler.js`; preserve reserved names, allocation limits, deleting-state behavior, label counters, and the `$wdlabel$<id>` IMAP bridge. Label deletion uses `lib/tasks/label-delete.js`.
- Message/mailbox changes must keep flags, quota, counters, Redis notifications, and published webhook events consistent. Inspect `lib/imap-notifier.js`, `lib/events.js`, and the relevant handler before adding a direct database update.
- IMAP notifications support the legacy `wd_events` channel and worker channels `wd_events:worker:<workerId>`. The `const:imap:use_wd_worker_channels` setting controls publishing; preserve listener registration, registry TTL refresh, and legacy fallback when changing routing.
- Account label/flagged counters use versioned Redis caches through `lib/tools.js`, `lib/lua/`, and notifier invalidation. Preserve the version check when caching a counted value so concurrent updates cannot install stale counts. IMAP quota responses share `lib/handlers/quota.js` for account/default quota resolution and non-negative usage.
- Apple push uses XAPPLEPUSHSERVICE, `lib/apn-client.js`, notifier integration, and push-subscription API routes. Preserve validation, subscription ownership, and notification behavior when changing these paths.

### MCP and Metrics

- MCP is an independent, disabled-by-default, read-only Streamable HTTP service. Tools access the REST API through `lib/mcp-api-client.js`; preserve its validation, permission, audit, and scope checks instead of introducing direct MongoDB reads. See `docs/in-depth/mcp.md`.
- MCP credentials use the `wdmcp_` prefix, `lib/mcp-token-handler.js`, the `mcptokens` users-database collection, and dedicated Redis sessions. Preserve bearer-only transport, user binding, expiry, revocation, 2FA, and MCP-only authentication behavior.
- Metrics run on their own listener through `prometheus.js` and top-level `[metrics]`. Preserve startup/service status instrumentation and bounded metric label cardinality; avoid user IDs, addresses, or message IDs as metric labels.

## State, Queues, and Configuration

MongoDB connection roles can differ: `lib/db.js` exports `database`, `users`, `senderDb`, and `gridfs`. Use the connection appropriate to the handler and data. `db.connect()` returns a promise without a callback and still supports a callback; it opens new connections on every call, so reuse established connections. Check `indexes.yaml` and `migrations/database/` or `migrations/users/` for document/query changes.

- Core collections include `users`, `addresses`, `addressregister`, `mailboxes`, `messages`, `threads`, `labels`, `filters`, and `autoreplies`.
- Auth/security includes `authlog`, `asps`, `mcptokens`, and `audits`; archival data includes `archived` and `deletedusers`. GridFS buckets include `audit.files`, `storage.files`, and `attachments.files`; outbound mail uses `zone-queue`.
- Durable jobs use `tasks.js` and `lib/task-handler.js`: `add`, `ensure`, `getNext`, `release`, and `keepAlive`. Types include `user-delete`, `restore`, `quota`, `audit`, `acme`, `acme-update`, `clear-folder`, `search-apply`, `user-indexing`, `run-migrations`, `mailbox-retention`, and `label-delete`.
- BullMQ webhook queues are `webhooks` (matching) and `webhooks_post` (delivery/retry). Search queues are `live_indexing` and `backlog_indexing`; inspect their feature gating before adding synchronization.
- Redis key names and TTLs are runtime contracts. Important families include `cached:<userId>`, `total:<mailboxId>`, `unseen:<mailboxId>`, `account-counters:{<userId>}:*`, `idw:<userId>`, `iup:<userId>`, `wdr:<userId>`, `wda:<autoreplyId>`, `wdf:<id>`, `lim:<service>`, `tn:token:<tokenHash>`, `auth_user:<tokenId>`, `totp:<userId>`, WebAuthn `challenge:*`, `feature:indexing`, and the `wd:imap:users:<userId>` worker registry. Inspect counter helpers in `lib/tools.js`, notification routing in `lib/imap-notifier.js`, and MCP key helpers in `lib/mcp-token-handler.js` before adding keys.

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
| `npm run test:proto` | Selected in-process IMAP, POP3, and application unit tests; no MongoDB/Redis required, but POP3 tests need `mpop` and local listening sockets |
| `npm run test:indexer` | MIME parser/rebuilder, fidelity, ranges, legacy, corpus, and attachment-codec suites |
| `npm run test:indexer-coverage` | Indexer/codec/length-limiter coverage |
| `npm run test:attachments` | Attachment and COPY/UID suites; includes integration tests needing MongoDB/Redis and optional S3 |
| `npm run test:attachments-coverage` | Storage/backend and S3 migration coverage |
| `npm run test:mutation` | MIME/indexer/codec mutation checks; see `imap-core/test/mutation/run.js` |
| `npm run runtest` | Full Grunt workflow without an initial database/Redis reset; tests still modify test state |
| `npm test` | Drop `wildduck-test`, flush Redis DB 13, then run `runtest` |
| `npm run runci` | Print configuration, then run `runtest` |
| `npm run generate-api-docs` | Generate API docs using route/schema specs through `server.js` |

`npm test` destroys test state. Verify the target databases and configuration before using it; do not use production connections for testing. Avoid `npm run update` for routine development: it removes `node_modules` and `package-lock.json` and upgrades dependencies.

The current Grunt default runs ESLint, starts the server, polls `/health` on the configured API port until ready (60-second deadline), runs `shell:mocha-imap`, `shell:mocha-pop3`, `shell:mocha-unit`, and `shell:mocha-api`, then stops the server. `testonly` skips lint; `proto` runs `shell:mocha-imap-unit`, `shell:mocha-pop3`, and `shell:mocha-unit`. `mocha-api` excludes POP3 and explicitly listed unit files already run by earlier targets; it also picks up application integration tests outside `test/api/`. ESLint covers root JavaScript, `lib/`, `imap-core/`, `test/`, `examples/`, and `bin/*`.

Test defaults in `config/test.toml`: MongoDB `mongodb://127.0.0.1:27017/wildduck-test`, Redis `redis://127.0.0.1:6379/13`, API 8080, IMAP 9993, LMTP 2424, and metrics 9998. Check overrides and existing listeners before starting another test server; API helpers use the configured port, which can be overridden with `APPCONF_api_port`. The full workflow needs MongoDB, Redis, `mongosh`, `curl`, `jq`, and `mpop`: IMAP integration setup runs `imap-core/test/prepare.sh`, which clears collections and creates fixtures through the API. `npm test` additionally uses `redis-cli` for its reset. CI tests Node 22.x, 24.x, and 26.x and enables S3 integration with a Moto endpoint; see `.github/workflows/test.yml`.

- Bugs need the smallest relevant regression test. Protocol changes should cover relevant literals, CRLF, MIME boundaries, partial ranges, mailbox state, and limits. API tests use Mocha/Chai/Supertest with cleanup, stable error assertions, and own/any permission cases.
- API tests also use `test/api/_inprocess.js` to build the full app for `app.inject()` without listening; these tests still connect to MongoDB/Redis. Reuse `test/api/_helpers.js` and `test/api/_fixtures.js` for setup and cleanup. In test mode the API exposes `/api-methods` and, when contract checking is enabled, `/api-contract-violations`; `test/_globals-test.js` writes `api-tests-overview.md` and verifies serialized response contracts. These helpers supplement the HTTP integration suites.
- `test/api/route-fuzz-test.js` generates seeded requests from route declarations. Use `FUZZ_SEED`, `FUZZ_ITERATIONS`, and `FUZZ_CASE` to replay or expand a failing API case; see its documented exclusions for raw streams and operations that modify shared fixtures.
- Attachment suites combine unit tests and MongoDB/Redis integration tests. S3 cases use `S3_TEST_ENDPOINT` and skip when unset; GridFS integration still needs its services. See `docs/in-depth/s3-attachment-storage.md` for service/credential setup. Report skipped integration coverage rather than treating it as exercised.
- See `imap-core/test/INDEXER-TESTING.md` for corpus/fuzz/mutation instructions. External corpora use `MIME_CORPUS_DIR` or `MIME_CORPUS_LIST`; use `FUZZ_SEED`/`FUZZ_ITERATIONS` to reproduce or expand indexer fuzz runs. Private mail must remain outside committed fixtures.
- If required services are unavailable, run the nearest focused checks and report the unverified behavior. For documentation-only changes, validate paths, scripts, configuration references, and consistency; do not start the full service test suite.

## Security, Maintenance, and Review

- Never commit credentials, production certificates/private keys, real mail, MongoDB/Redis dumps, or local configuration containing secrets. `.eml`, keys, certificates, and dumps outside deliberate fixture directories are sensitive. Do not log message bodies, passwords, tokens, or full authentication payloads.
- Preserve lockout/rate-limit TTLs, 2FA semantics, token scopes, ownership checks, and sensitive response filtering.
- Update this guide in the same task when changing scripts, test targets, Node requirements, service/handler structure, storage formats, deprecations, or documented conventions. Verify against `package.json`, `Gruntfile.js`, `.eslintrc`, `.prettierrc.js`, configuration, code, and relevant docs. Keep durable instructions here; leave detailed implementation history in tests/docs and release history in `CHANGELOG.md`.
- Use focused conventional-style commits such as `fix: ZMS-123: Correct message behavior`; reference the relevant issue when available. Do not stage unrelated workspace files.
- PRs/final reports should state the behavior changed, checks run, unverified areas, and material compatibility/migration risks. Explain generated documentation or lockfile changes. Include screenshots only for visible changes.
