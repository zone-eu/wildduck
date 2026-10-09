/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const db = require('../lib/db');
const onStatus = require('../lib/handlers/on-status');
const onOpen = require('../lib/handlers/on-open');
const onSubscribe = require('../lib/handlers/on-subscribe');

function loadConnectionModule(settings, connect) {
    const filename = require.resolve('../lib/db');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const stubs = {
        '@zone-eu/wild-config': { dbs: { redis: {}, ...settings } },
        mongodb: { MongoClient: { connect } },
        ioredis: class Redis {},
        './errors': { registerRedisErrorLogger() {} }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module,
        require: name => (Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name] : localRequire(name)),
        process
    });
    return module.exports;
}

describe('MongoDB promise connections', () => {
    it('shares the main client for named databases and falls back to the primary database', async () => {
        const databases = new Map();
        const connection = loadConnectionModule({ mongo: 'mongodb://primary/main', gridfs: 'attachments', users: 'accounts' }, async (...args) => {
            expect(args).to.deep.equal(['mongodb://primary/main']);
            return {
                db(name = 'main') {
                    if (!databases.has(name)) {
                        databases.set(name, { name });
                    }
                    return databases.get(name);
                }
            };
        });
        let calls = 0;
        await connection.connect(err => {
            expect(err).to.equal(undefined);
            calls++;
        });
        expect(calls).to.equal(1);
        expect(connection.database).to.equal(databases.get('main'));
        expect(connection.gridfs).to.equal(databases.get('attachments'));
        expect(connection.users).to.equal(databases.get('accounts'));
        expect(connection.senderDb).to.equal(connection.database);
    });

    it('selects the URI default database on a separate client', async () => {
        const uris = [];
        const connection = loadConnectionModule({ mongo: 'mongodb://primary/main', users: 'mongodb://secondary/accounts' }, async uri => {
            uris.push(uri);
            return { db: () => ({ name: path.basename(uri) }) };
        });
        await connection.connect(err => expect(err).to.equal(undefined));
        expect(uris).to.deep.equal(['mongodb://primary/main', 'mongodb://secondary/accounts']);
        expect(connection.users.name).to.equal('accounts');
    });

    it('reports a rejected primary or secondary connection exactly once', async () => {
        for (const failOn of ['mongodb://primary/main', 'mongodb://secondary/accounts']) {
            const error = new Error('connection failed');
            const connection = loadConnectionModule({ mongo: 'mongodb://primary/main', users: 'mongodb://secondary/accounts' }, async uri => {
                if (uri === failOn) {
                    throw error;
                }
                return { db: () => ({}) };
            });
            let calls = 0;
            await connection.connect(err => {
                expect(err).to.equal(error);
                calls++;
            });
            expect(calls).to.equal(1);
        }
    });
});

describe('IMAP handlers with promise-only MongoDB', () => {
    const session = { id: 'promise-test', user: { id: 'user' } };
    const server = { logger: { debug() {} } };
    let originalDatabase;

    beforeEach(() => {
        originalDatabase = db.database;
    });
    afterEach(() => {
        db.database = originalDatabase;
    });

    it('returns STATUS counters from promise-only reads', async () => {
        let calls = 0;
        db.database = {
            collection(name) {
                return name === 'mailboxes'
                    ? { findOne: async () => ({ _id: 'mailbox', uidNext: 5, uidValidity: 7, modifyIndex: 9 }) }
                    : { countDocuments: async query => (query.unseen ? 2 : 4) };
            }
        };
        await onStatus(server)('INBOX', session, (err, status) => {
            expect(err).to.equal(null);
            expect(status).to.deep.equal({ messages: 4, uidNext: 5, uidValidity: 7, unseen: 2, highestModseq: 9 });
            calls++;
        });
        expect(calls).to.equal(1);
    });

    it('reports a rejected STATUS count exactly once', async () => {
        const error = new Error('count failed');
        let calls = 0;
        db.database = {
            collection(name) {
                return name === 'mailboxes'
                    ? { findOne: async () => ({ _id: 'mailbox' }) }
                    : {
                          async countDocuments() {
                              throw error;
                          }
                      };
            }
        };
        await onStatus(server)('INBOX', session, err => {
            expect(err).to.equal(error);
            calls++;
        });
        expect(calls).to.equal(1);
    });

    it('returns unique message UIDs when opening a mailbox', async () => {
        const cursor = {
            project() {
                return this;
            },
            sort() {
                return this;
            },
            maxTimeMS() {
                return this;
            },
            toArray: async () => [{ uid: 1 }, { uid: 1 }, { uid: 2 }]
        };
        db.database = {
            collection(name) {
                return name === 'mailboxes' ? { findOne: async () => ({ _id: 'mailbox' }) } : { find: () => cursor };
            }
        };
        await onOpen(server)('INBOX', session, (err, mailbox) => {
            expect(err).to.equal(null);
            expect(mailbox.uidList).to.deep.equal([1, 2]);
        });
    });

    it('preserves subscription success and missing-mailbox responses', async () => {
        for (const value of [{ _id: 'mailbox' }, null]) {
            db.database = {
                collection: () => ({
                    async findOneAndUpdate(query, update, options) {
                        expect(options.includeResultMetadata).to.equal(true);
                        return { value };
                    }
                })
            };
            await onSubscribe(server)('INBOX', session, (err, status) => {
                expect(err).to.equal(null);
                expect(status).to.equal(value ? true : 'NONEXISTENT');
            });
        }
    });
});
