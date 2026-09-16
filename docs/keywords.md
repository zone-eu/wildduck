# Keyword paths

Keywords are stored in the `keywords` collection in the main database:

```javascript
{ _id: ObjectId('...'), user: ObjectId('...'), path: 'Projects/2026', slot: 0, created: ISODate('...') }
```

The unique `{ user: 1, path: 1 }` index scopes paths to an account. If this
collection is sharded, use `{ user: 1 }` so user lookups and path upserts can
be routed by user. Message assignments continue to use the full keyword
string in `messages.flags`; existing IMAP and search clients remain compatible.

`POST /users/:user/keywords` accepts `{ "path": "Projects/2026" }` and
idempotently creates the path and missing parent paths. Paths use `/`, cannot
have empty segments, and have at most five components (the root is level one).
The full path is limited to 256 characters, including separators, and follows
the existing IMAP keyword character restrictions. Paths preserve case; API
lookup and counters retain the existing exact-string semantics.

Each user can have at most 5,000 labels, including automatically created parents.
The unique `{ user: 1, slot: 1 }` index reserves slots 0–4999 and prevents
concurrent requests from exceeding the cap. Existing paths remain usable at
capacity. New paths fail with `KeywordLimitExceeded` when there is no capacity;
invalid length or depth is rejected before message assignments. Install both
unique indexes before enabling writes. Multi-path creation is not transactional:
under contention or a database failure, some requested paths may already have
been created when the request fails; retrying is idempotent.

`GET /users/:user/keywords` returns `keywords` entries with `id`, `keyword`
(the full path, retained for compatibility), `path`, and `name` (the last
component). This reads only keyword documents, without scanning messages or
requiring Redis. Empty labels remain after their last message is removed.

With `?counters=true`, entries also contain `total` and `unseen`. Counters
continue to use the existing versioned Redis cache and mailbox-scoped message
counts on cache misses. They are not persisted in keyword documents. Parent
counts include only messages explicitly tagged with that parent path, not
descendants. Counter queries run at most two at a time within one request.

New keywords observed through the message journal (API, IMAP, delivery, and
restore) and saved filter actions are registered automatically. Creating a
label does not apply it to a message. Rename and delete APIs are not included;
renaming a path will require coordinated updates to message flags and filters.

Install the indexes before enabling keyword writes. Labels are introduced by
this branch, so there is no historical backfill or migration. System flags
remain separate and are never registered in the keywords collection.
