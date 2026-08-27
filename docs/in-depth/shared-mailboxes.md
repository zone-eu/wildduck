# Shared Mailboxes (IMAP ACL)

WildDuck supports sharing mailboxes between users of the same server through the IMAP ACL extension
([RFC4314](https://tools.ietf.org/html/rfc4314)). Support is disabled by default and enabled in `imap.toml`:

```toml
[acl]
enabled = true
```

When enabled the IMAP server advertises the `ACL` and `RIGHTS=kxte` capabilities and the NAMESPACE response
announces all three [RFC2342](https://tools.ietf.org/html/rfc2342) namespaces. Mailboxes other users have
shared appear under the `Other Users/<username>/` hierarchy prefix, mailboxes of shared accounts (team
mailboxes) under the `Shared/<username>/` prefix.

## Rights

Rights follow RFC 4314. The owner of a mailbox always holds all rights and the rights of the owner can not be
modified or removed.

| Right | Name            | Grants                                                            |
| ----- | --------------- | ----------------------------------------------------------------- |
| `l`   | lookup          | mailbox is visible to LIST/LSUB, SUBSCRIBE                        |
| `r`   | read            | SELECT/EXAMINE the mailbox, STATUS, GETQUOTAROOT                  |
| `s`   | seen            | set or clear `\Seen`, also implicitly while fetching message text |
| `w`   | write           | set or clear flags other than `\Seen` and `\Deleted`              |
| `i`   | insert          | APPEND and COPY/MOVE messages into the mailbox                    |
| `p`   | post            | accepted and stored, but has no effect                            |
| `k`   | create          | CREATE sub-mailboxes, parent of the new name in RENAME            |
| `x`   | delete mailbox  | DELETE the mailbox, old name in RENAME                            |
| `t`   | delete messages | set or clear `\Deleted`                                           |
| `e`   | expunge         | EXPUNGE, also as part of CLOSE and MOVE                           |
| `a`   | administer      | SETACL, DELETEACL, GETACL, LISTRIGHTS                             |

The obsolete [RFC2086](https://tools.ietf.org/html/rfc2086) virtual rights are supported for compatibility:
in SETACL input `c` expands to `kx` and `d` expands to `te`, and ACL, MYRIGHTS and LISTRIGHTS responses
include the virtual `c` and `d` rights whenever a member right of theirs is present.

ACL identifiers are usernames of existing users on the same server. Group identifiers, `anyone` and negative
rights are not supported. Users without any rights for a mailbox can not detect its existence: such mailboxes
behave exactly like missing ones.

## Managing grants

Over IMAP with the standard commands:

```
C: A1 SETACL INBOX kati lrs
C: A2 GETACL INBOX
S: * ACL "INBOX" "andris" "lrswipkxtea" "kati" "lrs"
C: A3 DELETEACL INBOX kati
```

`SETACL` accepts `+rights` and `-rights` modifiers to add or remove rights from an existing entry. Granting an
empty rights string removes the entry.

Over the HTTP API with the `acl` role resource:

-   `GET /users/{user}/acl` – list every grant the user has given on their mailboxes
-   `GET /users/{user}/acl/shared` – list every mailbox shared with the user, with the rights held and the
    path in the shared namespace
-   `GET /users/{user}/mailboxes/{mailbox}/acl` – list grants of a mailbox
-   `PUT /users/{user}/mailboxes/{mailbox}/acl` – create or replace a grant (`{"identifier": "kati", "rights": "lrs"}`)
-   `DELETE /users/{user}/mailboxes/{mailbox}/acl/{grantee}` – remove a grant

Grants are stored in the `mailboxacls` collection, keyed by mailbox and grantee. No data migration is needed to
enable or disable the feature: with ACL disabled existing grants stay dormant, and nodes running without ACL
support ignore grants entirely, so mixed version deployments fail closed (sharing is unavailable, never wrongly
granted).

## Team mailboxes

A team mailbox is a mailbox of a shared account: a regular account flagged with `shared` at creation
(`POST /users` with `{"shared": true}`) that can never authenticate, on any protocol and with any
credential. Shared accounts require an email address, can not have a password and the flag can not be
changed later. Everything else works like for any other account: mail sent to the addresses of the
account is delivered into its INBOX, quota, encryption and retention apply as usual and the account is
removed with the regular user deletion, which also removes every grant it was involved in.

Mailboxes of shared accounts are exposed under the `Shared/<username>/` prefix instead of
`Other Users/<username>/` and report the quota root `Shared/<username>`. The namespace always matches
the kind of the account: a team mailbox can not be reached through the other users namespace and vice
versa, mismatched paths behave exactly like missing mailboxes.

Since nobody can log in as the account itself, the first grant of a fresh team mailbox is seeded over
the HTTP API (`PUT /users/{user}/mailboxes/{mailbox}/acl`). Users holding the `a` right manage further
grants over IMAP as usual. Shared accounts can not be grantees: granting rights _to_ a shared account
is rejected exactly like granting to an unknown user.

Sending mail _as_ the team address is not part of the IMAP ACL feature: message submission policy is
enforced by the outbound MTA (ZoneMTA), which validates the From: address against the addresses of the
authenticated user.

## Tenant separation

WildDuck deployments commonly host unrelated customers on one server. Sharing is therefore scoped by tenant,
configured with `scope` in the `[acl]` section:

-   **`domaingroup`** (the default) – users may only share mailboxes when the domains of their primary
    addresses match or belong to the same domain group. Users without a primary address can not participate in
    sharing at all.
-   **`server`** – all users of the server may share with each other. Only use this for single organization
    deployments.

Domain groups bundle the domains of one customer into a single tenant. A domain can belong to one group only.
Groups are managed with the `domaingroups` role resource over the HTTP API:

-   `GET /domaingroups` – list group entries, optionally filtered with `?group=`
-   `POST /domaingroups` – add a domain to a group (`{"group": "acme", "domain": "acme-corp.com"}`)
-   `DELETE /domaingroups/{domain}` – remove a domain from its group

The scope is enforced both when rights are granted and whenever grants are resolved: tightening the scope or
removing a domain from a group immediately hides existing grants that now cross the boundary. Users outside the
tenant scope are indistinguishable from users that do not exist, so grant management can not be used to probe
which usernames exist on the server.

## Semantics and limitations

-   **Seen state is shared.** WildDuck stores `\Seen` per message, so one user reading a message marks it read
    for everyone using the mailbox. Withhold the `s` right to keep a user's reading from changing seen state:
    without `s` fetching message content does not set `\Seen`.
-   **Quota follows the owner.** Messages appended, copied or moved into a shared mailbox are checked against and
    charged to the quota of the mailbox owner. Shared mailboxes report the quota root `Other Users/<username>`
    (`Shared/<username>` for team mailboxes), which can be queried with GETQUOTA by any user holding at least
    one grant from that owner.
-   **Encryption follows the owner, and only ever uses public keys.** Messages stored into a shared mailbox of a
    user with `encryptMessages` enabled are encrypted with the owner's public key. Messages that are already
    encrypted (PGP or S/MIME, whether by WildDuck or by the original sender) are transferred byte for byte: the
    server holds no private keys and can never decrypt or re-encrypt, so such messages stay readable only to the
    original key holder. Consequently, sharing an encrypted mailbox shares ciphertext.
-   **Moving between accounts is copy and expunge.** MOVE where source and destination belong to different users
    copies the messages into the target (with quota transfer and target encryption policy) and then expunges the
    source messages without archiving them.
-   **Flags are filtered by rights.** STORE ignores flag changes the user has no right for and only fails when
    nothing is permitted. Replacing the flag list preserves flag classes the user may not modify. APPEND and COPY
    silently drop flags the user has no right to set in the target mailbox.
-   **Created sub-mailboxes inherit grants.** A mailbox created inside a shared hierarchy belongs to the account
    owner and inherits all ACL entries of its parent.
-   **Subscriptions are personal.** SUBSCRIBE and UNSUBSCRIBE of a shared mailbox only affect the subscription
    state of the grantee, stored on the ACL entry.
-   **Revocation disconnects.** Removing rights from a user kicks their active sessions out of the mailbox, as
    does deleting a shared mailbox.
-   **MOVE between mailboxes of the same owner keeps flags.** [RFC6851](https://tools.ietf.org/html/rfc6851)
    defines MOVE as flag preserving; the RFC 4314 flag dropping rules apply to COPY, APPEND and to moves that
    cross accounts (which are internally a copy).
-   **CREATE in a shared hierarchy requires the immediate parent** to exist with the `k` right. This is
    stricter than RFC 4314, which only requires rights on the nearest existing parent.
-   **Personal folders literally named `Other Users/...` or `Shared/...`** become unreachable while ACL
    support is enabled, as the namespace prefixes take over. Rename such folders before enabling.
-   **POP3 is unaffected.** POP3 only ever exposes the INBOX of the authenticated user.
-   Changes made through the HTTP API notify the sessions of the mailbox owner but not of other users sharing
    the mailbox; changes made over IMAP notify everyone. Haraka and ZoneMTA hosts must run this fork's library
    version, otherwise users of shared mailboxes do not receive real time notifications for incoming mail.
