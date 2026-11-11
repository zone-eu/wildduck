# JMAP implementation plan

Status: work package 0.1 done. Branch `jmap`, draft pull request open. Next up: work package 0.2.

This is the working plan for adding JMAP to WildDuck. It is meant to be executed over many sessions: every work item has a checkbox, and section 10 is the progress log. Read sections 2 and 4 before touching code; they define how every change is made and tested.

Related documents:

- Feasibility review (why, data model mapping, hard problems): `~/Downloads/wildduck-jmap-feasibility/jmap-feasibility-report.html`
- Test portfolio (what "works" means): `test/jmap/README.md`, `test/jmap/overview.html`, `test/jmap/catalogue/*.yaml` (2,530 scenarios), `test/jmap/external/` (expectations for two independent suites)

## 1. Scope and decisions

### 1.1 Scope of the pull request

One pull request from branch `jmap` to `master`, containing phases 0 to 6:

| Phase | Content                                                                                                                            | Catalogue scenarios |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 0     | Backend prerequisites in the shared handlers                                                                                       | 31                  |
| 1     | Core and read only mail, EventSource, download                                                                                     | 848                 |
| 2     | Writes: Mailbox/set, Email/set, upload, import, parse, Identity, VacationResponse                                                  | 559                 |
| 3     | EmailSubmission                                                                                                                    | 142                 |
| 4     | Conformance extras: Web Push, queryChanges, thread keyword filters, extra sorts, body search, RFC 9404 blobs, Quota, IMAP OBJECTID | 204                 |
| 5     | Contacts (RFC 9610)                                                                                                                | 254                 |
| 6     | Calendars without scheduling (draft-ietf-jmap-calendars-33)                                                                        | 375                 |

Not in this pull request: phase 7, calendar scheduling (iTIP over iMIP, CalendarEvent/parse, CalendarEventNotification, 117 scenarios). It is held until the calendars draft is published as an RFC. RFC 9670 sharing stays out of scope.

Because everything ships in one pull request, the phases are milestones inside the branch, not releases. Intermediate states never reach users, so there is no "preview" release and no period in which a capability is advertised before its methods exist on `master`.

### 1.2 Decisions taken

| Topic              | Decision                                                                                                                                                                                                       | Taken      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Email id           | `root` is the stable id, a COPY gets a fresh root                                                                                                                                                              | 2026-11-11 |
| Change history     | The existing journal with a configurable, longer retention, plus a persisted per user state anchor                                                                                                             | 2026-11-11 |
| Enablement         | One server wide switch, no per user flag                                                                                                                                                                       | 2026-11-11 |
| Authentication     | Bearer user tokens and Basic (application specific password with scope `jmap`, or the account password when 2FA is off)                                                                                        | 2026-11-11 |
| Labels             | Exposed as `$wdlabel$<id>` keywords, as over IMAP                                                                                                                                                              | 2026-11-11 |
| Calendars          | Staged: storage, query, recurrence and alerts now, scheduling held                                                                                                                                             | 2026-11-11 |
| Pull request       | One pull request with phases 0 to 6, opened as a draft after the first work package                                                                                                                            | 2026-11-11 |
| Plan and progress  | This file, on the branch                                                                                                                                                                                       | 2026-11-11 |
| Dependencies       | In house first. A new runtime dependency only where the problem is large and well solved elsewhere, each one approved before it is added (section 3.9)                                                         | 2026-11-11 |
| EmailDelivery      | Follows the RFC literally: changes whenever a new Email is added to the store (delivery, IMAP APPEND, REST upload, Email/set create, Email/import, IMAP COPY, restore), never on move, flag change or deletion | 2026-11-11 |
| Special use rename | JMAP mirrors the handler: Sent, Trash, Drafts and Junk can be renamed (`mayRename` true), the role stays with the mailbox. INBOX cannot                                                                        | 2026-11-11 |
| Quota (RFC 9425)   | Included, phase 4, over the existing per user storage quota                                                                                                                                                    | 2026-11-11 |
| Email/queryChanges | General: result ids of recent queries are cached, queryChanges re-runs the query and diffs. An expired cache entry answers `cannotCalculateChanges`                                                            | 2026-11-11 |

### 1.3 Defaults chosen in this plan

These were open in the test portfolio. Each has a sensible default so work is not blocked; change any of them by editing this table before the named work package starts.

| Topic                                | Default                                                                                                                                                                                                                             | Affects  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Destroying a pending EmailSubmission | Removes the record only, delivery is not affected (RFC 8621 7.5). Cancelling is `undoStatus: canceled`                                                                                                                              | 3.4      |
| Upload quota                         | When an upload would exceed it, unreferenced uploads are deleted oldest first until there is room (RFC 8620 6.1). Refused only when nothing unreferenced is left                                                                    | 0.10     |
| Moving with one patch                | A patch is applied as a whole and judged on the resulting object. `{old: null, new: true}` is a move                                                                                                                                | 2.3      |
| Delayed send                         | `submissionExtensions` advertises `FUTURERELEASE`; `HOLDFOR` and `HOLDUNTIL` are the only accepted SMTP parameters                                                                                                                  | 3.4      |
| `/copy` methods                      | Email/copy, Blob/copy and the contact and calendar copies exist and answer with the RFC error order: unknown `accountId` is `accountNotFound`, equal ids are `invalidArguments`, a foreign `fromAccountId` is `fromAccountNotFound` | 2.9      |
| Account id                           | `u` plus the 24 hex user id                                                                                                                                                                                                         | 1.3      |
| Other ids                            | Email `M` plus root, Thread `T`, Mailbox `F`, Identity `I`, EmailSubmission `S`, blobs `B` plus a type letter. Only `A-Za-z0-9-_`                                                                                                   | 1.7      |
| `maxObjectsInGet`                    | 1500, equal to the mailbox limit, so Mailbox/get with `ids: null` always works. The cost of large Email/get calls is bounded by a per request body value budget                                                                     | 1.4      |
| Shared state                         | Email, Thread and Mailbox share one state string. `ifInState` on Mailbox/set can therefore fail because of unrelated mail delivery; documented                                                                                      | 1.6      |
| Safety window                        | Configurable (`jmap.changes.safetyWindow`). The default tolerates out of order journal ids across processes and may report an id twice. Tests assert on sets, and the single process test server runs with the window at zero       | 1.6      |
| Threading                            | Unchanged: shared reference and equal normalised subject                                                                                                                                                                            | 1.10     |
| New mailbox subscription             | Unchanged: subscribed by default                                                                                                                                                                                                    | 2.2      |
| Text search before OpenSearch        | `text` and header filters require all terms (each term sent to `$text` as a phrase, a leading minus escaped); `body` is checked against the stored plain text separately from headers                                               | 1.15     |
| Contacts and calendars limits        | `maxAddressBooksPerCard` 1, `maxCalendarsPerEvent` 1, card size limit 256 KB, 10,000 cards and 50,000 events per account. All configurable                                                                                          | 5.1, 6.1 |
| Address register                     | Synthesised on read as a read only address book; register writes from the mail path feed the contact change log                                                                                                                     | 5.7      |
| Null calendar time zone              | Treated as `Etc/UTC` (there are no principals)                                                                                                                                                                                      | 6.4      |
| VAPID (RFC 8292, RFC 9749)           | Included in 4.2: push services backed by FCM require it; ES256 signing with `node:crypto`, key pair generated on first start and stored in the settings collection, rotatable                                                       | 4.2      |

### 1.4 Still needs your input

- A ticket reference for commit messages. The repository convention is `feat(scope): ZMS-NNN: description`; no ticket exists for JMAP yet. Until one is given, commits use `feat(jmap): description`.
- Approval of the recurrence and time zone dependency, when work package 6.3 presents the candidates.
- The production measurements of work package 0.13 (scatter lookups by `root`, size of the new indexes, journal growth per day). They need access to the production cluster.

## 2. Ground rules

### 2.1 Branch and pull request

- All work happens on branch `jmap`, created from `master`. Start each session with `git fetch` and merge `origin/master` into `jmap` when it has moved (merge, not rebase, once the draft pull request is open, so review comments keep their anchors).
- The draft pull request is opened after work package 0.1 is pushed. Its description holds the phase checklist and is updated at every milestone. It is marked ready only after work package F.6.
- Push at the end of each work package, not after every commit. After pushing, watch the GitHub Actions runs to the end. A real failure is fixed and pushed following the same per change checklist. A flaky failure is rerun, at most three times, then reported.
- Nothing is merged to `master` from this branch except through the pull request.

### 2.2 The per change checklist

Every work item below is one logical change and normally one commit. For each of them, in this order:

1. **Tests first.** Write the scenario tests for the catalogue ids the item names (section 4.2), plus unit tests for new modules. They fail at this point.
2. **Implement** until the item's tests pass. Keep functions small and shallow where the choice is free (early returns, extracted helpers, lookup tables instead of long branch chains).
3. **Run the targeted tests**: the item's test files, then `npm run test:jmap` and, for changes to shared handlers, the affected existing suites.
4. **`/simplify`** on the change. This is also the maintainability check: if a function the change touched grew noticeably longer or more complex, see whether a simple extraction brings it back. Do not restructure unrelated code.
5. **`/security-review`** on the change. Address every finding or record why it does not apply.
6. **Prettier and ESLint** on the changed files (`npx prettier --write <files>`, `npx eslint <files>`).
7. **Full suite**: `npm test` (drops the test database, lints, runs every target including JMAP). It must pass.
8. **Commit** with a conventional message and the attribution trailer. One concern per commit; a refactor that prepares a change is its own commit before the change.
9. **Tick the checkbox** in this file. The plan update goes into the same commit as the last item of a work package.

Docs only or catalogue only commits skip steps 4, 5 and 7 but still run the catalogue validator (`node test/jmap/tools/check-catalogue.js`).

At the end of each work package additionally:

- `npm run test:jmap:coverage` (section 4.3): no catalogue scenario of a finished work package may be without a test.
- From milestone 2 on, `npm run test:jmap:compliance` (the jmapio suite against its expectation file).
- Push, watch CI, update the progress log in section 10.

### 2.3 Commit conventions

- Conventional commits: `feat(jmap): ...`, `fix(jmap): ...`, `test(jmap): ...`, `docs(jmap): ...`, `refactor(<area>): ...`. Changes to shared handlers use their own scope (`feat(journal): ...`, `fix(imap): ...`) so the release notes show what changed for non JMAP users.
- No em dashes or en dashes anywhere, including comments and commit messages.
- A commit never leaves the tree failing `npm test`.
- Catalogue changes (a scenario corrected, withdrawn or added) go in the same commit as the test or code that motivated them.

### 2.4 Rules for shared code

WildDuck is also a library: haraka-plugin-wildduck and zonemta-wildduck import its handlers. For every change under `lib/` outside `lib/jmap/`:

- Keep the dual callback and promise API and existing method signatures. New parameters are optional and additive.
- Behaviour changes visible to IMAP, POP3, the REST API or the plugins are listed in the pull request description under "Changes for existing deployments" as they are made. Known ones: a COPY gets a fresh `root`; journal entries gain `root` and `origin` fields; mailbox setting changes write journal entries; new indexes on `messages`, `archived` and `journal`.
- New fields on existing collections are optional and readers tolerate their absence, so a mixed fleet during deployment keeps working.
- Run the plugin test suites against the branch at the end of phase 0 and again before the pull request is marked ready (work packages 0.14 and F.4).

## 3. Architecture

### 3.1 Service

A separate Fastify instance on its own port, started in every worker like IMAP and POP3, stateless, sharing the handlers and the MongoDB and Redis connections.

| Piece               | Location                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service entry       | `jmap.js` exporting `done => start(config.jmap, done)`, `done(null, false)` when disabled; added to `SERVICES` in `worker.js`                                                                                                     |
| Configuration       | `config/jmap.toml` included from `config/default.toml`: `enabled`, `port`, `host`, `secure`, `baseUrl` (public URL used in the session), limits, push, changes, TLS block; `jmap` added to the TLS service list in `lib/certs.js` |
| Routes              | `GET /.well-known/jmap`, `GET /jmap/session`, `POST /jmap/api`, `POST /jmap/upload/{accountId}`, `GET /jmap/download/{accountId}/{blobId}/{name}`, `GET /jmap/eventsource`                                                        |
| Metrics and logging | `metrics.setServiceUp('jmap', ...)`, one access log line per request with user, method names, error types and timing, no credentials or content                                                                                   |

### 3.2 Module layout

```
jmap.js                       service entry, Fastify wiring
lib/jmap/
  auth.js                     Bearer and Basic, positive auth cache, failure counters
  session.js                  Session object, capabilities, session state
  request.js                  request validation, limits, sequential dispatch, method errors
  references.js               result references (JSON Pointer with *), creation ids
  patch.js                    PatchObject application and validation
  ids.js                      id and blob id encoding, decoding, validation
  state.js                    journal folding, state strings, account binding, anchors
  changelog.js                owned change log: per user sequence, tombstones
  query-cache.js              cached query results for /queryChanges
  blob.js                     blob resolver (raw message, MIME part, upload), streams
  email-model.js              message document to Email object: metadata, header forms
  email-body.js               MIME tree to bodyStructure, textBody, htmlBody, attachments, bodyValues
  email-builder.js            Email object to MIME (Email/set create)
  email-search.js             FilterCondition and Comparator to MongoDB and OpenSearch queries
  snippet.js                  SearchSnippet highlighting
  push/eventsource.js         EventSource endpoint over the notifier
  push/subscriptions.js       PushSubscription store, verification
  push/webpush.js             RFC 8291 encryption, RFC 8030 delivery, SSRF checks
  types/                      one module per data type: core, mailbox, thread, email,
                              searchsnippet, identity, submission, vacation, blob,
                              pushsubscription, quota, addressbook, contactcard,
                              calendar, calendarevent, participantidentity
lib/contact-handler.js        contacts storage and rules, usable by other front ends
lib/calendar-handler.js       calendars storage and rules
lib/calendar/recurrence.js    recurrence expansion
lib/calendar/alerts.js        alert scheduling
lib/schemas/jscontact.js      JSContact Card schema for the existing Ajv setup
lib/schemas/jscalendar.js     JSCalendar Event schema
lib/tasks/root-migration.js   one off migration of message roots
lib/tasks/upload-cleanup.js   removal of expired uploads
```

Everything that writes mail goes through `MessageHandler`, `MailboxHandler`, `UserHandler`, `StorageHandler` and `Maildropper`, so IMAP, the REST API and JMAP stay consistent, journaled, quota accounted and audited. Type modules contain protocol logic only.

### 3.3 Request flow

1. Authenticate (cache hit or `UserHandler.asyncAuthenticate` with scope `jmap`), load the cached user profile.
2. Validate the request envelope and limits; request level problems answer with RFC 7807 problem details.
3. For each method call in order: check the capability in `using`, resolve result references and creation ids, validate arguments, call the type module, append the response or a method error.
4. Add `createdIds` when the request had them, and `sessionState`.

### 3.4 State and changes

- **Journal types (Email, Thread, Mailbox).** One state string per account: `s` plus the 24 hex id of the newest journal entry written for the user, plus 8 hex characters of a keyed checksum over the account id, so a state from another account is rejected. The newest id is kept as a persisted anchor in a per user `jmapstate` document (`lib/journal-state.js`). It is maintained lazily when a state is read, with `$max`, and its lookups are bounded by the previous anchor, so no write path (IMAP, POP3, LMTP, the REST API, the Haraka and ZoneMTA plugins) pays for it. It never moves backwards and does not change when journal entries expire; an anchor older than the retention with nothing newer is replaced by a fresh id.
- **`/changes`.** Scan `{user, _id > since}` in the journal, fold per `root`: EXISTS is created, EXPUNGE destroyed, FETCH updated, an EXPUNGE and EXISTS with the same root (a move) is updated; created then destroyed inside the window is dropped. A `sinceState` older than the retention window minus a margin answers `cannotCalculateChanges`. `maxChanges` cuts on journal ids, which are the intermediate states.
- **EmailDelivery.** A second anchor in `jmapstate`, from the newest EXISTS entry whose `origin` is not a move (every new Email).
- **Owned types.** Identity, EmailSubmission, PushSubscription where needed, AddressBook, ContactCard, Calendar, CalendarEvent, ParticipantIdentity use `lib/jmap/changelog.js`: a per user, per type monotonically increasing sequence stored on each document, and tombstones kept 30 days. The state is the highest sequence; `/changes` is a range scan. Writers outside the JMAP worker that affect these types (address changes through the REST API, the address register written when mail is sent) call the same module.
- **Query state.** `q` plus a hash of the account state and a fingerprint of filter, sort and `collapseThreads`. The result id list of each query is cached in Redis under that state for a short time (default 10 minutes, capped in size). `/queryChanges` looks up the cached list, re-runs the query and diffs. A missing entry or a fingerprint mismatch answers `cannotCalculateChanges`.

### 3.5 Ids and blobs

- Email id `M<root>`, stable across moves. Lookups (`lib/message-roots.js`) use `{user, root: {$in}}` on the `by_root` index and tolerate the transient duplicate during a move by preferring the newest `_id`. Until the root repair has run for a user (on first JMAP use, or ahead of time by the optional `messages_root_repair` migration), a missing root is read as `_id`.
- Blob ids: `Bm<root>` raw message (served by `indexer.rebuild`), `Bp<root>_<part path>` decoded MIME part (`indexer.getContents`), `Bu<storage file id>` upload (streamed from the Storage bucket). Resolution always checks the owner.
- Uploads go through `StorageHandler` with an expiry; an upload stays downloadable until it expires even after it was consumed into a message.

### 3.6 Search

`lib/jmap/email-search.js` turns the JMAP filter tree into a MongoDB query using the existing filter builders, and into an OpenSearch query when the user is indexed (phase 4). Sorts advertised in `emailQuerySortOptions` are exactly the ones that work: `receivedAt`, `sentAt`, `size`, `hasKeyword` from phase 1; `from`, `to`, `subject` and the thread keyword sorts from phase 4.

### 3.7 Push

- EventSource: the existing notifier listener with JMAP state events, journal ids as event ids for `Last-Event-ID` replay, `types`, `closeafter` and clamped `ping`.
- Web Push: subscriptions in a `jmappush` collection bound to the creating credentials, verification before any push, RFC 8291 encryption with `node:crypto`, delivery through a BullMQ queue with backoff, SSRF checks on every URL and redirect.

### 3.8 New collections and indexes

| Collection                                      | Purpose                                                                            | Phase |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ----- |
| `jmapstate`                                     | Per user anchors (journal, delivery) and owned type sequences                      | 0     |
| `jmapchanges`                                   | Owned change log entries and tombstones (TTL 30 days on tombstones)                | 2     |
| `jmapidentities`                                | Identity fields not present on addresses (name override, replyTo, bcc, signatures) | 2     |
| `jmapsubmissions`                               | EmailSubmission records                                                            | 3     |
| `jmappush`                                      | PushSubscription records                                                           | 4     |
| `addressbooks`, `contacts`                      | Contacts                                                                           | 5     |
| `calendars`, `calendarevents`, `calendaralerts` | Calendars                                                                          | 6     |

New indexes on existing collections: `by_root` (`{root: 1}`, partial) on `messages` and `archived`, and `user_idate` (`{user: 1, idate: -1, _id: -1}`) for account wide listing, all three built only where JMAP is enabled (`feature: jmap` in `indexes.yaml`); two small partial indexes on `storage.files` for temporary uploads; the journal TTL becomes configurable (applied with `collMod`). The index review of 2026-10-05 listed `user_messages_by_thread` and `by_idate` as drop candidates; JMAP reads both, so they stay.

### 3.9 Dependencies

Policy: in house first. Planned without new runtime dependencies: Web Push encryption and VAPID (`node:crypto`), JSContact and JSCalendar validation (existing Ajv), EventSource client for tests (`fetch` streaming), RFC 8291 verification (the RFC's own test vector).

Needs approval before it is added:

| Need                                           | Why not in house                                                                                                                                                                                                      | When |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Recurrence rule expansion with IANA time zones | Large, subtle (DST, `bySetPosition`, `skip`), well covered by existing libraries. Work package 6.3 starts with a short comparison of candidates, including an in house option built on `Intl`, and stops for approval | 6.3  |
| `jmap-jam` as a devDependency                  | A real client library for the interop test layer; never loaded by the server                                                                                                                                          | 1.19 |

## 4. Test strategy

### 4.1 Layers

| Layer              | What                                                                                                                                                        | Where                                                   | Runs                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Unit               | Pure modules: pointer, patch, ids, state folding, header forms, body model, MIME builder, search translation, snippet, Web Push crypto, recurrence, schemas | `test/jmap/unit/*-test.js`                              | `npm run test:jmap:unit`, no server                                |
| Scenario           | One test per catalogue scenario, over HTTP against the test server, seeding through LMTP, IMAP, the REST API, the database or JMAP as the scenario says     | `test/jmap/scenarios/<area>-test.js`                    | `npm run test:jmap`, in `npm test` and CI                          |
| Prerequisite       | Phase 0 scenarios (`WDP-*`), no JMAP service needed                                                                                                         | `test/jmap/scenarios/wildduck-test.js`                  | Same target                                                        |
| Regression         | The existing IMAP, POP3, API and unit suites                                                                                                                | `test/`, `imap-core/test/`                              | `npm test`, every change                                           |
| External: jmapio   | 309 black box tests, compared with `external/jmapio-expectations.yaml`                                                                                      | fetched at the pinned commit                            | `npm run test:jmap:compliance`, CI on every push from milestone 2  |
| External: Fastmail | 173 files through a WildDuck adapter, compared with `external/fastmail-expectations.yaml`                                                                   | fetched at the pinned commit, run in a container        | `npm run test:jmap:fastmail`, nightly CI and before each milestone |
| Interop            | Real clients: jmap-jam (automated), aerc, meli, Ltt.rs, Bulwark Webmail, Twake Mail, Cypht (scripted or manual)                                             | `test/jmap/interop/`, log in `docs/jmap/interop-log.md` | End of each milestone                                              |
| Fuzz and property  | Request envelope and JSON parsing, pointer and patch, header parsing, MIME build then parse round trip, recurrence against brute force                      | `test/jmap/unit/*-fuzz-test.js`                         | With the unit target                                               |
| Mutation           | The existing mutation runner extended to `lib/jmap/` core modules                                                                                           | `npm run test:mutation`                                 | Before each milestone                                              |
| Migration          | Root migration and journal TTL change against prepared legacy data                                                                                          | `test/jmap/scenarios/wildduck-test.js`                  | Scenario target                                                    |
| Sharded            | Scatter lookup by root, index use, move across shards on a local two shard cluster                                                                          | `test/jmap/sharded/`, docker compose                    | Manually and in the nightly workflow                               |
| Performance        | Email/get, Email/query, Email/changes and EventSource fan out under load on a seeded account                                                                | `test/jmap/bench/`                                      | Before milestones 1 and 4, results recorded                        |
| Security           | `/security-review` on every change, dedicated negative tests, a full audit before the pull request is ready                                                 | Sections 4.7 and F.2                                    | Continuous                                                         |
| Library consumers  | haraka-plugin-wildduck and zonemta-wildduck test suites against the branch                                                                                  | Sibling repositories                                    | 0.14 and F.4                                                       |

### 4.2 The scenario harness

Lives in `test/jmap/harness/` and is built in work package 0.2, before any JMAP code, so the phase 0 scenarios run through it.

| File          | Role                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenario.js` | `scenario('EGET-012', async ctx => { ... })` registers a Mocha test. The title is the id plus the catalogue title, so results map back to the catalogue. An id that is not in the catalogue, or is used twice, fails at load time                                                           |
| `client.js`   | Thin JMAP client on `fetch`: session discovery, `call(methodCalls, using)`, raw requests with arbitrary bodies and headers, upload, download, an EventSource reader. Bearer and Basic. No typed client library, because conformance tests must send malformed requests and inspect raw HTTP |
| `accounts.js` | Creates and deletes users through the REST API, issues tokens and application specific passwords, enables 2FA, sets quotas and limits                                                                                                                                                       |
| `seed.js`     | Seeding by the mechanism the scenario names: `lmtp` (deliver a message), `imap` (imapflow: append, store, copy, move, expunge, create, rename, subscribe), `api` (REST calls), `db` (direct documents, for legacy and race states), `jmap`                                                  |
| `fixtures.js` | Access to `imap-core/test/fixtures`, `test/fixtures` and JMAP specific messages under `test/jmap/fixtures/` (built in code or original files, never copied from other suites)                                                                                                               |
| `clock.js`    | Helpers for `time` scenarios: wait for a condition with a deadline, run a background task on demand (retention, upload cleanup, alert scheduler), and short TTLs from `config/test.toml`                                                                                                    |
| `assert.js`   | JMAP specific assertions: method response shape, SetError type and properties, state changed or unchanged, set equality for change lists                                                                                                                                                    |
| `cross.js`    | Reads the same message over IMAP and over JMAP for the equality scenarios                                                                                                                                                                                                                   |

Rules for scenario tests:

- One `scenario()` per catalogue id. A table driven loop is fine when each row calls `scenario()` with its own id.
- Each test creates what it needs (usually a fresh user) and cleans up; no test depends on another test's data.
- Seed with the mechanism in the catalogue. The cross protocol scenarios are the ones no external suite can run, so never replace IMAP or REST seeding with JMAP calls.
- Assertions on change lists compare sets, not arrays, unless the RFC defines an order.
- When implementing shows a scenario is wrong, correct the catalogue in the same commit and say why in the scenario notes. A scenario is never deleted: withdrawn ones keep their id with `applies: no`.
- Scenario notes that state an assumption are settled before the test is written, and the note is updated.

### 4.3 Coverage of the catalogue

`test/jmap/tools/check-coverage.js` (work package 0.2):

- Scans the scenario test files for `scenario('ID'` calls and compares them with the catalogue.
- `test/jmap/progress.json` lists the work packages that are finished. Every scenario assigned to a finished work package (through the id ranges in section 5) must have a test, and with `--results <mocha json>` must have passed. Missing or failing ids fail the run.
- Prints a table per area and phase: scenarios, implemented, passing. The same numbers are added to `test/jmap/overview.html`.
- `npm run test:jmap:coverage` runs the scenario target with the JSON reporter and then this check. CI runs it.

### 4.4 Commands and CI

New npm scripts:

| Script                 | Does                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `test:jmap`            | Scenario and unit targets against a running test server (through Grunt, like the other targets)                                        |
| `test:jmap:unit`       | Unit, fuzz and property tests, no server                                                                                               |
| `test:jmap:coverage`   | Scenario run plus the catalogue coverage check                                                                                         |
| `test:jmap:compliance` | jmapio suite: fetch at the pinned commit into a cache directory, build, run against the test server, compare with the expectation file |
| `test:jmap:fastmail`   | Fastmail suite in a container with the WildDuck adapter, compare with the expectation file                                             |
| `test:jmap:catalogue`  | Catalogue validator and overview build                                                                                                 |

Grunt: a `shell:mocha-jmap` target for `test/jmap/**/*-test.js`, excluded from the `mocha-api` glob and added to the `default` and `testonly` task lists; `shell:mocha-jmap-unit` added to `proto`. `config/test.toml` enables the JMAP service on its own port and shortens the journal retention, upload expiry and cache TTLs used by `time` scenarios.

GitHub Actions:

- `test.yml`: unchanged structure; `npm run runtest` now includes the JMAP targets, followed by the coverage check.
- New `jmap-compliance.yml`: on every push to the branch and pull request, start the server and run the jmapio suite (from milestone 2). Nightly and on manual dispatch: the Fastmail suite, the sharded tests and the mutation run.

### 4.5 External suites

Both suites have no licence file. They are run as external tools at the commit pinned in their expectation file and never copied into the repository.

- **jmapio** (`scripts/jmap/run-jmapio.js`): creates two throwaway users through the REST API, writes the suite's config file, runs it with `-f`, parses the JSON report and compares each test with the expectation file using the gate rules in `test/jmap/external/README.md`. The suite's push tests use the public relay smee.io; the runner keeps test traffic off it (push tests excluded in the runner, PushSubscription is covered by our own scenarios against a local receiver).
- **Fastmail** (`test/jmap/external/fastmail-adapter/`): a Perl adapter that provisions pristine accounts with `POST /users` and removes them afterwards, a Dockerfile with Perl and the suite's dependencies, and a runner that compares per file results with the expectation file.
- A test expected to pass that fails is a failure. A test listed as `never` that passes is also a failure, so the list is corrected on purpose. Updating a pinned commit is its own commit and re-derives the expectation file.

### 4.6 Interop

- `test/jmap/interop/jmap-jam-test.js`: automated, a typed client library reads mail, follows result references, downloads a blob and holds an EventSource connection.
- Scripted where the client allows it (aerc, lttrs-cli, meli), manual otherwise (Bulwark Webmail, Twake Mail, Cypht, Ltt.rs on a phone). Clients that need a public HTTPS URL reach the local server through a cloudflared quick tunnel.
- Each run is recorded in `docs/jmap/interop-log.md`: client and version, what was exercised, what failed, and the catalogue scenario added for every failure so it cannot regress.

### 4.7 Security testing

Besides `/security-review` on every change, these are tested explicitly and listed here so none is forgotten:

- Authentication: every endpoint without credentials, wrong credentials, disabled and suspended users, the `jmap` scope, 2FA rule, lockout counters also on cache misses, cache invalidation on password change and token revocation.
- Account isolation: every id type and blob id of user A requested by user B (get, set, query, download, upload, changes, EventSource, push).
- Request abuse: size, call count, object count, concurrent requests and uploads, deeply nested filters and JSON, result reference loops, prototype pollution keys, duplicate JSON keys, invalid UTF-8.
- Injection: header and envelope injection through Email/set and EmailSubmission (CR, LF, NUL), MongoDB operator injection through filters and patches, regular expression denial of service through search terms, HTML injection in SearchSnippet output.
- Server side requests: push URLs to private, loopback and link local addresses, DNS rebinding, redirects, non HTTPS schemes.
- Resource limits: upload quota and eviction, recurrence expansion bounds, alert and push rate limits, EventSource connection limits, slow clients.
- Information leaks: error messages and logs free of credentials, tokens and message content; `PushSubscription/get` never returns `url` or `keys`.

### 4.8 Performance and scale

- `test/jmap/bench/`: scripts that seed an account (100k messages, 500 mailboxes) and measure Email/get of 50 and 500 ids, Email/query with paging and anchors, Email/changes over 10k journal entries, and 1,000 concurrent EventSource connections. Results go into `docs/jmap/performance.md`.
- `test/jmap/sharded/`: a docker compose cluster (mongos, two shards) sharded like production (`messages` by `{mailbox, uid}`), used to prove that lookups by root work across shards, that a move across shards keeps the id, and that the new indexes are used.
- Production measurements (work package 0.13) decide the journal retention and whether a `{user, root}` mapping collection is needed.

## 5. Work packages

Each work package ends with the end of package steps of section 2.2. Scenario ids name the catalogue entries the package must turn green; "all" means every scenario of that prefix in the given phase.

### Phase 0: backend prerequisites

- [x] **0.1 Branch, portfolio, plan.** Commit the test portfolio and this plan. Reconcile the catalogue and the expectation files with the decisions of section 1.2 and 1.3: EmailDelivery (`EDLV-*`), special use rename (`MBX-016`, `MBX-038`, `MBX-191`), quota scenarios become planned (`QUOTA-*`), queryChanges scenarios (`EQRY-*` phase 4, three Fastmail and jmapio entries), copy error order (`ECPY-*`, `BLOB-*`), FUTURERELEASE (`SUB-001`), account id (`CORE-009`), `maxObjectsInGet` (`CORE-088`). Regenerate the overview. Fold the corrections into the feasibility report. Push and open the draft pull request.
- [x] **0.2 Harness foundation.** `test/jmap/harness/` (scenario, accounts, seed for LMTP, IMAP, API and database, fixtures, clock, assert), `check-coverage.js`, `progress.json`, Grunt targets, npm scripts, CI steps. Proven by a first scenario that needs no JMAP code (`WDP-001`).
- [x] **0.3 Fresh root on COPY.** `lib/handlers/on-copy.js`; the copy's journal entry carries the source root (`sourceRoot`), instead of a per message log line, which would have meant one log line per copied message. MOVE and archive restore fill a missing root from `_id` (`WDP-012`). `WDP-001` to `WDP-005`. Listed under "Changes for existing deployments".
- [x] **0.4 Lookup by root.** `by_root` indexes (`{root: 1}`, partial on documents with a root) on `messages` and `archived` in `indexes.yaml`; a shared resolver (`lib/message-roots.js`) that prefers the newest `_id` and reads a missing root as `_id`. A single field index instead of `{user, root}`: roots are globally unique, so it is as selective at half the size; queries keep the user condition. `WDP-006`, `WDP-009`, `WDP-010`.
- [x] **0.5 Root repair.** Per user instead of one migration over every message: `repairUserRoots` and `ensureUserRoots` in `lib/message-roots.js` fill missing roots and separate shared ones (oldest keeps it, after a settle delay that tells legacy copies from moves in progress), once per user, recorded in `jmapstate`. The JMAP service runs it on first use; the optional, throttled `messages_root_repair` migration does it for every user ahead of time. `findDuplicateRoots` reports shared roots. `WDP-007`, `WDP-008`, `WDP-011`.
- [x] **0.6 Journal: root and origin.** Every message journal entry carries `root` (`ImapNotifier` falls back to the message id for legacy documents); EXISTS entries carry `origin` (the `normalizeSource()` labels, or `consts.JOURNAL_ORIGIN` copy, move, restore). Writers in `lib/message-handler.js`, `lib/handlers/on-store.js`, `on-fetch.js`, `on-copy.js`, `lib/tasks/label-delete.js`, `pop3.js`. The SSE updates endpoint keeps working. `WDP-020`, `WDP-021`, `WDP-022`, `WDP-027`.
- [x] **0.7 Journal: mailbox settings.** `ImapNotifier.journalMailboxUpdate` writes `MAILBOX_UPDATE` entries from `MailboxHandler.updateAsync` (also for settings changed with a rename) and from the shared IMAP SUBSCRIBE/UNSUBSCRIBE handler; new optional `sortOrder` field on mailboxes; IMAP sessions ignore the new entry kinds. `WDP-023`, `WDP-028`.
- [x] **0.8 Journal retention.** `const:journal:time` setting, applied to the TTL index with `collMod` at index setup, default unchanged. `WDP-024`.
- [x] **0.9 State anchors.** `jmapstate` collection; `lib/journal-state.js` maintains the journal and delivery anchors lazily when a state is read (changed from the notifier write path so no write pays for it), bounded by the previous anchor. `WDP-025`, `WDP-026`.
- [x] **0.10 Storage for uploads.** Temporary uploads in the storage bucket (`metadata.expires`), kept apart from storage files: the REST storage API and default lookups do not see them, JMAP asks for them with `{temporary: true}`. `StorageHandler.removeExpiredUploads` from the GC, a streaming read path and stream input, a separate upload quota with oldest first eviction. `WDP-040` to `WDP-043`, `BLOB` phase 0.
- [x] **0.11 Auth scope.** `jmap` in `SCOPES` and the application password schemas, `disabledScopes` support, API documentation regenerated. `WDP-050`, `WDP-051`, `CORE` phase 0.
- [x] **0.12 Indexes for account wide listing.** `user_idate` (`WDP-013`); note in `indexes.yaml` that `user_messages_by_thread` and the `by_idate` indexes are required by JMAP.
- [ ] **0.13 Sharded test rig and measurements.** Done: docker compose cluster and tests under `test/jmap/sharded/` (`npm run test:jmap:sharded`), `test/jmap/bench/roots-bench.js`, `scripts/jmap/measure-production.js`, local results in `docs/jmap/performance.md`. Pending: the production numbers (needs cluster access); until then the retention default stays at 3 hours and no mapping collection is built.
- [ ] **0.14 Library consumers.** Run the haraka-plugin-wildduck and zonemta-wildduck suites against the branch; fix or document anything that changes.
- [ ] **Milestone 0.** All 31 phase 0 scenarios pass, existing suites untouched, pull request description updated.

### Phase 1: core and read only mail

- [ ] **1.1 Service skeleton.** `jmap.js`, `config/jmap.toml`, `worker.js`, `lib/certs.js`, metrics, `config/test.toml`. `WDS-001`, `WDS-002`, `WDS-004`.
- [ ] **1.2 Authentication.** `lib/jmap/auth.js`: Bearer tokens, Basic, positive cache keyed by credential hash and `authVersion`, failure counters, 401 with `WWW-Authenticate`. `CORE` scenarios with method `Auth`.
- [ ] **1.3 Session and discovery.** `lib/jmap/session.js`, `/.well-known/jmap`, capabilities and limits, session state, no caching headers, public base URL. `CORE` scenarios with method `Session`, `WDS-003`.
- [ ] **1.4 Request dispatcher.** `lib/jmap/request.js`: envelope validation, `using` gating, limits, problem details, method errors, sequential execution, `Core/echo`, strict JSON handling. `CORE` scenarios with method `Request` and `Core/echo`. Fuzz tests for the envelope.
- [ ] **1.5 Result references and creation ids.** `lib/jmap/references.js`. Remaining `CORE` phase 1 scenarios. Unit and property tests for the pointer evaluation.
- [ ] **1.6 State module.** `lib/jmap/state.js`: state strings with account binding, journal folding, `maxChanges`, expiry detection, safety window. Unit tests with synthetic journals; the scenarios arrive with 1.9, 1.10 and 1.14.
- [ ] **1.7 Ids.** `lib/jmap/ids.js` with unit tests for every id and blob id type.
- [ ] **1.8 Mailbox/get.** Properties, role and parent derivation, counts, thread counters maintained by the notifier, `myRights`. `MBX` scenarios with method `Mailbox/get`, `WDX-010`.
- [ ] **1.9 Mailbox/changes and Mailbox/query.** Including `updatedProperties`, byte wise name sort, tree options; Mailbox/queryChanges answers `cannotCalculateChanges` until 4.3. Remaining `MBX` phase 1.
- [ ] **1.10 Thread/get and Thread/changes.** `THR` phase 1.
- [ ] **1.11 Email model: metadata and headers.** `lib/jmap/email-model.js`: metadata, keywords and labels, every header form, convenience properties. Unit tests on fixtures; `EGET` scenarios on metadata and headers.
- [ ] **1.12 Email model: body.** `lib/jmap/email-body.js`: bodyStructure, textBody, htmlBody, attachments, bodyValues, truncation, encoding problems, preview. Unit tests on the MIME fixture corpus; remaining `EGET` scenarios.
- [ ] **1.13 Email/get.** Wiring, properties handling, limits, body value budget. `EGET` complete (184), `WDX-003`, `WDX-005`.
- [ ] **1.14 Email/changes.** Every origin of change across IMAP, POP3, REST API, delivery and background tasks. `ECHG` phase 1 (107), `WDX-001`, `WDX-002`, `WDX-004`.
- [ ] **1.15 Email/query.** `lib/jmap/email-search.js`: filters, operators, sorts, paging, anchors, `collapseThreads`, `calculateTotal`, query state; `unsupportedFilter` and `unsupportedSort` where phase 4 will add support. `EQRY` phase 1 (152).
- [ ] **1.16 SearchSnippet/get.** `lib/jmap/snippet.js`. `SNIP` (21).
- [ ] **1.17 Blobs and download.** `lib/jmap/blob.js`, the download endpoint. `BLOB` phase 1 (28).
- [ ] **1.18 EventSource and EmailDelivery.** `lib/jmap/push/eventsource.js`. `ESRC` phase 1 (50), `EDLV` phase 1 (16).
- [ ] **1.19 Operations and first interop.** Access log, slow query handling (`WDS-005`, `WDS-006`); `jmap-jam` interop test; read only runs with aerc and meli recorded in the interop log; first benchmark run.
- [ ] **Milestone 1.** All 848 phase 1 scenarios pass; the 12 Fastmail files expected at phase 1 pass.

### Phase 2: writes

- [ ] **2.1 Upload endpoint.** `BLOB` phase 2 (20).
- [ ] **2.2 Mailbox/set.** Create, update, destroy, `onDestroyRemoveEmails`, `ifInState`, visibility over IMAP. `MBX` phase 2 (91).
- [ ] **2.3 PatchObject and Email/set update.** `lib/jmap/patch.js` with unit and property tests; keywords, labels, moves judged on the resulting object, immutable properties. `ESET` update scenarios.
- [ ] **2.4 Email/set destroy.** Archive behaviour, counts, state. `ESET` destroy scenarios, `ECHG` phase 2.
- [ ] **2.5 MIME builder.** `lib/jmap/email-builder.js` over nodemailer's MimeNode: arbitrary bodyStructure, parts by blob id, per part headers, header forms, generated Message-ID and Date, injection safe. Unit tests and a build then parse round trip property test.
- [ ] **2.6 Email/set create.** Through the existing store path (quota, encryption, journaling). Remaining `ESET` phase 2 (238 in total), `WDX-007`, `WDX-008`, `WDX-009`.
- [ ] **2.7 Email/import.** `EIMP` phase 2 (37).
- [ ] **2.8 Email/parse.** `EPAR` phase 2 (31).
- [ ] **2.9 Copy methods.** Email/copy and Blob/copy with the RFC error order. `ECPY` (6), `BLOB` copy scenarios.
- [ ] **2.10 Owned change log.** `lib/jmap/changelog.js`, `jmapchanges` collection, tombstone expiry. Unit tests.
- [ ] **2.11 Identity.** `jmapidentities`, Identity/get, set and changes; address changes through the REST API feed the change log. `IDN` (57).
- [ ] **2.12 VacationResponse.** Over `autoreplies`, round trip with the REST API, end to end replies. `VAC` (48).
- [ ] **2.13 Account lifecycle.** User deletion and restore cover the JMAP collections. `WDS-007`, `WDS-008`.
- [ ] **2.14 External suite runners.** `scripts/jmap/run-jmapio.js`, the Fastmail adapter and container, `jmap-compliance.yml`. First full runs; every difference from the expectation files is either fixed in the server or corrected in the file with a reason.
- [ ] **Milestone 2.** All 559 phase 2 scenarios pass; jmapio 262 of 309 as expected; Fastmail 112 of 173. Interop round with Ltt.rs, Bulwark Webmail and Cypht.

### Phase 3: submission

- [ ] **3.1 Submissions store.** `jmapsubmissions`, change log integration, cleanup after delivery.
- [ ] **3.2 EmailSubmission/set create.** Envelope derivation, validation, every SetError, recipient limits, Bcc stripping, injection safety, through `Maildropper`. `SUB` create scenarios.
- [ ] **3.3 Implicit Email/set.** `onSuccessUpdateEmail` and `onSuccessDestroyEmail`, creation id references, exactly one Sent copy. `SUB` onSuccess scenarios, `ESET` phase 3.
- [ ] **3.4 Delayed send and undo.** FUTURERELEASE hold parameters, `maxDelayedSend`, `undoStatus` transitions, `cannotUnsend`, destroy without cancelling. `SUB` delayed send and undo scenarios.
- [ ] **3.5 Read side.** EmailSubmission/get, changes, query, queryChanges. Remaining `SUB` (140 in phase 3).
- [ ] **3.6 End to end.** Delivery between two local users, queue entries visible in the REST API, DKIM where configured. Sending through aerc and Twake Mail recorded in the interop log.
- [ ] **Milestone 3.** All 142 phase 3 scenarios pass; jmapio 276; Fastmail 116.

### Phase 4: conformance extras

- [ ] **4.1 PushSubscription store.** `jmappush`, PushSubscription/get and set, binding to credentials, limits. `PUSH` store scenarios.
- [ ] **4.2 Web Push delivery.** Verification, RFC 8291 encryption checked against the RFC test vector, VAPID, BullMQ delivery with backoff, expiry, SSRF protection, a local receiver for tests. Remaining `PUSH` (87).
- [ ] **4.3 queryChanges.** `lib/jmap/query-cache.js`; Email/queryChanges and Mailbox/queryChanges. `EQRY` queryChanges scenarios, `MBX` phase 4 (10).
- [ ] **4.4 Thread keyword filters and sorts.** `allInThreadHaveKeyword`, `someInThreadHaveKeyword`, `noneInThreadHaveKeyword`. `EQRY` thread keyword scenarios.
- [ ] **4.5 Sorts on from, to and subject.** Starts with a short design note (derived sort keys on new and migrated messages, or OpenSearch backed sorting with an in memory fallback for bounded result sets); `emailQuerySortOptions` lists only what works. `EQRY` sort scenarios.
- [ ] **4.6 Body search through OpenSearch.** Finish the query path that is commented out in `lib/api/messages.js`, for indexed users; analyzer that keeps short terms. `EQRY` full body search scenarios (45 in phase 4 in total).
- [ ] **4.7 RFC 9404.** Blob/upload, Blob/get, Blob/lookup, capability. `BLOB` phase 4 (36), `EIMP` and `EPAR` phase 4.
- [ ] **4.8 Quota.** Quota/get, query, changes, queryChanges over `users.quota` and `storageUsed`. `QUOTA` (22).
- [ ] **4.9 IMAP OBJECTID.** EMAILID, THREADID, MAILBOXID reporting the JMAP ids. `WDX-006`.
- [ ] **Milestone 4.** All 204 phase 4 scenarios pass; jmapio 298; Fastmail 121. Second benchmark run. Mutation run on `lib/jmap/` core modules.

### Phase 5: contacts

- [ ] **5.1 Storage.** `lib/contact-handler.js`, `addressbooks` and `contacts` collections and indexes, limits, default address book.
- [ ] **5.2 JSContact validation.** `lib/schemas/jscontact.js` for the existing Ajv setup, with unit tests from RFC 9553 examples.
- [ ] **5.3 AddressBook.** Get, changes, set. `ABK` scenarios not tied to the register.
- [ ] **5.4 ContactCard get, set, changes.** Including deep patches and uid rules. `CARD` get, set and changes scenarios.
- [ ] **5.5 Media.** Photos as blobs, data URIs converted on input, download and Blob/lookup. `CARD` media scenarios.
- [ ] **5.6 ContactCard/query and queryChanges.** Every filter and sort, text index. `CARD` query scenarios.
- [ ] **5.7 Address register.** Read only address book synthesised from `addressregister`; register writes feed the change log. Remaining `ABK` (78 in total).
- [ ] **5.8 Push, copy errors, lifecycle.** StateChange for contact types, ContactCard/copy errors, user deletion. Remaining `CARD` (176 in total).
- [ ] **Milestone 5.** All 254 phase 5 scenarios pass; Fastmail 137. Contacts interop with Bulwark Webmail.

### Phase 6: calendars without scheduling

- [ ] **6.1 Storage.** `lib/calendar-handler.js`, `calendars` and `calendarevents` collections and indexes, limits, default calendar.
- [ ] **6.2 JSCalendar validation.** `lib/schemas/jscalendar.js`, with the draft's own constraints.
- [ ] **6.3 Recurrence engine.** Starts with the dependency comparison of section 3.9 and stops for approval. Then `lib/calendar/recurrence.js`: every rule part, overrides, time zones and DST, bounded expansion, synthetic instance ids. Unit tests and a property test against brute force expansion.
- [ ] **6.4 Calendar and ParticipantIdentity.** Get, changes, set; identities derived from addresses, fed by REST API address changes. `CAL` (77), `PID` (19).
- [ ] **6.5 CalendarEvent get, set, changes.** Including synthetic ids, uid and recurrenceId rules, deep patches, attachments by blob id. `CEV` phase 6 (160).
- [ ] **6.6 CalendarEvent/query.** Bounds index, filters, sorts, `expandRecurrences`, queryChanges. `CEQ` (77).
- [ ] **6.7 Alerts.** `lib/calendar/alerts.js`: trigger computation, scheduler, acknowledge and snooze, the CalendarAlert push event, email alerts to the user's own address, rate limits and jitter. `CALR` (42).
- [ ] **6.8 Lifecycle.** CalendarEvent/copy errors, user deletion, absence of availability and sharing capabilities.
- [ ] **Milestone 6.** All 375 phase 6 scenarios pass; Fastmail 153. Calendar interop with Bulwark Webmail.

### Finishing

- [ ] **F.1 Documentation.** `docs/in-depth/jmap.md` (configuration, authentication, discovery, reverse proxy notes for the event stream, limits, supported capabilities, known deviations), an operations section (root migration, journal retention, index builds), `docs/in-depth/protocol-support.md`, README, CLAUDE.md, the wildduck-docs site.
- [ ] **F.2 Security audit.** A full pass with the security audit workflow over `jmap.js`, `lib/jmap/` and the changed shared handlers; every finding fixed or recorded.
- [ ] **F.3 Performance.** Final benchmark and sharded runs, compared with the earlier ones, recorded.
- [ ] **F.4 Library consumers.** Plugin suites against the final branch.
- [ ] **F.5 Final gates.** `npm test`, catalogue coverage (every scenario of phases 0 to 6 has a passing test), both external suites match their expectation files, mutation run, a last interop round with every client in section 4.6.
- [ ] **F.6 Pull request ready.** Merge `origin/master`, final description (section 8), mark ready for review.

### Phase 7 (not in this pull request)

Calendar scheduling: 117 scenarios (`CSCH`, `CPAR`, `CEN`, one `CEV`). Planned after the calendars draft and JSCalendar bis are published; the catalogue is reviewed against the published text first.

## 6. Operations and rollout

What a deployment has to do, in order. This becomes the operations section of the documentation (F.1) and is kept current as work lands.

1. Deploy the release with JMAP disabled. New indexes are created at start up; on a large cluster build `by_root` and `user_idate` ahead of time with a rolling index build (they are created at start up only once JMAP is enabled).
2. Run the root migration (`run-migrations`). It is throttled, resumable and safe to run while the system is in use. Until it has finished for a user, lookups read a missing root as `_id`.
3. Set the journal retention (`const:journal:time`) to the chosen value; the TTL index is changed at the next start. The longer retention applies to every user.
4. Enable the service (`config/jmap.toml`), publish `/.well-known/jmap` and the SRV record, configure the reverse proxy not to buffer the event stream.
5. Watch the metrics: request rate and latency per method, scatter lookup latency, journal size, EventSource connections, push queue depth.

Rollback: disabling the service is enough. The schema additions (new fields, new collections, new indexes) are ignored by older code. The one behaviour that stays is the fresh root on COPY.

## 7. Documentation deliverables

- `docs/in-depth/jmap.md`, operations notes, protocol support table, README mention.
- `docs/jmap/implementation-plan.md` (this file), `docs/jmap/interop-log.md`, `docs/jmap/performance.md`. Whether the three working documents stay in the final pull request is decided at F.6.
- `test/jmap/README.md` updated with the harness and the commands.
- CLAUDE.md: the JMAP service, module layout, test commands.

## 8. Pull request description outline

1. What this adds, in three sentences, and that the service is off by default.
2. Phase checklist (kept current while the pull request is a draft).
3. Changes for existing deployments: fresh root on COPY, journal fields and retention setting, new indexes and collections, the root migration, the new auth scope.
4. How to try it: configuration, a curl session request, a client to point at it.
5. Testing: scenario counts, external suite results against their expectation files, interop log summary, benchmark summary.
6. Known deviations from the RFCs and what is not included (phase 7, sharing).
7. Review guide: suggested reading order by directory, since the diff is large.

## 9. Risks

| Risk                                                                 | Mitigation                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One very large pull request is hard to review                        | Logical commits in dependency order, shared handler changes first and each in its own commit with its own tests, a review guide in the description, the draft open from the start so review can follow the work |
| The branch drifts from `master` over a long time                     | Merge `origin/master` at the start of every session; shared handler changes are small and early                                                                                                                 |
| Scatter lookups by root are too slow in production                   | Measured in 0.13 before the read path is built on them; the mapping collection is the prepared fallback                                                                                                         |
| Journal growth at the longer retention                               | Measured in 0.13; the dedicated per user change log remains the fallback design                                                                                                                                 |
| Shared handler changes break IMAP, POP3, the REST API or the plugins | Phase 0 lands first with its own scenarios, the full existing suite runs on every change, plugin suites run in 0.14 and F.4                                                                                     |
| Catalogue scenarios turn out wrong                                   | They are corrected in the same commit as the test, with the reason in the notes; ids are never reused                                                                                                           |
| External suites change                                               | Pinned commits; an update is a deliberate commit that re-derives the expectation file                                                                                                                           |
| The calendars draft changes before publication                       | Phase 6 avoids scheduling; event property scenarios are marked as following RFC 8984 plus the draft, and are reviewed when the RFC is published                                                                 |
| Text search semantics differ between MongoDB and OpenSearch users    | One translation module with both back ends tested against the same scenarios                                                                                                                                    |

## 10. Progress log

| Date       | Work package | Notes                                                                                                                                                                                                                                                            |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-11 | Plan         | Plan written; branch `jmap` created; portfolio and plan not yet committed                                                                                                                                                                                        |
| 2026-11-11 | 0.1          | Portfolio committed; catalogue and expectations reconciled with the decisions (12 interim scenarios withdrawn, EmailDelivery, rename, quota, queryChanges, VAPID, account id); feasibility report and PDF revised; baseline `npm test`: 4,818 passing, 0 failing |
