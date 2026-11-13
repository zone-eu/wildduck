# JMAP service

WildDuck can serve mail, contacts and calendars over JMAP, the JSON based protocol of [RFC 8620](https://www.rfc-editor.org/rfc/rfc8620) (core) and [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621) (mail). The JMAP service is a separate HTTP listener that runs in every worker process next to IMAP, POP3 and the REST API. It is stateless and uses the same handlers, MongoDB databases and Redis as the other services, so a change made over JMAP is seen at once over IMAP, POP3 and the REST API, and the other way round.

The service is disabled by default. The service entry point is `jmap.js`, the code is in `lib/jmap/`, and the configuration is `config/jmap.toml`, included as the `[jmap]` section of `config/default.toml`.

## Supported specifications

| Capability                              | Specification                                                                                                                                                          | Methods                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `urn:ietf:params:jmap:core`             | [RFC 8620](https://www.rfc-editor.org/rfc/rfc8620)                                                                                                                     | `Core/echo`, `Blob/copy`, `PushSubscription/get`, `PushSubscription/set`; upload, download and EventSource endpoints                                                                                                                                                                                    |
| `urn:ietf:params:jmap:mail`             | [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621)                                                                                                                     | `Mailbox/get`, `/changes`, `/query`, `/queryChanges`, `/set`; `Thread/get`, `/changes`; `Email/get`, `/changes`, `/query`, `/queryChanges`, `/set`, `/copy`, `/import`, `/parse`; `SearchSnippet/get`                                                                                                   |
| `urn:ietf:params:jmap:submission`       | [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621) section 6 and 7                                                                                                     | `Identity/get`, `/changes`, `/set`; `EmailSubmission/get`, `/changes`, `/query`, `/queryChanges`, `/set`                                                                                                                                                                                                |
| `urn:ietf:params:jmap:vacationresponse` | [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621) section 8                                                                                                           | `VacationResponse/get`, `/set`                                                                                                                                                                                                                                                                          |
| `urn:ietf:params:jmap:blob`             | [RFC 9404](https://www.rfc-editor.org/rfc/rfc9404)                                                                                                                     | `Blob/upload`, `Blob/get`, `Blob/lookup`                                                                                                                                                                                                                                                                |
| `urn:ietf:params:jmap:quota`            | [RFC 9425](https://www.rfc-editor.org/rfc/rfc9425)                                                                                                                     | `Quota/get`, `/changes`, `/query`, `/queryChanges`                                                                                                                                                                                                                                                      |
| `urn:ietf:params:jmap:contacts`         | [RFC 9610](https://www.rfc-editor.org/rfc/rfc9610), cards in JSContact ([RFC 9553](https://www.rfc-editor.org/rfc/rfc9553))                                            | `AddressBook/get`, `/changes`, `/set`; `ContactCard/get`, `/changes`, `/set`, `/copy`, `/query`, `/queryChanges`                                                                                                                                                                                        |
| `urn:ietf:params:jmap:calendars`        | [draft-ietf-jmap-calendars-33](https://datatracker.ietf.org/doc/draft-ietf-jmap-calendars/), events in JSCalendar ([RFC 8984](https://www.rfc-editor.org/rfc/rfc8984)) | `Calendar/get`, `/changes`, `/set`; `CalendarEvent/get`, `/changes`, `/set`, `/copy`, `/query`, `/queryChanges`; `ParticipantIdentity/get`, `/changes`, `/set`; `CalendarEventNotification/get`, `/changes`, `/query`, `/set` (always empty, see [Known deviations](#known-deviations-and-limitations)) |
| `urn:ietf:params:jmap:webpush-vapid`    | [RFC 9749](https://www.rfc-editor.org/rfc/rfc9749)                                                                                                                     | Session capability only, carries the VAPID `applicationServerKey`. Present while Web Push is enabled                                                                                                                                                                                                    |

Web Push follows [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030), with message encryption by [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291) and VAPID by [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292).

The IMAP server advertises `OBJECTID` ([RFC 8474](https://www.rfc-editor.org/rfc/rfc8474)) whether or not the JMAP service is enabled. `EMAILID`, `THREADID` and `MAILBOXID` are the JMAP ids of the same objects (RFC 8621 section 1.6), and `SEARCH EMAILID` and `SEARCH THREADID` are supported, so a client that uses both protocols sees one identity per message, thread and mailbox.

Not included:

- Calendar scheduling: iTIP over iMIP, `CalendarEvent/parse`, real `CalendarEventNotification` objects. Held until the calendars draft is published as an RFC.
- Sharing ([RFC 9670](https://www.rfc-editor.org/rfc/rfc9670)), principals and availability (`Principal/getAvailability`). Every user has exactly one personal account.
- Conversion to and from iCalendar and vCard.

## Enabling the service

Minimal configuration for a service behind a TLS terminating reverse proxy:

```toml
[jmap]
enabled = true
host = "127.0.0.1"
port = 8081
secure = false
baseUrl = "https://jmap.example.com"
```

`baseUrl` is the public URL clients use. The session resource builds `apiUrl`, `downloadUrl`, `uploadUrl` and `eventSourceUrl` from it and never from request headers such as `Host` or `X-Forwarded-Host`. Without it the URLs point at `host` and `port` of the listener, which is only correct when clients connect to the listener directly.

To serve HTTPS from WildDuck itself, set `secure = true`. The certificate comes from a `[jmap.tls]` section (`key`, `cert`, `ca`, `dhparam`, the same keys as the other listeners), falling back to the global `[tls]` section. Certificates managed by WildDuck (`CertHandler`, ACME) are selected by server name (SNI), and certificate files are reloaded like those of the other listeners.

The service uses `[api.accessControl] secret` for keyed checksums: state strings, query states, the authentication cache and quota states. The default secret in `config/api.toml` must be replaced in production. Changing the secret later makes every JMAP client resynchronise, because its old states are no longer accepted.

EmailSubmission hands messages to the outbound queue exactly like the REST API submit endpoint (`[sender]` configuration, ZoneMTA with zonemta-wildduck), so sending over JMAP needs the same outbound setup.

## Configuration reference

Every key below is a key of `config/jmap.toml`, written relative to `[jmap]`: `limits.maxSizeUpload` is `maxSizeUpload` in the `[jmap.limits]` section. Defaults are the values in `config/jmap.toml`; a key that is commented out there shows the value the code uses when the key is not set.

### `[jmap]`

| Key            | Default       | Meaning                                                                                                                                                                               |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`      | `false`       | Starts the service. The indexes JMAP uses are created at start up whether or not it is enabled                                                                                        |
| `port`         | `8081`        | Listening port                                                                                                                                                                        |
| `host`         | `"127.0.0.1"` | Listening address                                                                                                                                                                     |
| `secure`       | `false`       | Serve HTTPS (certificates from `[jmap.tls]` or `[tls]`)                                                                                                                               |
| `baseUrl`      | not set       | Public base URL used for the URLs in the session resource. Must be set behind a proxy. Without it: `http(s)://<host>:<port>`, with `localhost` for a wildcard `host`                  |
| `queryTimeout` | `9000`        | Time limit in milliseconds for the database work of one `Email/query` call; a slower query answers `serverUnavailable`. Default: three times the message search limit of the REST API |

These `[jmap]` keys are read by the code but not listed in `config/jmap.toml`:

| Key            | Default | Meaning                                                                                                                                                                                                                                                   |
| -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trustProxy`   | `false` | Takes the client address from `X-Forwarded-For` (Fastify `trustProxy`). The address is used in the authentication log, failed login counters and message metadata. Enable only when the listener is reachable solely through a proxy that sets the header |
| `cors.origins` | `[]`    | Browser origins (exact `Origin` values) that get CORS headers, for web clients served from another origin. Preflight answers allow `Authorization`, `Content-Type`, `Accept` and `Last-Event-ID`                                                          |
| `tls`          | not set | `[jmap.tls]` with `key`, `cert`, `ca`, `dhparam`, as for the other listeners                                                                                                                                                                              |

### `[jmap.limits]`

| Key                           | Default              | Meaning                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxSizeUpload`               | `52428800` (50 MB)   | Largest upload, advertised in the core capability. Also caps `maxSizeAttachmentsPerEmail` of the mail capability                                                                                                                                                                                                         |
| `maxConcurrentUpload`         | `4`                  | Uploads one user may have in flight across all workers                                                                                                                                                                                                                                                                   |
| `maxSizeRequest`              | `10485760` (10 MB)   | Largest API request body                                                                                                                                                                                                                                                                                                 |
| `maxConcurrentRequests`       | `8`                  | API requests one user may have in flight across all workers; more answer HTTP 429                                                                                                                                                                                                                                        |
| `maxCallsInRequest`           | `32`                 | Method calls in one request                                                                                                                                                                                                                                                                                              |
| `maxObjectsInGet`             | `1500`               | Ids in one `/get` call. Equal to the mailbox limit, so `Mailbox/get` with `ids: null` always fits                                                                                                                                                                                                                        |
| `maxObjectsInSet`             | `500`                | Objects in one `/set` call (create, update and destroy together)                                                                                                                                                                                                                                                         |
| `uploadQuota`                 | `209715200` (200 MB) | Bytes of temporary uploads per user. A new upload that does not fit deletes unreferenced uploads, oldest first; it is refused only when nothing unreferenced is left. Separate from the mail quota                                                                                                                       |
| `maxUploads`                  | `1000`               | Temporary uploads per user, pinned ones included. One too many deletes unreferenced uploads, oldest first, as `uploadQuota` does                                                                                                                                                                                         |
| `uploadTtl`                   | `86400`              | Seconds an upload is kept (RFC 8620 6.1 asks for at least one hour). An upload stays downloadable until it expires, also after it was used in a message                                                                                                                                                                  |
| `maxSizeMessage`              | `67108864` (64 MB)   | Largest message `Email/import` stores. Default: the message size limit of `MessageHandler`                                                                                                                                                                                                                               |
| `maxSizeBlobSet`              | `10485760` (10 MB)   | `Blob/upload`: largest blob one creation may build. It is assembled in memory                                                                                                                                                                                                                                            |
| `maxDataSources`              | `64`                 | `Blob/upload`: most data sources per creation (RFC 9404 asks for at least 64)                                                                                                                                                                                                                                            |
| `maxSizeBlobGet`              | `16777216` (16 MB)   | Most octets one `Blob/get` call returns. A larger blob answers `requestTooLarge` unless the client asks for a range (`offset`, `length`)                                                                                                                                                                                 |
| `maxBodyValueBytesPerRequest` | `33554432` (32 MB)   | Octets of body values one `Email/get` call returns at most; later values come back empty with `isTruncated: true`. Bounded by what is left of `maxResponseBytes`                                                                                                                                                         |
| `maxResponseBytes`            | `67108864` (64 MB)   | Octets the `/get` calls of one request return together. The responses of all calls are held until the request ends, so every `/get` draws from this one budget; a call that does not fit in what is left answers `requestTooLarge`, `Email/get` body values are truncated instead. Not advertised, see [Limits](#limits) |

### `[jmap.contacts]`

| Key                      | Default           | Meaning                                                                                                           |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `maxAddressBooksPerCard` | `1`               | Address books one card may be in, advertised as `maxAddressBooksPerCard`                                          |
| `maxAddressBooks`        | `100`             | Address books per account                                                                                         |
| `maxCards`               | `10000`           | Cards per account                                                                                                 |
| `maxCardSize`            | `262144` (256 KB) | Largest card, in octets of JSON. Photos and other media are blobs and do not count                                |
| `maxMediaSize`           | `4194304` (4 MB)  | Largest photo, logo or sound of a card (also limited by `limits.maxSizeUpload`)                                   |
| `maxMediaBytes`          | `104857600`       | Octets (100 MB) of all photos, logos and sounds of an account, more is `overQuota`. Each card keeps its own copy  |
| `maxMediaPerCard`        | `20`              | Media entries (photos, logos, sounds) of one card, more is `tooLarge`                                             |
| `maxRegisterCards`       | `10000`           | Most address register entries shown as cards of the read only register address book, the most recently used first |

### `[jmap.auth]`

| Key        | Default | Meaning                                                                                                                                                                                                    |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cacheTtl` | `300`   | Seconds a verified Basic credential is remembered, so a client that sends the same password with every request does not pay for a password hash each time. A password or 2FA change ends the entry at once |

### `[jmap.changes]`

| Key                  | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safetyWindow`       | `2000`  | Milliseconds before the given state that Email, Thread and Mailbox `/changes` look again. Journal ids are made in different processes, so an entry with a smaller id can be committed after a larger one was read. An id may be reported twice, which RFC 8620 5.2 allows: ids seen again are reported as updated or destroyed, never as created, and at most half of `maxChanges` of them (the most recently changed), so every page advances |
| `ownedSafetyWindow`  | `32`    | The same for the types with their own change log (Identity, EmailSubmission, AddressBook, ContactCard, Calendar, CalendarEvent, ParticipantIdentity): sequence numbers below the state that are read again. `0` turns it off                                                                                                                                                                                                                   |
| `maxChanges`         | `1500`  | Most ids in one `/changes` response. A larger client `maxChanges`, or none, is capped to this                                                                                                                                                                                                                                                                                                                                                  |
| `retentionCacheTime` | `60`    | Seconds the journal retention setting (`const:journal:time`) is kept in memory                                                                                                                                                                                                                                                                                                                                                                 |
| `scanLimit`          | `10000` | Most journal entries read for one `/changes` response. A long run of changes to a few ids is answered with an intermediate state                                                                                                                                                                                                                                                                                                               |

### `[jmap.query]`

| Key           | Default | Meaning                                                                                                                                                                                                                                                                      |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryLimit` | `10000` | Most messages one `Email/query` examines in memory: the results of a `from`, `to`, `subject` or thread keyword sort (a larger result answers `unsupportedSort`) and the candidates of thread keyword filters. Must not be higher than `queryCache.maxIds` (checked at start) |

### `[jmap.queryCache]`

Result ids of queries are kept in Redis under their query state so `/queryChanges` (RFC 8620 5.6) can compute differences.

| Key          | Default          | Meaning                                                                                                                                      |
| ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttl`        | `600`            | Seconds a cached result list is kept. A query state whose list is gone answers `cannotCalculateChanges`                                      |
| `maxIds`     | `10000`          | Most ids kept per query state. A query window that ends past it, or starts more than 1000 entries in, answers `canCalculateChanges: false`   |
| `maxBytes`   | `1048576` (1 MB) | Size budget of the Redis hash holding all query states of one user (12 bytes per id). Must hold one full list of `maxIds` (checked at start) |
| `maxEntries` | `200`            | Most query states per user. Storing more drops the states stored longest ago                                                                 |

### `[jmap.eventSource]`

| Key           | Default | Meaning                                                                                                          |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `minPing`     | `5`     | Smallest ping interval in seconds a client may ask for. Must be between 1 and 30 (RFC 8620 7.3)                  |
| `maxPing`     | `300`   | Largest ping interval in seconds. Must be at least 300                                                           |
| `maxDuration` | `1800`  | Seconds after which a stream is closed; the client reconnects with `Last-Event-ID`                               |
| `maxStreams`  | `15`    | Open streams per user across all workers (counted in Redis like the IMAP connection limit). More answer HTTP 429 |
| `retryAfter`  | `30`    | `Retry-After` value in seconds of that 429                                                                       |

### `[jmap.submission]`

| Key              | Default             | Meaning                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxDelayedSend` | `2592000` (30 days) | Longest delayed send (`FUTURERELEASE` with `HOLDFOR` or `HOLDUNTIL`) in seconds, advertised as `maxDelayedSend`. `0` turns delayed send off. Default: `[sender] maxQueueTime`                                                                                                     |
| `retention`      | `604800` (7 days)   | Seconds after their send time that sent and canceled submissions are removed. The messages are not affected                                                                                                                                                                       |
| `maxSize`        | `67108864` (64 MB)  | Largest message that can be submitted. Default: `limits.maxSizeMessage`, else 64 MB                                                                                                                                                                                               |
| `pollInterval`   | `15`                | Seconds between polls of the outbound queue for due pending submissions, so clients learn when delivery started. A message that keeps waiting is checked less often, the delay doubling up to an hour. `0` turns the poller off (submissions are then updated when they are read) |

### `[jmap.calendars]`

| Key                        | Default                  | Meaning                                                                                                                                                                                          |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxCalendars`             | `1000`                   | Calendars per account; `Calendar/set` create answers `overQuota` beyond it                                                                                                                       |
| `maxCalendarsPerEvent`     | `1`                      | Calendars one event may be in, advertised as `maxCalendarsPerEvent`                                                                                                                              |
| `maxEventsPerAccount`      | `50000`                  | Events per account                                                                                                                                                                               |
| `maxParticipantsPerEvent`  | `500`                    | Participants per event, advertised                                                                                                                                                               |
| `minDateTime`              | `"1900-01-01T00:00:00Z"` | Earliest date-time an event may use, advertised                                                                                                                                                  |
| `maxDateTime`              | `"2199-12-31T23:59:59Z"` | Latest date-time an event may use, advertised                                                                                                                                                    |
| `maxExpandedQueryDuration` | `"P366D"`                | Longest window `CalendarEvent/query` may expand recurrences over, advertised                                                                                                                     |
| `defaultName`              | `"Calendar"`             | Name of the default calendar a user gets on first calendar access                                                                                                                                |
| `maxEventSize`             | `262144` (256 KB)        | Largest stored event, in octets of JSON                                                                                                                                                          |
| `maxQueryEventBytes`       | `67108864` (64 MB)       | Octets of stored events one `CalendarEvent/query` may read (every event when expanding recurrences, recurring events under a time range); past it the query answers `cannotCalculateOccurrences` |

### `[jmap.alerts]`

Calendar alerts (`lib/calendar/alerts.js`).

| Key           | Default | Meaning                                                                            |
| ------------- | ------- | ---------------------------------------------------------------------------------- |
| `enabled`     | `true`  | Runs the alert scheduler                                                           |
| `interval`    | `10`    | Seconds between two scheduler runs. One JMAP worker at a time runs it (Redis lock) |
| `jitter`      | `30`    | A user's alerts fire up to this many seconds early, never late                     |
| `pushLimit`   | `120`   | Display alerts pushed per user per `pushWindow`                                    |
| `pushWindow`  | `3600`  | Seconds                                                                            |
| `emailLimit`  | `30`    | Email alerts per user per `emailWindow`                                            |
| `emailWindow` | `86400` | Seconds                                                                            |

`batch` (default `500`, due events read per scheduler run) is read by the code but not listed in `config/jmap.toml`.

### `[jmap.push]`

Web Push for `PushSubscription` (RFC 8620 7.2).

| Key                   | Default           | Meaning                                                                                                                                         |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `true`            | Runs Web Push delivery and advertises `urn:ietf:params:jmap:webpush-vapid`                                                                      |
| `maxPerUser`          | `20`              | Subscriptions per user, all credentials together                                                                                                |
| `createRate`          | `30`              | New subscriptions per user and hour                                                                                                             |
| `maxLifetime`         | `604800` (7 days) | Longest subscription lifetime in seconds; a later `expires` is shortened. At least 172800 (48 hours, RFC 8620 7.2), checked at start            |
| `verificationTimeout` | `3600`            | Seconds an unverified subscription is kept                                                                                                      |
| `verifyAttempts`      | `5`               | Wrong verification codes that destroy a subscription                                                                                            |
| `attempts`            | `5`               | Tries of a push answered with 5xx or not answered                                                                                               |
| `retryDelay`          | `10`              | First retry delay in seconds, growing exponentially                                                                                             |
| `maxRetryDelay`       | `600`             | Largest retry delay in seconds. A 429 is retried at this pace (at least its `Retry-After`) until it succeeds                                    |
| `failureLimit`        | `5`               | Pushes failed in a row that remove the subscription                                                                                             |
| `timeout`             | `10`              | Seconds to wait for a push service to answer, and separately for the DNS resolution of its host                                                 |
| `coalesce`            | `1`               | Seconds changes are collected before they are pushed together                                                                                   |
| `ttl`                 | `86400`           | `TTL` header of push requests, in seconds                                                                                                       |
| `concurrency`         | `20`              | Push requests one worker runs in parallel                                                                                                       |
| `vapidRefresh`        | `60`              | Seconds between two reads of the VAPID key; a rotated key is noticed this late                                                                  |
| `vapidSubject`        | not set           | Contact of the VAPID JWT (`sub` claim), `mailto:` or `https:`. Default: the origin of an `https` `baseUrl`, else `mailto:postmaster@<hostname>` |
| `allowHosts`          | `[]`              | Host names exempt from the public address check. For tests only, keep empty in production                                                       |
| `ca`                  | not set           | Extra trusted certificate files for push services, on top of the default ones. For tests only                                                   |

`testDns` (a DNS server and domains used to resolve push hosts) is read by the code for the test suite only and is not listed in `config/jmap.toml`.

### Related settings outside `[jmap]`

| Setting                                            | Effect on JMAP                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `[api.accessControl] secret`                       | Key of the state, query state and quota state checksums and of the authentication cache; also signs access tokens |
| `[api.accessControl] tokenLifetime`, `[api] roles` | Bearer token checks, shared with the REST API                                                                     |
| `[sender]`                                         | Outbound queue used by EmailSubmission                                                                            |
| `[elasticsearch]`, the `indexing` feature flag     | Text search through OpenSearch, see [Search](#search)                                                             |
| `[migrations.database.messagesRootRepair]`         | The optional root repair migration, see [Root repair](#root-repair)                                               |
| Setting `const:journal:time`                       | How far back the change history of Email, Thread and Mailbox reaches, see [Journal retention](#journal-retention) |

## Authentication

Every endpoint except the CORS preflight needs credentials (RFC 8620 8.2). A request without them, or with credentials that are not accepted, answers HTTP 401 with `WWW-Authenticate: Basic realm="JMAP", Bearer realm="JMAP"`. Exactly one `Authorization` header is accepted. A request other than GET or HEAD whose `Origin` header is neither listed in `cors.origins`, the origin of `baseUrl`, nor the host the request was sent to answers HTTP 403 before authentication, so a page of another site can not use credentials the browser remembers. Downloads hold a concurrency slot of their own, limited to `maxConcurrentRequests` at once per user.

- **Bearer**: a user access token, the 40 character token `POST /authenticate` with `token: true` issues. The same tokens work for the REST API. JMAP accepts only tokens with the role `user` that are bound to a user account and carry the 2FA assurance state recorded at issue. A token whose 2FA step is not done, or that requires a password change, is refused, and so are root tokens, tokens with any other role and tokens without a lifetime. Tokens issued before the assurance state was recorded (before 2026-10-06) get HTTP 401 from JMAP while they keep working for the REST API; their holders sign in again to get a new token.
- **Basic** with an application specific password whose scopes include `jmap` (or all scopes). The `jmap` scope can be chosen when the password is created through the REST API.
- **Basic** with the account password, only while the account has no 2FA enabled.

Disabled and suspended accounts are refused, and so is an account that has `jmap` in `disabledScopes`. Failed attempts go through the same failure counters as IMAP and POP3, logged with protocol `JMAP`. A locked out account answers HTTP 429 with `Retry-After`, also when its credentials are still in the authentication cache.

A verified Basic credential is cached in Redis for `auth.cacheTtl` seconds under an HMAC of the credential, never the credential itself. The entry is bound to the account's `authVersion` and, for an application password, to that password still existing, so a password change, a 2FA change or deleting the application password ends it at once.

## Discovery

| Path                                         | Method | Purpose                                                 |
| -------------------------------------------- | ------ | ------------------------------------------------------- |
| `/.well-known/jmap`, `/jmap/session`         | GET    | Session resource (RFC 8620 2)                           |
| `/jmap/api/`                                 | POST   | API requests                                            |
| `/jmap/upload/{accountId}/`                  | POST   | Upload (RFC 8620 6.1)                                   |
| `/jmap/download/{accountId}/{blobId}/{name}` | GET    | Download (RFC 8620 6.2), `?type=` sets the Content-Type |
| `/jmap/eventsource/`                         | GET    | Event stream (RFC 8620 7.3)                             |

Paths are served with and without the trailing slash. Other HTTP methods on these paths answer 405 with `Allow`. The session resource is sent with `Cache-Control: no-cache, no-store, must-revalidate`.

The session lists one personal, writable account per user, with the id `u` followed by the 24 hex digit user id, and that account is primary for every capability.

For autodiscovery from an email address (RFC 8620 2.2), publish an SRV record for the mail domain that points at the public host and port, and serve `/.well-known/jmap` there:

```
_jmap._tcp.example.com. 3600 IN SRV 0 1 443 jmap.example.com.
```

Clients that are given a server name instead fetch `https://<server>/.well-known/jmap` directly, so the public host must answer that path. Set `baseUrl` to the same public origin.

## Running behind a reverse proxy

- **`baseUrl`**: set it to the public origin. The session URLs are built from it only.
- **Client address**: set `trustProxy = true` only if the listener can not be reached except through the proxy, and let the proxy replace `X-Forwarded-For` rather than append to it, so a client can not choose the address the failure counters and logs see.
- **Event stream**: the proxy must not buffer `/jmap/eventsource/`. The service sends `X-Accel-Buffering: no`, which nginx honours, and writes a comment line at once to flush the headers. Other proxies need buffering turned off for that path. Pass the `Last-Event-ID` request header through.
- **Timeouts**: a stream stays open up to `eventSource.maxDuration` (1800 seconds). A client chooses its ping interval, clamped to `minPing` and `maxPing` (300 seconds), and may ask for no pings at all. Set the proxy read timeout for the event stream above `maxDuration`, or at least above `maxPing`, so idle streams are not cut. API requests are bounded by `queryTimeout` and the database time limits.
- **Body size**: allow request bodies of `limits.maxSizeUpload` (50 MB by default) on `/jmap/upload/` and `limits.maxSizeRequest` (10 MB) on `/jmap/api/`. Downloads stream and can be as large as the largest stored message.
- **Compression**: responses are not compressed by the service; compress JSON responses in the proxy if wanted, but never the event stream.

An nginx example:

```nginx
location /.well-known/jmap {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header X-Forwarded-For $remote_addr;
}

location /jmap/ {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header X-Forwarded-For $remote_addr;
    client_max_body_size 50m;
}

location /jmap/eventsource {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1900s;
}
```

## Limits

The core limits of `[jmap.limits]` are advertised in the session. The account capabilities carry the others:

| Capability | Value                                                                                                       | Source                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| mail       | `maxMailboxesPerEmail: 1`                                                                                   | A message is stored in exactly one mailbox                                                                                 |
| mail       | `maxMailboxDepth: 128`                                                                                      | Mailbox depth limit of WildDuck                                                                                            |
| mail       | `maxSizeMailboxName: 512`                                                                                   |                                                                                                                            |
| mail       | `maxSizeAttachmentsPerEmail`                                                                                | Derived from the 64 MB message limit after base64 overhead, capped by `limits.maxSizeUpload` (48849526 with the defaults)  |
| mail       | `emailQuerySortOptions`                                                                                     | `receivedAt`, `sentAt`, `size`, `from`, `to`, `subject`, `hasKeyword`, `allInThreadHaveKeyword`, `someInThreadHaveKeyword` |
| submission | `maxDelayedSend`, `submissionExtensions`                                                                    | `submission.maxDelayedSend`; `FUTURERELEASE` is listed while delayed send is on                                            |
| blob       | `maxSizeBlobSet`, `maxDataSources`, `supportedTypeNames`, `supportedDigestAlgorithms`                       | `[jmap.limits]`; types Mailbox, Thread, Email, ContactCard, CalendarEvent; digests `sha`, `sha-256`, `sha-512`             |
| contacts   | `maxAddressBooksPerCard`                                                                                    | `[jmap.contacts]`                                                                                                          |
| calendars  | `maxCalendarsPerEvent`, `minDateTime`, `maxDateTime`, `maxExpandedQueryDuration`, `maxParticipantsPerEvent` | `[jmap.calendars]`                                                                                                         |

The core capability lists the collations `i;ascii-numeric`, `i;ascii-casemap` and `i;unicode-casemap`.

Besides the advertised limits:

- A request answers with RFC 7807 problem details (`application/problem+json`) for request level errors: `notJSON`, `notRequest`, `limit` (with the name of the limit), `unknownCapability`. JSON must be valid I-JSON; duplicate keys and nesting deeper than 64 levels are refused.
- One response budget per request (`limits.maxResponseBytes`, 64 MB): every `/get` call of the request draws what it returns, estimated from stored values without rendering (the stored JSON size of events and cards, header and body value lengths of Emails, blob octets, the Email ids of Threads, and 256 octets per object). A call that does not fit in what is left answers `requestTooLarge`; the calls before it keep their results. Body values of `Email/get` are truncated (`isTruncated`) instead. Per call caps such as `maxBodyValueBytesPerRequest`, `maxSizeBlobGet` and the 64 MB of a `ContactCard/get` apply within it.
- An id given more than once in a `/get` call is answered once, in `list` or in `notFound` (RFC 8620 5.1).
- `Email/query` filters are limited to 10 levels and 100 conditions; a larger filter answers `unsupportedFilter`.
- Recurrence expansion is limited to 10,000 instances per window and 20,000 iterations per rule; beyond that `cannotCalculateOccurrences`. A `CalendarEvent/query` reads the stored events it must expand or range test in batches and keeps only the ids of the matches; when they add up to more than `calendars.maxQueryEventBytes` (64 MB) it answers `cannotCalculateOccurrences` before reading any.
- The mail limits of WildDuck apply as for every other way of writing mail: the storage quota, the 1500 mailbox limit, the daily recipient limits (shared with the REST API and ZoneMTA through the `wdr:` counter) and the message size limit.

## Push

### Event stream

`GET /jmap/eventsource/?types=...&closeafter=state|no&ping=N` (RFC 8620 7.3). `types` is `*` or a list of type names; `CalendarAlert` asks for calendar alerts, which are sent as `calendarAlert` events and never replayed. All three parameters are required.

A stream listens to the same change notifications as IMAP IDLE, fanned out between workers through Redis, and reads the states only when a change arrives. The event id is the mail state string, followed by a digest of the states of the other requested types. A client that reconnects with `Last-Event-ID` gets one event for the types that changed since, or for every requested type when the id is unknown or older than the journal retention.

A stream ends as soon as its credential is revoked: the password or 2FA setup changes, the application password is deleted, the token is revoked, or the account is disabled, suspended or loses the `jmap` scope. Every open stream also checks its credential again every 5 minutes (one user read, plus one Redis read for a token or one application password read), so changes that send no notification, such as a token reaching its idle or maximum lifetime, an expiring application password or a new `api.accessControl.secret`, end the stream within that time.

### Web Push

`PushSubscription/set` creates a subscription bound to the credential that created it (the application password, the account password and its `authVersion`, or the access token). Deleting that application password, changing the password, revoking the token or changing `api.accessControl.secret` removes the subscription. `PushSubscription/get` never returns `url` or `keys`.

- A subscription receives a `PushVerification` first and gets no state changes until the client sets the verification code.
- Payloads are encrypted with RFC 8291 (`aes128gcm`) when the client gave keys, and every push request carries a VAPID (RFC 8292) `Authorization` header. The VAPID key pair (ES256) is created on first start and stored in the `settings` collection under the hidden key `jmap:vapid`. To rotate it, delete that setting (`db.settings.deleteOne({key: 'jmap:vapid'})`); the next worker that reads it creates a new pair and the session state changes, so clients see the new `applicationServerKey`. Subscriptions created under the old key are destroyed when their next push is due (RFC 9749 section 5, no transition period), and clients create new ones.
- Server side request protection: the URL must be `https` without credentials, the host is resolved once per request (with c-ares against the system DNS servers, not through `/etc/hosts`, and given up after `timeout` seconds), every address it resolves to must be public (loopback, private, link local, shared address space, multicast, reserved ranges and IPv4 embedded in IPv6 are refused), and the connection goes to exactly the checked address. Redirects are never followed. The check runs when the subscription is created and on every delivery. `push.allowHosts` exempts host names from the address check and exists for tests only.
- Responses 404 and 410 remove the subscription. Other failures are retried with exponential backoff; `failureLimit` failures in a row remove it.

Delivery is detected on the write side: every change notification checks, with one Redis call, whether the user has a verified subscription, and marks the user as due. JMAP workers claim due users after `coalesce` seconds and queue jobs in the BullMQ queue `jmap_push`, which every JMAP worker processes. One push per subscription runs at a time, and a retry always carries the newest state.

## Search

`Email/query` turns the JMAP filter into a MongoDB query over the visible messages of the account. Messages flagged `\Deleted` and mail in hidden mailboxes are never matched.

- **MongoDB (default)**: `text`, `body`, `subject` and the address conditions use the MongoDB text index. A string is split into terms that must all be present; a quoted part is a phrase, and a leading minus is matched literally. The text index holds the subject, addresses and the first 1 KB of the plain text body, so `body` and `text` only find words near the start of the body, and stop words are dropped. Text search of messages encrypted at rest matches headers only. Header conditions match decoded header values, case and diacritic insensitively.
- **OpenSearch**: for accounts in the `indexing` feature set (or all accounts when the indexer feature flag is on in the configuration) and with `[elasticsearch] enabled = true`, `text` and `body` conditions are answered by the search index, which holds the whole stored plain text and HTML body. Each term is a phrase and all terms are required, as with MongoDB.
- Thread keyword filters (`allInThreadHaveKeyword`, `someInThreadHaveKeyword`, `noneInThreadHaveKeyword`) are decided for the candidate threads of the rest of the filter, at most `query.memoryLimit` messages. When there are more, the threads that decide the condition are used if they are few, otherwise the filter answers `unsupportedFilter`.
- Sorting by `receivedAt`, `sentAt`, `size` and `hasKeyword` runs in the database. Sorting by `from`, `to`, `subject` and the thread keyword sorts runs in memory on results of at most `query.memoryLimit` messages (RFC 5256 base subjects, the advertised collations); a larger result answers `unsupportedSort`. See [Email sorting](../jmap/email-sorting.md).
- `Email/queryChanges`, `Mailbox/queryChanges`, `ContactCard/queryChanges` and `CalendarEvent/queryChanges` re-run the query and compare it with the cached result list of the old query state (`[jmap.queryCache]`). Queries that expand recurrences report `canCalculateChanges: false`. `EmailSubmission/queryChanges` and `Quota/queryChanges` check their arguments and answer `cannotCalculateChanges`.

`ContactCard/query` uses a term index on the cards and decides filters and sorts in memory on at most `contacts.maxCards` cards. `CalendarEvent/query` preselects by calendar, uid and the first and last instance of each event, then expands recurrences in the requested window.

## Ids, states and blobs

| Object              | Id                                                         |
| ------------------- | ---------------------------------------------------------- |
| Account             | `u` + user id                                              |
| Email               | `M` + message root                                         |
| Thread              | `T` + thread id                                            |
| Mailbox             | `F` + mailbox id                                           |
| Identity            | `I` + id                                                   |
| EmailSubmission     | `S` + id                                                   |
| PushSubscription    | `P` + id                                                   |
| AddressBook         | `A` + id; the address register book is `Aregister`         |
| ContactCard         | `C` + id; a card of the register book is `R` + id          |
| Calendar            | `K` + id                                                   |
| CalendarEvent       | `V` + id; a recurrence instance is `V<id>_<recurrence id>` |
| ParticipantIdentity | `N` + id                                                   |
| Quota               | `Qstorage`                                                 |
| VacationResponse    | `singleton`                                                |

An Email id is built from the message `root`, which stays the same when the message moves to another mailbox (a move stores a new document with a new `_id`, because `messages` is sharded by mailbox). An IMAP COPY gives the copy a root, and so an Email id, of its own. Messages stored before every message had a root are read with their `_id` as root until the root repair has run for the user.

Blob ids:

| Blob                               | Id                               |
| ---------------------------------- | -------------------------------- |
| Raw message                        | `Bm` + root                      |
| Decoded MIME part of a message     | `Bp` + root + `_` + part path    |
| Upload                             | `Bu` + storage file id           |
| Decoded MIME part of an upload     | `Bv` + file id + `_` + part path |
| Contact media (photo, logo, sound) | `Bc` + id                        |

Part paths are written with `-` instead of `.`. Every blob id is checked against the account; another account's blob answers exactly like an unknown one.

Email, Thread and Mailbox share one state string, derived from the newest entry of the change journal for the user plus a keyed checksum of the account, so a state of another account is never accepted. The newest entry is kept in the user's `jmap.state` document and only moves forward. `EmailDelivery` has its own state, which changes whenever a new Email is added to the store (delivery, IMAP APPEND, REST upload, `Email/set` create, `Email/import`, IMAP COPY, restore), never on moves, flag changes or deletions. The other types number their changes with a per user sequence in `jmap.state` and keep tombstones of destroyed objects in `jmap.changes` for 30 days.

A `/changes` call with a `sinceState` older than the journal retention answers `cannotCalculateChanges`, and the client resynchronises.

## Known deviations and limitations

Behaviour where WildDuck differs from the RFCs, or from what clients and the two external test suites ([jmapio/jmap-test-suite](https://github.com/jmapio/jmap-test-suite) and [fastmail/JMAP-TestSuite](https://github.com/fastmail/JMAP-TestSuite)) expect. The per test reasons are kept in `test/jmap/external/jmapio-expectations.yaml` and `test/jmap/external/fastmail-expectations.yaml`.

### Data model

- **One mailbox per Email.** `maxMailboxesPerEmail` is 1. Creating, importing or updating an Email into two mailboxes answers `tooManyMailboxes`. Tests that put one message into two mailboxes fail by design.
- **One account per user, no sharing.** The session never has a second account, so the cross account `/copy` tests of both suites are skipped. `Email/copy`, `Blob/copy`, `ContactCard/copy` and `CalendarEvent/copy` exist and answer in this order: unknown `accountId` is `accountNotFound`, equal ids are `invalidArguments`, any other `fromAccountId` is `fromAccountNotFound`.
- **Shared state.** Email, Thread and Mailbox share one state. `ifInState` on `Mailbox/set` can fail because of unrelated mail delivery.
- **Duplicate ids in `/changes`.** Because of the safety windows an id can appear in `/changes` twice (as created and updated, or updated twice), which RFC 8620 5.2 allows.
- **IMAP COPY.** A copy is a new Email with its own id, keywords and blobs. A manual move done as COPY plus EXPUNGE is a destroy and a create.
- **Threading.** Messages are threaded when they share a reference and have the same normalised subject. Replies with a changed subject start a new thread, so the Fastmail thread keyword filter tests that rely on references alone fail.
- **Labels.** WildDuck labels are keywords `$wdlabel$<label id>`, as over IMAP. Setting such a keyword assigns the label; an unknown label id is refused.
- **Special use mailboxes.** Sent, Trash, Drafts and Junk can be renamed (`mayRename` is true) and keep their role. INBOX can not be renamed.
- **Mailbox subscription.** A created mailbox is subscribed, as over IMAP and the REST API (RFC 8621 2 says it SHOULD be). Fastmail tests that expect `isSubscribed: false` fail.

### Methods

- **`Email/get` and `Thread/get` need `ids`.** Fetching every Email or Thread with `ids: null` answers `invalidArguments` (RFC 8620 5.1 makes listing all records optional). `Mailbox/get` with `ids: null` works.
- **Body values of single part messages** keep the line break that ends the last line. Fastmail tests that compare with the text without that line break fail; parts of multipart messages are not affected.
- **`maxBodyValueBytes: null`** is treated like an omitted argument; Fastmail expects `invalidArguments`.
- **`subParts` with an explicit `bodyProperties` list** is set only on multipart parts; Fastmail expects `subParts: null` on leaf parts.
- **`hasAttachment`** is the flag `MessageHandler` sets from the attachments it extracts. An attachment with an empty body is not extracted, so a message whose only attachment is empty has `hasAttachment: false`.
- **`invalidProperties`** on `/set` create names the top level property that failed (`bodyStructure`, `textBody`, `bodyValues`, `myRights`), not a path into it. RFC 8620 5.3 defines no paths for create.
- **Raw header values** are written after the colon exactly as given (`header:X-Foo:raw` of `cat` reads back as `cat`), and display names made of atoms are written without quotes.
- **Duplicate mailbox name** under the same parent answers `invalidProperties` on `name`; jmapio expects `alreadyExists`, which RFC 8620 defines only for `/copy` and `/import`.
- **`Mailbox/query` sorts names** case insensitively (`i;unicode-casemap`) by default; Fastmail expects byte order.
- **A `position` past the end** of a query result is clamped to the result length; Fastmail expects position 0.
- **`Email/import` and `Email/parse`** accept a blob without any header line and treat it as a message with an empty header, like IMAP APPEND (RFC 8621 makes rejecting it optional).
- **Text search without OpenSearch** drops MongoDB stop words and only sees the first 1 KB of the plain text body (see [Search](#search)).
- **`unsupportedSort` and `unsupportedFilter`** are answered for in memory sorts and thread keyword filters that would examine more than `query.memoryLimit` messages.
- **Destroying a pending EmailSubmission** removes the record only; the message is still sent (RFC 8621 7.5). Set `undoStatus: canceled` to cancel. `HOLDFOR` and `HOLDUNTIL` are the only accepted SMTP parameters.
- **Uploads** stay downloadable until `limits.uploadTtl` ends, also after they were used in a message.

### Contacts and calendars

- Cards are stored and returned as JSContact; there is no vCard conversion. `shareWith` is always null. The address register (addresses the user exchanged mail with) is a read only address book `Aregister`.
- Register updates reach `ContactCard/changes` only when the process that writes them has `[jmap] enabled` (see `lib/jmap/owned-sync.js`). Updates written by a process with another configuration, for example a mail plugin that loads WildDuck as a library, do not change the ContactCard state.
- Calendars follow draft-ietf-jmap-calendars-33 without scheduling. `CalendarEventNotification` methods answer empty results, `myRights` reports all rights, and there are no principals, sharing or availability.
- A calendar without `timeZone` is treated as `Etc/UTC`, also for floating events and alerts.
- Only the gregorian calendar system is accepted in recurrence rules. `iCalendar` can not be requested from `CalendarEvent/get`.
- Recurrence expansion uses `rrule-temporal` behind `lib/calendar/recurrence.js`. Four combinations are known to be expanded wrongly by the library and are pinned by unit tests: `byYearDay` with `byDay` or `byMonthDay`, `byWeekNo` with `byMonthDay`, `skip` with several `byMonthDay` values, and a monthly `byMonthDay` rule with an interval above 1 or `bySetPosition` together with `skip`. See [Recurrence options](../jmap/recurrence-options.md).
- Display alerts go to event streams and to Web Push subscriptions that ask for `CalendarAlert`. Email alerts are delivered into the user's own INBOX. Drafts, events in unsubscribed calendars and disabled or suspended users fire no alerts.

### Test suite opinions WildDuck follows

jmapio requires some behaviour the RFCs leave open, and WildDuck complies: an HTTP 4xx for `notRequest`, `unknownCapability` and a wrong content type (the service answers HTTP 400), `unknownMethod` for every call when `using` is empty, `invalidArguments` for `/copy` with equal account ids, real results for `/queryChanges`, and the `from`, `to` and `subject` sorts.

## Operations

### Rollout

1. **Deploy the release with JMAP disabled.** Nothing changes for IMAP, POP3 and the REST API except what is listed under [Changes for existing deployments](#changes-for-existing-deployments). The indexes JMAP uses are created at the first start, also while the service is disabled. On a large cluster, build `by_root` and `user_idate` before deploying, see [Indexes](#indexes).
2. **Optionally repair message roots ahead of time** with the `messages_root_repair` migration, see [Root repair](#root-repair). Without it, the service repairs each user on first use.
3. **Set the journal retention** (`const:journal:time`), see [Journal retention](#journal-retention).
4. **Enable the service** in `config/jmap.toml` (`enabled`, `baseUrl`, listener settings), configure the reverse proxy, publish `/.well-known/jmap` and the SRV record.
5. **Watch** the metrics and logs listed under [Monitoring](#monitoring).

Rollback: disabling the service is enough. New fields, collections and indexes are ignored by older code. The one behaviour that stays is that an IMAP COPY gives the copy its own root.

### Changes for existing deployments

These apply with the release, whether or not JMAP is enabled:

- An IMAP COPY gives the copy a fresh `root`; the copy's journal entry records the source root (`sourceRoot`). MOVE and archive restore fill a missing root from `_id`.
- Journal entries of messages carry `root`, EXISTS entries carry `origin`. Mailbox setting changes and IMAP SUBSCRIBE and UNSUBSCRIBE write journal entries. IMAP sessions ignore the new entry kinds.
- The new indexes, among them `by_root` on `messages` and `archived` and `user_idate` on `messages`, are created at start up. Build the large ones ahead of time on a big cluster, see [Indexes](#indexes).
- The journal TTL comes from the `const:journal:time` setting (default unchanged at 3 hours).
- `jmap` is a new application password scope and can be listed in `disabledScopes`.
- IMAP advertises `OBJECTID`.
- Autoreplies (also those sent by the Haraka plugin) answer only mail that names the user in a recipient header (To, Cc and the like, RFC 3834 2): mail that reaches the user only as a Bcc or through a list gets no autoreply. The user's addresses, their alias domains, wildcards and `fromWhitelist` count as the user.
- Every change notification makes one extra Redis call to check whether the user has a verified Web Push subscription.
- Temporary uploads live in the storage bucket with `metadata.expires`; the REST storage API does not list them, and the garbage collector removes expired ones.
- Deleting a user through the REST API takes the user's mail out of the outbound queue: mail held for a later send time (REST `sendTime`, JMAP `FUTURERELEASE`) and mail sent during the last day that is still retried. Entries being delivered at that moment are left alone. A restored user does not get that mail back, the stored copy stays in the mailbox.
- Address changes and autoreply changes through the REST API, and address register updates on the mail path, feed the JMAP change logs of identities, participant identities, the VacationResponse and the register address book. This happens only in processes where `[jmap] enabled` is true, and only for users that have used JMAP.

### Root repair

JMAP Email ids are message roots. Messages stored by old versions may lack a root, and IMAP copies made before this release share the root of their original. `ensureUserRoots` (`lib/message-roots.js`) fills missing roots and gives every legacy copy a root of its own (the oldest document keeps the shared root; a shared root must persist for a settle delay so a move in progress is not mistaken for a copy). It runs once per user and records `rootsChecked` in the user's `jmap.state` document.

The JMAP service runs it for a user on first Email access. To do it for every user ahead of time, enable the migration in `config/migrations.toml`:

```toml
[database.messagesRootRepair]
enabled = true
# pause after each repaired user, in milliseconds
throttleMs = 100
# how long a shared root must persist before it is treated as a legacy copy
settleMs = 2000
```

Migrations run in the `run-migrations` task, which the task runner queues at start. The migration walks every user (through the INBOX entries of the `user_path` index), skips users already checked and can be interrupted: the next run continues with the users not yet done. It runs while the system is in use. Turn it off again once it has finished, so later starts do not walk the users list. Until a user is repaired, lookups also match documents without a root by `_id`, which costs about half again as much at 500 ids (see [performance notes](../jmap/performance.md)).

### Journal retention

The change history of Email, Thread and Mailbox is the existing change journal. A client that was offline longer than the journal retention gets `cannotCalculateChanges` and downloads its state again, so the retention decides how long a client may stay offline before a full resynchronisation. The default is 3 hours, as before.

The retention is the setting `const:journal:time`, in milliseconds, at least one hour:

```bash
curl -X POST http://127.0.0.1:8080/settings/const:journal:time \
  -H 'Content-Type: application/json' \
  -d '{"value": 604800000}'
```

The JMAP service reads the new value within `changes.retentionCacheTime` seconds. The TTL index `journal_autoexpire` is changed in place with `collMod` at the next start (no index rebuild). The retention applies to every user, and the journal grows in proportion to it: measure entries per day with `scripts/jmap/measure-production.js` before choosing a long retention. On a cluster writing about 600,000 journal entries an hour, 24 hours of retention takes about 6.5 GB, 72 hours about 19 GB, all on the primary shard because the journal is not sharded; 24 hours is a good start (see `docs/jmap/performance.md`). Owned types (identities, submissions, contacts, calendars) keep their own tombstones for 30 days independently of this setting.

### Indexes

The JMAP indexes are part of `indexes.yaml` and are created at start up like every other index, whether or not `[jmap] enabled` is true, so the service can be enabled later without an index build. Set `enabled` the same way in every WildDuck process: it decides whether REST API address and autoreply changes are recorded in the JMAP change logs.

On existing collections, these three can take a long time on a large cluster, and the start up index setup waits for each build to finish:

| Collection | Index        | Key                             | Options                                            |
| ---------- | ------------ | ------------------------------- | -------------------------------------------------- |
| `messages` | `by_root`    | `{root: 1}`                     | `partialFilterExpression: {root: {$exists: true}}` |
| `archived` | `by_root`    | `{root: 1}`                     | `partialFilterExpression: {root: {$exists: true}}` |
| `messages` | `user_idate` | `{user: 1, idate: -1, _id: -1}` |                                                    |

Build them before deploying the release, through mongos on a sharded cluster or as a rolling index build per replica set, with exactly these names, keys and options, so the start up check finds them and does nothing:

```js
db.messages.createIndex({ root: 1 }, { name: 'by_root', partialFilterExpression: { root: { $exists: true } } });
db.archived.createIndex({ root: 1 }, { name: 'by_root', partialFilterExpression: { root: { $exists: true } } });
db.messages.createIndex({ user: 1, idate: -1, _id: -1 }, { name: 'user_idate' });
```

`by_root` is a single field index because roots are globally unique; queries always add the user condition. JMAP also reads `user_messages_by_thread` and the `by_idate` indexes, so these must not be dropped.

The other new indexes are on new collections, on `addressregister` (`user_modseq`, partial, empty until JMAP writes it) and on `storage.files` for temporary uploads (`user_temporary_files`, `temporary_files_expiry`, partial), and are cheap to build at start up.

### New collections

All in the main database, named with a prefix: `jmap.` for JMAP bookkeeping, `contacts.` and `calendars.` for contact and calendar data, which is not tied to JMAP. Every one is removed for a user by the user delete task once the restore window has passed (`lib/jmap/account-data.js`), together with the user's temporary uploads.

| Collection            | Content                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `jmap.state`          | One document per user: journal and delivery anchors, owned type sequences, `rootsChecked`         |
| `jmap.changes`        | Tombstones of the owned types, expire after 30 days (TTL index `entry_autoexpire`)                |
| `jmap.identities`     | Identity fields not stored on addresses (name override, replyTo, bcc, signatures)                 |
| `jmap.submissions`    | EmailSubmission records, removed after `submission.retention` (TTL index `submission_autoexpire`) |
| `jmap.push`           | PushSubscription records (TTL index `push_autoexpire`)                                            |
| `jmap.participants`   | ParticipantIdentity ids and change sequence, derived from the addresses                           |
| `contacts.books`      | Address books                                                                                     |
| `contacts.cards`      | Contact cards, stored as JSON text plus the fields queries and limits need                        |
| `contacts.media`      | Media of contact cards                                                                            |
| `calendars.calendars` | Calendars                                                                                         |
| `calendars.events`    | Events, with instance bounds, search text and the next alert time (`alertAt`)                     |

### Capacity

**Redis**, besides what IMAP and the REST API already use:

| Key                                                                    | Use                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jmap:qc:<user>`, `jmap:qco:<user>`                                    | Query cache hashes, up to `queryCache.maxBytes` (1 MB) each, `queryCache.ttl` (10 minutes) after the last write. The largest JMAP user of Redis memory: plan for active JMAP users times the budget |
| `jmap:auth:<hmac>`                                                     | Authentication cache entry per credential, `auth.cacheTtl`                                                                                                                                          |
| `jmap:conc:<user>`, `jmap:upc:<user>`                                  | Requests and uploads in flight                                                                                                                                                                      |
| `lim:jmap-eventsource`                                                 | Open event streams per user                                                                                                                                                                         |
| `jmap:mbc:<mailbox>`                                                   | Cached thread counts of a mailbox, 24 hours                                                                                                                                                         |
| `jmap:push:users`, `jmap:push:due`, `jmap:push:synced`                 | Users with verified push subscriptions, users due for a push, the resync marker                                                                                                                     |
| `jmap:push:lock:<id>`, `jmap:push:dirty:<id>`, `jmap:push:rate:<user>` | Per subscription send lock and pending states, subscription creation rate                                                                                                                           |
| `jmap:alert:push:<user>`, `jmap:alert:mail:<user>`                     | Alert rate counters                                                                                                                                                                                 |
| `jmap:calendar:alerts:lock`, `jmap:submissions:poll`                   | Locks of the alert scheduler and the submission poller                                                                                                                                              |
| `wd:bull:jmap_push:*`                                                  | The BullMQ queue `jmap_push`                                                                                                                                                                        |

**Background work** in the JMAP workers:

- **Submission poller**: one worker at a time (Redis lock) checks due pending EmailSubmissions against the outbound queue every `submission.pollInterval` seconds, at most 500 per run, with a growing delay per submission.
- **Alert scheduler**: one worker at a time reads due events on the `alert_due` index every `alerts.interval` seconds, in batches of 500, and claims each event with a conditional update.
- **Push delivery**: every JMAP worker claims due users and processes the `jmap_push` queue with `push.concurrency` parallel requests. A worker at a time re-adds every user with a verified subscription to `jmap:push:users` once an hour, as a safety net after Redis data loss.
- **Event streams**: one notifier listener per open stream; states are read only when a change for the user arrives. `eventSource.maxStreams` bounds the streams per user.
- **Garbage collection** (task runner): expired temporary uploads are removed with the other expired data.

### Monitoring

With `[metrics]` enabled, the service reports under the label `service="jmap"` (or `source="jmap"`):

| Metric                                                                                               | JMAP part                                                                         |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `wildduck_service_up{service="jmap"}`                                                                | 1 while the listener is up                                                        |
| `wildduck_auth_attempts_total{service="jmap"}`                                                       | Basic authentication results (`success`, `fail`, `ratelimited`, `error`) by scope |
| `wildduck_message_operations_total{source="jmap"}`, `wildduck_message_size_bytes{source="jmap"}`     | Messages stored through JMAP (Email/set, Email/import, email alerts)              |
| `wildduck_bullmq_jobs{queue="jmap_push"}`, `wildduck_bullmq_jobs_processed_total{queue="jmap_push"}` | Push queue depth and results                                                      |
| `wildduck_journal_entries_total`                                                                     | Journal growth, which a longer retention keeps longer                             |

There are no per method request metrics. Every response writes one access log line (`JMAP` prefix) with the HTTP method, path, status, user id, a request id, the JMAP method names, the method error types and the time in milliseconds. It contains no credentials and no content. Watch for `serverUnavailable` errors (queries over `queryTimeout`), `cannotCalculateChanges` rates after changing the retention, 429 answers (concurrency, event stream and lockout limits), the size of the `journal` collection and of the `by_root` indexes, and Redis memory.

## Testing

The scenario tests live in `test/jmap/` and run against the test server with `npm run test:jmap`; each test is a scenario of the catalogue in `test/jmap/catalogue/`. `npm run test:jmap:coverage` also checks that every scenario of a finished work package passed. The two external suites run with `npm run test:jmap:jmapio` and `npm run test:jmap:fastmail` and are compared with their expectation files. See `test/jmap/README.md` and `test/jmap/external/README.md`.
