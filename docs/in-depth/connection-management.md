# Connection Management

WildDuck provides advanced connection management capabilities for both IMAP and POP3 servers through onConnect and onClose handlers. These handlers allow you to implement custom connection filtering, rate limiting, monitoring, and access control without modifying the core server code.

## Features

### onConnect Handlers
- **Connection Filtering**: Block connections based on IP address, user agent, or custom criteria
- **Rate Limiting**: Implement per-IP or per-user connection limits
- **Custom Authentication**: Add additional authentication layers
- **Connection Monitoring**: Log and track connection attempts
- **Dynamic Configuration**: Adjust server behavior based on connection context

### onClose Handlers
- **Connection Cleanup**: Perform custom cleanup when connections close
- **Session Logging**: Log connection duration and statistics
- **Resource Management**: Free up resources allocated during connection
- **Audit Trails**: Track connection lifecycle for security auditing

## IMAP Server Configuration

### Basic Setup

```javascript
const { IMAPServer } = require('wildduck/imap-core');

const server = new IMAPServer({
    onConnect: (session, callback) => {
        // Custom connection logic here
        console.log(`New IMAP connection from ${session.remoteAddress}`);
        callback(); // Allow connection
    },

    onClose: (session) => {
        // Custom cleanup logic here
        console.log(`IMAP connection closed: ${session.id}`);
    }
});
```

### Advanced Connection Filtering

```javascript
const blockedIPs = new Set(['192.168.1.100', '10.0.0.50']);
const connectionCounts = new Map();

const server = new IMAPServer({
    onConnect: (session, callback) => {
        // IP blocking
        if (blockedIPs.has(session.remoteAddress)) {
            return callback(new Error('IP address blocked'));
        }

        // Rate limiting
        const currentCount = connectionCounts.get(session.remoteAddress) || 0;
        if (currentCount >= 10) {
            return callback(new Error('Too many connections from this IP'));
        }

        // Update connection count
        connectionCounts.set(session.remoteAddress, currentCount + 1);

        // Log successful connection
        console.log(`IMAP connection allowed from ${session.remoteAddress}`);
        callback();
    },

    onClose: (session) => {
        // Decrement connection count
        const currentCount = connectionCounts.get(session.remoteAddress) || 0;
        if (currentCount > 0) {
            connectionCounts.set(session.remoteAddress, currentCount - 1);
        }

        console.log(`IMAP connection closed: ${session.id} from ${session.remoteAddress}`);
    }
});
```

## POP3 Server Configuration

### Basic Setup

```javascript
const POP3Server = require('wildduck/lib/pop3/server');

const server = new POP3Server({
    onConnect: (session, callback) => {
        // Custom connection logic here
        console.log(`New POP3 connection from ${session.remoteAddress}`);
        callback(); // Allow connection
    },

    onClose: (session) => {
        // Custom cleanup logic here
        console.log(`POP3 connection closed: ${session.id}`);
    }
});
```

### Time-based Access Control

```javascript
const server = new POP3Server({
    onConnect: (session, callback) => {
        const now = new Date();
        const hour = now.getHours();

        // Only allow connections during business hours (9 AM - 5 PM)
        if (hour < 9 || hour >= 17) {
            return callback(new Error('Service unavailable outside business hours'));
        }

        // Check if it's a weekend
        const day = now.getDay();
        if (day === 0 || day === 6) {
            return callback(new Error('Service unavailable on weekends'));
        }

        console.log(`POP3 connection allowed from ${session.remoteAddress} at ${now}`);
        callback();
    },

    onClose: (session) => {
        const duration = Date.now() - session.created;
        console.log(`POP3 session ${session.id} lasted ${duration}ms`);
    }
});
```

## Session Object Properties

Both IMAP and POP3 session objects provide the following properties:

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

## Error Handling

When an onConnect handler returns an error, the connection is immediately terminated:

```javascript
onConnect: (session, callback) => {
    // Reject connection with custom error message
    if (shouldRejectConnection(session)) {
        return callback(new Error('Connection rejected: Custom reason'));
    }

    // Allow connection
    callback();
}
```

The error message will be sent to the client before closing the connection.

## Best Practices

### Performance Considerations
- Keep onConnect handlers lightweight and fast
- Use asynchronous operations when possible
- Cache frequently accessed data (IP lists, user permissions)
- Implement proper cleanup in onClose handlers

### Security
- Always validate input from session objects
- Implement proper rate limiting to prevent abuse
- Log security-relevant events for auditing
- Use secure methods for storing sensitive configuration

### Monitoring
- Track connection patterns and anomalies
- Monitor connection success/failure rates
- Log connection duration and resource usage
- Implement alerting for suspicious activity

### Backward Compatibility
- onConnect and onClose handlers are completely optional
- Existing configurations continue to work without modification
- No performance impact when handlers are not used

## Integration Examples

### With Redis for Distributed Rate Limiting

```javascript
const redis = require('redis');
const client = redis.createClient();

const server = new IMAPServer({
    onConnect: async (session, callback) => {
        try {
            const key = `connections:${session.remoteAddress}`;
            const count = await client.incr(key);
            await client.expire(key, 3600); // 1 hour window

            if (count > 100) {
                return callback(new Error('Rate limit exceeded'));
            }

            callback();
        } catch (err) {
            console.error('Redis error:', err);
            callback(); // Allow connection on Redis failure
        }
    }
});
```

### With Database Logging

```javascript
const server = new POP3Server({
    onConnect: (session, callback) => {
        // Log connection attempt to database
        db.connections.insert({
            sessionId: session.id,
            remoteAddress: session.remoteAddress,
            timestamp: new Date(),
            protocol: 'POP3',
            status: 'connected'
        });

        callback();
    },

    onClose: (session) => {
        // Update connection record
        db.connections.update(
            { sessionId: session.id },
            {
                $set: {
                    status: 'disconnected',
                    duration: Date.now() - session.created
                }
            }
        );
    }
});
```

## Troubleshooting

### Common Issues

1. **Handler Exceptions**: Unhandled exceptions in handlers will terminate connections
   - Always use try-catch blocks for error handling
   - Provide meaningful error messages to clients

2. **Performance Impact**: Heavy processing in handlers can slow down connections
   - Use asynchronous operations where possible
   - Consider moving heavy work to background processes

3. **Memory Leaks**: Improper cleanup can lead to memory leaks
   - Always clean up resources in onClose handlers
   - Use WeakMap for session-specific data when possible

### Debugging

Enable debug logging to troubleshoot connection issues:

```javascript
const server = new IMAPServer({
    logger: {
        info: console.log,
        error: console.error,
        debug: console.debug
    },

    onConnect: (session, callback) => {
        console.log('onConnect called for session:', session.id);
        callback();
    }
});
```

