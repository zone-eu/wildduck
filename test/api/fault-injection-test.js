/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

// Database outages, in-process with app.inject(): the MongoDB and Redis clients
// the app shares with this process are patched to fail, and the API must
// answer with an error reply instead of hanging, crashing or succeeding with
// partial data. An access token check that can not reach Redis must refuse.

const chai = require('chai');
const mongodb = require('mongodb');
const db = require('../../lib/db');
const MessageHandler = require('../../lib/message-handler');
const { buildApp } = require('./_inprocess');
const { createFixtures } = require('./_fixtures');
const { createRoleToken, deleteRoleToken } = require('./_helpers');
const { createRandom, buildRequest, toInject, withTimeout } = require('./_route-requests');

const expect = chai.expect;

const REQUEST_TIMEOUT = 10000;

// read routes left out: who-am-i answers from the token alone, health has its
// own tests above and the event stream never ends
const NO_DATABASE_ROUTES = new Set(['/authenticated', '/health', '/users/:user/updates']);

// replaces methods for the duration of a test, see restoreAll()
const patches = [];
const patch = (target, name, replacement) => {
    const own = Object.hasOwn(target, name);
    patches.push({ target, name, own, original: target[name] });
    target[name] = replacement;
};
const restoreAll = () => {
    while (patches.length) {
        const { target, name, own, original } = patches.pop();
        if (own) {
            target[name] = original;
        } else {
            delete target[name];
        }
    }
};

const outage = () => {
    const err = new Error('connection refused (injected)');
    err.name = 'MongoNetworkError';
    return err;
};

// every MongoDB operation the API uses rejects, cursors included
const breakMongo = () => {
    const failing = async () => {
        throw outage();
    };
    for (const name of [
        'findOne',
        'insertOne',
        'insertMany',
        'updateOne',
        'updateMany',
        'deleteOne',
        'deleteMany',
        'findOneAndUpdate',
        'findOneAndDelete',
        'countDocuments',
        'distinct',
        'bulkWrite'
    ]) {
        patch(mongodb.Collection.prototype, name, failing);
    }
    for (const name of ['next', 'hasNext', 'toArray', 'tryNext']) {
        patch(mongodb.AbstractCursor.prototype, name, failing);
    }
    patch(mongodb.Db.prototype, 'command', failing);
};

describe('API under database outages', function () {
    this.timeout(5 * 60 * 1000); // eslint-disable-line no-invalid-this

    let app;
    let routes;
    let fixtures;

    before(async () => {
        ({ app, routes } = await buildApp());
        fixtures = await createFixtures(app, 'fi');
    });

    afterEach(restoreAll);

    after(async () => {
        if (fixtures) {
            await fixtures.cleanup();
        }
        if (app) {
            await app.close();
        }
    });

    describe('GET /health', () => {
        const health = async () => {
            const res = await withTimeout(app.inject({ method: 'GET', url: '/health' }), 15000);
            return { status: res.statusCode, body: res.json() };
        };

        it('reports MongoDB down when the ping fails', async () => {
            patch(db.database, 'command', async () => {
                throw outage();
            });
            const { status, body } = await health();
            expect(status).to.equal(500);
            expect(body).to.include({ success: false, message: 'DB is down' });
        });

        it('reports MongoDB down when the ping is not ok', async () => {
            patch(db.database, 'command', async () => ({ ok: 0 }));
            const { status, body } = await health();
            expect(status).to.equal(500);
            expect(body.message).to.equal('DB is down');
        });

        it('reports MongoDB read-only when the write check fails', async () => {
            patch(mongodb.Collection.prototype, 'insertOne', async () => {
                throw outage();
            });
            const { status, body } = await health();
            expect(status).to.equal(500);
            expect(body.message).to.equal('Could not write to DB');
        });

        it('reports Redis down when the ping fails', async () => {
            patch(db.redis, 'ping', async () => {
                throw new Error('redis gone (injected)');
            });
            const { status, body } = await health();
            expect(status).to.equal(500);
            expect(body.message).to.equal('Redis is down');
        });

        it('reports Redis read-only when the write check fails', async () => {
            patch(db.redis, 'hset', async () => {
                throw new Error('redis read-only (injected)');
            });
            const { status, body } = await health();
            expect(status).to.equal(500);
            expect(body.message).to.equal('Redis is not writeable/readable');
        });

        it('reports healthy again once the services are back', async () => {
            const { status, body } = await health();
            expect(status).to.equal(200);
            expect(body.success).to.be.true;
        });
    });

    describe('access token check', () => {
        it('refuses a valid token while Redis can not be read', async () => {
            const { accessToken, tokenHash } = await createRoleToken('user', fixtures.ids.user);
            try {
                patch(db.redis, 'hgetall', async () => {
                    throw new Error('redis gone (injected)');
                });
                const res = await app.inject({ method: 'GET', url: `/users/${fixtures.ids.user}`, headers: { 'x-access-token': accessToken } });
                expect(res.statusCode).to.equal(500);
                expect(res.json()).to.include({ code: 'InternalDatabaseError' });
            } finally {
                await deleteRoleToken(tokenHash);
            }
        });

        it('refuses a valid token while the account can not be read', async () => {
            const { accessToken, tokenHash } = await createRoleToken('user', fixtures.ids.user);
            try {
                patch(mongodb.Collection.prototype, 'findOne', async () => {
                    throw outage();
                });
                const res = await app.inject({ method: 'GET', url: `/users/${fixtures.ids.user}`, headers: { 'x-access-token': accessToken } });
                expect(res.statusCode).to.be.within(500, 599);
                expect(res.json().code).to.be.a('string');
            } finally {
                await deleteRoleToken(tokenHash);
            }
        });
    });

    it('answers every read route with an error reply while MongoDB is down', async () => {
        const failures = [];
        const unhandled = [];
        const onUnhandled = err => unhandled.push(err && err.message);
        process.on('unhandledRejection', onUnhandled);

        let checked = 0;
        try {
            for (const route of routes) {
                if (route.method !== 'GET' || NO_DATABASE_ROUTES.has(route.url)) {
                    continue;
                }

                // the request is built while MongoDB still works
                const request = buildRequest(route, { rnd: createRandom(1), fixtures, optionalChance: 0 });

                breakMongo();
                let res;
                try {
                    res = await withTimeout(app.inject(toInject(route, request)), REQUEST_TIMEOUT);
                } catch (err) {
                    failures.push(`${route.url}: ${err.message}`);
                    continue;
                } finally {
                    restoreAll();
                }
                checked++;

                if (res.statusCode < 400) {
                    // nothing behind these routes can be answered without the database
                    failures.push(`${route.url}: answered ${res.statusCode} while MongoDB was down`);
                    continue;
                }

                let body;
                try {
                    body = res.json();
                } catch {
                    failures.push(`${route.url}: ${res.statusCode} without a JSON body`);
                    continue;
                }
                if (typeof body.code !== 'string' || !(typeof body.error === 'string' || typeof body.message === 'string')) {
                    failures.push(`${route.url}: ${res.statusCode} with an error body that has no code: ${res.body.slice(0, 120)}`);
                }
                if (/\n\s+at /.test(res.body)) {
                    failures.push(`${route.url}: the reply contains a stack trace`);
                }
            }
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }

        expect(checked).to.be.greaterThan(40);
        expect(unhandled, 'unhandled rejections').to.deep.equal([]);
        expect(failures, failures.join('\n')).to.deep.equal([]);
    });

    it('answers a failed mark-as-seen with an error reply instead of a 200', async () => {
        patch(MessageHandler.prototype, 'updateAsync', async () => {
            throw outage();
        });

        // only an unseen message gets marked, so make sure the fixture message is one
        await db.database
            .collection('messages')
            .updateOne({ mailbox: new mongodb.ObjectId(fixtures.ids.mailbox), uid: fixtures.path.message }, { $set: { unseen: true } });

        const res = await app.inject({
            method: 'GET',
            url: `/users/${fixtures.ids.user}/mailboxes/${fixtures.ids.mailbox}/messages/${fixtures.path.message}?markAsSeen=true`
        });
        expect(res.statusCode).to.equal(500);
        expect(res.json()).to.include({ code: 'InternalError' });
    });
});
