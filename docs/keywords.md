# Keyword paths

Keywords are stored in the `keywords` collection in the main database:

```javascript
{ _id: ObjectId('...'), user: ObjectId('...'), path: 'Projects/2026', slot: 0, created: ISODate('...') }
```

The unique `{ user: 1, path: 1 }` index scopes paths to an account. If this
collection is sharded, use `{ user: 1 }` so user lookups and path upserts can
be routed by user. Message assignments use keyword object IDs in
`messages.keywords`. System flags and unregistered legacy keywords remain in
`messages.flags`.

At the IMAP boundary, keyword IDs are translated to their current paths.
`FETCH` and `COPY` expose those paths as custom flags, `APPEND` and `STORE`
create missing keyword records and persist their IDs, and `SEARCH KEYWORD`
matches the ID while retaining a fallback for legacy string flags. This keeps
REST labels and IMAP keywords synchronized without duplicating paths in message
documents; renames are therefore immediately visible to IMAP clients.

`POST /users/:user/keywords` accepts `{ "path": "Projects/2026" }` and
idempotently creates the path and missing parent paths. Paths use `/`, cannot
have empty segments, and have at most five components (the root is level one).
The full path is limited to 256 characters, including separators, and follows
the label path schema. Paths preserve case; API lookup and counters retain the
existing exact-string semantics.

Each user can have at most 5,000 labels, including automatically created parents.
The unique `{ user: 1, slot: 1 }` index reserves slots 0–4999 and prevents
concurrent requests from exceeding the cap. Existing paths remain usable at
capacity. New paths fail with `KeywordLimitExceeded` when there is no capacity;
invalid length or depth is rejected before message assignments. Install both
unique indexes before enabling writes. Multi-path creation is not transactional:
under contention or a database failure, some requested paths may already have
been created when the request fails; retrying is idempotent.

`GET /users/:user/keywords` returns `keywords` entries with `id`, `keyword`
(the final path component), and `path` (the full path). This reads only keyword
documents, without scanning messages or requiring Redis. Empty labels remain
after their last message is removed.

With `?counters=true`, entries also contain `total` and `unseen`. Counters
continue to use the existing versioned Redis cache and mailbox-scoped message
counts on cache misses. They are not persisted in keyword documents. Parent
counts include only messages explicitly tagged with that parent path, not
descendants. Counter queries run at most two at a time within one request.

New keywords assigned through the REST API and saved filter actions are
registered automatically. Creating a label does not apply it to a message.

`PUT /users/:user/keywords/:keyword` renames the selected keyword by updating
its path. The request body is `{ "path": "New/Path" }`. Descendant keyword
records are independent and are not renamed. Message and filter assignments
continue to refer to the same stable keyword object ID. An existing target path
fails with `409 KeywordConflict`; renaming to the current path is a no-op.

`DELETE /users/:user/keywords/:keyword` schedules a durable `keyword-delete`
task. It removes the selected path and descendants from messages and filter
actions, then deletes their catalog records. A parent remains when deleting a
child. Paths are hidden from listings and cannot be assigned while deletion is
in progress. The request returns the task ID; repeat requests reuse it.

Install the indexes before enabling keyword writes. Labels are introduced by
this branch, so there is no historical backfill or migration. System flags
remain separate and are never registered in the keywords collection. IMAP
flags beginning with `$`, including Thunderbird tags such as `$label1`, also
remain in `messages.flags` and are not registered as labels.
