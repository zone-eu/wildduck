# JMAP mutation testing

Mutation testing of the JMAP core modules (work package F.5, test layer "Mutation" of the implementation plan, section 4.1). A mutant is a copy of one source file with one small change; a mutant that no test notices ("survives") marks behaviour the tests do not pin.

## Method

`imap-core/test/mutation/run.js` has a `jmap` profile next to the existing indexer profile:

```bash
npm run test:mutation:jmap                       # node imap-core/test/mutation/run.js --profile jmap
node imap-core/test/mutation/run.js --profile jmap --workers 4
node imap-core/test/mutation/run.js --profile jmap --file lib/jmap/patch.js
node imap-core/test/mutation/run.js --profile jmap --survivors <survivors.json>   # only the mutants of an earlier run
```

- Files: `lib/jmap/patch.js`, `references.js`, `json.js`, `ids.js`, `state.js`, `changelog.js`, `email-headers.js`, `email-builder.js`, `query-cache.js`, `utcdate.js`, `set.js` and `lib/calendar/recurrence.js`.
- Mutations: the operator replacements of the runner (`===` and `!==`, `<` and `<=`, `>` and `>=`, `&&` and `||`, `+ 1` and `+ 2`, `- 1` and `- 2`, `true` and `false`, `\r\n` to `\n`, a dropped `!`), one per mutant, on code lines only.
- Tests: the whole JMAP unit directory, `NODE_ENV=test mocha --bail test/jmap/unit/*-test.js`, because a module is often pinned by the tests of the modules that use it. The suites that need MongoDB or Redis use the test configuration (override with `APPCONF_*` variables); every worker gets a database name of its own (`dbs.dbname` with a `-mutant<n>` suffix). A mutant that makes the suites run longer than two minutes (a loop that never ends) counts as killed.
- Survivors are written to `wildduck-mutation-survivors-jmap.json` in the system temp directory.

## Results

| Run                                                 | Mutants | Killed | Survived | Score |
| --------------------------------------------------- | ------- | ------ | -------- | ----- |
| Before (2026-11-12, baseline, full run)             | 808     | 599    | 209      | 74.1% |
| After the new tests (only the 209 survivors re-run) | 808     | 771    | 37       | 95.4% |
| After the performance changes (full run)            | 814     | 777    | 37       | 95.5% |
| After the `state.js` tests (its survivors re-run)   | 814     | 781    | 33       | 95.9% |

The full run after the performance work (F.3) has 814 mutants, because `state.js` gained code. Its six `state.js` survivors were then covered in `test/jmap/unit/email-changes-fold-test.js` (the scan limit at its edge, the default safety window, a state equal to and newer than the current one), and a re-run of those six left two.

Survivors per file (after: the last row of the table above):

| File                         | Before | After |
| ---------------------------- | ------ | ----- |
| `lib/calendar/recurrence.js` | 41     | 20    |
| `lib/jmap/email-builder.js`  | 58     | 2     |
| `lib/jmap/state.js`          | 25     | 2     |
| `lib/jmap/set.js`            | 22     | 0     |
| `lib/jmap/email-headers.js`  | 18     | 1     |
| `lib/jmap/query-cache.js`    | 15     | 2     |
| `lib/jmap/changelog.js`      | 10     | 3     |
| `lib/jmap/patch.js`          | 10     | 1     |
| `lib/jmap/json.js`           | 6      | 2     |
| `lib/jmap/utcdate.js`        | 3      | 0     |
| `lib/jmap/references.js`     | 1      | 0     |
| `lib/jmap/ids.js`            | 0      | 0     |

## Tests added

| Test file                                    | New tests | What they pin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/jmap/unit/email-builder-test.js`       | 30        | address encoding (punycode, names, malformed addresses), draft addresses written as typed, 18 more invalidProperties cases (groups, message ids, URLs, charset, language, multipart with content, sub parts on a leaf, charset next to partId, the htmlBody header conflict), date fields, the 998 octet line, the part and depth limits at their edge, Content-Language, Content-Location and charset of an attachment, inline parts without a cid, CRLF line breaks, part header values as given, 8bit detection at 0x80, the generated Date, MIME-Version and Message-ID next to given header fields |
| `test/jmap/unit/set-test.js`                 | 10        | argument shape checks, null arguments, accountId and accountless types, `maxObjectsInSet` at its edge, `ifInState`, per object outcomes keyed by id or by the unknown creation reference, forbidden operations, errors that are not SetErrors, new state and event stream notification after each kind of change                                                                                                                                                                                                                                                                                        |
| `test/jmap/unit/state-test.js` (new)         | 6         | state strings of the mail types (own, foreign, malformed, not a string), whole second creation comparison, the journal retention cache (read per request, re-read after the cache time, kept within it, default), the anchor as state                                                                                                                                                                                                                                                                                                                                                                   |
| `test/jmap/unit/recurrence-mutation-test.js` | 15        | the limit error message, local times from year 0 to 9999 and before the common era in a zone, `formatDuration` input checks, durations as `{days, seconds}`, empty by-lists, limits and intervals that are not positive integers, skip with an explicit interval of one, the chunk limit at its edge, null overrides, overrides without a rule, instance order at the same time, overrides counted towards `maxInstances`, `complete`                                                                                                                                                                   |
| `test/jmap/unit/query-cache-test.js`         | 6         | `diff` with one id, partial lists ending at the first or the last place, `upToId` at the first place and at a removed id, `canonical` of different values, the byte budget filled exactly (Redis), a cached value of a wrong length (Redis); the settings check at its edge was added to an existing test                                                                                                                                                                                                                                                                                               |
| `test/jmap/unit/changelog-test.js`           | 5         | an old state stays usable while nothing changed, changes filling `maxChanges` exactly, the safety window ids up to `maxChanges` less one, entries read only up to the given sequence, `changeLogFor` (one instance, configured or default window)                                                                                                                                                                                                                                                                                                                                                       |
| `test/jmap/unit/email-headers-test.js`       | 5         | every convenience property reads the last instance, header lines without a name, encoded words glued to text on one side, text and white space between encoded words, two and three digit years (RFC 5322 4.3)                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/jmap/unit/patch-test.js`               | 3         | a pointer that is not a string, the two "parent" errors, array members by index (existing, past the end, leading zero, `-`, null)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/jmap/unit/json-test.js`                | 3         | surrogate pairs at the range ends, a high surrogate followed by text that looks like an escape, depth counted by nesting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test/jmap/unit/utcdate-test.js`             | 2         | only primitive strings parse, missing dates format as null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/jmap/unit/references-test.js`          | 1         | a path without the leading slash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

No survivor showed a bug; every killed mutant was missing coverage of behaviour that already worked.

## Remaining survivors

Equivalent mutants (no observable difference) and margins that are not worth pinning. Lines are given by their text, as the runner matches them.

`lib/jmap/patch.js`

- `!key.length && key.startsWith('/')`: an empty key or one starting with `/` still fails, as an empty reference token, with the same error.

`lib/jmap/json.js`

- `i <= text.length` in `stringEnd` and in `checkStructure`: the extra step reads `undefined` and matches nothing; an unterminated string fails either way.

`lib/jmap/state.js`

- `retentionCache.expires < Date.now()` for `<=`: differs only within the same millisecond.
- `since.getTimestamp().getTime() <= Date.now() - retention + EXPIRY_MARGIN` in `entriesSince`: differs only within the same millisecond.

`lib/jmap/changelog.js`

- `{ ordered: true }` for the tombstone insert: the tombstones have no unique index, an insert never fails part way.
- `since.time <= Date.now() - this.retention`: differs only within the same millisecond.
- `maxChanges + window + 2` as the read limit: one more entry is read and cut away by the same `budget` logic.

`lib/jmap/email-headers.js`

- `offset <= 0 ? '-' : '+'`: an offset of 0 is written as `Z`, the sign is not used.

`lib/jmap/email-builder.js`

- `/[\n\x00]/` for `/[\r\n\x00]/` on an encoded value: no encoder can produce a CR (addresses, ids and URLs refuse controls, text and names become encoded words); the check is defence in depth.
- `indexOf('\n\r\n')` for `indexOf('\r\n\r\n')`: the header block then ends with the CR of its last line, which is a Content field and is joined back unchanged.

`lib/jmap/query-cache.js`

- `values[tails[middle]] <= values[i]`: the positions are distinct old indexes, never equal.
- `low >= 0 ? tails[low - 1]`: `tails[-1]` is `undefined`, which ends the walk back like `-1`.

`lib/calendar/recurrence.js`

- `formatters.size > FORMATTER_CACHE_SIZE`, `cache: true`: cache sizing of the zone formatters and of the library, no effect on results.
- `!timeZone && UTC_ZONES.has(timeZone)`: the UTC zones then go through `Intl`, which answers offset 0 too (slower, same result); no caller passes an empty zone.
- `DAY_MS + 1 * HOUR_MS` in `durationUpperMs` and `utc + 1 * DAY_MS` in `startLowering`: window margins; both values keep the bounds wider than the instances, so the results do not change.
- `untilWall <= startWall`, `untilWall >= startWall` (in `bounds`): an until equal to the start gives the start alone either way.
- `parts.byMonth && [...]`: without byMonth the library runs a yearly byMonthDay rule in every month, the same as all twelve months.
- `/maximum|exceeded/i.test(err || err.message)`: differs only for a thrown `null`, which the library never throws.
- `startWall < hi` and `startWall >= low || ...` for an only-start rule, `startWall < hi` for the added start: the window edges are an hour wider than the UTC window, and `expandEvent` filters by overlap again; `occurrenceKind` answers the start before it generates.
- `return true` for a value past the upper edge, `stopped = false` and `return true` after `visit` stopped: the library is already bounded by the same edge, and the only caller that stops (`occurrenceKind`) asks for a one second window.
- `++raw >= rawCap`: the library's own `maxIterations` limit always ends the walk first.
- `ra <= rb ? -1` and `ra >= rb ? 1`: two instances never share a recurrence id (a generated time with an override is skipped).
- `event.recurrenceId && null` in `bounds`: the recurrence id of the single instance is not used for the bounds.
- `patch || typeof patch === 'object'` in `bounds`: only the start and end are used, an override that is not a patch object gives the same times.
