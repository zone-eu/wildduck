# Recurrence engine: dependency options (work package 6.3)

Status: for approval. Nothing is built or installed. Checked 2026-11-11.

Context: section 3.9 of the implementation plan allows a new runtime dependency only when the problem is large and well solved elsewhere, and each one is approved first. WildDuck is EUPL-1.2 and requires Node `>=22.19.0` (`package.json`; the brief said 20, the repo says 22.19).

## What the engine must do

- Expand the JSCalendar `recurrenceRule` (RFC 8984 4.3.3 as `recurrenceRules`, a single rule in draft-ietf-calext-jscalendarbis-22 3.3.3, same semantics): every `by*` part, `bySetPosition`, `count`, `until`, `interval`, `firstDayOfWeek`, `rscale`, `skip`.
- JSCalendar expands in local date-time. A local time in a DST gap is kept and converted with the offset before the transition (RFC 8984 1.4.5); a repeated time uses the earlier offset. This differs from RFC 5545 3.3.10, which says a nonexistent local time MUST be ignored and not counted.
- `skip` (omit, backward, forward) is about invalid calendar dates (February 30, missing leap months), not about DST.
- The event `start` is always the first occurrence and is counted, even when the rule does not match it (RFC 8984 4.3.3.1). RFC 5545 leaves this undefined.
- Bounded expansion for `CalendarEvent/query` with `expandRecurrences` (bounded by `maxExpandedQueryDuration`), alerts and free/busy: cheap for a window far from `start`, with an iteration cap so a hostile rule cannot pin a worker.

## Node and Temporal

Verified locally: Node 22.23.2 (LTS Jod) and Node 24.21.0 (LTS Krypton) have no global `Temporal`; Node 24 exposes it behind `--harmony-temporal`. Node 26.11.1 exposes `Temporal` unflagged, and reported no LTS codename at that version. With engines at 22.19, Temporal cannot be assumed for years. `Intl.DateTimeFormat` with `timeZone` works on all supported versions and reads the ICU time zone data that ships with Node.

## Comparison

Data from `npm view`, `gh api repos/...` and the GitHub advisory database on 2026-11-11. "Open" counts issues plus pull requests. Behaviour marked "measured" was run on Node 22.23.2 against the published tarball in a scratch directory.

| Candidate                                | Licence      | Last release / last commit                            | Open | Unpacked                                      | Runtime deps                            | Advisories                                                                         |
| ---------------------------------------- | ------------ | ----------------------------------------------------- | ---- | --------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `rrule` 2.8.1 (jkbrzt/rrule)             | BSD-3-Clause | 2023-11-10 / 2023-11-10                               | 220  | 687 KB                                        | `tslib`                                 | none for rrule (Luxon ReDoS GHSA-3xq5-wjfh-ppjc, rrule no longer depends on Luxon) |
| `rrule-temporal` 2.2.8 (ggaabe)          | MIT          | 2026-10-01 / 2026-11-06                               | 10   | 463 KB (bundles a Temporal polyfill)          | `temporal-spec` (types only, 53 KB)     | none                                                                               |
| `ical.js` 2.2.1 (kewisch)                | MPL-2.0      | 2025-08-08 / 2026-11-06 (recurrence fixes unreleased) | 66   | 1.2 MB, time zone data not included           | none                                    | none                                                                               |
| `rrule-rust` 3.1.1 (lsndr)               | MIT          | 2026-10-12 / 2026-10-12                               | 9    | 268 KB plus 2.9 MB native binary per platform | 14 optional platform packages (napi-rs) | none (npm, nor Rust crates `rrule`, `chrono-tz`)                                   |
| `temporal-polyfill` 1.0.8 (fullcalendar) | MIT          | 2026-11-04 / 2026-11-04                               | 7    | 1.0 MB                                        | `temporal-spec`, `temporal-utils`       | none                                                                               |
| `@js-temporal/polyfill` 0.5.1            | ISC          | 2025-03-31 / 2026-09-22                               | 55   | 3.0 MB                                        | `jsbi`                                  | none                                                                               |
| In house on `Intl`                       | EUPL-1.2     | n/a                                                   | n/a  | estimated 1,000 to 1,500 lines                | none                                    | n/a                                                                                |

| Candidate        | Time zones and DST                                                                                                                                                                                                                                                                                                               | BYSETPOS       | RSCALE / skip                                                                                                       | Bounded expansion                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rrule`          | `tzid` via `Intl`; returns "floating UTC" `Date`s whose meaning depends on the process time zone (measured: same rule, different output under `TZ=Europe/Tallinn` and `TZ=America/New_York`). `dateInTimeZone` subtracts one offset difference, no gap or overlap rule. Many open tz issues (#355, #571, #596, #607, #649, #658) | yes            | no / no                                                                                                             | Iterates from `dtstart` every time. Measured: `FREQ=MINUTELY` from 1970, `between` a 5 minute window in 2026 took 47.8 s. Cap only through the iterator callback                                                                |
| `rrule-temporal` | Temporal `ZonedDateTime`, native `Temporal` when present, otherwise a bundled copy of fullcalendar `temporal-polyfill`. Measured: gap time omitted (RFC 5545 rule, not JSCalendar), repeated time uses the earlier offset. Floating rules expand without a zone                                                                  | yes (measured) | yes, Gregorian, Chinese, Hebrew, Indian; `SKIP` omit/backward/forward (measured Hebrew new year and `SKIP=FORWARD`) | `between` fast-forwards (measured 1 ms for a 1900 start). `maxIterations` default 10,000 throws when exceeded (measured on `COUNT` from 1900). Start not matching the rule is excluded (measured), JSCalendar needs it included |
| `ical.js`        | Needs VTIMEZONE definitions registered; the npm package ships none, a separate generated `ical.timezones.js` is required. Not `Intl` based. Open: #295, #257, #318 (infinite loop from a timezone rule)                                                                                                                          | yes            | no (#1001: RSCALE and SKIP dropped on serialise)                                                                    | No `between` iterator (#148, open since 2015), iterates from `dtstart`; guards only against the same occurrence twice                                                                                                           |
| `rrule-rust`     | Rust `rrule` 0.14 crate with `chrono-tz`, which embeds its own copy of the IANA database (updates need a new release, separate from Node). Gap and overlap behaviour not verified                                                                                                                                                | yes            | no                                                                                                                  | `between` and `all(limit)`; internal iteration limit of the crate not verified                                                                                                                                                  |
| Polyfills        | Not recurrence engines. They give `ZonedDateTime` with `disambiguation: 'compatible'`, which is exactly the RFC 8984 1.4.5 rule, and non Gregorian calendar arithmetic                                                                                                                                                           | n/a            | calendar arithmetic only                                                                                            | n/a                                                                                                                                                                                                                             |
| In house         | Expand in local date-time (pure arithmetic), convert to UTC with a small `Intl` helper applying the offset before the transition                                                                                                                                                                                                 | to build       | Gregorian only without Temporal; other calendars need Temporal or day by day `Intl` mapping                         | designed in: jump to the first period overlapping the window when there is no `count`, hard cap otherwise                                                                                                                       |

Others found: `node-ical` (depends on `rrule-temporal`), `ical-expander` (wraps `ical.js` 1.2.2), `@fullcalendar/rrule` (UI plugin around `rrule`), `rrule-es` (one release, 2025-06). None adds anything beyond the rows above.

Weekly downloads (npm, 2026-11-04 to 2026-11-10): `rrule` 5.1 M, `rrule-temporal` 3.3 M, `ical.js` 1.4 M, `rrule-rust` 17 K.

## Assessment

- `rrule`: unmaintained since 2023, output depends on the server process time zone, no RSCALE or skip, and the measured 47.8 s window query is a denial of service vector for `expandRecurrences`. Rejected.
- `ical.js`: built for iCalendar documents, needs a separate time zone data build, no windowed iteration, no RSCALE. MPL-2.0 is compatible with EUPL-1.2 for unmodified use, but the fit is poor. Rejected.
- `rrule-rust`: native binaries per platform, its own IANA data copy, no RSCALE. Adds build and deployment surface for speed we do not need. Rejected.
- Polyfills alone do not solve recurrence; they only help an in house engine with non Gregorian calendars.
- `rrule-temporal`: the only candidate covering every rule part including RSCALE and skip, with fast windowed expansion and an iteration cap, actively maintained, MIT, no real runtime dependency. Risks: mostly one maintainer (378 commits, next contributor 118), project started 2025-04, and two semantic gaps against JSCalendar (DST gap and start inclusion) that a wrapper must close.

## Recommendation: `rrule-temporal`, pinned, behind our own wrapper

Add `rrule-temporal` at an exact version, used only from `lib/calendar/recurrence.js`. The wrapper:

1. Maps the JSCalendar `RecurrenceRule` object to options directly (no RRULE string parsing, so no parser input surface from clients).
2. Expands in floating local time only, never with `tzid`, so the library makes no DST decisions. The wrapper converts each local date-time to UTC with an `Intl` helper that applies RFC 8984 1.4.5 (offset before the transition). Floating events stay floating. Instants that collide after conversion (an `hourly` rule across a gap) are deduplicated; this case is not spelled out in RFC 8984 and is an open point.
3. Adds `start` as the first, counted occurrence when the rule does not produce it.
4. Converts the UTC query window to local bounds with a one day margin, calls `between`, then filters exactly in UTC.
5. Sets `maxIterations` and its own per call instance cap, and maps a cap hit to a JMAP error rather than a 500.
6. Applies `recurrenceOverrides` and `excluded` itself, and generates the synthetic instance ids.

Because the library is used only for calendar arithmetic, it can later be replaced by the in house engine without touching callers. Effort: 4. The rule semantics come from the library; the wrapper, the `Intl` helper, overrides and the tests are ours.

## If the dependency is rejected: in house engine

Scope (`lib/calendar/recurrence.js` plus `lib/calendar/tz.js`):

- All frequencies; `byMonth`, `byWeekNo` with `firstDayOfWeek`, `byYearDay`, `byMonthDay` (negative values), `byDay` with `nthOfPeriod`, `byHour`, `byMinute`, `bySecond`, `bySetPosition`, `interval`, `count`, `until`, the implicit parts of RFC 8984 4.3.3.1, and start inclusion.
- `skip` for Gregorian (`byMonthDay` beyond the month end, with duplicate removal).
- `rscale` other than `gregorian` rejected with `invalidProperties` until Node ships Temporal in every supported version; then added on native `Temporal` without a polyfill.
- Time zones: local to UTC through `Intl.DateTimeFormat` offsets (two pass guess, offset before the transition), UTC to local for windows, unknown zone ids rejected.
- Windows: without `count`, jump arithmetically to the first period that can overlap the window; with `count`, iterate from the start under a hard cap.

Effort: 8 for Gregorian. Many interacting rule parts, week numbering and set positions are where existing libraries still collect bug reports. 16 if non Gregorian calendars are required before Node ships Temporal, because that needs calendar arithmetic built on day by day `Intl` mapping or a polyfill dependency anyway.

## Test strategy (either option)

- Unit tests from the RFC 5545 3.8.5.3 examples translated to JSCalendar, the RFC 8984 examples, and DST cases in at least `Europe/Tallinn`, `America/Los_Angeles`, `Australia/Melbourne` and `Australia/Lord_Howe` (30 minute shift).
- Property test against a brute force oracle that follows RFC 8984 4.3.3.1 literally: enumerate every candidate local date-time in each period (at the finest unit the rule can produce, not every second), apply each `by*` filter, then `bySetPosition`, `skip`, start inclusion, `count` and `until`, then convert with the same `Intl` rule. Random rules, starts and zones, compared over random windows with a small count limit so the oracle stays fast.
- Window consistency property: `between(a, c)` equals `between(a, b)` plus `between(b, c)`, and every result of `all()` that falls in a window is returned for that window.
- Cap tests: pathological rules (never matching, huge `count` from a far past start, `secondly` rules) must finish under a fixed time budget with the cap error.
- With the dependency, the same suite pins its behaviour, so a library upgrade that changes semantics fails CI.
