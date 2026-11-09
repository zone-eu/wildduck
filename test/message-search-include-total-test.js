/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const fastify = require('fastify');
const { ObjectId } = require('mongodb');
const registerMessages = require('../lib/api/messages');
const { attachNativeRoutes } = require('../lib/fastify/routes');
const { sharedSchemas } = require('../lib/fastify/validation');

// Exercise the real GET route, validation, serialization and paging wrappers.
// Only database reads are replaced with a small, ordered set of distinct threads.
function createSearch({ failCount = false, empty = false } = {}) {
    const user = new ObjectId('507f1f77bcf86cd799439010');
    const mailbox = new ObjectId('507f1f77bcf86cd799439011');
    const messages = empty
        ? []
        : [3, 2, 1].map(uid => ({
              _id: new ObjectId(`507f1f77bcf86cd79943902${uid}`),
              thread: new ObjectId(`507f1f77bcf86cd79943903${uid}`),
              user,
              mailbox,
              uid,
              flags: [],
              subject: `Message ${uid}`,
              idate: new Date(`2026-01-0${uid}T00:00:00.000Z`)
          }));
    const counts = [];
    const pipelines = [];
    const cacheReads = [];
    const matches = (message, query) => {
        if (query.$and && !query.$and.every(part => matches(message, part))) {
            return false;
        }
        if (query.$or && !query.$or.some(part => matches(message, part))) {
            return false;
        }
        const id = query._id;
        return (
            !id ||
            ((!id.$in || id.$in.some(value => message._id.equals(value))) &&
                (!id.$lt || message._id.toString() < id.$lt.toString()) &&
                (!id.$gt || message._id.toString() > id.$gt.toString()))
        );
    };
    const pageRows = (query, sort, limit) => {
        const direction = sort._id || sort[Object.keys(sort)[0]];
        return messages
            .filter(message => matches(message, query))
            .sort((a, b) => direction * a._id.toString().localeCompare(b._id.toString()))
            .slice(0, limit)
            .map(message => ({ ...message }));
    };
    const collection = {
        async countDocuments(query) {
            counts.push(query);
            if (failCount) {
                throw new Error('Unexpected total count');
            }
            return messages.length;
        },
        find(query) {
            let sort = { _id: -1 };
            let limit = messages.length;
            const cursor = {
                project() {
                    return cursor;
                },
                sort(value) {
                    sort = value;
                    return cursor;
                },
                limit(value) {
                    limit = value;
                    return cursor;
                },
                toArray: async () => pageRows(query, sort, limit)
            };
            return cursor;
        },
        aggregate(pipeline, options) {
            // Thread state enrichment has no pagination options.
            if (!options) {
                return { toArray: async () => [] };
            }
            pipelines.push(pipeline);
            const facet = pipeline.find(stage => stage.$facet);
            const pagePipeline = facet ? facet.$facet.results : pipeline.slice(4);
            const query = pagePipeline.find(stage => stage.$match)?.$match || {};
            const sort = pagePipeline.find(stage => stage.$sort).$sort;
            const limit = pagePipeline.find(stage => stage.$limit).$limit;
            const results = pageRows(query, sort, limit);
            return { toArray: async () => (facet ? [{ total: [{ value: messages.length }], results }] : results) };
        }
    };
    const database = {
        collection(name) {
            return name === 'messages' ? collection : {};
        }
    };
    const db = {
        database,
        senderDb: database,
        users: { collection: () => ({ findOne: async () => ({ _id: user }) }) },
        redis: {
            async get(key) {
                cacheReads.push(key);
                if (failCount) {
                    throw new Error('Unexpected cached total lookup');
                }
                return String(messages.length);
            }
        }
    };
    const app = fastify();
    for (const schema of sharedSchemas.values()) {
        app.addSchema(schema);
    }
    app.decorateRequest('role', 'root');
    app.decorateRequest('validate', () => {});
    attachNativeRoutes(app, {});
    const routes = [];
    registerMessages(
        db,
        {
            route(route) {
                routes.push(route);
                if (route.method === 'GET' && route.url === '/users/:user/search') {
                    app.route(route);
                }
            },
            loggelf() {}
        },
        {},
        {},
        {},
        {}
    );
    return {
        app,
        routes,
        counts,
        pipelines,
        cacheReads,
        run: query => app.inject({ method: 'GET', url: `/users/${user}/search`, query: { mailbox: mailbox.toString(), limit: '1', ...query } })
    };
}

describe('Message search optional total', () => {
    const apps = [];
    const searchApp = options => {
        const search = createSearch(options);
        apps.push(search.app);
        return search;
    };
    afterEach(async () => {
        await Promise.all(apps.splice(0).map(app => app.close()));
    });

    for (const collapseThreads of ['false', 'true']) {
        for (const includeTotal of [undefined, 'true', 'false']) {
            it(`preserves results and forward/backward cursors with collapseThreads=${collapseThreads}, includeTotal=${includeTotal}`, async () => {
                const baseline = searchApp();
                const search = searchApp({ failCount: includeTotal === 'false' });
                const query = { collapseThreads, ...(includeTotal === undefined ? {} : { includeTotal }) };
                let next;
                let previous;
                for (const pageQuery of [{}, { next: true }, { previous: true }]) {
                    const cursors = pageQuery.next ? { next } : pageQuery.previous ? { previous } : {};
                    const expected = await baseline.run({ collapseThreads, ...cursors });
                    const response = await search.run({ ...query, ...cursors });
                    expect(response.statusCode).to.equal(200);
                    const body = response.json();
                    const expectedBody = expected.json();
                    expect(expectedBody.total).to.equal(3);
                    if (includeTotal === 'false') {
                        expect(body).not.to.have.property('total');
                        delete expectedBody.total;
                    }
                    expect(body).to.deep.equal(expectedBody);
                    expect(body.results.map(message => message.id)).to.deep.equal([pageQuery.next ? 2 : 3]);
                    expect(body.page).to.equal(pageQuery.next ? 2 : 1);
                    if (!pageQuery.previous) {
                        next = body.nextCursor;
                        previous = body.previousCursor;
                    }
                }
                if (collapseThreads === 'true') {
                    expect(search.pipelines).to.have.length(3);
                    for (const pipeline of search.pipelines) {
                        expect(pipeline.some(stage => stage.$facet)).to.equal(includeTotal !== 'false');
                        if (includeTotal === 'false') {
                            expect(JSON.stringify(pipeline)).not.to.include('$count');
                        }
                    }
                    expect(search.counts).to.be.empty;
                } else {
                    expect(search.counts).to.have.length(includeTotal === 'false' ? 0 : 3);
                }
                expect(search.cacheReads).to.be.empty;
            });
        }

        it(`omits total for an empty page with collapseThreads=${collapseThreads}`, async () => {
            const search = searchApp({ empty: true, failCount: true });
            const response = await search.run({ includeTotal: 'false', collapseThreads });
            expect(response.statusCode).to.equal(200);
            expect(response.json()).to.include({ page: 1, previousCursor: false, nextCursor: false });
            expect(response.json().results).to.deep.equal([]);
            expect(response.json()).not.to.have.property('total');
            expect(search.counts).to.be.empty;
            expect(search.cacheReads).to.be.empty;
        });
    }

    for (const includeTotal of ['invalid', '2']) {
        it(`rejects an invalid boolean ${JSON.stringify(includeTotal)} through normal route validation`, async () => {
            const search = searchApp();
            const response = await search.run({ includeTotal });
            expect(response.statusCode).to.equal(400);
            expect(response.json().code).to.equal('InputValidationError');
            expect(response.json().details).to.have.property('includeTotal');
            expect(search.counts).to.be.empty;
            expect(search.pipelines).to.be.empty;
        });
    }

    it('declares includeTotal only on GET search and defaults it to true', () => {
        const { routes } = searchApp();
        const searches = routes.filter(route => route.url === '/users/:user/search');
        expect(searches.find(route => route.method === 'GET').config.validationObjs.queryParams.includeTotal).to.include({
            $ref: 'wd:boolean',
            default: true
        });
        expect(searches.find(route => route.method === 'POST').config.validationObjs.requestBody).not.to.have.property('includeTotal');
    });
});
