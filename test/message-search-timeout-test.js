/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { mock } = require('node:test');
const { ObjectId } = require('mongodb');
const registerMessages = require('../lib/api/messages');
const { DB_MAX_TIME_MESSAGES, DB_MAX_TIME_MESSAGES_SEARCH } = require('../lib/consts');
const { setPageToMongopagingCursor } = require('../lib/mongopaging-find-wrapper');

const snapshot = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const timeoutError = () => Object.assign(new Error('mock database deadline exceeded'), { code: 50, codeName: 'MaxTimeMSExpired' });

// Runs the real route, query builders and paging wrapper. Only database operations
// are mocked; deadlines expire asynchronously when the fake clock advances.
function createSearch({ mailboxCount = 2, duration = 4000, failure, countFailure, collapseFailure } = {}) {
    const user = new ObjectId('507f1f77bcf86cd799439010');
    const inbox = new ObjectId('507f1f77bcf86cd799439011');
    const read = new ObjectId('507f1f77bcf86cd799439012');
    const junk = new ObjectId('507f1f77bcf86cd799439013');
    const calls = [];
    const counts = [];
    const logs = [];
    let handler;
    const database = {
        collection(name) {
            if (name === 'mailboxes') {
                return {
                    async countDocuments() {
                        return mailboxCount;
                    },
                    async findOne(query) {
                        const path = query.$or[0].path;
                        return { _id: path === 'INBOX' ? inbox : read };
                    },
                    find(query) {
                        const ids = query.specialUse.$nin ? [inbox, read] : [junk];
                        return { project: () => ({ toArray: async () => ids.map(_id => ({ _id })) }) };
                    }
                };
            }
            if (name !== 'messages') {
                return {};
            }
            const execute = (query, maxTimeMS, error) => {
                calls.push({ query: snapshot(query), maxTimeMS });
                return new Promise((resolve, reject) => {
                    setTimeout(() => {
                        if (error) {
                            return reject(error);
                        }
                        if (duration > maxTimeMS) {
                            return reject(timeoutError());
                        }
                        resolve([]);
                    }, Math.min(duration, maxTimeMS));
                });
            };
            return {
                async countDocuments(query) {
                    counts.push(snapshot(query));
                    if (countFailure) {
                        throw countFailure;
                    }
                    return 17;
                },
                find(query, options) {
                    const cursor = {
                        project: () => cursor,
                        sort: () => cursor,
                        limit: () => cursor,
                        toArray: () => execute(query, options.maxTimeMS, failure)
                    };
                    return cursor;
                },
                aggregate(pipeline, options) {
                    // Empty thread-counter aggregation after a successful collapsed page.
                    if (!options) {
                        return { toArray: async () => [] };
                    }
                    return {
                        toArray: async () => {
                            await execute(pipeline[0].$match, options.maxTimeMS, collapseFailure);
                            return [{ total: [{ value: 17 }], results: [] }];
                        }
                    };
                }
            };
        }
    };
    const db = {
        database,
        senderDb: database,
        users: { collection: () => ({ findOne: async () => ({ _id: user }) }) },
        redis: { sismember: async () => 0 }
    };
    const server = {
        route(route) {
            if (route.method === 'GET' && route.url === '/users/:user/search') {
                handler = route.handler;
            }
        },
        loggelf: entry => logs.push(entry)
    };
    registerMessages(db, server, {}, {}, {}, {});
    const reply = {
        statusCode: 200,
        code(code) {
            this.statusCode = code;
            return this;
        },
        send(body) {
            this.body = body;
            return body;
        }
    };
    return {
        inbox,
        read,
        calls,
        counts,
        logs,
        reply,
        run: params => handler({ params: { user: user.toString(), limit: 20, ...params }, user: user.toString(), role: 'root', validate() {} }, reply)
    };
}

describe('Message search database deadlines', () => {
    beforeEach(() => mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 }));
    afterEach(() => mock.timers.reset());

    const complete = async promise => {
        const outcome = promise.then(value => ({ value }), error => ({ error }));
        // Drain route/query-builder microtasks before each fake-clock step, including
        // the continuation that schedules the fallback after the first deadline.
        for (let step = 0; step < 4; step++) {
            await flush();
            mock.timers.tick(DB_MAX_TIME_MESSAGES);
        }
        const result = await outcome;
        if (result.error) {
            throw result.error;
        }
        return result.value;
    };

    for (const q of [
        undefined,
        'in:INBOX',
        'in:INBOX OR in:READ',
        '(in:INBOX OR in:READ) AND subject:report',
        '(in:INBOX AND subject:report) OR (in:READ AND -in:Trash)',
        'subject:report AND (in:INBOX OR (in:READ AND subject:other))',
        '(in:INBOX OR subject:report) AND in:READ'
    ]) {
        it(`uses one long attempt and preserves explicit scope for ${q || 'structured mailbox'}`, async () => {
            const search = createSearch();
            await complete(search.run(q ? { q } : { mailbox: search.inbox.toString() }));
            expect(search.reply.statusCode, JSON.stringify(search.reply.body)).to.equal(200);
            expect(search.calls).to.have.length(1);
            expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES);
            expect(search.calls[0].query.$and[1]).to.deep.equal(search.counts[0]);
            expect(search.reply.body.total).to.equal(17);
            expect(search.logs).to.have.length(1);
            expect(search.logs[0]).not.to.have.property('_is_retry');
        });
    }

    it('waits beyond the short deadline without starting a fallback for explicit mailboxes', async () => {
        const search = createSearch();
        let settled = false;
        const pending = search.run({ mailbox: search.inbox.toString() }).then(() => (settled = true));
        await flush();
        mock.timers.tick(DB_MAX_TIME_MESSAGES_SEARCH);
        await flush();
        expect(search.calls).to.have.length(1);
        expect(settled).to.equal(false);
        mock.timers.tick(1000);
        await pending;
        expect(search.reply.statusCode).to.equal(200);
        expect(search.calls).to.have.length(1);
    });

    for (const mailboxCount of [2, 200]) {
        it(`uses the q mailbox with generated searchable scope at mailbox count ${mailboxCount}`, async () => {
            const search = createSearch({ mailboxCount });
            await complete(search.run({ q: 'in:READ', mailbox: search.inbox.toString(), searchable: true }));
            expect(search.reply.statusCode).to.equal(200);
            expect(search.calls).to.have.length(1);
            expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES);
            const filter = search.calls[0].query.$and[1];
            expect(filter).to.deep.equal(search.counts[0]);
            expect(filter.$and[0]).to.deep.equal({ mailbox: search.read.toString() });
            expect(filter.$and[1].mailbox).to.have.property(mailboxCount < 200 ? '$in' : '$nin');
        });

        it(`retains the short-to-long fallback for generated searchable ${mailboxCount < 200 ? '$in' : '$nin'}`, async () => {
            const search = createSearch({ mailboxCount });
            await complete(search.run({ searchable: true }));
            expect(search.reply.statusCode).to.equal(200);
            expect(search.calls.map(call => call.maxTimeMS)).to.deep.equal([DB_MAX_TIME_MESSAGES_SEARCH, DB_MAX_TIME_MESSAGES]);
            expect(search.calls[0].query.$and[1].mailbox).to.have.property(mailboxCount < 200 ? '$in' : '$nin');
            expect(search.calls[1].query.$and[1]).not.to.have.property('mailbox');
            expect(search.counts[0]).to.deep.equal(search.calls[0].query.$and[1]);
            expect(search.logs[0]._is_retry).to.equal(true);
        });

        it(`keeps generated searchable scope with q at mailbox count ${mailboxCount}`, async () => {
            const search = createSearch({ mailboxCount });
            await complete(search.run({ q: 'subject:report', searchable: true }));
            expect(search.calls.map(call => call.maxTimeMS)).to.deep.equal([DB_MAX_TIME_MESSAGES_SEARCH, DB_MAX_TIME_MESSAGES]);
            expect(search.calls[1].query).to.deep.equal(search.calls[0].query);
        });
    }

    for (const q of ['in:INBOX OR subject:report', '-in:INBOX', 'in:INBOX OR -in:READ', '-(in:INBOX OR in:READ)']) {
        it(`preserves all branches while retaining broad-search fallback for ${q}`, async () => {
            const search = createSearch();
            await complete(search.run({ q, mailbox: search.inbox.toString() }));
            expect(search.reply.statusCode).to.equal(200);
            expect(search.calls.map(call => call.maxTimeMS)).to.deep.equal([DB_MAX_TIME_MESSAGES_SEARCH, DB_MAX_TIME_MESSAGES]);
            expect(search.calls[1].query).to.deep.equal(search.calls[0].query);
            expect(search.counts[0]).not.to.have.property('mailbox'); // q overrides structured inputs
        });
    }

    it('returns explicit-scope timeout errors without retrying or widening', async () => {
        const search = createSearch({ duration: DB_MAX_TIME_MESSAGES + 1 });
        await complete(search.run({ mailbox: search.inbox.toString() }));
        expect(search.calls).to.have.length(1);
        expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES);
        expect(search.reply.statusCode).to.equal(500);
        expect(search.reply.body.code).to.equal('InternalDatabaseError');
    });

    it('returns non-timeout database errors without retrying', async () => {
        const search = createSearch({ failure: new Error('mock query failure') });
        await complete(search.run({ searchable: true }));
        expect(search.calls).to.have.length(1);
        expect(search.reply.statusCode).to.equal(500);
        expect(search.reply.body.error).to.include('mock query failure');
    });

    it('does not retry code 50 errors with a different codeName', async () => {
        const search = createSearch({ failure: Object.assign(new Error('other failure'), { code: 50, codeName: 'OtherError' }) });
        await complete(search.run({ searchable: true }));
        expect(search.calls).to.have.length(1);
        expect(search.reply.statusCode).to.equal(500);
    });

    it('keeps fast broad searches on one short attempt', async () => {
        const search = createSearch({ duration: 100 });
        await complete(search.run({ searchable: true }));
        expect(search.calls).to.have.length(1);
        expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES_SEARCH);
        expect(search.reply.statusCode).to.equal(200);
    });

    it('returns fallback database errors', async () => {
        const search = createSearch({ duration: DB_MAX_TIME_MESSAGES + 1 });
        await complete(search.run({ searchable: true }));
        expect(search.calls).to.have.length(2);
        expect(search.reply.statusCode).to.equal(500);
        expect(search.reply.body.code).to.equal('InternalDatabaseError');
    });

    it('propagates concurrent count errors after a successful listing', async () => {
        const error = new Error('mock count failure');
        const search = createSearch({ countFailure: error });
        const pending = search.run({ mailbox: search.inbox.toString() }).catch(err => err);
        expect(await complete(pending)).to.equal(error);
        expect(search.calls).to.have.length(1);
    });

    for (const direction of ['next', 'previous']) {
        it(`preserves ${direction} cursor conditions through the automatic fallback`, async () => {
            const search = createSearch();
            const cursor = setPageToMongopagingCursor(Buffer.from(JSON.stringify(search.inbox.toString())).toString('base64url'), 2);
            await complete(search.run({ searchable: true, [direction]: cursor }));
            expect(search.reply.statusCode).to.equal(200);
            expect(search.calls).to.have.length(2);
            expect(search.calls[0].query.$and[0]).not.to.deep.equal({});
            expect(search.calls[1].query.$and[0]).to.deep.equal(search.calls[0].query.$and[0]);
        });
    }

    it('keeps collapsed searches on their existing single long attempt', async () => {
        const search = createSearch();
        await complete(search.run({ collapseThreads: true, mailbox: search.inbox.toString() }));
        expect(search.calls).to.have.length(1);
        expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES);
        expect(search.reply.statusCode).to.equal(200);
        expect(search.reply.body.total).to.equal(17);
    });

    it('does not retry a collapsed-search timeout', async () => {
        const search = createSearch({ collapseFailure: timeoutError() });
        await complete(search.run({ collapseThreads: true }));
        expect(search.calls).to.have.length(1);
        expect(search.reply.statusCode).to.equal(500);
    });
});
