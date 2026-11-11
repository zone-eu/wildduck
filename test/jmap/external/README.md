# External JMAP conformance suites: expected results

WildDuck has no JMAP implementation yet. When development starts, two independent black box suites are run against it at every phase as regression gates. This directory holds the prediction they are compared against:

| File                         | Content                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `jmapio-expectations.yaml`   | One entry per test of jmapio/jmap-test-suite (309 tests)       |
| `fastmail-expectations.yaml` | One entry per `.t` file of fastmail/JMAP-TestSuite (173 files) |
| `README.md`                  | This document                                                  |

The directory contains documents only. Runner scripts, adapters and config files with credentials live elsewhere.

Both files were derived by reading the suite sources at the pinned commits, together with the WildDuck constraints in the JMAP plan. Neither suite has been executed against WildDuck, so the first real run is expected to correct some entries. Phases are the plan phases: 0 backend prerequisites, 1 core and read only mail, 2 writes, 3 submission, 4 conformance extras, 5 contacts, 6 calendars, 7 calendar scheduling.

## How the files work as a gate

The gate takes the current phase `P` and the suite results, and fails when any of these is true:

1. An entry with `expect: pass` (or `expect: opinion` that has a `phase`) and `phase <= P` did not pass.
2. An entry with `expect: never` passed. A `never` test must keep failing (or keep being skipped), so that an unexpected pass is noticed and the list is updated on purpose.
3. An entry with `expect: skip` (Fastmail file only) was not skipped. Same idea: if the suite starts running it, WildDuck began advertising something the plan says it does not.
4. The result set and the file disagree on the list of ids (a test appeared or vanished). That means the pinned commit moved and the file must be re-derived.
5. The suite ended with a fatal error (jmapio exit code 2, for example when seeding fails).

Not gated, only reported: entries with `phase > P` (a pass there is an early pass, worth a note), and `opinion` entries without a `phase`.

A skip counts as a failure for rule 1, with one exception: an entry that carries `skip_when` may be skipped when the run was deliberately set up that way (for example smee.io blocked, see below). The gate configuration should name the accepted `skip_when` cases explicitly instead of accepting every skip.

When a prediction turns out wrong, fix the cause or change the entry in the same commit that changes the behaviour, with the reason. Do not add a second allow list next to these files.

This is the model used by `bulwark-legacy-proxy` (`test/compliance/known-failures.txt` and `scripts/run-compliance.mjs`), extended with phases and with the requirement that a known failure must still fail.

## jmapio/jmap-test-suite

- Repository: https://github.com/jmapio/jmap-test-suite
- Pinned commit: `0f2c117dc5f3621bfa50cb0b8b4d4ac87a4154be`
- What it is: a TypeScript command line tool with no runtime dependencies that speaks JMAP to a live server. 309 tests for RFC 8620 and RFC 8621 in the categories core 38, binary 13, mailbox 45, thread 9, email 150, search-snippet 6, identity 13, submission 14, vacation 10, push-subscription 7, push-eventsource 4. Each test has an RFC section and a required or recommended flag (5 are recommended). `rfc-clarifications.md` in the suite records rulings that turn several RFC SHOULDs into required tests; those are the `opinion` entries.
- Licence: the repository has no LICENSE file, so no licence is granted. Consequence: clone it at the pinned commit as an external tool at run time, never vendor it, never copy test code, fixtures or expected values into this repository. Referring to a test by its id is fine.

### Prerequisites

- Node.js 18 or later (the suite uses the built in fetch), `npm install && npm run build` inside the clone.
- A running WildDuck with JMAP enabled.
- Two dedicated WildDuck users created through the REST API (`POST /users`), with 2FA off so that HTTP Basic with the account password works (or use an application specific password with the `jmap` scope). The primary user must be empty: only INBOX and the special use mailboxes, no mail. The secondary user is the recipient of the EmailSubmission tests; without it the whole `submission` category is skipped.
- Create fresh users for each run and delete them afterwards (`DELETE /users/:id`). Email/set destroy archives messages in WildDuck for 25 days and submissions leave entries in the outbound queue, so reused accounts collect debris.

### Config file template

Keep the file outside the repository, it holds credentials.

```json
{
    "sessionUrl": "<JMAP_BASE_URL>/.well-known/jmap",
    "serverInfo": "WildDuck <VERSION> phase <P>",
    "users": {
        "primary": { "username": "<PRIMARY_USERNAME>", "password": "<PRIMARY_PASSWORD>" },
        "secondary": { "username": "<SECONDARY_USERNAME>", "password": "<SECONDARY_PASSWORD>" }
    },
    "authMethod": "basic",
    "timeout": 30000,
    "verbose": false
}
```

With `"authMethod": "bearer"` the `password` field is sent as the Bearer token (a WildDuck user access token).

### Running it

```
git clone https://github.com/jmapio/jmap-test-suite <WORKDIR>/jmap-test-suite
git -C <WORKDIR>/jmap-test-suite checkout 0f2c117dc5f3621bfa50cb0b8b4d4ac87a4154be
cd <WORKDIR>/jmap-test-suite && npm install && npm run build
node dist/cli.js -c <CONFIG.json> -f -o <REPORT.json>
```

Exit codes: 0 all required tests passed, 1 a required test failed, 2 fatal error. The gate ignores 0 and 1 and reads `<REPORT.json>`: `results[].testId` is the `id` in the expectations file, `results[].status` is `pass`, `fail` or `skip`. `--filter 'email/query*'` limits a run to matching ids (then rule 4 above must be relaxed to the filtered subset).

### What `-f` does

At start the suite inspects the primary account. If it finds any email or any mailbox without a role it stops, unless `-f` is given. With `-f` it destroys every email in the account (Email/query plus Email/set destroy in batches of 50) and then every mailbox without a role, with `onDestroyRemoveEmails`. Independently of `-f`, the teardown at the end again destroys every email in the account and the four mailboxes it created. So the primary account is wiped in every run. Never point the suite at an account that holds anything worth keeping.

### The suite cannot run before phase 2

The suite always seeds first: four mailboxes through Mailbox/set, two blobs through the upload endpoint, 21 or 22 messages through Email/import, then Identity/get. If seeding throws, the run ends with exit code 2 and no test result. A phase 1 server (read only mail) therefore cannot be tested with this suite at all. For that reason `phase` is never lower than 2 in `jmapio-expectations.yaml`, and the 180 entries whose behaviour belongs to phase 1 carry `feature_phase: 1`. The first jmapio gate is at the end of phase 2.

One seed message is imported into two mailboxes. WildDuck rejects that import (`maxMailboxesPerEmail` is 1); the suite logs a warning and continues, and only `email/get-mailbox-ids` depends on that message.

### The smee.io relay

At start up the runner always contacts the public relay `https://smee.io` (`GET /new`, then a long lived event stream on the channel URL), whatever the filter. There is no config switch for it. If the channel opens, six PushSubscription tests register that public URL as the push endpoint, and WildDuck itself then POSTs the PushVerification object (with its verification code) and StateChange objects (account id and state strings) to smee.io, where anyone who knows the channel URL can read them. One of those tests opens a second channel of its own.

To keep test traffic off the relay, make the name unreachable from the machine that runs the suite, for example run the suite in a container started with `--add-host smee.io:127.0.0.1`, or block outbound traffic to smee.io on the CI runner. The suite then prints a warning and reports the six tests as skipped (`skip_when: "smee.io is unreachable"` in the expectations file); `push-subscription/push-subscription-reject-non-https` does not need the relay and still runs. This is the default for CI. Before phase 4 nothing is lost, the tests cannot pass anyway.

From phase 4 the six tests need a deliberate, separate run with the relay reachable, throwaway accounts, and a WildDuck that is allowed to make outbound HTTPS requests to smee.io. Alternatively resolve `smee.io` to a self hosted relay that speaks the same protocol and presents a certificate the runner and WildDuck trust.

### Reading the expectations

- `never`, multiple mailboxes: `email/get-mailbox-ids`, `email/set-update-add-mailbox`, `email/set-update-remove-mailbox`, `email/set-destroy-removes-from-all-mailboxes`.
- `never`, no second account in the session (the suite reports these as skipped): `binary/blob-copy-cross-account`, `binary/blob-copy-not-found`, `binary/blob-copy-response-structure`, `email/copy-cross-account`, `email/copy-not-found`.
- `opinion` with a phase (WildDuck complies): four request level error tests in `core`, the two same account `/copy` tests, the duplicate mailbox name error type, sorting by `from` and `to` and a sort with `subject` as second key, and all nine queryChanges tests.
- `opinion` without a phase (recommended tests WildDuck is expected to fail): `email/import-invalid-blob`, `email/parse-not-parsable`.
- Unlike the IMAP proxy that this approach was taken from, `email/set-update-move-mailbox` is expected to pass, because the Email id is stable across moves (phase 0).

## fastmail/JMAP-TestSuite

- Repository: https://github.com/fastmail/JMAP-TestSuite
- Pinned commit: `0319ec8b1841f040fd313531a3df12a74c4b7bf7`
- What it is: a Perl suite (Test::Routine, JMAP::Tester, Test::Deep) run with `prove`. 173 `.t` files with 315 named subtests: mail (Email 64, Mailbox 29, Thread 7, SearchSnippet 2, Identity 4, EmailSubmission 4, VacationResponse 3), core 6, four legacy files at the top level, Blob 8, contacts 17, calendars 17, and Principal 3, Quota 3, MDN 2. It is the only independent suite that covers RFC 9404 blobs, contacts and calendars. Assertions are mostly exact deep comparisons, so extra or missing response properties fail a file.
- Licence: the repository has no LICENSE file. Same consequence as above: external tool at the pinned commit, never vendored, no test code copied.
- The unit of the expectations file is the `.t` file, because that is what `prove` reports.

### Prerequisites

- Perl 5.14 or later and `cpanm --installdeps .` inside the clone (JMAP::Tester 0.110 or later, Moose, Test::Routine, LWP, Email::MIME and others).
- A running WildDuck with JMAP enabled, and a REST API access token that may create and delete users.
- A WildDuck server adapter (below). The suite ships none for WildDuck.

### The adapter contract

The suite reads `JMAP_SERVER_ADAPTER_FILE`, a JSON file whose `adapter` key names the class `JMAP::TestSuite::ServerAdapter::<adapter>`; every other key is a constructor argument.

| Method                           | Needed   | Returns                                                                                                                                                                                                                                     | Without it                                                                                |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `any_account` (adapter)          | yes      | an object doing the `JMAP::TestSuite::Account` role, with the JMAP `accountId` taken from the session `primaryAccounts`                                                                                                                     | nothing runs                                                                              |
| `authenticated_tester` (account) | yes      | a `JMAP::TestSuite::JMAP::Tester::WithSugar` with `api_uri`, `upload_uri`, `download_uri`, `authentication_uri` (the session URL), an Authorization header on its user agent, and `default_using` set to the capability URNs of the session | nothing runs                                                                              |
| `pristine_account` (adapter)     | optional | a brand new, empty account on every call                                                                                                                                                                                                    | the 52 files marked `attr pristine => 1` are skipped, including every `foreign-account.t` |
| `pool_account_pair` (adapter)    | optional | two accounts that can see each other                                                                                                                                                                                                        | the four cross account `/copy` files are skipped                                          |

Two skip mechanisms follow from this. Files with `attr pristine => 1` or `attr pool_pairs => 1` skip when the adapter lacks the method. Inside a file, `require_capabilities` skips when a URN is missing from `default_using`. So `default_using` must be built from what the session really advertises, and capabilities must only be advertised once the methods behind them exist. That is what makes contacts files skip before phase 5 and calendar files before phase 6.

For WildDuck: implement `any_account`, `authenticated_tester` and `pristine_account`. Do not implement `pool_account_pair`, WildDuck has no sharing, so the four copy files are expected to skip.

### Outline of a WildDuck adapter

The adapter is our own code written against the documented contract, so it may be kept in a WildDuck owned location (not in this directory, and not inside the suite clone). `prove` finds it through a second include path.

Config file (`<WILDDUCK_ADAPTER.json>`, outside the repository):

```json
{
    "adapter": "WildDuck",
    "jmap_uri": "<JMAP_BASE_URL>",
    "api_uri": "<WILDDUCK_REST_API_URL>",
    "api_token": "<REST_API_ACCESS_TOKEN>",
    "domain": "<TEST_DOMAIN>"
}
```

Class `JMAP::TestSuite::ServerAdapter::WildDuck` (Moose, `with 'JMAP::TestSuite::ServerAdapter'`), attributes as in the config:

```perl
our $STARTTIME = time; our $USERNUM = 1; my @CREATED;

sub _create_account {
  my ($self) = @_;
  my $name = "jt-$STARTTIME-$$-" . $USERNUM++;          # unique across parallel prove jobs
  my $pass = <random 32 hex characters>;
  # POST <api_uri>/users, header X-Access-Token: <api_token>, JSON body:
  #   { username: $name, password: $pass, address: "$name@<domain>",
  #     allowUnsafe: true, tags: ["jmap-testsuite"] }
  # die with the HTTP status line unless the answer has success true; keep the returned id
  push @CREATED, $id;
  # GET <jmap_uri>/.well-known/jmap with Basic $name:$pass, die on failure;
  # accountId = primaryAccounts{"urn:ietf:params:jmap:mail"} (do not assume it equals $id)
  return JMAP::TestSuite::Account::WildDuck->new({
    server => $self, accountId => $account_id, username => $name, password => $pass,
  });
}
sub any_account      { $_[0]->_create_account }
sub pristine_account { $_[0]->_create_account }

END {
  # for each id in @CREATED: DELETE <api_uri>/users/<id> with X-Access-Token, warn on failure
}
```

Class `JMAP::TestSuite::Account::WildDuck` (Moose, `with 'JMAP::TestSuite::Account'`, attributes `username` and `password`):

```perl
sub authenticated_tester {
  my ($self) = @_;
  # GET the session with Basic username:password, die on failure
  my $tester = JMAP::TestSuite::JMAP::Tester::WithSugar->new({
    authentication_uri => "<jmap_uri>/.well-known/jmap",
    api_uri            => $session->{apiUrl},
    upload_uri         => $session->{uploadUrl},     # {accountId} replaced by $self->accountId
    download_uri       => $session->{downloadUrl},   # keeps the {accountId} {blobId} {name} {type} variables
  });
  $tester->ua->set_default_header(Authorization => "Basic <base64 of username:password>");
  $tester->default_using([ sort keys %{ $session->{capabilities} } ]);
  return $tester;
}
```

Notes on the outline:

- A fresh WildDuck user has INBOX and the special use mailboxes and no mail, which is what the pristine files expect (they tolerate server provisioned mailboxes).
- Each `.t` file is its own process, so the `END` block removes the users of that file. `DELETE /users/:id` schedules the deletion; the `jmap-testsuite` tag allows a sweep (`GET /users?tags=jmap-testsuite`, then delete) after an aborted run.
- Users are created with 2FA off, so Basic with the account password is accepted. A Bearer token from `POST /authenticate` with `token: true` works as well.
- Do not set `default_arguments` on the tester, the Account role injects `accountId` itself.
- The `account-locks` directory mentioned in the suite documentation is only used when `pristine_account` is missing.

### Caveat: the shipped Simple adapter is broken

The suite's own `Simple` adapter (static credentials, no provisioning) cannot be used as a shortcut. It calls `$tester->simple_auth(...)`, which the JMAP::Tester changelog lists as removed in 0.108, and it reads `$self->base_uri`, an attribute the class does not declare. It would also leave all 52 pristine files skipped. Write the adapter above instead.

### Running it

```
git clone https://github.com/fastmail/JMAP-TestSuite <WORKDIR>/JMAP-TestSuite
git -C <WORKDIR>/JMAP-TestSuite checkout 0319ec8b1841f040fd313531a3df12a74c4b7bf7
cd <WORKDIR>/JMAP-TestSuite && cpanm --installdeps .
JMAP_SERVER_ADAPTER_FILE=<WILDDUCK_ADAPTER.json> prove -Ilib -I<ADAPTER_LIB_DIR> -r t
```

Useful while bringing the adapter up: `prove -Ilib -I<ADAPTER_LIB_DIR> -v t/core/jmap-session-resource.t`, then `-r t/Mailbox`, then everything. `JMTS_TELEMETRY=1` logs the HTTP exchanges. `-j4` runs files in parallel; account names stay unique because they contain the process id.

Mapping to the expectations file, per `.t` file (path relative to `t/`):

- `pass`: prove reports the file ok and its test body ran (subtests skipped inside the body are fine, several files skip a subtest on purpose).
- `skip`: prove reports the file ok and the test body was skipped as a whole (TAP line with `# skip`, reason `server does not support ...`, `test requires pristine_account` or `test requires implementation of pool_account_pair`).
- anything else is a failure.

The gate needs the TAP of each file to tell pass from skip (run prove with `-v` and parse it, or use a TAP archive or JUnit formatter). This mapping is taken from the suite source and should be confirmed on the first run.

Unlike the jmapio suite, this one creates its own fixtures per file, so the files that only read can already run in phase 1 (12 files).

### Reading the expectations

- `never`, multiple mailboxes: `Email/import/good-imports.t`, `Mailbox/set/destroy/on-destroy-remove-messages-true-mail-in-other-boxes.t`.
- `never`, threading rule (a reply with a different subject starts a new thread in WildDuck, the suite assumes References alone): `Email/query/filtering.t`.
- `never`, mailbox subscription default (the suite expects `isSubscribed` false on a mailbox the user just created): `Mailbox/get/some-entities.t`, `Mailbox/get/limiting-properties-in-response.t`.
- `skip`, no second account: the four `copy/basic.t` files (Email, Blob, ContactCard, CalendarEvent).
- `skip`, capability not advertised: `urn:ietf:params:jmap:blob2` (3 files), `mdn` (2), `principals` (3), `quota` (3).

## Counts

Generated from the expectation files; regenerate after editing them.

jmapio/jmap-test-suite, 309 tests:

| Phase    | pass | opinion | Total gated |
| -------- | ---- | ------- | ----------- |
| 2        | 255  | 7       | 262         |
| 3        | 14   | 0       | 14          |
| 4        | 10   | 12      | 22          |
| no phase | 0    | 2       | not gated   |

| expect  | Count                                                          |
| ------- | -------------------------------------------------------------- |
| pass    | 279 (6 of them are skipped when smee.io is blocked, see above) |
| opinion | 21                                                             |
| never   | 9 (4 multiple mailboxes, 5 no second account)                  |

fastmail/JMAP-TestSuite, 173 files:

| Phase | pass |
| ----- | ---- |
| 1     | 12   |
| 2     | 100  |
| 3     | 4    |
| 4     | 8    |
| 5     | 16   |
| 6     | 16   |
| 7     | 0    |

| expect | Count                                                              |
| ------ | ------------------------------------------------------------------ |
| pass   | 156                                                                |
| never  | 5 (2 multiple mailboxes, 1 threading rule, 2 subscription default) |
| skip   | 12 (4 no second account, 8 capability not advertised)              |

## What the suites say about the plan

Points found while deriving the files. Each one changes or pins down a design decision. Resolution as of 2026-11-11, recorded in docs/jmap/implementation-plan.md section 1: points 1, 2, 8 to 12 are adopted as stated; point 5 is resolved by the general, cached queryChanges design; points 3 and 4 keep WildDuck's behaviour and the never entries; point 6 goes to work package 4.6; point 7: the submission capability is advertised with Identity, which in the single pull request is moot.

1. `/copy` error order. The plan says Email/copy "always returns fromAccountNotFound". Both suites need more: an unknown or foreign `accountId` is `accountNotFound`, `fromAccountId` equal to `accountId` is `invalidArguments` (jmapio), a foreign `fromAccountId` is `fromAccountNotFound` (Fastmail). The same holds for Blob/copy, which therefore has to exist as a method; an `unknownMethod` answer fails `binary/blob-copy-same-account-error`.
2. Patches that touch two mailbox ids. `Email/set/update/one-folder-to-another.t` and `submission/set-on-success-update-email` move an Email with one patch that sets the old mailbox id to null and the new one to true. The patch must be applied as a whole and judged on the result (one mailbox, a move). Rejecting it with `tooManyMailboxes` because of the intermediate state would fail both.
3. Threading on References plus equal subject costs the largest query file of the Fastmail suite (`Email/query/filtering.t`). The rule is the one RFC 8621 section 3 suggests, so this is the suite's assumption, not a conformance defect, but it is the price of the rule.
4. `isSubscribed` on a new mailbox. WildDuck subscribes created mailboxes and RFC 8621 says SHOULD default to true; two Fastmail files expect false. Either accept the two `never` entries or report the assertion upstream.
5. Email/queryChanges scope. The plan sketches queryChanges for mailbox views sorted by receivedAt. `Email/queryChanges/simple.t` uses a text filter with a subject sort, and two jmapio tests use no mailbox filter at all. If phase 4 keeps the narrow scope, change those entries to `never` (Fastmail) and keep only the unchanged state case (jmapio).
6. Text search and stop words. `Email/query/filtering.t` searches `text: "here"` and `Email/queryChanges/simple.t` searches `text: "aaa"`. A full text index that drops stop words or stems aggressively will miss these. Relevant for the OpenSearch analyzer in phase 4.
7. Identity before submission. Identity is phase 2 but lives under `urn:ietf:params:jmap:submission`, which both suites use as the switch for Identity tests. The files assume the capability is advertised from phase 2 with EmailSubmission methods answering `unknownMethod` until phase 3. If it is only advertised in phase 3, move the 13 jmapio and 4 Fastmail Identity entries to phase 3.
8. `Mailbox/changes` must fill `updatedProperties` with the four counters when only message changes touched a mailbox (`Mailbox/changes/changed-properties.t`). Null is allowed by the RFC and not by the suite. The journal can tell the two cases apart, so comply.
9. Mailbox/query sort by `name` must compare byte wise (uppercase before lowercase) to satisfy `Mailbox/query/filtering-with-filter-operators.t`; the jmapio name sort test is satisfied by the same order with the default mailbox names.
10. Exact response shapes. The Fastmail session test allows no property beyond the RFC ones in the session object, the core capability and the mail account capability; upload must echo `type` without parameters; download must answer with exactly the requested Content-Type. Vendor additions belong under their own capability URN.
11. Uploads consumed by Email/import must stay downloadable until they expire (`Email/import/download-after-import.t`).
12. Email/set create must accept an Email that has only `mailboxIds` (`Email/set/create/created-response-required-properties.t`) and must ignore an unknown key inside a `bodyValues` entry (`EmailSubmission/get/basic.t`).

## Updating the pins

When a suite moves to a new commit: diff the test list (jmapio: the `id` values registered under `src/tests/`, in the import order of `src/cli.ts`; Fastmail: the `.t` files under `t/`), read every new or changed test, update the entries and the counts above, and change the `commit` field and the commit in this document in the same change.
