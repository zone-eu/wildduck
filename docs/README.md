# WildDuck Mail Server

WildDuck is a scalable no-SPOF IMAP/POP3 mail server. WildDuck uses a distributed database (sharded + replicated MongoDB) as a backend for storing all data,
including emails.

WildDuck tries to follow Gmail in product design. If there's a decision to be made then usually the answer is to do whatever Gmail has done.

## Recent Enhancements

WildDuck has been enhanced with several new features for improved connection management and protocol support:

- **[Connection Management](in-depth/connection-management.md)** - Advanced onConnect and onClose handlers for IMAP and POP3 servers, enabling custom connection filtering, rate limiting, and monitoring
- **[CONDSTORE Extension](in-depth/condstore-extension.md)** - Full RFC 4551 CONDSTORE implementation for efficient email synchronization with conditional STORE operations
- **Smart POP3 Timeout Handling** - Automatic timeout reset during active command processing to prevent unexpected disconnections

## Contact

[![Gitter chat](https://img.shields.io/gitter/room/nodemailer/wildduck?color=orange)](https://gitter.im/nodemailer/wildduck)

## Requirements

-   _MongoDB_ to store all data
-   _Redis_ for pubsub and counters
-   _Node.js_ at least version 10.0.0

**Optional requirements**

-   Redis Sentinel for automatic Redis failover
-   Build tools to install optional dependencies that need compiling

WildDuck can be installed on any Node.js compatible platform.

## No-SPOF architecture

Every component of the WildDuck mail server can be replicated which eliminates potential single point of failures.

![](https://raw.githubusercontent.com/zone-eu/wildduck/master/assets/wd.png)

## Storage

Attachment de-duplication and compression gives up to 56% of storage size reduction.

![](https://raw.githubusercontent.com/zone-eu/wildduck/master/assets/storage.png)

## Goals of the Project

1.  Build a scalable and distributed IMAP/POP3 server that uses clustered database instead of single machine file system as mail store
2.  Allow using internationalized email addresses
3.  Provide Gmail-like features like pushing sent messages automatically to Sent Mail folder or notifying about messages moved to Junk folder so these could be
    marked as spam
4.  Provide parsed mailbox and message data over HTTP. This should make creating webmail interfaces super easy, no need to parse RFC822 messages to get text
    content or attachments

## Future considerations

-   Optimize FETCH queries to load only partial data for BODY subparts
-   Parse incoming message into the mime tree as a stream. Currently the entire message is buffered in memory before being parsed.
-   Maybe allow some kind of message manipulation through plugins
-   WildDuck does not plan to be the most feature-rich IMAP client in the world. Most IMAP extensions are useless because there aren't too many clients that are
    able to benefit from these extensions. There are a few extensions though that would make sense to be added to WildDuck:

    -   IMAP4 non-synchronizing literals, LITERAL- ([RFC7888](https://tools.ietf.org/html/rfc7888)). Synchronized literals are needed for APPEND to check mailbox
        quota, small values could go with the non-synchronizing version.
    -   LIST-STATUS ([RFC5819](https://tools.ietf.org/html/rfc5819))
    -   _What else?_ (definitely not NOTIFY nor QRESYNC)

## License

WildDuck Mail Agent is licensed under the [European Union Public License 1.2](https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12) or later.