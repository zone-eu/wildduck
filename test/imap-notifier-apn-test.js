/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* global before */

'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const forge = require('node-forge');
const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const ImapNotifier = require('../lib/imap-notifier');
const ApnClient = require('../lib/apn-client');

// 64-char hex device token accepted by the client
const VALID_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

// debounce window in ApnClient is 2000ms, so assertions wait a bit longer
const FLUSH_WAIT = 2500;

// Self-signed cert/key on disk so the ApnClient constructor (which reads them) does not throw.
// The HTTP/2 layer is never exercised here: _push is stubbed, so no real connection is made.
function generateSelfSignedCert() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    const attrs = [{ name: 'commonName', value: 'localhost' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const keyPath = path.join(os.tmpdir(), 'imap-notifier-apn-test-key.pem');
    const certPath = path.join(os.tmpdir(), 'imap-notifier-apn-test-cert.pem');

    fs.writeFileSync(keyPath, Buffer.from(forge.pki.privateKeyToPem(keys.privateKey)));
    fs.writeFileSync(certPath, Buffer.from(forge.pki.certificateToPem(cert)));

    return { keyPath, certPath };
}

// Minimal redis stub: counters(redis) defines lua commands at construction, registerRedisErrorLogger
// attaches an 'error' listener, and updateCounters() calls cachedcounter/del.
function mockRedis() {
    return {
        on() {},
        defineCommand() {},
        cachedcounter() {
            return Promise.resolve(1);
        },
        del() {
            return Promise.resolve(1);
        }
    };
}

// journal.insertMany is the only mailbox-db call reached on this path (modseq is preset on entries,
// so no findOneAndUpdate, and a pre-resolved mailbox object means no mailboxes lookup).
function mockNotifierDatabase() {
    return {
        collection() {
            return {
                insertMany(entries) {
                    return Promise.resolve({ insertedCount: entries.length });
                }
            };
        }
    };
}

// pushsubscriptions store backing the ApnClient: matches the {user, mailboxIds} query shape it uses,
// comparing ObjectIds by value.
function mockSubscriptionDatabase(subscriptions) {
    return {
        collection() {
            return {
                find(query) {
                    let matched = subscriptions.filter(sub => sub.user.equals(query.user));
                    if (query.mailboxIds) {
                        let wanted = (query.mailboxIds.$in || [query.mailboxIds]).map(id => id.toString());
                        matched = matched.filter(sub => sub.mailboxIds.some(m => wanted.includes(m.toString())));
                    }
                    return {
                        toArray() {
                            return Promise.resolve(matched);
                        }
                    };
                }
            };
        }
    };
}

describe('ImapNotifier APNs integration', function () {
    this.timeout(15000); // eslint-disable-line

    let tls;

    before(function () {
        tls = generateSelfSignedCert();
    });

    // Build a real ApnClient (constructor bypasses the singleton) with _push stubbed to record
    // every push attempt, plus a real ImapNotifier wired to it via the apn option.
    function createSetup(subscriptions) {
        let pushCalls = [];

        let apn = new ApnClient({
            topic: 'com.apple.mail.XServer.test',
            certPath: tls.certPath,
            keyPath: tls.keyPath,
            database: mockSubscriptionDatabase(subscriptions),
            loggelf: () => false
        });
        // never touch the network; just record what would have been pushed
        apn._push = (deviceToken, accountId) => {
            pushCalls.push({ deviceToken, accountId });
            return Promise.resolve({ status: 200, reason: null });
        };

        let notifier = new ImapNotifier({
            database: mockNotifierDatabase(),
            redis: mockRedis(),
            settingsHandler: {},
            apn,
            pushOnly: true
        });

        return { notifier, apn, pushCalls };
    }

    // addEntries is callback-based; promisify for the tests
    function addEntries(notifier, mailbox, entries) {
        return new Promise((resolve, reject) => {
            notifier.addEntries(mailbox, entries, (err, count) => (err ? reject(err) : resolve(count)));
        });
    }

    // EXISTS entry with a preset modseq so addEntries takes the no-findOneAndUpdate path
    function existsEntry() {
        return { command: 'EXISTS', message: new ObjectId(), uid: 1, modseq: 5 };
    }

    it('should push when a new message arrives in a subscribed mailbox', async function () {
        let user = new ObjectId();
        let mailbox = { _id: new ObjectId(), user };

        let { notifier, pushCalls } = createSetup([{ _id: '1', user, deviceToken: VALID_TOKEN, accountId: 'acc-1', mailboxIds: [mailbox._id] }]);

        await addEntries(notifier, mailbox, [existsEntry()]);

        await new Promise(resolve => setTimeout(resolve, FLUSH_WAIT));

        expect(pushCalls).to.have.length(1);
        expect(pushCalls[0].deviceToken).to.equal(VALID_TOKEN);
    });

    it('should NOT push when a new message arrives in a non-subscribed mailbox', async function () {
        let user = new ObjectId();
        // the device subscribes to a different mailbox than the one receiving the message
        let subscribedMailbox = new ObjectId();
        let mailbox = { _id: new ObjectId(), user };

        let { notifier, pushCalls } = createSetup([{ _id: '1', user, deviceToken: VALID_TOKEN, accountId: 'acc-1', mailboxIds: [subscribedMailbox] }]);

        await addEntries(notifier, mailbox, [existsEntry()]);

        await new Promise(resolve => setTimeout(resolve, FLUSH_WAIT));

        expect(pushCalls).to.have.length(0);
    });

    it('should NOT push when entries contain no new messages (no EXISTS)', async function () {
        let user = new ObjectId();
        let mailbox = { _id: new ObjectId(), user };

        let { notifier, apn, pushCalls } = createSetup([{ _id: '1', user, deviceToken: VALID_TOKEN, accountId: 'acc-1', mailboxIds: [mailbox._id] }]);

        // guard against the debounce path being entered at all for non-EXISTS entries
        let notifyCalls = 0;
        let origNotify = apn.notify.bind(apn);
        apn.notify = (u, m) => {
            notifyCalls++;
            return origNotify(u, m);
        };

        // FETCH (flag change) and EXPUNGE are not new mail and must not trigger a push
        await addEntries(notifier, mailbox, [
            { command: 'FETCH', message: new ObjectId(), uid: 1, modseq: 5 },
            { command: 'EXPUNGE', message: new ObjectId(), uid: 2, modseq: 5 }
        ]);

        await new Promise(resolve => setTimeout(resolve, FLUSH_WAIT));

        expect(notifyCalls).to.equal(0);
        expect(pushCalls).to.have.length(0);
    });
});
