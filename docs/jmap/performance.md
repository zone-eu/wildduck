# JMAP performance notes

Measurements taken while building JMAP support. Local numbers come from a laptop with MongoDB 6.0 in Docker and only show relative cost; production numbers come from `scripts/jmap/measure-production.js`.

## Phase 0: lookups by root and journal anchors

`node test/jmap/bench/roots-bench.js`, one user with 100,000 messages in 20 mailboxes and 10,000 journal entries, 50 rounds each (2026-11-11):

| Operation                                               | p50     | p95     |
| ------------------------------------------------------- | ------- | ------- |
| `resolveRoots`, 50 ids, roots checked (`legacy: false`) | 0.51 ms | 0.81 ms |
| `resolveRoots`, 50 ids, legacy branch                   | 0.54 ms | 0.71 ms |
| `resolveRoots`, 500 ids, roots checked                  | 2.26 ms | 2.72 ms |
| `resolveRoots`, 500 ids, legacy branch                  | 3.47 ms | 5.53 ms |
| `journalAnchors`                                        | 0.34 ms | 0.54 ms |

The legacy branch (documents without root, matched by `_id`) costs about 50% more at 500 ids, which is why `ensureUserRoots` records per user that it is no longer needed.

On the sharded test cluster (`npm run test:jmap:sharded`, two shards) a lookup by root asks both shards, each through `by_root`, and a move between shards keeps the id.

## Work package F.3: the JMAP service under load (2026-11-12)

### Method

`test/jmap/bench/jmap-bench.js` measures through the real HTTP service of a running server:

- **Seed.** One account with 100,000 messages in 500 mailboxes: three real messages (short text, multipart/alternative, long text) are uploaded through the REST API and cloned directly in MongoDB. Every fifth message is in INBOX (20,000), the rest spread over 499 folders (about 160 each), three consecutive messages of a folder share a thread, received dates span two years, 30% unread, 5% flagged, a search word on 1% of the messages. Then one REST API flag change on INBOX `1:10000` writes 10,000 journal entries, like a client marking a mailbox read.
- **Timing.** Every operation runs once to warm up, then 30 times in a row; p50 and p95 of the HTTP round trip.
- **MongoDB work.** Every operation runs once more with the MongoDB profiler at level 2 on the server database. Each query it made is listed with its plan summary (the index of the winning plan), keys examined, documents examined and documents returned: the numbers an explain of each query gives, for every query of the operation, not only the main one. Lookups of `webhooks` are left out (the webhooks worker handling the events of earlier changes).
- **EventSource.** 100 users with 10 streams each (1,000 streams, `ping=0`, `closeafter=no`), first with `types=*`, then with `types=Email,Mailbox,Thread`. 200 messages are delivered through the REST API, one at a time, round robin over the users; the latency is from the upload to the event on all 10 streams of the user. Memory is the server's `process_resident_memory_bytes` and `nodejs_heap_size_used_bytes` (lowest of five samples) before and after opening the streams. MongoDB operations come from the profiler and Redis commands from `MONITOR` (filtered to the server's Redis database), each compared with the same 200 deliveries without streams, which gives the work the streams add per change.
- **Server.** `NODE_ENV=test` with the production values of `[jmap.changes]` (`safetyWindow = 2000`, `ownedSafetyWindow = 32`, `maxChanges = 1500`, `retentionCacheTime = 60`), one process.

```bash
NODE_ENV=test APPCONF_dbs_dbname=<throw away database> APPCONF_jmap_changes_safetyWindow=2000 APPCONF_jmap_changes_maxChanges=1500 \
    APPCONF_jmap_changes_retentionCacheTime=60 node server.js &
NODE_ENV=test APPCONF_dbs_dbname=<same database> node test/jmap/bench/jmap-bench.js [requests|eventsource|all]
```

**Machine caveat.** Apple M5 Pro laptop (18 cores, 24 GB), Node.js 24.21, MongoDB 6.0.28 (single node in Docker under OrbStack), Redis 8.6 on the host. Other test runs shared the machine during the measurements, so single numbers jump between runs (a p95 of 70 ms next to a p50 of 10 ms is that). The timings show relative cost and how it grows with the account; the keys and documents examined are exact and do not depend on the machine. "Before" is the `jmap` branch at b75a94bd, "after" includes the fixes below; each on a fresh database.

### Requests

| Operation (100,000 messages, 500 mailboxes)                  | Before p50 | Before p95 | After p50 | After p95 | MongoDB work after (per request)                                                       |
| ------------------------------------------------------------ | ---------- | ---------- | --------- | --------- | -------------------------------------------------------------------------------------- |
| Email/get 50 random ids, metadata                            | 12.2 ms    | 28.6 ms    | 9.6 ms    | 20.9 ms   | `by_root`: 100 keys, 50 docs                                                           |
| Email/get 50 ids, default properties, all bodyValues         | 15.1 ms    | 24.6 ms    | 12.7 ms   | 16.7 ms   | `by_root`: 100 keys, 50 docs                                                           |
| Email/get 500 ids, metadata                                  | 25.3 ms    | 35.5 ms    | 19.0 ms   | 27.9 ms   | `by_root`: about 1,000 keys, 500 docs                                                  |
| Email/get 500 ids, default properties, all bodyValues        | 44.5 ms    | 60.6 ms    | 35.8 ms   | 54.0 ms   | `by_root`: about 1,000 keys, 500 docs                                                  |
| Email/query account, receivedAt, position 0                  | 8.4 ms     | 9.6 ms     | 3.5 ms    | 4.8 ms    | `user_idate`: 50 keys, 50 docs                                                         |
| Email/query account, position 500                            | 9.3 ms     | 13.1 ms    | 4.5 ms    | 6.3 ms    | `user_idate`: 550 keys (read from 0 and cached for queryChanges)                       |
| Email/query account, position 5000                           | 13.3 ms    | 55.9 ms    | 10.3 ms   | 76.3 ms   | `user_idate`: 5,050 keys (`$skip`, grows with the position)                            |
| Email/query account, calculateTotal                          | 138.7 ms   | 152.4 ms   | 122.7 ms  | 145.7 ms  | the count: 100,000 keys and docs (open finding 1)                                      |
| Email/query account, anchor at position 2000                 | 137.1 ms   | 159.6 ms   | 12.8 ms   | 19.7 ms   | `user_idate`: about 4,500 keys (was 102,000, fix 2)                                    |
| Email/query account, anchor at position 50000                | 260.8 ms   | 384.3 ms   | 162.1 ms  | 219.1 ms  | `user_idate`: about 100,500 keys (grows with the position, open finding 2)             |
| Email/query inMailbox INBOX (20,000), position 0             | 5.8 ms     | 8.0 ms     | 3.1 ms    | 4.5 ms    | `by_idate_reverse_uid`: 50 keys, 50 docs                                               |
| Email/query inMailbox INBOX, position 5000, calculateTotal   | 40.1 ms    | 257.5 ms   | 40.0 ms   | 260.8 ms  | 5,050 keys for the page; the count over `mailbox_undeleted_flag`: 20,000 keys and docs |
| Email/query inMailbox, folder of 160                         | 5.3 ms     | 6.7 ms     | 6.6 ms    | 9.6 ms    | `by_idate_reverse_uid`: 50 keys, 50 docs                                               |
| Email/query text filter (1% match)                           | 12.1 ms    | 14.2 ms    | 9.8 ms    | 11.9 ms   | `fulltext`: 1,000 keys, 2,000 docs (the matches)                                       |
| Email/query text filter and inMailbox                        | 12.9 ms    | 14.8 ms    | 9.8 ms    | 11.0 ms   | the same                                                                               |
| Email/query account, collapseThreads                         | 231.9 ms   | 264.5 ms   | 4.1 ms    | 5.0 ms    | `user_idate`: 500 keys (was 100,000, fix 3)                                            |
| Email/query inMailbox INBOX, collapseThreads                 | 57.8 ms    | 63.4 ms    | 4.3 ms    | 5.5 ms    | `by_idate_reverse_uid`: 500 keys (was 20,000, fix 3)                                   |
| Email/changes over 10,000 entries, maxChanges 50, first page | 4.7 ms     | 5.6 ms     | 4.1 ms    | 4.6 ms    | `user_limit_id`: one batch of 1,000 entries                                            |
| Email/changes, maxChanges 500, first page                    | 13.0 ms    | 16.3 ms    | 4.8 ms    | 5.5 ms    | `user_limit_id`: one batch of 1,000 entries (was 3,200 plus 9,900 in the second batch) |
| Email/changes, maxChanges 500, every page until done         | not done   | not done   | 343.5 ms  | 368.5 ms  | 39 pages (was: not done after 200 pages, fix 1)                                        |
| Mailbox/get all 500 mailboxes with counts, cold              | 231.8 ms   | 304.3 ms   | 227.2 ms  | 254.0 ms  | 4,000 queries, 260,000 index keys, 30,000 unread docs (open finding 3)                 |
| Mailbox/get all 500 mailboxes with counts, cached            | 11.1 ms    | 12.3 ms    | 10.1 ms   | 24.4 ms   | the 500 mailbox documents (`{user, path}`), the counts from Redis                      |
| Thread/get 50 threads (after an Email/get of their Emails)   | 10.3 ms    | 11.5 ms    | 7.0 ms    | 9.1 ms    | `by_root` 100 keys, then `user_messages_by_thread`: 200 keys, 150 docs                 |
| Email/query collapseThreads, Email/get, Thread/get (50)      | 219.8 ms   | 247.4 ms   | 4.5 ms    | 5.1 ms    | 500 + 57 + 120 keys                                                                    |

Every request also reads the account's mailboxes (500 documents through the `{user, path}` index), the user (by `_id`) and the journal anchors. Before fix 4, the delivery anchor lookup examined 1,600 to 3,100 journal entries on every request after the flag change (the entries of the last second of the change), until the next change of the account; after it, nothing once the change is two seconds old.

No query of any operation was a collection scan. The account wide query uses `user_idate`, the mailbox query `by_idate_reverse_uid`, lookups by id `by_root`, threads `user_messages_by_thread`, the mailbox counts the mailbox indexes (mostly count scans), journal reads `user_limit_id`.

The first JMAP request of an account checks once that every message has a root (`ensureUserRoots`): 570 to 780 ms for this account.

### EventSource

| 1,000 streams (100 users, 10 each), 200 deliveries | Before `types=*` | After `types=*` | Before `Email,Mailbox,Thread` | After `Email,Mailbox,Thread` |
| -------------------------------------------------- | ---------------- | --------------- | ----------------------------- | ---------------------------- |
| Delivery to event on all 10 streams, p50           | 317 ms           | 115 ms          | 113 ms                        | 117 ms                       |
| Delivery to event on all 10 streams, p95           | 326 ms           | 123 ms          | 120 ms                        | 125 ms                       |
| MongoDB operations the streams add per change      | 108.7            | 10.3            | 39.3                          | 3.3                          |
| Redis commands the streams add per change          | 8.2              | 3.9             | 7.4                           | 2.3                          |
| Opening the 1,000 streams                          | 4.0 s            | 0.9 s           | 0.36 s                        | 0.5 s                        |

- A delivery without streams costs 11 MongoDB operations and 6 Redis commands. About 100 ms of the latency is the batching of the notifier (`lib/imap-notifier.js`).
- Before fix 5 every stream read every state on its own: a change for a user with 10 streams made 10 state reads (11 MongoDB operations each with `types=*`: the journal anchors, the `jmap.state` document of the change logs, the user for Quota). Now the streams of an account with the same types share one read per change, so the work is per account and change, not per stream.
- `types=*` reads the states of every type (Identity, EmailSubmission, VacationResponse, Quota, contacts, calendars): about 10 operations per change against 3 for the mail types.
- The streams add 2 to 8 Redis commands per change in total, not per stream.
- Memory: across runs the heap grew by 20 to 90 kB per stream (`types=*` at the high end), and the resident size moved by less than garbage collection moves it between samples. These numbers are rough, the server cannot be made to collect garbage before a sample; 1,000 streams stay well under 100 MB.

### Fixes

1. **Email/changes, Thread/changes and Mailbox/changes did not advance under a dense journal** (`lib/jmap/state.js`, `lib/jmap/types/email-changes.js`, `thread.js`, `mailbox.js`). The safety window (`[jmap.changes] safetyWindow`, two seconds of journal read again before the state) came through the same cursor and counted against maxChanges. After a flag change of more than about maxChanges / 2 entries per second every page was filled by the window, the intermediate state did not move and a client paging through the changes never finished (measured: not done after 200 pages of 500 ids for 10,000 changes). Now the window is read apart (newest first, at most the server's maxChanges entries) and reports at most half of maxChanges ids, the most recently changed, so every page advances by at least half a page (39 pages for the same changes). Ids seen again in the window are treated as known to the client: reported as updated or destroyed, never as created, as the owned change logs already do. That also fixes a lost destroy: an Email delivered in the two seconds before the state and destroyed after it went from created to dropped and was left out of the response, so the client kept it. Tests: `test/jmap/unit/email-changes-fold-test.js`.
2. **Email/query with an anchor read the rest of the list** (`lib/jmap/types/email-query.js`). The anchor search streams ids in sort order and stops at the anchor, but without a batch size MongoDB sent the whole remaining list (up to the 100,000 scan limit) in the second batch. Now batches of 500: anchor at position 2000, 102,000 keys to 4,500, 137 ms to 13 ms. Test: `test/jmap/unit/email-query-test.js`.
3. **collapseThreads grouped every message of the query** (`lib/jmap/types/email-query.js`). A page was computed with a `$group` over all matching messages, so every page of a collapsed query read the whole mailbox or account. The pages of the cached part of the list (up to position 1000, and the lists of queryChanges) now stream the messages in sort order and keep the first of every thread, stopping when the page is full; after 20,000 messages (very long threads) they fall back to the `$group`. The list is the same. Account wide: 100,000 keys to 500, 232 ms to 4 ms. Test: `test/jmap/unit/email-query-test.js`.
4. **The delivery anchor re-read the journal after every burst** (`lib/journal-state.js`). Its search starts a second before the stored journal anchor (ids of other processes do not sort by time within a second), so after a burst every state read examined the last second of the burst again, on every request and every pushed event, until the account changed. Once a search has run after that second was over, the anchor is recorded as settled (`jmap.state.settled`) and later searches start at the anchor itself. Test: `test/jmap/unit/journal-state-test.js`.
5. **Event streams of one account read the states once per stream** (`lib/jmap/routes/eventsource.js`). A read that started after a stream heard of a change sees that change, so the other streams of the account with the same types join it. Test: `test/jmap/unit/eventsource-test.js`.
6. The `/changes` journal cursor reads in batches of 1,000 instead of everything up to the scan limit in its second batch (`lib/jmap/state.js`).

### Open findings

1. **calculateTotal reads every message of the result.** The total counts visible messages, and visibility needs fields that no index holds (the `$nor` on `exp` and `rdate`, and `undeleted` on the account wide query), so the count fetches every document: 100,000 for the account (about 130 ms), 20,000 for INBOX. A count scan would need an index with these fields, or a count of `{mailbox, undeleted: true}` minus the (normally empty) expired set; not done here because it changes how visibility is computed in one place only.
2. **Anchors and deep positions grow with the position.** `$skip` and the anchor search read every id before the position (5,050 keys at position 5000; 100,500 for an anchor at 50,000, capped by `ANCHOR_SCAN_LIMIT`). Inherent to positions in a list without stored ranks; clients page near the start.
3. **Mailbox/get counts with a cold cache read every index key of every mailbox.** Eight queries per mailbox (five counts, the thread count over `by_idate_reverse_thread`, the threads of `\Deleted` messages, and the unread thread count, which fetches the unread documents because no index holds `{mailbox, unseen, thread}`): 4,000 queries, 260,000 index keys and 30,000 documents for this account, about 230 ms. The counts are cached in Redis per mailbox until that mailbox changes, so this is paid once per mailbox and change, not per request.
4. **collapseThreads with calculateTotal, with an anchor, or past position 1000** still groups the whole result in the database.
5. **`types=*` streams cost three times the mail types per change**, since every type module reads its state. Shared per account now, but every account holding such a stream costs about 10 operations per change.
6. **Memory per stream** could not be measured precisely from outside the process (see above).

### Sharded cluster

`npm run test:jmap:sharded` on a fresh two shard cluster (`JMAP_SHARDED_PROJECT=wildduck-jmap-sharded-g1 JMAP_SHARDED_PORT=27217`; the two new variables let a second cluster run next to the default one on 27117): 10 passing. The new `test/jmap/sharded/routing-sharded-test.js` explains through mongos the queries the JMAP code builds, with the two mailboxes of the user on different shards:

| Read                                                      | Routing                        | Index on each shard                                 |
| --------------------------------------------------------- | ------------------------------ | --------------------------------------------------- |
| Email/query `inMailbox`, with and without collapseThreads | only the shard of that mailbox | `by_idate_reverse_uid` or `by_idate_reverse_thread` |
| Email/query of the whole account                          | both shards                    | `user_idate`                                        |
| Mailbox counts (`{mailbox}`, `{mailbox, unseen}`)         | only the shard of that mailbox | no collection scan                                  |
| Thread/get                                                | both shards                    | `user_messages_by_thread`                           |
| Email/get (lookup by root)                                | both shards                    | `by_root`                                           |

The earlier checks (`roots-sharded-test.js`) still pass: a lookup by root finds a message moved to the other shard, prefers the new copy while both exist, and the root repair works across shards.

## Production measurements (2026-11-12)

`scripts/jmap/measure-production.js` against the production mongos (MongoDB 6.0, 22 shards), database `zonemail`, read only, with secondaries preferred. The first run reported the `$collStats` document of one shard only for the sharded `messages` and `archived` collections (fixed since: the script now sums every shard); the per shard numbers below are multiplied by 22, which matches the known total of about 1.0 billion messages. `journal` is not sharded, so its numbers are complete.

### Journal

| Measure                        | Value                                                |
| ------------------------------ | ---------------------------------------------------- |
| Entries per hour               | 598,957 (about 166 per second, 14.4 million per day) |
| Entries kept now (TTL 3 hours) | 1,787,069                                            |
| Size now                       | 362 MB data, 386 MB indexes (748 MB)                 |
| Per entry                      | about 420 bytes with indexes                         |

The branch adds `root` to message entries and `origin` to EXISTS entries, about 30 bytes, so plan for roughly 450 bytes per entry. The journal size at other retentions:

| `const:journal:time` | Entries      | Size with indexes |
| -------------------- | ------------ | ----------------- |
| 3 hours (default)    | 1.8 million  | 0.8 GB            |
| 24 hours             | 14.4 million | 6.5 GB            |
| 72 hours             | 43 million   | 19 GB             |
| 7 days               | 101 million  | 45 GB             |

The journal is not sharded: all of it lives on the primary shard of the database, and its indexes (about half of the size) want to stay in that shard's cache. **Recommendation: 24 hours** when JMAP is enabled. A client offline overnight then still gets `/changes` instead of a full resynchronisation, at about 6.5 GB on one shard. Going beyond 72 hours puts more than 10 GB of journal indexes into one shard's cache and should wait for a measured need.

### Roots

| Measure                                           | Value                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Messages sampled                                  | 20,000 (`$sample`)                                                                                                    |
| Without `root`                                    | 0                                                                                                                     |
| `root` different from `_id` (moved at some point) | 1,219 (6.1%)                                                                                                          |
| Shared roots, `{user, root}` lookup latency       | not measured: there is no `by_root` index yet, and without it every probe would scan a user's messages on every shard |

Every sampled message already has a root, so the optional `messages_root_repair` migration is not needed for missing roots; `ensureUserRoots` still checks each user on first JMAP use for roots shared by old IMAP copies. Run the script again after `by_root` is built: it then probes 200 roots and reports how many are shared and the latency of a lookup across all shards. Only if that latency is too high is a `{user, root}` to location mapping collection worth building; until then it is not.

### Indexes

`messages` has about 110.8 GB of indexes per shard (2.4 TB in total), 71.4 GB per shard of it the `fulltext` text index. The JMAP indexes, scaled from the ratios measured on the sharded test cluster below (`by_root` about half of `_id_`, `user_idate` about 1.65 times `_id_`) and from the existing index of the most similar shape:

| Index                                      | Estimate per shard                                                 | 22 shards   |
| ------------------------------------------ | ------------------------------------------------------------------ | ----------- |
| `messages.by_root` `{root}`                | 0.7 GB (half of `_id_`, 1.37 GB)                                   | about 15 GB |
| `messages.user_idate` `{user, idate, _id}` | 1.5 to 2.3 GB (between `by_idate`, 1.14 GB, and 1.65 times `_id_`) | 33 to 50 GB |
| `archived.by_root`                         |                                                                    | under 1 GB  |

About 50 to 65 GB in total, 2 to 3% on top of the current `messages` indexes. The index review of 2026-10-05 found about 179 GiB of redundant `messages` indexes (`mailbox_uid_shard`, `by_idate_reverse_uid`, `mailbox_uid_reverse` and others); dropping those first more than pays for the JMAP indexes.

### Collector check on the sharded test cluster

The fixed collector ran against the two shard test cluster (`test/jmap/sharded/`, `messages` sharded on `{mailbox, uid}`) with a seeded database of known content: 5,000 users with 100 messages each over 20 mailboxes, 1% moved (root different from `_id`), 1% legacy copies sharing a root, 30,000 journal entries over three hours, and `by_root`, `user_idate` and `user_messages_by_thread` built.

| Check                                    | Seeded                        | Collector                                                         |
| ---------------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `messages` documents, summed over shards | 504,994 (252,538 and 252,456) | 504,994 over 2 shards                                             |
| Journal entries, per hour                | 30,000, 10,000                | 30,000, 9,975                                                     |
| Sampled messages without root            | 0                             | 0 of 20,000                                                       |
| Root different from `_id`                | 1.98%                         | 2.03%                                                             |
| Shared roots among 200 probes            | expected about 4              | 1                                                                 |
| `{user, root}` count across both shards  |                               | p50 1.0 ms, p95 1.7 ms, p99 2.2 ms                                |
| Index sizes (`_id_` = 1)                 |                               | `by_root` 0.49, `user_messages_by_thread` 0.47, `user_idate` 1.65 |

A lookup by root asks every shard, so on production it costs one round trip to each of the 22 shards in parallel instead of two; the latency there is still to be measured with the same script once `by_root` exists, before deciding on a mapping collection.

Raw output: `measurements.json` of 2026-11-12 (kept outside the repository).
