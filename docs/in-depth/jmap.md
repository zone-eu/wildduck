# JMAP support (overview) ✨

This document describes the JMAP support implemented in WildDuck. It covers discovery, session, uploads/blobs, core methods implemented, configuration, authentication, testing, and next steps.

---

## Status ✅

- Implemented: discovery (`/.well-known/jmap`), session resource (`GET /jmap`), POST dispatcher (`POST /jmap`) and upload endpoint (`POST /jmap/upload`).
- Core JMAP methods implemented: `Mailbox/get`, `Mailbox/set` (create), `Email/query`, `Email/get`, `Email/set` (flags), `Email/send`, and a best-effort `Email/changes` feed.
- Attachments: upload to GridFS via `POST /jmap/upload` and reference using `blobId` in `Email/send`.
- Auth: supports Bearer tokens (existing API tokens) and Basic auth (username/password).
- Push: reuses SSE at `/users/:user/updates` for notifications.

---

## Quick endpoints reference 🔗

- Discovery: `GET /.well-known/jmap` – returns `apiUrl` and basic capability list.
- Session: `GET /jmap` – returns session object with `apiUrl`, `uploadUrl`, `downloadUrl` template, `eventSourceUrl`, `state`, and `maxUploadSize`.
- Dispatcher: `POST /jmap` – JMAP methodCalls (array) are dispatched and responses are returned in `methodResponses`.
- Upload: `POST /jmap/upload` – accepts raw binary body or JSON `{ content: "<base64>", encoding: "base64" }`.
- Storage: existing storage endpoints are available under `/users/:user/storage`.

---

## Authentication examples 🔐

- Bearer token (preferred for automation):

  - Header: `Authorization: Bearer <accessToken>`

- Basic auth (username/password):

  - Header: `Authorization: Basic <base64(username:password)>`

The server prefers token-based auth when provided, and falls back to Basic auth when needed.

---

## Example: session discovery (GET /jmap) 💡

Request (Basic auth or Bearer):

```
GET /jmap
Authorization: Basic <...>
```

Response (excerpt):

```
{
  "username": "<accountId>",
  "apiUrl": "https://example.com/jmap",
  "uploadUrl": "https://example.com/jmap/upload",
  "downloadUrl": "https://example.com/users/:user/storage/:file",
  "eventSourceUrl": "https://example.com/users/:user/updates",
  "state": "1234567890",
  "maxUploadSize": 26214400
}
```

---

## Upload blob example (POST /jmap/upload) 📎

- You can upload a binary file directly in the body (set `x-filename`, `content-type` headers).
- Or POST JSON: `{ "filename": "pic.png", "encoding": "base64", "content": "<base64>" }`.

On success the server returns `{ success: true, id: "<blobId>" }` which can be referenced in `Email/send` attachments like `{ blobId: "<blobId>", filename: "pic.png" }`.

> Note: uploads are size-limited by `config.jmap.maxUploadMB` (default 25 MB).

---

## JMAP method examples 📨

- Email/query (list ids):

Request body:
```
{ "methodCalls": [["Email/query", {"filter": {"inMailbox": "<mailboxId>"}, "limit": 20}, "R1"]]
}
```

- Email/get (fetch messages):

Request body:
```
{ "methodCalls": [["Email/get", {"ids": ["<id>"]}, "R1"]]
}
```

- Email/set (flags):

Request body to add \Seen:
```
{ "methodCalls": [["Email/set", {"update": {"<id>": {"addFlags": ["\\Seen"]}}}, "R1"]]
}
```

- Email/send (with a blob):

Request body:
```
{
  "methodCalls": [[
    "Email/send",
    {"create": {"c1": {"email": {"to": [{"address":"you@example.com"}], "subject":"Hi","text":"See blob","attachments": [{"blobId": "<blobId>"}]}}}},
    "R1"
  ]]
}
```

---

## Email/changes (best-effort) 🔁

- `Email/changes` accepts `sinceState` and returns `created`, `updated`, and `destroyed` arrays.
- Current implementation uses message `modseq` and mailbox `modifyIndex` to compute a best-effort state and change lists. Deletions are inferred when a message has `undeleted: false`.
- For robust change-tracking (per-account state tokens and change logs) see 'Next steps' below.

---

## Configuration ⚙️

Add or edit `config/jmap.toml` and include it from `config/default.toml`:

```toml
enabled = true
basePath = "/jmap"
wellKnown = true
auth = ["bearer", "basic"]
maxUploadMB = 25
maxConcurrentRequests = 4
[push]
sse = true
```

- `enabled`: toggle JMAP endpoints.
- `basePath`: base URL for JMAP endpoints.
- `maxUploadMB`: maximum upload size in megabytes.

---

## Tests & files 📂

- Tests: `test/api/jmap-test.js` (integration tests for discovery, session, query/get/set/send, upload, changes).
- Route implementation: `lib/api/jmap.js`.
- Upload storage: `lib/storage-handler.js` + `lib/api/storage.js`.

> To run tests locally, ensure MongoDB and Redis are available and run `npm test`.

---

## Limitations & next steps 🚧

Planned improvements:
- Implement deterministic per-account state tokens and a changelog for reliable `Email/changes` (completed; changelog stored in Redis and optionally compacted to MongoDB). ✅
- Support full JMAP RFC upload semantics (`/upload` multipart behavior and strict responses) and `Email/upload` when needed.
- Extend method support (threads, identity management, full mailbox operations), and run a JMAP conformance test suite.
- Improve performance and add more comprehensive tests (concurrency, large attachments, edge-cases).

### Background maintenance

- A periodic task `jmap-compact` exports older changelog entries from Redis to the `jmap_changes` MongoDB collection and trims Redis lists to a configurable `keep` size. This prevents unbounded Redis memory growth and allows long-term retention in MongoDB.
- The `jmap-compact` task is registered in the tasks runner as `jmap-compact` and configurable via `config.jmap.changelogKeep` (default 1000 entries to keep in Redis).
---

If you'd like, I can proceed with implementing deterministic change-tracking (per-account state & changelog) next — this will make `Email/changes` reliable for clients. 🔧
