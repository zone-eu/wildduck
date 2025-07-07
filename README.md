# WildDuck Mail Server

<p align="center">
  <a href="https://wildduck.email" target="blank"><img src="./graphics/wildduck-type.svg" width="256" alt="Wild Duck" /></a>
  <br />
  WildDuck is a scalable no-SPOF IMAP/POP3 mail server.
</p>

<p align="center">
  <a href="https://gitter.im/nodemailer/wildduck" target="_blank"><img src="https://img.shields.io/gitter/room/nodemailer/wildduck?color=orange" alt="gitter" /></a>
  <a href="https://raw.githubusercontent.com/nodemailer/wildduck/refs/heads/master/docs/api/openapidocs.json"><img src="https://img.shields.io/swagger/valid/3.0?specUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fnodemailer%2Fwildduck%2Frefs%2Fheads%2Fmaster%2Fdocs%2Fapi%2Fopenapidocs.json"></a>
  <a href="https://github.com/zone-eu/wildduck/blob/master/LICENSE" target="_blank">
    <img src="https://img.shields.io/github/license/zone-eu/wildduck" alt="License" />
  </a>
</p>

WildDuck uses a distributed database (sharded + replicated MongoDB) as a backend for storing all data, including emails.

WildDuck tries to follow Gmail in product design. If there's a decision to be made then usually the answer is to do whatever Gmail has done.

## Recent Improvements

### Enhanced Connection Management
- **onConnect/onClose Handlers**: Full support for custom connection handling in both IMAP and POP3 servers
  - IP-based connection filtering and rate limiting
  - Custom authentication and authorization logic
  - Connection monitoring and logging capabilities
  - Backward compatible - handlers are optional

### Improved POP3 Reliability
- **Smart Timeout Management**: POP3 connections now automatically reset timeouts during active command processing
  - Prevents unexpected disconnections during legitimate usage
  - Maintains security timeouts for idle connections
  - Seamless operation with existing timeout configurations

### CONDSTORE Support
- **RFC 4551 Compliance**: Full CONDSTORE (Conditional STORE) extension support
  - ENABLE CONDSTORE extension
  - STORE and UID STORE with UNCHANGESINCE modifier
  - MODIFIED response codes for conflict detection
  - Enhanced synchronization capabilities for modern email clients

## Links

- [Website](https://wildduck.email)
- [Documentation](https://docs.wildduck.email)
- [Installation instructions](https://docs.wildduck.email/docs/general/install)
- [API Documentation](https://docs.wildduck.email/docs/category/wildduck-api)

## Configuration Examples

### IMAP Server with Connection Handlers

```javascript
const { IMAPServer } = require('wildduck/imap-core');

const server = new IMAPServer({
    // Connection filtering and rate limiting
    onConnect: (session, callback) => {
        // Block specific IPs
        if (blockedIPs.includes(session.remoteAddress)) {
            return callback(new Error('IP blocked'));
        }

        // Rate limiting
        if (connectionCount[session.remoteAddress] > 10) {
            return callback(new Error('Too many connections'));
        }

        console.log(`New IMAP connection from ${session.remoteAddress}`);
        callback();
    },

    // Connection cleanup
    onClose: (session) => {
        console.log(`IMAP connection closed: ${session.id}`);
        // Custom cleanup logic here
    }
});
```

### POP3 Server with Connection Management

```javascript
const POP3Server = require('wildduck/lib/pop3/server');

const server = new POP3Server({
    // Enhanced timeout handling (automatic)
    socketTimeout: 300000, // 5 minutes

    // Connection filtering
    onConnect: (session, callback) => {
        // Custom authentication logic
        if (!isAllowedConnection(session)) {
            return callback(new Error('Connection not allowed'));
        }
        callback();
    },

    // Connection monitoring
    onClose: (session) => {
        logConnectionStats(session);
    }
});
```

### CONDSTORE Usage

```javascript
// Enable CONDSTORE extension
A1 ENABLE CONDSTORE

// Conditional STORE operations
A2 STORE 1:5 (UNCHANGEDSINCE 12345) +FLAGS (\Seen)
// Response: A2 OK [MODIFIED 3,5] Conditional STORE completed

// UID STORE with UNCHANGEDSINCE
A3 UID STORE 100:200 (UNCHANGEDSINCE 67890) FLAGS (\Deleted)
// Response: A3 OK [MODIFIED 150,175] Conditional STORE completed
```

## License

WildDuck Mail Server is licensed under the [European Union Public License 1.2](https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12) or later.

> WildDuck Mail Server is part of the Zone Mail Suite (ZMS). Suite of programs and modules for an efficient, fast and modern email server.

Copyright (c) 2024 Zone Media OÜ
