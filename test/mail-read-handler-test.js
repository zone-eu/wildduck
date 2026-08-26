'use strict';

const chai = require('chai');
const { ObjectId } = require('mongodb');
const MailReadHandler = require('../lib/mail-read-handler');

const expect = chai.expect;

const USER_ID = new ObjectId();
const OTHER_USER_ID = new ObjectId();
const MAILBOX_ID = new ObjectId();
const THREAD_ID = new ObjectId();
const MESSAGE_ID = new ObjectId();

function sameId(left, right) {
    return left && right && left.toString() === right.toString();
}

function cursor(values) {
    return {
        sort() {
            return this;
        },
        project() {
            return this;
        },
        async toArray() {
            return values;
        }
    };
}

async function expectCode(promise, code) {
    let thrown;
    try {
        await promise;
    } catch (err) {
        thrown = err;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.code).to.equal(code);
    return thrown;
}

describe('MailReadHandler', () => {
    it('binds account and mailbox reads to one user and hides hidden mailboxes by default', async () => {
        let inbox = { _id: MAILBOX_ID, user: USER_ID, path: 'INBOX', subscribed: true, modifyIndex: 2 };
        let hidden = { _id: new ObjectId(), user: USER_ID, path: 'Hidden', hidden: true, subscribed: false };
        let other = { _id: new ObjectId(), user: OTHER_USER_ID, path: 'Other' };
        let mailboxQueries = [];
        let users = {
            collection(name) {
                if (name === 'users') {
                    return {
                        async findOne(query) {
                            return sameId(query._id, USER_ID)
                                ? {
                                      _id: USER_ID,
                                      username: 'alice',
                                      name: 'Alice',
                                      address: 'alice@example.com',
                                      quota: 1000,
                                      storageUsed: 100
                                  }
                                : null;
                        }
                    };
                }
                if (name === 'addresses') {
                    return {
                        find(query) {
                            expect(sameId(query.user, USER_ID)).to.equal(true);
                            return cursor([
                                { address: 'alice@example.com' },
                                { address: 'alias@example.com', name: 'Alias' }
                            ]);
                        }
                    };
                }
                throw new Error(`Unexpected users collection ${name}`);
            }
        };
        let database = {
            collection(name) {
                if (name === 'mailboxes') {
                    return {
                        find(query) {
                            mailboxQueries.push(query);
                            return cursor([inbox, hidden, other].filter(mailbox => sameId(mailbox.user, query.user)));
                        }
                    };
                }
                throw new Error(`Unexpected database collection ${name}`);
            }
        };
        let counters = [];
        let handler = new MailReadHandler({
            database,
            users,
            settingsHandler: { get: async () => 5000 },
            getMailboxCounter: async (connections, mailbox, type) => {
                counters.push({ connections, mailbox, type });
                return type === 'unseen' ? 1 : 2;
            }
        });
        let reader = handler.bind(USER_ID);

        expect(await reader.getAccount()).to.deep.equal({
            id: USER_ID.toString(),
            username: 'alice',
            name: 'Alice',
            primaryAddress: 'alice@example.com',
            aliases: [{ address: 'alias@example.com', name: 'Alias' }],
            quota: { allowed: 1000, used: 100 }
        });
        let listed = await reader.listMailboxes({ counters: true });
        expect(listed.results).to.have.length(1);
        expect(listed.results[0]).to.include({ id: MAILBOX_ID.toString(), path: 'INBOX', total: 2, unseen: 1, hidden: false });
        expect(mailboxQueries).to.have.length(1);
        expect(sameId(mailboxQueries[0].user, USER_ID)).to.equal(true);
        expect(counters).to.have.length(2);
    });

    it('rejects guessed mailbox IDs owned by another user', async () => {
        let queries = [];
        let handler = new MailReadHandler({
            database: {
                collection(name) {
                    expect(name).to.equal('mailboxes');
                    return {
                        async findOne(query) {
                            queries.push(query);
                            return null;
                        }
                    };
                }
            }
        });

        await expectCode(handler.bind(USER_ID).resolveMailbox(new ObjectId()), 'NoSuchMailbox');
        expect(sameId(queries[0].user, USER_ID)).to.equal(true);
    });

    it('returns bounded text bodies, keeps HTML opt-in, and never mutates mail state', async () => {
        let operations = [];
        let message = {
            _id: MESSAGE_ID,
            user: USER_ID,
            mailbox: MAILBOX_ID,
            uid: 7,
            thread: THREAD_ID,
            hdate: new Date('2026-01-01T00:00:00.000Z'),
            idate: new Date('2026-01-01T00:01:00.000Z'),
            mimeTree: {
                parsedHeader: {
                    from: [{ name: 'Sender', address: 'sender@example.com' }],
                    to: [{ address: 'alice@example.com' }],
                    'content-type': { value: 'text/plain' }
                },
                attachmentMap: { ATT1: Buffer.from('secret hash') }
            },
            subject: 'Subject',
            msgid: '<id@example.com>',
            size: 100,
            unseen: true,
            undeleted: true,
            flagged: false,
            draft: false,
            flags: [],
            attachments: [{ id: 'ATT1', filename: 'file.txt', contentType: 'text/plain', size: 9 }],
            text: 'abcdefgh',
            html: ['<b>abcdefgh</b>'],
            meta: { custom: { private: true }, files: ['draft-reference'] },
            forwardTargets: ['forward@example.com'],
            outbound: ['queue-id']
        };
        let database = {
            collection(name) {
                if (name === 'mailboxes') {
                    return {
                        async findOne(query) {
                            operations.push({ operation: 'findMailbox', query });
                            return sameId(query.user, USER_ID) && sameId(query._id, MAILBOX_ID)
                                ? { _id: MAILBOX_ID, user: USER_ID, path: 'INBOX' }
                                : null;
                        }
                    };
                }
                if (name === 'messages') {
                    return {
                        async findOne(query) {
                            operations.push({ operation: 'findMessage', query });
                            return sameId(query.user, USER_ID) && sameId(query.mailbox, MAILBOX_ID) && query.uid === 7 ? message : null;
                        }
                    };
                }
                throw new Error(`Unexpected collection ${name}`);
            }
        };
        let reader = new MailReadHandler({ database, maxBodyChars: 5 }).bind(USER_ID);

        let textOnly = await reader.getMessage({ mailbox: MAILBOX_ID, uid: 7, safe: true, markAsSeen: true });
        expect(textOnly.body).to.deep.equal({
            text: { available: true, content: 'abcde', truncated: true, originalLength: 8, returnedLength: 5 }
        });
        expect(textOnly).not.to.have.any.keys('html', 'text', 'forwardTargets', 'outbound', 'files', 'metaData', 'verificationResults');
        expect(textOnly.attachments[0]).not.to.have.property('hash');
        expect(textOnly.seen).to.equal(false);

        let both = await reader.getMessage({ mailbox: MAILBOX_ID, uid: 7, safe: true, bodyFormat: 'both' });
        expect(both.body.html).to.deep.equal({ available: true, content: '<b>ab', truncated: true, originalLength: 15, returnedLength: 5 });
        expect(operations.every(entry => entry.operation.startsWith('find'))).to.equal(true);
        expect(operations.filter(entry => entry.operation === 'findMessage')).to.have.length(2);
        for (let entry of operations.filter(candidate => candidate.operation === 'findMessage')) {
            expect(sameId(entry.query.user, USER_ID)).to.equal(true);
            expect(sameId(entry.query.mailbox, MAILBOX_ID)).to.equal(true);
        }
    });

    it('marks missing parsed bodies as unavailable', async () => {
        let database = {
            collection(name) {
                return {
                    async findOne() {
                        if (name === 'mailboxes') return { _id: MAILBOX_ID, user: USER_ID, path: 'INBOX' };
                        return {
                            _id: MESSAGE_ID,
                            user: USER_ID,
                            mailbox: MAILBOX_ID,
                            uid: 7,
                            thread: THREAD_ID,
                            mimeTree: {
                                parsedHeader: { 'content-type': { value: 'application/pkcs7-mime', params: { 'smime-type': 'enveloped-data' } } }
                            },
                            flags: []
                        };
                    }
                };
            }
        };
        let result = await new MailReadHandler({ database, maxBodyChars: 5 })
            .bind(USER_ID)
            .getMessage({ mailbox: MAILBOX_ID, uid: 7, safe: true, bodyFormat: 'both' });

        expect(result.encrypted).to.equal(true);
        expect(result.body.text).to.deep.equal({ available: false, content: '', truncated: false, originalLength: 0, returnedLength: 0 });
        expect(result.body.html).to.deep.equal({ available: false, content: '', truncated: false, originalLength: 0, returnedLength: 0 });
    });

    it('keeps the bound user and mailbox filters on a search timeout retry', async () => {
        let aggregateCalls = [];
        let listingAttempt = 0;
        let database = {
            collection(name) {
                if (name === 'mailboxes') {
                    return {
                        async findOne(query) {
                            return sameId(query.user, USER_ID) && sameId(query._id, MAILBOX_ID)
                                ? { _id: MAILBOX_ID, user: USER_ID, path: 'INBOX' }
                                : null;
                        }
                    };
                }
                if (name === 'messages') {
                    return {
                        aggregate(pipeline, options) {
                            aggregateCalls.push({ pipeline, options });
                            let isCount = pipeline.some(stage => stage.$count);
                            return {
                                async toArray() {
                                    if (isCount) return [{ total: 0 }];
                                    listingAttempt++;
                                    if (listingAttempt === 1) {
                                        let err = new Error('timeout');
                                        err.code = 50;
                                        err.codeName = 'MaxTimeMSExpired';
                                        throw err;
                                    }
                                    return [];
                                }
                            };
                        }
                    };
                }
                throw new Error(`Unexpected collection ${name}`);
            }
        };
        let timings = [];
        let reader = new MailReadHandler({ database }).bind(USER_ID);
        let result = await reader.searchMessages({
            q: 'subject:test',
            mailbox: MAILBOX_ID,
            collapseThreads: true,
            order: 'desc',
            onTiming: timing => timings.push(timing)
        });

        expect(result.total).to.equal(0);
        expect(result.results).to.deep.equal([]);
        expect(listingAttempt).to.equal(2);
        expect(timings).to.have.length(1);
        expect(timings[0].retry).to.equal(true);
        expect(aggregateCalls).to.have.length(3);
        for (let call of aggregateCalls) {
            let match = call.pipeline.find(stage => stage.$match).$match;
            expect(sameId(match.user, USER_ID)).to.equal(true);
            expect(sameId(match.mailbox, MAILBOX_ID)).to.equal(true);
        }
    });

    it('rejects mixed q and typed filters and caps every page at 50', async () => {
        let reader = new MailReadHandler({ database: {}, maxResults: 50 }).bind(USER_ID);
        await expectCode(reader.searchMessages({ q: 'hello', from: 'sender@example.com', rejectMixedSearch: true }), 'InputValidationError');
        expect(await reader.normalizePagingOptions({ limit: 500, maxLimit: 500 })).to.deep.equal({
            limit: 50,
            next: undefined,
            previous: undefined,
            order: 'desc'
        });
    });
});
