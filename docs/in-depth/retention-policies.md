# Retention policies

Wild Duck IMAP server has retention support built in. This means that messages that have been stored in a mailbox for a defined amount of time are deleted automatically.

All Spam and Trash folders have a maximum retention time set to 30 days, other folders do not have retention time set by default.You can set the retention time when creating users via HTTP API using the `retention` property. It is a numeric field that if set, causes all mailboxes of the user to have a retention time of the value in milliseconds.

Once retention time is reached, the message is deleted from database and attachment references are decremented.

> Spam and Trash folders can not have longer than 30 days of retention, so if you use a larger value it is capped at 30 days

For example if you want to have a default retention policy of 90 days, then use `7776000000` as the retention value (90 * 24 * 3600 * 1000). If defined then this value also applies to any new folders the user creates.

```
curl -XPOST "http://localhost:8080/user" -H 'content-type: application/json' -d '{
  "username": "testuser",
  "password": "secretpass",
  "retention": 7776000000
}'
```

You can change the retention with the [Mailbox Update](https://github.com/wildduck-email/wildduck/wiki/API-Docs#update-mailbox-details) API. Updating retention policy for a mailbox does not change retention time for existing messages, it only applies to new messages.

### How does it work?

All Wild Duck instances (this means processes) periodically try to get a [lock](https://www.npmjs.com/package/redfour) for cleaning up expired messages. If a lock is acquired then this instance starts cleanup process by creating a cursor to list all messages that have retention time set older than current time. This cursor is then used to delete expired messages one by one. This also means that a message might be available a bit longer than retention time, it is not deleted exactly the time retention time kicks in but sometime later (in most cases within a minute).

A lot of things happen when a message is deleted:

  * the message entry is removed from the messages collection
  * IMAP clients are notified about the expunged message
  * Quota usage counter is updated in users collection
  * Reference counters for linked attachments are decremented (attachments in Wild Duck are de-duplicated which means that only the first copy of an identical attachment is stored in database)

A separate process then finds all attachments that have zero references and deletes these.
