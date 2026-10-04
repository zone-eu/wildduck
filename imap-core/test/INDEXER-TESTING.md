# Testing the MIME parser and rebuilder

WildDuck stores every message as a parsed MIME tree and rebuilds the RFC 822 bytes on every fetch. Three
things must hold, and each has its own kind of test.

1. **Messages parse and rebuild correctly.** A delivered message rebuilds to its bytes (CRLF line
   endings, a final line break), every section announces exactly the bytes it emits, and the parsed
   structure is the one the MIME grammar describes.
2. **Any range can be served.** A partial fetch returns exactly the slice of the full output at that
   origin, for every origin and length, with attachments in the storage or not.
3. **Trees that are already stored keep rendering as before.** Mail stores hold trees written by the
   previous parser (v1, no `v` property), including the broken trees it wrote for broken mail. Their
   stored size and the quota were computed by the previous code, and clients received what it served.

## The suites

| Suite | Approach | What it pins |
|---|---|---|
| `parse-mime-tree-v2-test.js`, `get-contents-test.js`, `body-structure-test.js`, `create-envelope-test.js`, `get-query-response-test.js`, `indexer-maildata-test.js` | Example based unit tests | One rule per test: structure fields, section numbering, BODYSTRUCTURE and ENVELOPE fields, search text and attachment extraction |
| `indexer-fidelity-test.js` | Fixtures and synthetic layouts | Byte exact rebuild, size equals bytes for every section, no length correction on the IMAP literal path, partial windows |
| `indexer-fuzz-test.js` | Model based fuzzing and mutation of inputs | A seeded generator builds random messages together with the structure the parser must find; a mutator breaks them like real mail is broken. Checks structure against the model and all rebuild properties. `FUZZ_SEED`, `FUZZ_ITERATIONS` |
| `indexer-corpus-test.js` | Property and metamorphic testing over a corpus | Canonical rebuild, parse stability (the rebuilt message parses into the same tree), the tree as MongoDB returns it (BSON, `Binary` bodies) renders the same, stored attachments are invisible, metadata responses parse |
| `indexer-ranges-test.js` | Exhaustive testing | Every (origin, length) pair for small messages, for every section, v1 and v2 trees, attachments decoded or verbatim in 1, 5 and 57 byte storage chunks, through the IMAP literal path; out of range and malformed range options |
| `indexer-legacy-differential-test.js` | Differential testing against a frozen reference | `fixtures/legacy-v1/` is the previous parser and rebuilder, unchanged. Every corpus message is parsed by the old parser and every section rendered by both: same size always; identical bytes where the old output was consistent; otherwise what clients received or the old output without its uncounted line breaks; the same from BSON and with stored attachments; identical `getMaildata()` output and tree state |
| `indexer-legacy-test.js` | Snapshot | v1 trees captured from the previous parser with the size and a hash of every section served |
| `indexer-attachments-test.js`, `attachment-codec-test.js`, `test/attachment-storage-contract-test.js` | Scenario matrix, unit and contract tests | Decoded and verbatim attachment storage, the base64 acceptance proof as a property over random and corrupted input, storage failure paths (too much, too little, file lost mid-read, lookup errors, no storage), the in-memory storage double against real GridFS |

## Corpus

`fixtures/indexer-corpus.js` collects the repository fixtures, the synthetic layouts, the attachment
scenarios, generated and mutated messages and garbage input. Real mail that can not live in this
repository can be added for a local run:

```
MIME_CORPUS_DIR=/path/to/mail:/other/path npm run test:indexer
```

Every `.eml` file below those directories is parsed and checked by the corpus and the differential suites.
`MIME_CORPUS_FUZZ` sets the number of generated messages (150 by default).

## Coverage and mutation testing

```
npm run test:indexer            # the suites above
npm run test:indexer-coverage   # line and branch coverage of the parser, rebuilder and codec
npm run test:mutation           # mutation testing, see imap-core/test/mutation/run.js
```

The mutation runner changes one operator or constant at a time in the parser, the walker, the indexer,
the codec, the offset calculation and the length limiter, runs the suites against each mutant in a
private copy of the repository, and lists the mutants no test caught. `--survivors <file>` re-runs the
survivors of an earlier run after tests were added. The survivors that remain are equivalent mutants
(changes that can not alter any output, such as an extra empty iteration or a return value nobody
reads); a new survivor that is not equivalent is a gap in the tests.

Result on 2026-10-04: 333 mutants, 298 killed. The 35 survivors were each checked by hand and are
equivalent: an empty extra iteration or chunk, a return value nobody reads, a check that a later, stronger
check repeats (the base64 proof verifies line break positions and then the whole stripped text), or a
LengthLimiter branch that ends in the same state either way.

## Rules for the frozen reference

`fixtures/legacy-v1/` and `fixtures/legacy-v1-trees.json` describe what is already in production. They
are never edited and never regenerated from current code. A change that makes the differential suite
fail on a v1 tree changes what existing messages look like to clients, and needs a documented reason in
the suite itself (as the part numbering corrections have).
