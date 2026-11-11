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

## Production measurements

Pending: run the collector against mongos with a read only user and paste the result here.

```bash
MONGO_URI='mongodb://...' DB_NAME=wildduck node scripts/jmap/measure-production.js > measurements.json
```

It reports, with bounded queries only:

- collection and index sizes of `messages`, `archived` and `journal`
- journal entries per hour and the resulting per day estimate, with the current TTL
- on a sample of messages: how many have no root, how many have a root different from `_id` (moved), and, once the `by_root` index exists, how many probed roots are shared and the latency of a `{user, root}` count across the shards

The results decide the journal retention to recommend (`const:journal:time`), the size budget of the new indexes (`by_root`, `user_idate`), and whether a `{user, root}` to location mapping collection is needed for shard targeted lookups (only if the lookup latency across all shards is too high).
