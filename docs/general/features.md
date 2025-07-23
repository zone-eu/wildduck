# What are the killer features?

1.  **Stateless.** Start as many instances as you want. You can start multiple WildDuck instances in different machines and as long as they share the same
    MongoDB and Redis settings, users can connect to any instances. This is very different from the traditional IMAP servers where a single user always needs to
    connect (or be proxied) to the same IMAP server. WildDuck keeps all required state information in MongoDB, so it does not matter which IMAP instance you
    use.
2.  **Scalable** as WildDuck uses sharded MongoDB cluster for the backend storage. If you're running out of space, add a new shard.
3.  **No SPOF.** You can run multiple instances of every required service.
4.  **Centralized authentication** which allows modern features like 2FA, application specific passwords, authentication scopes, revoking authentication tokens,
    audit logging and even profile files to auto-configure Apple email clients without master password
5.  **Works on any OS including Windows.** At least if you get MongoDB and Redis running first.
6.  Focus on **internationalization**, ie. supporting email addresses with non-ascii characters
7.  **Deduplication of attachments.** If the same attachment is referenced by different messages then only a single copy of the attachment is stored.
8.  Access messages both using **IMAP and [HTTP API](https://docs.wildduck.email/api)**. The latter serves parsed data, so no need to fetch RFC822 messages and parse
    out html, plaintext content or attachments. It is super easy to create a webmail interface on top of this.
9.  Built in **address labels**: _username+label@example.com_ is delivered to _username@example.com_
10. Dots in usernames and addresses are informational only. username@example.com is the same as user.name@example.com
11. **HTTP Event Source** to push modifications in user email account to browser for super snappy webmail clients
12. **Super easy to tweak.** The entire codebase is pure JavaScript, so there's nothing to compile or anything platform specific. If you need to tweak something
    then change the code, restart the app and you're ready to go. If it works on one machine then most probably it works in every other machine as well.
13. **Better disk usage**. Attachment deduplication and MongoDB compression yield in about 40% smaller disk usage as the sum of all stored email sizes.
14. **Extra security features** like automatic GPG encryption of all stored messages or authenticating with U2F
15. **Exposed logs.** Users have access to logs concerning their account such as authentication attempts and other changes.
16. **Advanced Connection Management.** Both IMAP and POP3 servers support onConnect and onClose handlers for custom connection filtering, rate limiting, IP blocking, and monitoring. Implement sophisticated access control and connection management without modifying core server code.
17. **Smart POP3 Timeout Handling.** POP3 connections automatically reset timeouts during active command processing, preventing unexpected disconnections while maintaining security for idle connections. Ensures reliable operation for legitimate email clients.
18. **CONDSTORE Extension Support.** Full RFC 4551 compliance with CONDSTORE (Conditional STORE) extension for enhanced synchronization. Supports ENABLE CONDSTORE, STORE/UID STORE with UNCHANGESINCE modifier, and MODIFIED response codes for conflict detection and efficient email client synchronization.
