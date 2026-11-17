/* eslint no-unused-expressions: 0 */
/* global before */
'use strict';

// Catalogue file email-query.yaml: Email/query limits and large accounts seeded in the database.

const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const Redis = require('ioredis');
const log = require('npmlog');
const { scenario, api, accounts, seed, jmap } = require('../harness');
const { setup, query } = require('./email-query-helpers');
const { MAX_LIMIT } = require('../../../lib/jmap/types/email-query');
const { createApp } = require('../../../lib/jmap/server');
const types = require('../../../lib/jmap/types');
const UserHandler = require('../../../lib/user-handler');
const redisUrl = require('../../../lib/redis-url');
const consts = require('../../../lib/consts');

const BASE = Date.UTC(2023, 0, 1);
// the default time limit of one Email/query
const QUERY_TIME_LIMIT = consts.DB_MAX_TIME_MESSAGES_SEARCH * 3;
const DESC = [{ property: 'receivedAt', isAscending: false }];

/**
 * Inserts `count` message documents straight into the database, one second apart (index 0 oldest).
 * Only the fields Email/query reads are set. Answers the Email ids by index.
 *
 * @param {Object} user From setup()
 * @param {Function} place index -> {mailbox: id string, thread: ObjectId}
 */
async function bulkMessages(user, count, place) {
    const db = await seed.db();
    const owner = new seed.ObjectId(user.id);
    const ids = new Array(count);
    const uids = new Map();
    for (let start = 0; start < count; start += 10000) {
        const docs = [];
        for (let i = start; i < Math.min(count, start + 10000); i++) {
            const _id = new seed.ObjectId();
            const { mailbox, thread } = place(i);
            const uid = (uids.get(mailbox) || 0) + 1;
            uids.set(mailbox, uid);
            const date = new Date(BASE + i * 1000);
            docs.push({
                _id,
                root: _id,
                user: owner,
                mailbox: new seed.ObjectId(mailbox),
                uid,
                modseq: 1,
                thread,
                idate: date,
                hdate: date,
                size: 1000 + (i % 100),
                flags: [],
                unseen: true,
                flagged: false,
                draft: false,
                undeleted: true,
                searchable: true,
                headers: [{ key: 'subject', value: `bulk ${i}` }],
                ha: false,
                subject: `bulk ${i}`,
                copied: false
            });
            ids[i] = `M${_id}`;
        }
        await db.collection('messages').insertMany(docs, { ordered: false });
    }
    return ids;
}

/** Runs fn and checks it finished within the query time limit */
async function timed(fn) {
    const started = Date.now();
    const result = await fn();
    expect(Date.now() - started).to.be.below(QUERY_TIME_LIMIT);
    return result;
}

describe('Email/query on large accounts (email-query.yaml)', function () {
    this.timeout(180000); // eslint-disable-line no-invalid-this

    describe('limit', () => {
        let ctx;
        let big, small;
        before(async () => {
            ctx = await setup(['Big', 'Small']);
            big = await bulkMessages(ctx.user, MAX_LIMIT + 10, () => ({ mailbox: ctx.boxes.Big.id, thread: new seed.ObjectId() }));
            small = await bulkMessages(ctx.user, 3, () => ({ mailbox: ctx.boxes.Small.id, thread: new seed.ObjectId() }));
        });
        const onBig = args => query(ctx, Object.assign({ filter: { inMailbox: ctx.mailbox('Big') }, sort: DESC }, args));

        scenario('EQRY-125', async () => {
            const above = await onBig({ limit: MAX_LIMIT + 1 });
            expect(above.ids).to.have.lengthOf(MAX_LIMIT);
            expect(above.limit).to.equal(MAX_LIMIT);

            const exact = await onBig({ limit: MAX_LIMIT });
            expect(exact.ids).to.have.lengthOf(MAX_LIMIT);
            expect(exact).to.not.have.property('limit');

            const rest = await onBig({ position: MAX_LIMIT, limit: MAX_LIMIT + 1 });
            expect(rest.ids).to.deep.equal(big.slice(0, 10).reverse());
        });

        scenario('EQRY-126', async () => {
            for (const args of [{ limit: null }, {}]) {
                const res = await onBig(args);
                expect(res.ids).to.have.lengthOf(MAX_LIMIT);
                expect(res.limit).to.equal(MAX_LIMIT);
            }
            const res = await query(ctx, { filter: { inMailbox: ctx.mailbox('Small') } });
            expect(res.ids).to.have.members(small);
            expect(res.limit).to.equal(MAX_LIMIT);
        });
    });

    describe('one large mailbox', () => {
        const COUNT = 100000;
        let ctx;
        let seeded;
        before(async () => {
            ctx = await setup(['Large']);
            seeded = await bulkMessages(ctx.user, COUNT, () => ({ mailbox: ctx.boxes.Large.id, thread: new seed.ObjectId() }));
        });

        scenario('EQRY-162', async () => {
            // newest first: index k of the result is seeded message COUNT - 1 - k
            const order = k => seeded[COUNT - 1 - k];
            const slice = (from, to) => Array.from({ length: to - from }, (item, k) => order(from + k));
            const run = args => timed(() => query(ctx, Object.assign({ filter: { inMailbox: ctx.mailbox('Large') }, sort: DESC, calculateTotal: true }, args)));

            const cases = [
                [{ position: 0, limit: 50 }, slice(0, 50), 0],
                [{ position: 99950, limit: 50 }, slice(99950, 100000), 99950],
                [{ position: -50 }, slice(99950, 100000), 99950],
                [{ anchor: order(50000), anchorOffset: -25, limit: 50 }, slice(49975, 50025), 49975]
            ];
            for (const [args, expected, position] of cases) {
                const res = await run(args);
                expect(res.ids, JSON.stringify(args)).to.deep.equal(expected);
                expect(res.position, JSON.stringify(args)).to.equal(position);
                expect(res.total).to.equal(COUNT);
            }
        });
    });

    describe('a large account', () => {
        const COUNT = 100000;
        let ctx;
        let seeded;
        let mailboxOf;
        before(async () => {
            const paths = Array.from({ length: 198 }, (item, i) => `Folder ${String(i).padStart(3, '0')}`);
            ctx = await setup();
            const queue = [...paths];
            await Promise.all(
                Array.from({ length: 10 }, async () => {
                    while (queue.length) {
                        await api('POST', `/users/${ctx.user.id}/mailboxes`, { path: queue.pop() });
                    }
                })
            );
            ctx.boxes = await accounts.mailboxes(ctx.user);
            const all = [...new Set(Object.values(ctx.boxes).map(box => box.id))].filter(id => id !== ctx.boxes.INBOX.id);
            expect(all).to.have.lengthOf(202);
            const used = all.filter(id => ![ctx.boxes['\\Sent'].id, ctx.boxes['\\Drafts'].id].includes(id));
            expect(used).to.include(ctx.boxes['\\Trash'].id).and.include(ctx.boxes['\\Junk'].id);
            const threads = Array.from({ length: COUNT / 2 }, () => new seed.ObjectId());
            // 200 mailboxes, every thread has two messages next to each other in time
            mailboxOf = i => used[i % used.length];
            seeded = await bulkMessages(ctx.user, COUNT, i => ({ mailbox: mailboxOf(i), thread: threads[Math.floor(i / 2)] }));
        });

        scenario('EQRY-163', async () => {
            const newest = (count, keep = () => true, collapse = false) => {
                const result = [];
                for (let i = COUNT - 1; i >= 0 && result.length < count; i--) {
                    // the newer message of a thread pair has the odd index
                    if (keep(i) && (!collapse || i % 2 === 1)) {
                        result.push(seeded[i]);
                    }
                }
                return result;
            };
            const junk = [ctx.boxes['\\Trash'].id, ctx.boxes['\\Junk'].id];
            const cases = [
                [{}, newest(50), COUNT],
                [{ collapseThreads: true }, newest(50, undefined, true), COUNT / 2],
                [
                    { filter: { inMailboxOtherThan: [ctx.mailbox('\\Trash'), ctx.mailbox('\\Junk')] } },
                    newest(50, i => !junk.includes(mailboxOf(i))),
                    seeded.filter((id, i) => !junk.includes(mailboxOf(i))).length
                ]
            ];
            for (const [args, expected, total] of cases) {
                for (const calculateTotal of [false, true]) {
                    const res = await timed(() => query(ctx, Object.assign({ sort: DESC, limit: 50, calculateTotal }, args)));
                    expect(res.ids, JSON.stringify(args)).to.deep.equal(expected);
                    if (calculateTotal) {
                        expect(res.total, JSON.stringify(args)).to.equal(total);
                    }
                }
            }
        });

        scenario('EQRY-164', async () => {
            // a JMAP service on the same database whose query time limit is far too short for an
            // unindexed header search over the whole account
            const database = await seed.db();
            const redis = new Redis(typeof config.dbs.redis === 'string' ? redisUrl(config.dbs.redis) : config.dbs.redis);
            const queryTimeout = 5;
            // the service logs the expired query, keep the test output clean
            const logLevel = log.level;
            log.level = 'silent';
            try {
                const app = createApp(
                    {
                        database,
                        users: database,
                        redis,
                        userHandler: new UserHandler({ database, users: database, redis }),
                        modules: types.modules,
                        routes: types.routes
                    },
                    Object.assign({}, config.jmap, {
                        queryTimeout,
                        accessSecret: config.api.accessControl.secret,
                        roles: config.api.roles,
                        tokenLifetime: config.api.accessControl.tokenLifetime
                    })
                );
                const token = await accounts.createToken(ctx.user);
                const accountId = `u${ctx.user.id}`;
                const started = Date.now();
                const res = await app.inject({
                    method: 'POST',
                    url: '/jmap/api',
                    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                    payload: JSON.stringify({
                        using: [jmap.URN.core, jmap.URN.mail],
                        methodCalls: [
                            ['Core/echo', { hello: 'world' }, 'e'],
                            ['Email/query', { accountId, filter: { header: ['X-Rare', 'value'] } }, 'q'],
                            ['Mailbox/get', { accountId, ids: [ctx.mailbox('INBOX')] }, 'm']
                        ]
                    })
                });
                const elapsed = Date.now() - started;
                expect(res.statusCode).to.equal(200);
                const [echo, failed, mailboxes] = JSON.parse(res.body).methodResponses;
                expect(echo).to.deep.equal(['Core/echo', { hello: 'world' }, 'e']);
                expect(failed[0]).to.equal('error');
                expect(failed[1].type).to.equal('serverUnavailable');
                expect(failed[1]).to.not.have.property('ids');
                expect(failed[2]).to.equal('q');
                expect(mailboxes[0]).to.equal('Mailbox/get');
                expect(mailboxes[1].list).to.have.lengthOf(1);
                // the limit plus a margin for the other calls and the request itself
                expect(elapsed).to.be.below(queryTimeout + 2000);
                await app.close();
            } finally {
                log.level = logLevel;
                redis.disconnect();
            }
        });
    });
});
