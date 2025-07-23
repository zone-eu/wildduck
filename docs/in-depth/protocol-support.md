# E-Mail Protocol support

WildDuck IMAP server supports the following IMAP standards:

-   The entire **IMAP4rev1** suite with some minor differences from the spec. See below for [IMAP Protocol Differences](#imap-protocol-differences) for a complete
    list
-   **IDLE** ([RFC2177](https://tools.ietf.org/html/rfc2177)) – notfies about new and deleted messages and also about flag updates
-   **CONDSTORE** ([RFC4551](https://tools.ietf.org/html/rfc4551)) and **ENABLE** ([RFC5161](https://tools.ietf.org/html/rfc5161)) – supports most of the spec,
    except metadata stuff which is ignored. See [CONDSTORE Extension](condstore-extension.md) for detailed implementation guide.
-   **STARTTLS** ([RFC2595](https://tools.ietf.org/html/rfc2595))
-   **NAMESPACE** ([RFC2342](https://tools.ietf.org/html/rfc2342)) – minimal support, just lists the single user namespace with hierarchy separator
-   **UNSELECT** ([RFC3691](https://tools.ietf.org/html/rfc3691))
-   **UIDPLUS** ([RFC4315](https://tools.ietf.org/html/rfc4315))
-   **SPECIAL-USE** ([RFC6154](https://tools.ietf.org/html/rfc6154))
-   **ID** ([RFC2971](https://tools.ietf.org/html/rfc2971))
-   **MOVE** ([RFC6851](https://tools.ietf.org/html/rfc6851))
-   **AUTHENTICATE PLAIN** ([RFC4959](https://tools.ietf.org/html/rfc4959)) and **SASL-IR**
-   **APPENDLIMIT** ([RFC7889](https://tools.ietf.org/html/rfc7889)) – maximum global allowed message size is advertised in CAPABILITY listing
-   **UTF8=ACCEPT** ([RFC6855](https://tools.ietf.org/html/rfc6855)) – this also means that WildDuck natively supports unicode email usernames. For example
    [андрис@уайлддак.орг](mailto:андрис@уайлддак.орг) is a valid email address that is hosted by a test instance of WildDuck
-   **QUOTA** ([RFC2087](https://tools.ietf.org/html/rfc2087)) – Quota size is global for an account, using a single quota root. Be aware that quota size does not
    mean actual byte storage in disk, it is calculated as the sum of the [RFC822](https://tools.ietf.org/html/rfc822) sources of stored messages.
-   **COMPRESS=DEFLATE** ([RFC4978](https://tools.ietf.org/html/rfc4978)) – Compress traffic between the client and the server

For advanced connection management features including onConnect/onClose handlers, see [Connection Management](connection-management.md).

WildDuck more or less passes the [ImapTest](https://www.imapwiki.org/ImapTest/TestFeatures) Stress Testing run. Common errors that arise in the test are
unknown labels (WildDuck doesn't send unsolicited `FLAGS` updates even though it does send unsolicited `FETCH FLAGS` updates) and sometimes NO for `STORE`
(messages deleted in one session can not be updated in another).

In comparison WildDuck is slower in processing single user than Dovecot. Especially when fetching messages, which is expected as Dovecot is reading directly
from filesystem while WildDuck is recomposing messages from different parts.

Raw read/write speed for a single user is usually not relevant anyway as fetching entire mailbox content is not something that happens often. WildDuck offers
better parallelization through MongoDB sharding, so more users should not mean slower response times. It is also more important to offer fast synchronization
speeds between clients (eg. notifications about new email and such) where WildDuck excels due to the write ahead log and the ability to push this log to
clients.

## POP3 Support

In addition to the required POP3 commands ([RFC1939](https://tools.ietf.org/html/rfc1939)) WildDuck supports the following extensions:

-   **UIDL**
-   **USER**
-   **PASS**
-   **SASL PLAIN**
-   **PIPELINING**
-   **TOP**

### POP3 command behaviors

All changes to messages like deleting messages or marking messages as seen are stored in storage only in the UPDATE stage (eg. after calling QUIT). Until then
the changes are preserved in memory only. This also means that if a message is downloaded but QUIT is not issued then the message does not get marked as _Seen_.

#### LIST

POP3 listing displays the newest 250 messages in INBOX (configurable)

#### UIDL

WildDuck uses message `_id` value (24 byte hex) as the unique ID. If a message is moved from one mailbox to another then it might _re-appear_ in the listing.

#### RETR

If a messages is downloaded by a client this message gets marked as _Seen_

#### DELE

If a messages is deleted by a client this message gets marked as Seen and moved to Trash folder

# Message filtering

WildDuck has built-in message filtering. This is somewhat similar to Sieve even though the filters are not scripts.

Filters can be managed via the [WildDuck API](https://docs.wildduck.email/api).

# IMAP Protocol Differences

This is a list of known differences from the IMAP specification. Listed differences are either intentional or are bugs that became features.

1.  `\Recent` flags is not implemented and most probably never will be (RFC3501 2.3.2.)
2.  `RENAME` does not touch subfolders which is against the spec (RFC3501 6.3.5\. _If the name has inferior hierarchical names, then the inferior hierarchical
    names MUST also be renamed._). WildDuck stores all folders using flat hierarchy, the "/" separator is fake and only used for listing mailboxes
3.  Unsolicited `FLAGS` responses (RFC3501 7.2.6.) and `PERMANENTFLAGS` are not sent (except for as part of `SELECT` and `EXAMINE` responses). WildDuck notifies
    about flag updates only with unsolicited FETCH updates.
4.  WildDuck responds with `NO` for `STORE` if matching messages were deleted in another session
5.  `CHARSET` argument for the `SEARCH` command is ignored (RFC3501 6.4.4.)
6.  Metadata arguments for `SEARCH MODSEQ` are ignored (RFC7162 3.1.5.). You can define `<entry-name>` and `<entry-type-req>` values but these are not used for
    anything
7.  `SEARCH TEXT` and `SEARCH BODY` both use MongoDB [\$text index](https://docs.mongodb.com/v3.4/reference/operator/query/text/) against decoded plaintext
    version of the message. RFC3501 assumes that it should be a string match either against full message (`TEXT`) or body section (`BODY`).
8.  What happens when FETCH is called for messages that were deleted in another session? _Not sure, need to check_
9.  **Autoexpunge**, meaning that an EXPUNGE is called on background whenever a messages gets a `\Deleted` flag set. This is not in conflict with IMAP RFCs.

Any other differences are most probably real bugs and unintentional.

# Other Differences

1. Messages retrieved from WildDuck might not be exact copies of messages that were initially stored. This mostly affects base64 encoded attachments and content in multipart mime nodes (eg. text like "This is a multi-part message in MIME format.")