'use strict';

// Seeding by the mechanism a scenario names: LMTP delivery, IMAP sessions and direct database
// access. REST API seeding goes through ./api. Connections are opened lazily and closed by the
// root after hook, so a test file that does not need one never opens it.

const config = require('@zone-eu/wild-config');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { MongoClient, ObjectId } = require('mongodb');

let lmtpTransport;
let mongoClient;
const imapClients = new Set();

/**
 * Delivers a raw message over LMTP to one or more recipients.
 *
 * @param {String|String[]} to Recipient address(es)
 * @param {Buffer|String} raw RFC 822 message
 * @param {String} [from] Envelope sender
 */
async function deliver(to, raw, from = 'sender@example.net') {
    if (!lmtpTransport) {
        lmtpTransport = nodemailer.createTransport({ lmtp: true, host: '127.0.0.1', port: config.lmtp.port, logger: false });
    }
    const info = await lmtpTransport.sendMail({ envelope: { from, to: [].concat(to) }, raw });
    if (info.rejected && info.rejected.length) {
        throw new Error(`LMTP rejected ${info.rejected.join(', ')}`);
    }
    return info;
}

/**
 * Opens an authenticated IMAP session for a user. The session is closed by the root after hook
 * unless the caller logs out first.
 */
async function imap(user) {
    const client = new ImapFlow({
        host: '127.0.0.1',
        port: config.imap.port,
        secure: true,
        auth: { user: user.username, pass: user.password },
        tls: { rejectUnauthorized: false },
        logger: false
    });
    // a session a test leaves open may time out while later tests run; without a listener its error would
    // be thrown into whichever test runs at that moment
    client.on('error', () => client.close());
    await client.connect();
    imapClients.add(client);
    client.on('close', () => imapClients.delete(client));
    return client;
}

/** Runs fn with an IMAP session and logs out afterwards. */
async function withImap(user, fn) {
    const client = await imap(user);
    try {
        return await fn(client);
    } finally {
        await client.logout().catch(() => client.close());
    }
}

/** The test database (shared connection). */
async function db() {
    if (!mongoClient) {
        mongoClient = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 5000 });
    }
    return mongoClient.db(config.dbs.dbname);
}

async function close() {
    for (const client of imapClients) {
        client.close();
    }
    imapClients.clear();
    if (lmtpTransport) {
        lmtpTransport.close();
        lmtpTransport = null;
    }
    if (mongoClient) {
        const client = mongoClient;
        mongoClient = null;
        await client.close();
    }
}

module.exports = { deliver, imap, withImap, db, close, ObjectId };
