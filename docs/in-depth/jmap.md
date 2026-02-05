# JMAP Support in WildDuck

This document describes the JMAP (JSON Meta Application Protocol) support implemented in WildDuck. JMAP is a modern, efficient protocol for email client-server communication, defined in [RFC 8620](https://www.rfc-editor.org/rfc/rfc8620.html) (JMAP Core) and [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621.html) (JMAP for Mail).

## Implementation Status

WildDuck implements JMAP with the following features:

### Core Endpoints
- **Discovery**: `/.well-known/jmap` - RFC 8620 compliant discovery endpoint
- **Session**: `GET /jmap` - Session resource with capabilities and URLs
- **API**: `POST /jmap` - Main JMAP dispatcher for method calls
- **Upload**: `POST /jmap/upload` - Blob upload endpoint for attachments

### Implemented JMAP Methods

#### Mailbox Methods
- **Mailbox/get** - Retrieve mailbox information with counts, roles, and permissions
- **Mailbox/set** - Create, update, and delete mailboxes

#### Email Methods
- **Email/query** - Search and filter emails with support for:
  - Mailbox filters (`inMailbox`)
  - Keyword filters (`hasKeyword`, `notKeyword`)
  - Text search (`text`, `subject`)
   - Sorting (by `receivedAt`, `sentAt`, `subject`, `size`)
  - Pagination (`position`, `limit`)
  
- **Email/get** - Fetch full email details with all JMAP properties:
  - Standard properties: `id`, `blobId`, `threadId`, `mailboxIds`, `keywords`, `size`
  - Header properties: `subject`, `from`, `to`, `cc`, `bcc`, `replyTo`, `messageId`, `sentAt`, `receivedAt`
  - Body properties: `bodyValues`, `textBody`, `htmlBody`, `preview`
  - Attachment properties: `attachments`, `hasAttachment`
  - Property filtering support via `properties` parameter

- **Email/set** - Modify emails with support for:
  - Update keywords (flags): `$seen`, `$flagged`, `$answered`, `$draft`
  - Move between mailboxes via `mailboxIds`
  - Destroy (delete) messages
  - Full JMAP keyword format plus legacy flag operations

- **Email/changes** - Track email changes since a state with deterministic changelog
  - Returns `created`, `updated`, and `destroyed` arrays
  - Reliable state-based synchronization
  - Backed by Redis changelog with MongoDB archival

- **Email/send** - Send emails with full attachment support
  - Supports blob references via `blobId`
  - Direct attachment upload and send

### Additional Features
- **Authentication**: Bearer tokens (recommended) and HTTP Basic auth
- **Blob Storage**: GridFS-based attachment storage with blob references
- **Push Notifications**: SSE (Server-Sent Events) integration at `/users/:user/updates`
- **State Management**: Deterministic per-account state tokens
- **Changelog**: Redis-backed with automatic MongoDB archival and compaction

---

## Quick Start

### 1. Enable JMAP

Edit `config/jmap.toml` or include it in your `config/default.toml`:

```toml
enabled = true
basePath = "/jmap"
wellKnown = true
auth = ["bearer", "basic"]
maxUploadMB = 25
maxConcurrentRequests = 4

[push]
sse = true

# Changelog settings
changelogKeep = 1000  # Keep last 1000 entries in Redis per user
```

### 2. Authentication

#### Bearer Token (Recommended)
```bash
# Get a token (using WildDuck's auth endpoint)
curl -X POST https://example.com/authenticate \
  -H "Content-Type: application/json" \
  -d '{"username":"user@example.com","password":"secret","scope":"master","protocol":"API"}'

# Use the token
curl https://example.com/jmap \
  -H "Authorization: Bearer <token>"
```

#### Basic Auth
```bash
curl https://example.com/jmap \
  -u "username:password"
```

### 3. Discovery

```bash
curl https://example.com/.well-known/jmap

# Response:
{
  "success": true,
  "apiUrl": "https://example.com/jmap",
  "capabilities": {
    "urn:ietf:params:jmap:core": {},
    "urn:ietf:params:jmap:mail": {}
  }
}
```

### 4. Get Session

```bash
curl https://example.com/jmap \
  -H "Authorization: Bearer <token>"

# Response includes:
{
  "username": "<userId>",
  "accounts": {
    "<accountId>": {
      "name": "<userId>",
      "isPrimary": true,
      "accountCapabilities": {}
    }
  },
  "primaryAccounts": {
    "urn:ietf:params:jmap:mail": "<accountId>"
  },
  "capabilities": {
    "urn:ietf:params:jmap:core": {},
    "urn:ietf:params:jmap:mail": {}
  },
  "apiUrl": "https://example.com/jmap",
  "downloadUrl": "https://example.com/users/:user/storage/:file",
  "uploadUrl": "https://example.com/jmap/upload",
  "eventSourceUrl": "https://example.com/users/:user/updates",
  "state": "1234567890",
  "maxUploadSize": 26214400
}
```

---

## JMAP Method Examples 📨

All JMAP methods are called by POSTing to `/jmap` with a JSON body containing `methodCalls`:

```json
{
  "methodCalls": [
    ["Method/name", { arguments }, "callId"]
  ]
}
```

### List Mailboxes

**Request:**
```json
{
  "methodCalls": [
    ["Mailbox/get", {}, "m1"]
  ]
}
```

**Response:**
```json
{
  "methodResponses": [
    ["Mailbox/get", {
      "accountId": "<userId>",
      "state": "1234567890",
      "list": [
        {
          "id": "mailboxId1",
          "name": "Inbox",
          "parentId": null,
          "role": "inbox",
          "sortOrder": 0,
          "totalEmails": 42,
          "unreadEmails": 5,
          "totalThreads": 42,
          "unreadThreads": 5,
          "myRights": {
            "mayReadItems": true,
            "mayAddItems": true,
            "mayRemoveItems": true,
            "maySetSeen": true,
            "maySetKeywords": true,
            "mayCreateChild": true,
            "mayRename": false,
            "mayDelete": false,
            "maySubmit": true
          },
          "isSubscribed": true
        }
      ],
      "notFound": []
    }, "m1"]
  ],
  "sessionState": "1234567890"
}
```

### Query Emails

**Request (all emails in mailbox):**
```json
{
  "methodCalls": [
    ["Email/query", {
      "filter": { "inMailbox": "mailboxId1" },
      "sort": [{ "property": "receivedAt", "isAscending": false }],
      "position": 0,
      "limit": 50
    }, "q1"]
  ]
}
```

**Request (unread emails):**
```json
{
  "methodCalls": [
    ["Email/query", {
      "filter": {
        "inMailbox": "mailboxId1",
        "notKeyword": "$seen"
      },
      "limit": 20
    }, "q2"]
  ]
}
```

**Request (search by subject):**
```json
{
  "methodCalls": [
    ["Email/query", {
      "filter": {
        "subject": "invoice"
      }
    }, "q3"]
  ]
}
```

**Response:**
```json
{
  "methodResponses": [
    ["Email/query", {
      "accountId": "<userId>",
      "queryState": "1234567890",
      "canCalculateChanges": true,
      "position": 0,
      "ids": ["msgId1", "msgId2", "msgId3"],
      "total": 42,
      "limit": 50
    }, "q1"]
  ],
  "sessionState": "1234567890"
}
```

### Get Email Details

**Request:**
```json
{
  "methodCalls": [
    ["Email/get", {
      "ids": ["msgId1", "msgId2"],
      "properties": ["id", "subject", "from", "to", "receivedAt", "preview", "hasAttachment", "keywords"]
    }, "e1"]
  ]
}
```

**Response:**
```json
{
  "methodResponses": [
    ["Email/get", {
      "accountId": "<userId>",
      "state": "1234567890",
      "list": [
        {
          "id": "msgId1",
          "blobId": "msgId1",
          "threadId": "threadId1",
          "mailboxIds": { "mailboxId1": true },
          "keywords": { "$seen": true, "$flagged": false },
          "size": 4567,
          "receivedAt": "2026-02-01T10:30:00Z",
          "sentAt": "2026-02-01T10:29:45Z",
          "subject": "Meeting reminder",
          "from": [{ "name": "Alice Smith", "email": "alice@example.com" }],
          "to": [{ "name": "Bob Jones", "email": "bob@example.com" }],
          "cc": [],
          "bcc": [],
          "replyTo": [],
          "messageId": ["<unique@example.com>"],
          "hasAttachment": false,
          "preview": "Don't forget about our meeting tomorrow at 2pm..."
        }
      ],
      "notFound": []
    }, "e1"]
  ],
  "sessionState": "1234567890"
}
```

**Request (full email with body):**
```json
{
  "methodCalls": [
    ["Email/get", {
      "ids": ["msgId1"],
      "properties": null,
      "bodyProperties": ["partId", "blobId", "size", "type"]
    }, "e2"]
  ]
}
```

### Update Email (Mark as Read)

**Request:**
```json
{
  "methodCalls": [
    ["Email/set", {
      "update": {
        "msgId1": {
          "keywords": { "$seen": true }
        }
      }
    }, "u1"]
  ]
}
```

**Response:**
```json
{
  "methodResponses": [
    ["Email/set", {
      "accountId": "<userId>",
      "oldState": "1234567890",
      "newState": "1234567891",
      "created": {},
      "updated": { "msgId1": null },
      "destroyed": [],
      "notCreated": {},
      "notUpdated": {},
      "notDestroyed": {}
    }, "u1"]
  ],
  "sessionState": "1234567891"
}
```

### Move Email to Another Mailbox

**Request:**
```json
{
  "methodCalls": [
    ["Email/set", {
      "update": {
        "msgId1": {
          "mailboxIds": { "trashMailboxId": true }
        }
      }
    }, "u2"]
  ]
}
```

### Delete Email

**Request:**
```json
{
  "methodCalls": [
    ["Email/set", {
      "destroy": ["msgId1", "msgId2"]
    }, "d1"]
  ]
}
```

**Response:**
```json
{
  "methodResponses": [
    ["Email/set", {
      "accountId": "<userId>",
      "oldState": "1234567891",
      "newState": "1234567892",
      "created": {},
      "updated": {},
      "destroyed": ["msgId1", "msgId2"],
      "notCreated": {},
      "notUpdated": {},
      "notDestroyed": {}
    }, "d1"]
  ],
  "sessionState": "1234567892"
}
```

### Check for Changes

**Request:**
```json
{
  "methodCalls": [
    ["Email/changes", {
      "sinceState": "1234567890",
      "maxChanges": 100
    }, "c1"]
  ]
}
```

**Response:**
```json
{
  "methodResponses": [
    ["Email/changes", {
      "accountId": "<userId>",
      "oldState": "1234567890",
      "newState": "1234567892",
      "hasMoreChanges": false,
      "created": ["msgId3", "msgId4"],
      "updated": ["msgId1"],
      "destroyed": ["msgId2"]
    }, "c1"]
  ],
  "sessionState": "1234567892"
}
```

### Upload Attachment

**Binary Upload:**
```bash
curl -X POST https://example.com/jmap/upload \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: image/png" \
  -H "X-Filename: photo.png" \
  --data-binary @photo.png

# Response:
{
  "success": true,
  "id": "blobId123"
}
```

**JSON Upload (Base64):**
```bash
curl -X POST https://example.com/jmap/upload \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "document.pdf",
    "contentType": "application/pdf",
    "encoding": "base64",
    "content": "JVBERi0xLjQK..."
  }'
```

### Send Email with Attachment

**Request:**
```json
{
  "methodCalls": [
    ["Email/send", {
      "create": {
        "k1": {
          "email": {
            "to": [{ "email": "recipient@example.com", "name": "Recipient Name" }],
            "cc": [],
            "bcc": [],
            "subject": "Document attached",
            "text": "Please find the document attached.",
            "html": "<p>Please find the document attached.</p>",
            "attachments": [
              {
                "blobId": "blobId123",
                "filename": "document.pdf",
                "contentType": "application/pdf"
              }
            ]
          }
        }
      }
    }, "s1"]
  ]
}
```

**Response:**
```json
{
  "methodResponses": [
    ["Email/send", {
      "accountId": "<userId>",
      "created": {
        "k1": {
          "id": "sentMsgId1",
          "mailboxId": "sentMailboxId"
        }
      },
      "notCreated": {}
    }, "s1"]
  ],
  "sessionState": "1234567893"
}
```

---

## Advanced Features

### Chaining Method Calls

JMAP supports referencing results from previous method calls in the same request:

```json
{
  "methodCalls": [
    ["Email/query", {
      "filter": { "inMailbox": "inboxId" },
      "limit": 10
    }, "q1"],
    ["Email/get", {
      "#ids": {
        "resultOf": "q1",
        "name": "Email/query",
        "path": "/ids"
      },
      "properties": ["id", "subject", "from", "receivedAt"]
    }, "e1"]
  ]
}
```

### Batch Operations

Update multiple emails in one request:

```json
{
  "methodCalls": [
    ["Email/set", {
      "update": {
        "msgId1": { "keywords": { "$seen": true } },
        "msgId2": { "keywords": { "$seen": true } },
        "msgId3": { "keywords": { "$seen": true, "$flagged": true } }
      }
    }, "u1"]
  ]
}
```

### Changelog Maintenance

WildDuck automatically manages the changelog:

- Recent changes (default 1000) are kept in Redis for fast access
- Older changes are compacted to MongoDB via the `jmap-compact` task
- Configurable via `config.jmap.changelogKeep`
- Prevents unbounded Redis memory growth

The `jmap-compact` task runs periodically and:
1. Exports older Redis changelog entries to MongoDB `jmap_changes` collection
2. Trims Redis lists to the configured `keep` size
3. Allows long-term change history retention

---

## Configuration Reference

**File: `config/jmap.toml`**

```toml
# Enable/disable JMAP endpoints
enabled = true

# Base path for JMAP API
basePath = "/jmap"

# Enable RFC 8620 discovery endpoint
wellKnown = true

# Supported authentication methods
auth = ["bearer", "basic"]

# Maximum upload size in megabytes
maxUploadMB = 25

# Maximum concurrent JMAP requests per session
maxConcurrentRequests = 4

# Push notification settings
[push]
# Enable Server-Sent Events integration
sse = true

# Changelog retention (number of recent entries to keep in Redis)
changelogKeep = 1000
```

---

## Testing 🧪

### Test Files
- **Integration tests**: `test/api/jmap-test.js` - Full JMAP workflow tests
- **Changelog concurrency**: `test/api/jmap-changelog-concurrency-test.js` - Concurrent change tracking
- **Compaction**: `test/tasks/jmap-compact-test.js` - Changelog archival

### Run Tests
```bash
# Run all tests
npm test

# Run only JMAP tests
npm test -- --grep "jmap"
```

### Manual Testing with curl

```bash
# 1. Authenticate
TOKEN=$(curl -X POST http://localhost:8080/authenticate \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test","scope":"master","protocol":"API"}' \
  | jq -r '.token')

# 2. Get session
curl http://localhost:8080/jmap \
  -H "Authorization: Bearer $TOKEN" | jq

# 3. List mailboxes
curl -X POST http://localhost:8080/jmap \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"methodCalls":[["Mailbox/get",{},"m1"]]}' | jq

# 4. Query emails
curl -X POST http://localhost:8080/jmap \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"methodCalls":[["Email/query",{"filter":{},"limit":10},"q1"]]}' | jq

# 5. Get email details
curl -X POST http://localhost:8080/jmap \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"methodCalls":[["Email/get",{"ids":["<messageId>"]},"e1"]]}' | jq
```

---

## Architecture

### Components

- **`lib/api/jmap.js`** - Main JMAP API implementation
- **`lib/jmap-changes.js`** - Changelog tracking module (Redis-backed)
- **`lib/tasks/jmap-compact.js`** - Changelog compaction task
- **`config/jmap.toml`** - JMAP configuration

### Data Flow

1. Client discovers JMAP via `/.well-known/jmap`
2. Client gets session and capabilities via `GET /jmap`
3. Client authenticates (Bearer token or Basic auth)
4. Client sends method calls via `POST /jmap`
5. Server processes methods sequentially
6. Server tracks changes in Redis changelog
7. Server returns responses with updated state
8. Background task compacts old changelog to MongoDB

### State Management

- **Global state**: Computed from MAX(mailbox.modifyIndex, message.modseq, timestamp)
- **Per-user changelog**: Redis lists storing change events (created/updated/destroyed)
- **State tokens**: String representations used by clients for synchronization
- **Changelog archival**: Older entries moved from Redis to MongoDB for long-term storage

---

## JMAP Standards Compliance 📋

WildDuck implements core features from:

- **RFC 8620**: JMAP Core
  - Session resources
  - Core data types
  - Method calling conventions
  - Error handling
  - State synchronization

- **RFC 8621**: JMAP for Mail
  - Mailbox objects and methods
  - Email objects and methods
  - Email submission (basic)
  - Search queries
  - Keyword/flag management

### Known Limitations

- **Identity management**: Not yet implemented
- **SearchSnippet**: Not implemented
- **Thread/get**: Thread aggregation simplified
- **Email/import**: Not implemented
- **VacationResponse**: Use WildDuck's autoreply API
- **OAuth 2.0**: Not implemented (use Bearer tokens)

---

## Troubleshooting 🔍

### Common Issues

**Authentication fails:**
- Verify token is valid and not expired
- Check `Authorization` header format: `Bearer <token>`
- Ensure user account is active

**Upload fails with 413:**
- Check `config.jmap.maxUploadMB` setting
- Increase limit if needed for larger attachments

**Changes not appearing:**
- Verify `messageHandler.jmapChanges` is initialized
- Check Redis connectivity
- Review `jmap-compact` task logs

**State mismatches:**
- Client state may be too old
- Full resync needed if state gap is too large
- Check changelog retention settings

### Debug Mode

Enable debug logging:
```bash
DEBUG=api:jmap* node server.js
```

---

## Next Steps & Roadmap

### Planned Enhancements

1. **Full RFC compliance**
   - Run JMAP conformance test suite
   - Implement missing methods (Identity/*, Thread/get, Email/import)
   - OAuth 2.0 support

2. **Performance**
   - Connection pooling optimization
   - Caching for frequently accessed mailboxes
   - Efficient thread aggregation
   - Bulk operation optimizations

3. **Extensions**
   - JMAP Quotas extension
   - JMAP Sharing/delegation
   - Custom JMAP extensions for WildDuck-specific features

4. **Client Tools**
   - Official JavaScript JMAP client library
   - Example integrations and tutorials
   - Mobile SDK samples

---

## Resources 📚

- **JMAP Specifications**: https://jmap.io/spec.html
- **RFC 8620** (JMAP Core): https://www.rfc-editor.org/rfc/rfc8620.html
- **RFC 8621** (JMAP Mail): https://www.rfc-editor.org/rfc/rfc8621.html
- **WildDuck Documentation**: https://docs.wildduck.email/
- **JMAP Community**: https://groups.google.com/g/jmap-discuss

---

## Support 💬

If you encounter issues or have questions:

- **GitHub Issues**: https://github.com/nodemailer/wildduck/issues
- **Community Forum**: https://groups.google.com/g/wildduck

---

*Last updated: February 2026*
