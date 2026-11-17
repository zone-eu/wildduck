# JMAP client interop log

Real clients against a WildDuck test server from branch `jmap` (implementation plan section 4.6). Every run lists the client and version, what was exercised and what failed. Every failure is either fixed in WildDuck, with the catalogue scenario that keeps it fixed, or recorded as a client problem with the evidence and the spec reference.

## Summary

| Client          | Version                       | Date       | Result                                                                                                                                     | WildDuck fixes                                            |
| --------------- | ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| jmap-jam        | 0.13.8                        | 2026-11-12 | Pass, automated (`test/jmap/interop/jmap-jam-test.js`)                                                                                     | none                                                      |
| aerc            | 0.22.0 (go-jmap 0.5.3)        | 2026-11-12 | Pass after one fix                                                                                                                         | upload status (BLOB-086)                                  |
| meli            | 0.9.0                         | 2026-11-12 | Pass after two fixes                                                                                                                       | null collation (EQRY-198), undoStatus on create (SUB-144) |
| Bulwark Webmail | 1.21.1                        | 2026-11-12 | Pass after one fix (F.5b)                                                                                                                  | CORS on the event stream (ESRC-053)                       |
| Twake Mail web  | 0.41.3 (`linagora/tmail-web`) | 2026-11-12 | Fails without TMail behaviour: empty mailbox list and no sending. Everything else passes once two client errors are patched in the request | none, both are client errors                              |
| Cypht           | 2.12.2 (`cypht/cypht:latest`) | 2026-11-12 | Partial: reading, search, flags and moves pass; appending, folder management and sending do not                                            | none, client errors                                       |
| Ltt.rs          | not run                       |            | Android only                                                                                                                               |                                                           |

## Setup

- WildDuck from the worktree of branch `jmap` (later `jmap-interop`), `NODE_ENV=test` with every port overridden (API 8211, IMAP 9211, POP3 9212, LMTP 2411, JMAP 8212, metrics 9911), its own MongoDB database `wildduck-interop` and its own Redis on port 6398.
- jmap-jam: the plain HTTP listener, as in every scenario run.
- Real clients: JMAP over HTTPS on 8212 with a self signed certificate for `host.docker.internal`, `[jmap] baseUrl = "https://host.docker.internal:8212"`, `[jmap.cors]` for the Twake origin. aerc and meli ran in an Alpine edge container (distribution packages, the certificate added to the trust store) driven through tmux `send-keys` and `capture-pane`. Twake Mail and Cypht ran in their published images, driven with Playwright from the host, with `host.docker.internal` mapped to the host.
- Accounts were seeded over the REST API and LMTP (six messages, one with an attachment, a two message thread, a `Projects` folder). Sending was checked end to end: the queued message was handed to the recipient's mailbox with the ZoneMTA stand in of the test harness (`test/jmap/harness/outbound.js`) and read back.

## jmap-jam 0.13.8

Automated in `test/jmap/interop/jmap-jam-test.js`, part of the `mocha-jmap` target (`npm run test:jmap`). Seeding over LMTP, the REST API and IMAP only.

| Exercised                                                                  | Result |
| -------------------------------------------------------------------------- | ------ |
| Session with Bearer token, primary mail account                            | Pass   |
| Mailbox/get, counts                                                        | Pass   |
| Email/query then Email/get through a result reference (`#ids`), Thread/get | Pass   |
| Attachment download (`downloadBlob`), bytes and headers                    | Pass   |
| Upload (`uploadBlob`) and download of the same blob                        | Pass   |
| Email/set create of a draft with the uploaded blob, checked over IMAP      | Pass   |
| Event source (`connectEventSource`), StateChange after an LMTP delivery    | Pass   |

Client side, not WildDuck:

- `connectEventSource` constructs the global `EventSource`, which sends no `Authorization` header (and Node has none without `--experimental-eventsource`). RFC 8620 7.3 makes the event source an authenticated GET, so the library only works where the browser holds credentials for the JMAP host. The test supplies an `EventSource` that adds the Bearer token (`test/jmap/interop/event-source.js`).
- The README listens for `message` events; RFC 8620 7.3 sends StateChange as event type `state`, so such a listener never fires.
- `ping` is required in practice: without it the library sends `ping=undefined`, which WildDuck refuses with 400 (RFC 8620 7.3 defines ping as a number).
- URL templates are filled in without percent encoding (`dist/index.js`, `replaceAll`), so a file name with `/` or `?` breaks the download URL (RFC 6570 level 1 encodes the values). Not hit by the test.

## aerc 0.22.0

Alpine edge package, built with go-jmap 0.5.3. `source = jmap://aerc1:...@host.docker.internal:8212/.well-known/jmap`, `outgoing = jmap://`, `copy-to = Sent Mail`.

| Exercised                                                                       | Result             |
| ------------------------------------------------------------------------------- | ------------------ |
| Folder list with unread counts                                                  | Pass               |
| Open a message (plain text, full headers)                                       | Pass               |
| Search: `:filter -b zebra` (body), `:filter Lunch` (subject)                    | Pass               |
| Flag (`:flag`), checked over the REST API                                       | Pass               |
| Move (`:move Projects`), checked over the REST API                              | Pass               |
| Send: upload, Email/import, EmailSubmission/set, copy in `Sent Mail`; delivered | Pass after the fix |
| Live update: a message delivered over LMTP appears without action               | Pass               |

Failure, fixed in WildDuck:

- **Sending failed with `HTTP 201 201 Created`.** The upload endpoint answered 201. go-jmap treats every status but 200 as an error (`client.go`, `if resp.StatusCode != 200`), so aerc could neither send nor postpone. RFC 8620 6.1 names no status code for a successful upload; Stalwart answers 200, and jmapio, the Fastmail suite, jmap-jam, meli and Bulwark accept any 2xx. Fixed in `c6ae76e0` (the upload answers 200), new scenario **BLOB-086**, BLOB-024, BLOB-028 and BLOB-029 now expect 200.

Client side, not WildDuck:

- The date shown in the list and in the message view is `receivedAt`, not the `Date` header (`sentAt`, RFC 8621 4.1.2.3). The raw message has the right date.
- go-jmap uploads every blob with `Content-Type: application/json`, so uploaded messages are typed `application/json` (RFC 8620 6.1 takes the type from that header). Harmless, Email/import reads the bytes; BLOB-086 covers it.
- The message view shows a `Labels:` header that is not in the message; aerc adds it from the mailbox ids.

## meli 0.9.0

Alpine edge package. `format = "jmap"`, `server_url = "https://host.docker.internal:8212"`, `send_mail = "server_submission"`.

| Exercised                                                 | Result                    |
| --------------------------------------------------------- | ------------------------- |
| Folder list, thread view (the two message thread grouped) | Pass after the first fix  |
| Open a message with an attachment (MIME tree, download)   | Pass                      |
| Search (`:search zebra`, Email/query on the server)       | Pass                      |
| Flag (`:flag set flagged`), set seen on open              | Pass                      |
| Move (`:moveto Projects`)                                 | Pass                      |
| Send through EmailSubmission, delivered                   | Pass after the second fix |
| Live update over the event source after an LMTP delivery  | Pass                      |
| Contacts: AddressBook/get, ContactCard/get                | Pass                      |

Failures, fixed in WildDuck:

- **No mail at all ("Could not deserialize server JSON response").** meli sends `collation: null` in every Comparator. WildDuck answered `invalidArguments` ("collation must be a string"), so every Email/query failed. RFC 8620 5.5 types `collation` and `isAscending` as optional String and Boolean, so null is strictly invalid, but Cyrus and Stalwart read null as absent, as WildDuck already did for `position`. Fixed in `afee0f8d` for every /query method with a sort, new scenario **EQRY-198**.
- **Sending silently did nothing.** meli creates the submission with `undoStatus: "final"`. WildDuck refused it with `invalidProperties` (only the value it sets itself, `pending`, was accepted), and meli does not read `notCreated`. RFC 8621 7 makes undoStatus server set on create, so meli should not send it, but Stalwart ignores the value. Fixed in `7c71655f`: `pending` and `final` are ignored, `canceled` is still refused (SUB-025). The created object now also reports server set values that differ from what the client sent (RFC 8620 5.3), here the real undoStatus and the derived envelope. New scenario **SUB-144**.

Client side, not WildDuck:

- EmailSubmission/set errors are not checked (`melib/src/jmap/mod.rs`, "[ref:TODO] parse/return any error"), so a refused submission looks sent. The draft stays in Drafts.
- Each send leaves two copies in `Sent Mail`: the draft moved there by `onSuccessUpdateEmail`, and a second Email/import from `composing.store_sent_mail`. The imported copy is not `$seen`. With JMAP submission `store_sent_mail = false` avoids the duplicate.
- After `moveto` the message stays in the source mailbox listing until meli restarts. meli takes the new Email state from the Email/set response and so skips Email/changes; the server reported the move correctly (the Mailbox counts and a fresh start are right).
- The download URL is filled in with an empty `{name}` and no `type`; WildDuck serves it.

## Bulwark Webmail 1.21.1

Run as work package F.5b on 2026-11-12: production build driven with Playwright, JMAP over HTTPS cross origin with `[jmap.cors]`. Full report in the F.5b progress log entry of the plan.

| Exercised                                                                                   | Result             |
| ------------------------------------------------------------------------------------------- | ------------------ |
| Sign in, session discovery, folder tree and counts, threads and paging                      | Pass               |
| HTML message with inline image, plain text, attachment download                             | Pass               |
| Search (text, sender), star, read, tags, folder create and rename, move, delete and destroy | Pass               |
| Compose with attachment, draft, send, reply, forward, undo send (FUTURERELEASE)             | Pass               |
| Identities, vacation response, contacts, calendar events and a weekly series                | Pass               |
| Live updates from LMTP delivery and IMAP flag changes over the event stream                 | Pass after the fix |

Failure, fixed in WildDuck: the event stream dropped the CORS headers after the reply was hijacked, so a cross origin client could not read it. Fixed in `cc2c556e`, scenario **ESRC-053**.

Client side, not WildDuck: Stalwart probes (`PROPFIND /dav/cal/`, an admin check) even with `STALWART_FEATURES=false`, answered 404 and handled; no `$answered` or `$forwarded` on the original after reply or forward (RFC 8621 4.1.1); the forward header shows `receivedAt`; a search filter survives a reload; the attachment reminder fires on quoted text. Not tested: delivery past `zone-queue`, Web Push.

## Twake Mail web 0.41.3

`linagora/tmail-web:latest` (image revision `524c1d7b`), `SERVER_URL=https://host.docker.internal:8212/`, Firebase and the app grid off. Sign in with username and password (Basic) after its OpenID probes.

| Exercised                                                           | Result                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Sign in, Identity/get, Mailbox/get, Quota/get, VacationResponse/get | Pass                                                         |
| Mailbox list                                                        | Fails, client error (1). Pass with the request patched       |
| Open a message with an attachment                                   | Pass with (1) patched                                        |
| Star, search with highlighted snippets, move to a folder            | Pass with (1) patched                                        |
| Send                                                                | Fails, client error (2). Pass and delivered with (2) patched |
| Live update after an LMTP delivery                                  | Not shown within 20 s, see (3)                               |

Client errors, TMail specific:

1. **Every Email/get asks for `header:List-Unsubscribe:asText`.** RFC 8621 4.1.2.2 allows the Text form only for Subject, Comments, Keywords, List-Id and fields not defined in RFC 5322 or RFC 2369; List-Unsubscribe is defined in RFC 2369 (its parsed form is URLs, 4.1.2.7). RFC 8621 4.2 says fetching a forbidden form "MUST result in the method call being rejected with an invalidArguments error", which WildDuck does, so Twake shows an empty mailbox. Apache James (TMail's backend) accepts it. Not changed in WildDuck: the MUST is tested by the catalogue. With the property removed from the request by Playwright, the rest of Twake works.
2. **EmailSubmission/set without `identityId`.** RFC 8621 7 defines `identityId` as a required, immutable property, and WildDuck answers `invalidProperties` naming it. Twake has already created the Email in its own Outbox, so a failed send leaves a message there. With `identityId` added to the request the submission is created, the message moves to `Sent Mail` and is delivered.
3. **No push without TMail transports.** Twake web opened no event source connection; it pushes over the JMAP WebSocket (RFC 8887) or Firebase, neither offered here.

Other TMail behaviour, handled: it creates `Outbox` and `Templates` folders and tries to give them the roles `outbox` and `templates`, which WildDuck refuses (changing a role is rejected, MBX-188), so they stay plain folders; it probes `/.well-known/openid-configuration`, `/.well-known/webfinger` and `/.well-known/linagora-ecosystem` (404); its EmailBodyValue objects carry extra `header:*` keys, which WildDuck ignores.

## Cypht 2.12.2

`cypht/cypht:latest` with the `jmap` module enabled, sqlite, no cache servers. The web UI could not save a JMAP only server, so the module's own JMAP client class (`modules/imap/hm-jmap.php`, the code the UI calls) was driven from PHP inside the container.

| Exercised (Hm_JMAP)                                                           | Result                                                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Session (Basic, `/.well-known/jmap/`), folder list                            | Pass                                                                              |
| Mailbox page (Email/query, Email/get), headers, structure                     | Pass                                                                              |
| Search: body and subject                                                      | Pass                                                                              |
| Flag, mark read, move                                                         | Pass                                                                              |
| Append to `Sent Mail` (upload, Email/import), used for sent copies and drafts | Fails, client error (1)                                                           |
| Create, rename and delete a folder (Mailbox/set)                              | Fails, client error (1)                                                           |
| Send                                                                          | Not supported: the JMAP module has no EmailSubmission, Cypht sends over SMTP only |

Client errors:

1. **Empty creation ids.** Every create is built as `array(NULL => ...)`, which PHP turns into the key `""`. A creation id is an `Id` (RFC 8620 5.3, `create: Id[Foo]`), and an Id is 1 to 255 characters (RFC 8620 1.2), so WildDuck answers `invalidArguments` ("invalid creation id").
2. The server setup stepper accepts a JMAP only server only with both "Sender account" and "Receiver account" on, and its handler then sets up SMTP first and fails on the empty SMTP address ("Authentication failed", "Could not save server"). Calling the same AJAX hook with the sender off reached the session endpoint twice but did not save the server either.
3. `get_special_use_mailboxes()` without a type returns only one role (`$res[$type]` with `$type` false), so only Trash was recognised.

Deployment note: behind a published port the image's nginx hands PHP the Host without the port, and Cypht's origin check then logs every login out ("invalid source origin"). The run sent `X-Forwarded-Host: 127.0.0.1:8214`.

## Ltt.rs

Not run. Ltt.rs is an Android application; this environment has no Android device or emulator, and its JMAP library (jmap-mua) is not the client. Plan item 4.6 lists it as manual, on a phone.
