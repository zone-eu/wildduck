# Connection Management

WildDuck provides connection management capabilities for both IMAP and POP3 servers through onConnect and onClose handlers.

## Handler Configuration

### IMAP Server

```javascript
const { IMAPServer } = require('wildduck/imap-core');

const server = new IMAPServer({
    onConnect: (session, callback) => {
        // Connection logic
        callback(); // Allow connection
    },
    onClose: (session) => {
        // Cleanup logic
    }
});
```

### POP3 Server

```javascript
const POP3Server = require('wildduck/lib/pop3/server');

const server = new POP3Server({
    onConnect: (session, callback) => {
        // Connection logic
        callback(); // Allow connection
    },
    onClose: (session) => {
        // Cleanup logic
    }
});
```

## Session Object Properties

### Common Properties
- `id`: Unique session identifier
- `remoteAddress`: Client IP address
- `remotePort`: Client port number
- `localAddress`: Server IP address
- `localPort`: Server port number
- `created`: Session creation timestamp
- `secure`: Boolean indicating if connection is encrypted

### IMAP-specific Properties
- `state`: Current IMAP state ('Not Authenticated', 'Authenticated', 'Selected', 'Logout')
- `selected`: Currently selected mailbox (if any)

### POP3-specific Properties
- `state`: Current POP3 state ('AUTHORIZATION', 'TRANSACTION', 'UPDATE')
- `user`: Authenticated user information (if authenticated)

## Handler Implementation

### Connection Filtering

```javascript
onConnect: (session, callback) => {
    if (blockedIPs.has(session.remoteAddress)) {
        return callback(new Error('IP address blocked'));
    }
    callback();
}
```

### Rate Limiting

```javascript
onConnect: (session, callback) => {
    const currentCount = connectionCounts.get(session.remoteAddress) || 0;
    if (currentCount >= 10) {
        return callback(new Error('Too many connections'));
    }
    connectionCounts.set(session.remoteAddress, currentCount + 1);
    callback();
}
```

### Async Operations

```javascript
onConnect: async (session, callback) => {
    try {
        await checkDatabase(session.remoteAddress);
        callback();
    } catch (err) {
        callback(err);
    }
}
```

## Error Handling

When an onConnect handler returns an error, the connection is immediately terminated with the error message sent to the client.

## Backward Compatibility

Both onConnect and onClose handlers are optional. Existing configurations continue to work without modification.

