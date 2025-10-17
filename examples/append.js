/* eslint no-console:0 */

'use strict';

const rawpath = process.argv[2];
const config = require('@zone-eu/wild-config');
const { ImapFlow } = require('imapflow');

const raw = require('fs').readFileSync(rawpath);
console.log('Processing %s of %s bytes', rawpath, raw.length);

const client = new ImapFlow({
    host: '127.0.0.1',
    port: config.imap.port,
    secure: config.imap.secure,
    auth: {
        user: 'myuser',
        pass: 'verysecret'
    },
    tls: {
        rejectUnauthorized: false
    },
    clientInfo: {
        name: 'My Client',
        version: '0.1'
    }
});

client.on('error', err => {
    console.log(err);
    process.exit(1);
});

client
    .connect()
    .then(() => client.append('INBOX', raw))
    .then(() => client.mailboxOpen('INBOX'))
    .then(mailbox => client.fetchOne(mailbox.exists, { bodyStructure: true, source: true }))
    .then(data => {
        console.log(data);
        console.log('<<<%s>>>', data.source.toString());
        return process.exit(0);
    })
    .catch(err => {
        console.log(err);
        process.exit(1);
    });
