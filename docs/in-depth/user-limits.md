# Per-user limits

Administrators can set these fields through `POST /users` and `PUT /users/:user`. Ordinary users cannot change their own allowances. Missing fields and `0` inherit the deployment default.

| User field | Deployment fallback | Enforcement |
| --- | --- | --- |
| `maxMailboxes` | `const:max:mailboxes`, then `MAX_MAILBOXES` (1500) | Existing mailbox creation count check |
| `maxLabels` | `MAX_LABELS` (5000) | Custom label allocation |
| `maxRecipientsPerMessage` | `const:max:rcpt_to`, then `MAX_RCPT_TO` (400) | Envelope recipients when submitting mail |
| `maxApplicationPasswords` | `const:asp:limit`, then `MAX_ASP_COUNT` (50) | Application password creation |
| `maxMcpTokens` | `MAX_MCP_TOKEN_COUNT` (50) | Personal MCP token creation, interactive sessions are separate |
| `autoreplyInterval` | `const:autoreply:interval`, then `MAX_AUTOREPLY_INTERVAL` (4 hours) | Per-sender autoreply history and its expiry, in milliseconds |
| `apiMaxDownload` | `const:max:api:download`, then `MAX_API_DOWNLOAD` (0, unlimited) | API attachment and uploaded-file response bytes per 24 hours |

Positive count overrides replace deployment defaults. Label allocation remains capped at `MAX_LABELS`, and the existing global message-size ceiling still applies. IMAP APPEND, LMTP, HTTP parsers and multipart/schema byte limits retain their deployment-wide ceilings.

`GET /users/:user` returns configured fields at the top level. Resolved allowances appear under `limits.<field>.allowed`, except the protocol-style API traffic entry is named `limits.apiDownload`. Mailbox, label, application password, and MCP token entries also include `used`. API traffic includes `allowed`, `used` and `ttl` (remaining seconds, or `false` without an active window).

## API attachment download allowance

Set `apiMaxDownload` in bytes, for example:

```json
{ "apiMaxDownload": 1073741824 }
```

The deployment default is `const:max:api:download`. A zero user value inherits it. A zero deployment setting disables this traffic allowance. The deployment default is zero, preserving unlimited API downloads until an allowance is configured.

The following endpoints share one allowance for the content owner, including requests made with administrator credentials:

- `GET /users/:user/mailboxes/:mailbox/messages/:message/attachments/:attachment`
- `GET /users/:user/storage/:file`

Accounting runs after MIME/charset decoding and measures response-body bytes admitted to the response stream, not encoded storage bytes or TCP/TLS overhead. Redis key `adw:<userId>` expires 86400 seconds after the first charged chunk. Changing an allowance preserves usage and the existing window.

A Redis script atomically checks and spends each chunk across workers and concurrent downloads. Refused chunks are not charged. Known-length files that cannot fit are rejected before opening storage. Exhausted requests return HTTP 429 with `ApiDownloadLimitExceeded` and allowance/usage/TTL details. If capacity is consumed by another download or exhausted while decoding an unknown-length body, the stream fails. After response headers have been sent, this appears as an interrupted download. Completed chunks remain charged on disconnect or storage failure. Accounting failure stops delivery rather than allowing unmetered traffic.

Raw `.eml` downloads, message JSON/text, data exports, and non-API protocols are outside this allowance. They retain their existing behavior. It is an API attachment quota, not a deployment-wide egress budget.

## Autoreplies

Sender-history comparisons and Redis `PEXPIRE` use the configured interval in milliseconds. The independent daily reply cap now uses `MAX_AUTOREPLIES` (2000) with the existing 24-hour counter. Changing the per-sender interval does not change that daily cap. Existing sender-history keys adopt the corrected expiry when next touched.
