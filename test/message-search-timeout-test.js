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
const hasEmptyMailboxScope = value => {
    if (!value || typeof value !== 'object') return false;
    if (value.mailbox && Array.isArray(value.mailbox.$in) && !value.mailbox.$in.length) return true;
    return Object.values(value).some(hasEmptyMailboxScope);
};

// Adapted from the explicit-mailbox-search regression. Runs the real route, query builders and paging wrapper. Only database operations
// are mocked; deadlines expire asynchronously when the fake clock advances.
function createSearch({ mailboxCount = 2, duration = 4000, failure, countFailure, collapseFailure, directoryFailure } = {}) {
    const user = new ObjectId('507f1f77bcf86cd799439010');
    const inbox = new ObjectId('507f1f77bcf86cd799439011');
    const read = new ObjectId('507f1f77bcf86cd799439012');
    const junk = new ObjectId('507f1f77bcf86cd799439013');
    const trash = new ObjectId('507f1f77bcf86cd799439014');
    const eligible = [inbox, read, ...Array.from({ length: Math.max(0, mailboxCount - 2) }, (_, index) => new ObjectId((index + 1000).toString(16).padStart(24, '0')))].slice(0, mailboxCount);
    const directoryQueries = [];
    let directoryCounts = 0;
    const calls = [];
    const counts = [];
    const logs = [];
    let handler;
    const database = {
        collection(name) {
            if (name === 'mailboxes') {
                return {
                    async countDocuments() {
                        directoryCounts++;
                        return mailboxCount;
                    },
                    async findOne(query) {
                        const path = query.$or[0].path;
                        return { _id: path === 'INBOX' ? inbox : read };
                    },
                    find(query) {
                        directoryQueries.push(snapshot(query));
                        const ids = query.specialUse.$nin ? eligible : [junk, trash];
                        return { project: () => ({ toArray: async () => {
                            if (directoryFailure) throw directoryFailure;
                            return ids.map(_id => ({ _id }));
                        } }) };
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
                    return hasEmptyMailboxScope(query) ? 0 : 17;
                },
                find(query, options) {
                    const cursor = {
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
        junk,
        trash,
        eligible,
        directoryQueries,
        get directoryCounts() { return directoryCounts; },
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
            expect(search.reply.statusCode).to.equal(200);
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

    for (const mailboxCount of [0, 1, 2, 199, 200, 201]) {
        it(`uses the q mailbox with generated searchable scope at mailbox count ${mailboxCount}`, async () => {
            const search = createSearch({ mailboxCount });
            await complete(search.run({ q: 'in:READ', mailbox: search.inbox.toString(), searchable: true }));
            expect(search.reply.statusCode).to.equal(200);
            expect(search.calls).to.have.length(1);
            expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES);
            const filter = search.calls[0].query.$and[1];
            expect(filter).to.deep.equal(search.counts[0]);
            expect(filter.$and[0]).to.deep.equal({ mailbox: search.read.toString() });
            expect(filter.$and[1].mailbox.$in).to.deep.equal(search.eligible.map(id => id.toString()));
        });

        for (const params of [{ searchable: true }, { q: 'subject:report', searchable: true }]) {
            it(`preserves generated searchable scope in one search at mailbox count ${mailboxCount} (${params.q || 'structured'})`, async () => {
                const search = createSearch({ mailboxCount });
                await complete(search.run(params));
                expect(search.reply.statusCode).to.equal(200);
                expect(search.calls).to.have.length(1);
                expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES);
                const filter = search.calls[0].query.$and[1];
                expect(filter).to.deep.equal(search.counts[0]);
                const mailboxFilter = params.q ? filter.$and[1].mailbox : filter.mailbox;
                expect(mailboxFilter.$in).to.deep.equal(search.eligible.map(id => id.toString()));
                expect(search.directoryQueries).to.have.length(1);
                expect(search.directoryQueries[0].specialUse).to.deep.equal({ $nin: ['\\Junk', '\\Trash'] });
                expect(search.directoryCounts).to.equal(0);
                expect(search.reply.body.total).to.equal(mailboxCount ? 17 : 0);
            });
        }
    }

    it('shares one mailbox snapshot across searchable terms and the global option', async () => {
        const search = createSearch({ mailboxCount: 201 });
        await complete(search.run({ q: 'searchable:true OR -searchable:true', searchable: true }));
        expect(search.directoryQueries).to.have.length(1);
        expect(search.calls).to.have.length(1);
        const filter = search.calls[0].query.$and[1];
        const scopes = [];
        const collect = value => {
            if (!value || typeof value !== 'object') return;
            if (value.mailbox) scopes.push(value.mailbox);
            Object.values(value).forEach(collect);
        };
        collect(filter);
        const ids = search.eligible.map(id => id.toString());
        expect(scopes).to.have.deep.members([{ $in: ids }, { $not: { $in: ids } }, { $in: ids }]);
        expect(filter).to.deep.equal(search.counts[0]);
    });

    it('preserves explicit q negation of the searchable scope', async () => {
        const search = createSearch({ mailboxCount: 201 });
        await complete(search.run({ q: '-searchable:true' }));
        expect(search.calls).to.have.length(1);
        expect(search.calls[0].query.$and[1].$and[0].mailbox).to.deep.equal({
            $not: { $in: search.eligible.map(id => id.toString()) }
        });
        expect(search.counts[0]).to.deep.equal(search.calls[0].query.$and[1]);
    });

    for (const params of [{ searchable: true }, { q: 'subject:report', searchable: true }]) {
        it(`propagates mailbox enumeration errors (${params.q || 'structured'})`, async () => {
            const failure = new Error('mailbox directory unavailable');
            const search = createSearch({ directoryFailure: failure });
            const error = await search.run(params).catch(err => err);
            expect(error).to.equal(failure);
            expect(error.code).to.equal('InternalDatabaseError');
            expect(search.calls).to.have.length(0);
            expect(search.counts).to.have.length(0);
        });
    }

    it('preserves an explicit multi-mailbox filter in one search', async () => {
        const search = createSearch();
        await complete(search.run({ q: 'in:INBOX OR in:READ' }));
        expect(search.calls).to.have.length(1);
        expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES);
        expect(search.calls[0].query.$and[1]).to.deep.equal(search.counts[0]);
        expect(search.reply.statusCode).to.equal(200);
    });

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

    it('returns a timeout error without widening the generated searchable scope', async () => {
        const search = createSearch({ duration: DB_MAX_TIME_MESSAGES + 1 });
        await complete(search.run({ searchable: true }));
        expect(search.calls).to.have.length(1);
        expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES);
        expect(search.reply.statusCode).to.equal(500);
        expect(search.reply.body.code).to.equal('InternalDatabaseError');
        expect(search.reply.body).not.to.have.property('total');
    });

    it('propagates concurrent count errors after a successful listing', async () => {
        const error = new Error('mock count failure');
        const search = createSearch({ countFailure: error });
        const pending = search.run({ mailbox: search.inbox.toString() }).catch(err => err);
        expect(await complete(pending)).to.equal(error);
        expect(search.calls).to.have.length(1);
    });

    for (const direction of ['next', 'previous']) {
        it(`preserves ${direction} cursor conditions and scope in one search`, async () => {
            const search = createSearch();
            const cursor = setPageToMongopagingCursor(Buffer.from(JSON.stringify(search.inbox.toString())).toString('base64url'), 2);
            await complete(search.run({ searchable: true, [direction]: cursor }));
            expect(search.reply.statusCode).to.equal(200);
            expect(search.calls).to.have.length(1);
            expect(search.calls[0].maxTimeMS).to.equal(DB_MAX_TIME_MESSAGES);
            expect(search.calls[0].query.$and[0]).not.to.deep.equal({});
            expect(search.calls[0].query.$and[1]).to.deep.equal(search.counts[0]);
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
