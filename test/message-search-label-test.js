/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const registerMessages = require('../lib/api/messages');
const { prepareSearchFilter } = require('../lib/prepare-search-filter');
const { parseSearchQuery, getMongoDBQuery } = require('../lib/search-query');
const { compileRouteValidator } = require('../lib/fastify/validation');
require('../lib/schemas/json-schemas'); // registers the shared wd:* schemas

// validates one request part on its own, the way the merged route validator sees it
const validatePart = (part, schema, input) => compileRouteValidator({ [part]: schema })(input);

describe('Message search label validation', () => {
    const routes = [];
    // captures native fastify route registrations: server.route({method, url, config, handler})
    const server = {
        route(options) {
            routes.push({ method: options.method.toLowerCase(), options: { path: options.url, validationObjs: options.config.validationObjs } });
        },
        get() {},
        post() {},
        put() {},
        delete() {}
    };
    const database = {
        collection() {
            return {};
        }
    };
    registerMessages({ database, senderDb: database }, server, { put() {}, update() {} }, {}, {}, {});
    const createLabel = routes.find(route => route.method === 'post' && route.options.path === '/users/:user/labels');

    for (const method of ['get', 'post']) {
        const route = routes.find(entry => entry.method === method && entry.options.path === '/users/:user/search');
        const part = method === 'get' ? 'queryParams' : 'requestBody';
        const schema = route.options.validationObjs[part];

        for (const name of [' Projects ', '   ']) {
            it(`${method.toUpperCase()} /users/:user/search preserves the label name ${JSON.stringify(name)}`, async () => {
                const created = validatePart('requestBody', { name: createLabel.options.validationObjs.requestBody.name }, { name });
                expect(created.error).not.to.exist;
                expect(created.value.name).to.equal(name);
                const validated = validatePart(part, schema, { label: name, ...(method === 'post' ? { action: { seen: true } } : {}) });
                expect(validated.error).not.to.exist;
                expect(validated.value.label).to.equal(name);

                const user = new ObjectId();
                const label = new ObjectId();
                const db = {
                    users: {
                        collection() {
                            return {
                                async findOne() {
                                    return { _id: user };
                                }
                            };
                        }
                    },
                    database: {
                        collection(collection) {
                            expect(collection).to.equal('labels');
                            return {
                                async findOne(query) {
                                    expect(query).to.deep.equal({ user, name, deleting: { $ne: true } });
                                    return { _id: label };
                                }
                            };
                        }
                    }
                };
                const { filter } = await prepareSearchFilter(db, user, validated.value);
                expect(filter.labels).to.equal(label);
            });
        }

        it(`${method.toUpperCase()} /users/:user/search accepts an omitted or empty label filter`, () => {
            for (const input of [{}, { label: '' }]) {
                const result = validatePart(part, schema, { ...input, ...(method === 'post' ? { action: { seen: true } } : {}) });
                expect(result.error).not.to.exist;
                expect(result.value.label).to.equal(undefined);
            }
        });
    }
});

describe('Message search label expressions', () => {
    const user = new ObjectId();
    const work = new ObjectId('507f1f77bcf86cd799439011');
    const urgent = new ObjectId();
    const missing = new ObjectId('0'.repeat(24));
    const foreign = new ObjectId();
    const deleting = new ObjectId();
    const labelRecords = [
        { _id: work, user },
        { _id: urgent, user },
        { _id: foreign, user: new ObjectId() },
        { _id: deleting, user, deleting: true }
    ];
    const labels = new Map([
        ['Work', work],
        ['Urgent', urgent],
        [' Projects ', work],
        ['   ', work],
        ['Sub (dub)', work],
        ['Projects AND Stuff', work],
        [work.toString(), urgent],
        [` ${work} `, urgent],
        ['g'.repeat(24), urgent]
    ]);
    const db = {
        database: {
            collection(name) {
                expect(name).to.equal('labels');
                return {
                    async findOne(query, options) {
                        expect(query.user).to.equal(user);
                        expect(query.deleting).to.deep.equal({ $ne: true });
                        expect(options).to.deep.equal({ projection: { _id: true } });
                        if (query._id) {
                            expect(query).not.to.have.property('name');
                            expect(query._id).to.be.instanceOf(ObjectId);
                            return labelRecords.find(record => record._id.equals(query._id) && record.user.equals(query.user) && !record.deleting) || null;
                        }
                        const id = labels.get(query.name);
                        return id ? { _id: id } : null;
                    }
                };
            }
        }
    };

    it('matches either label with OR', async () => {
        expect(await getMongoDBQuery(db, user, 'label:Work OR label:Urgent')).to.deep.equal({
            user,
            $and: [{ $or: [{ labels: work }, { labels: urgent }] }]
        });
    });

    it('requires both labels with explicit or implicit AND', async () => {
        for (const q of ['label:Work AND label:Urgent', 'label:Work label:Urgent']) {
            expect(await getMongoDBQuery(db, user, q)).to.deep.equal({ user, $and: [{ labels: work }, { labels: urgent }] });
        }
    });

    it('resolves label IDs, including uppercase and quoted IDs', async () => {
        for (const value of [work.toString(), work.toString().toUpperCase(), `"${work}"`]) {
            expect(await getMongoDBQuery(db, user, `label:${value}`)).to.deep.equal({ user, $and: [{ labels: work }] });
        }
    });

    it('combines label IDs and names with OR and AND', async () => {
        for (const value of ['Urgent', urgent.toString()]) {
            expect(await getMongoDBQuery(db, user, `label:${work} OR label:${value}`)).to.deep.equal({
                user,
                $and: [{ $or: [{ labels: work }, { labels: urgent }] }]
            });
            expect(await getMongoDBQuery(db, user, `label:${work} AND label:${value}`)).to.deep.equal({
                user,
                $and: [{ labels: work }, { labels: urgent }]
            });
        }
        expect(await getMongoDBQuery(db, user, `-label:${work}`)).to.deep.equal({ user, $and: [{ $nor: [{ labels: work }] }] });
    });

    it('matches values that are not exact ObjectId strings as names', async () => {
        for (const name of [` ${work} `, 'g'.repeat(24)]) {
            expect(await getMongoDBQuery(db, user, `label:"${name}"`)).to.deep.equal({ user, $and: [{ labels: urgent }] });
        }
    });

    it('keeps unknown, foreign, and deleting label IDs as nonmatching branches', async () => {
        for (const id of [new ObjectId(), foreign, deleting]) {
            expect(await getMongoDBQuery(db, user, `label:${id}`)).to.deep.equal({ user, $and: [{ labels: missing }] });
            expect(await getMongoDBQuery(db, user, `label:Work OR label:${id}`)).to.deep.equal({
                user,
                $and: [{ $or: [{ labels: work }, { labels: missing }] }]
            });
            expect(await getMongoDBQuery(db, user, `label:Work AND label:${id}`)).to.deep.equal({
                user,
                $and: [{ labels: work }, { labels: missing }]
            });
            expect(await getMongoDBQuery(db, user, `-label:${id}`)).to.deep.equal({ user, $and: [{ $nor: [{ labels: missing }] }] });
        }
    });

    it('combines grouped labels with other search criteria', async () => {
        expect(await getMongoDBQuery(db, user, '(label:Work OR label:Urgent) is:unread')).to.deep.equal({
            user,
            $and: [{ $or: [{ labels: work }, { labels: urgent }] }, { unseen: true, searchable: true }]
        });
    });

    for (const name of [' Projects ', '   ', 'Sub (dub)', 'Projects AND Stuff']) {
        it(`preserves the exact quoted label name ${JSON.stringify(name)}`, async () => {
            const q = `label:"${name}"`;
            expect(parseSearchQuery(q)[0].keywords.label).to.deep.equal({ value: name, negated: false });
            expect(await getMongoDBQuery(db, user, q)).to.deep.equal({ user, $and: [{ labels: work }] });
            expect(await getMongoDBQuery(db, user, `${q} OR label:Urgent`)).to.deep.equal({
                user,
                $and: [{ $or: [{ $and: [{ labels: work }] }, { labels: urgent }] }]
            });
        });
    }

    it('negates a label assignment', async () => {
        expect(await getMongoDBQuery(db, user, 'label:Work AND -label:Urgent')).to.deep.equal({
            user,
            $and: [{ labels: work }, { $nor: [{ labels: urgent }] }]
        });
        expect(await getMongoDBQuery(db, user, '-label:" Projects "')).to.deep.equal({ user, $and: [{ $nor: [{ labels: work }] }] });
    });

    it('keeps unknown, deleting, and differently cased names as nonmatching branches', async () => {
        for (const name of ['Unknown', 'Deleting', 'work']) {
            expect(await getMongoDBQuery(db, user, `label:Work OR label:${name}`)).to.deep.equal({
                user,
                $and: [{ $or: [{ labels: work }, { labels: missing }] }]
            });
            expect(await getMongoDBQuery(db, user, `label:Work AND label:${name}`)).to.deep.equal({
                user,
                $and: [{ labels: work }, { labels: missing }]
            });
            expect(await getMongoDBQuery(db, user, `-label:${name}`)).to.deep.equal({ user, $and: [{ $nor: [{ labels: missing }] }] });
        }
    });

    it('preserves the user index prefix when combining label and fulltext alternatives', async () => {
        expect(await getMongoDBQuery(db, user, 'label:Work OR invoice')).to.deep.equal({
            user,
            searchable: true,
            $and: [{ $or: [{ labels: work, user }, { $text: { $search: 'invoice' }, user }] }]
        });
    });
});

describe('Message search label resolution', () => {
    const NO_MATCH = new ObjectId('0'.repeat(24));

    // Serve only active labels owned by the searched user.
    const createLabelsDb = records => {
        const user = new ObjectId();
        records = records.map(record => ({ user, ...record }));
        return {
            user,
            db: {
                users: {
                    collection() {
                        return {
                            async findOne() {
                                return { _id: user };
                            }
                        };
                    }
                },
                database: {
                    collection(collectionName) {
                        expect(collectionName).to.equal('labels');
                        return {
                            async findOne(query) {
                                expect(query.user).to.equal(user);
                                expect(query.deleting).to.deep.equal({ $ne: true });
                                const record = records.find(
                                    entry =>
                                        entry.user.equals(query.user) &&
                                        entry.deleting !== true &&
                                        (query._id ? entry._id.equals(query._id) : entry.name === query.name)
                                );
                                return record ? { _id: record._id } : null;
                            }
                        };
                    }
                }
            }
        };
    };

    it('resolves the structured label filter by label id', async () => {
        const labelId = new ObjectId();
        const { user, db } = createLabelsDb([{ _id: labelId, name: 'Projects' }]);
        const { filter } = await prepareSearchFilter(db, user, { label: labelId.toString() });
        expect(filter.labels).to.equal(labelId);
    });

    it('prefers the label id over a label named with that id', async () => {
        const labelId = new ObjectId();
        const hexName = labelId.toString();
        const { user, db } = createLabelsDb([
            { _id: labelId, name: 'Real Label' },
            { _id: new ObjectId(), name: hexName }
        ]);
        const { filter } = await prepareSearchFilter(db, user, { label: hexName });
        expect(filter.labels).to.equal(labelId);
    });

    it('falls back to the name lookup when the label id does not exist', async () => {
        const labelId = new ObjectId();
        const hexName = new ObjectId().toString();
        const { user, db } = createLabelsDb([{ _id: labelId, name: hexName }]);
        const { filter } = await prepareSearchFilter(db, user, { label: hexName });
        expect(filter.labels).to.equal(labelId);
    });

    it('falls back to the name lookup when the label id is being deleted', async () => {
        const dyingLabelId = new ObjectId();
        const hexName = dyingLabelId.toString();
        const fallbackLabelId = new ObjectId();
        const { user, db } = createLabelsDb([
            { _id: dyingLabelId, name: 'Dying Label', deleting: true },
            { _id: fallbackLabelId, name: hexName }
        ]);
        const { filter } = await prepareSearchFilter(db, user, { label: hexName });
        expect(filter.labels).to.equal(fallbackLabelId);
    });

    for (const status of ['missing', 'foreign', 'deleting']) {
        it(`uses the exact hex-name fallback for structured and q searches when the ID is ${status}`, async () => {
            const id = new ObjectId();
            const fallbackId = new ObjectId();
            const records = [{ _id: fallbackId, name: id.toString() }];
            if (status !== 'missing') {
                records.push({ _id: id, name: 'Unavailable', ...(status === 'foreign' ? { user: new ObjectId() } : { deleting: true }) });
            }
            const { user, db } = createLabelsDb(records);
            expect((await prepareSearchFilter(db, user, { label: id.toString() })).filter.labels).to.equal(fallbackId);
            for (const value of [id.toString(), `"${id}"`]) {
                expect(await getMongoDBQuery(db, user, `label:${value}`)).to.deep.equal({ user, $and: [{ labels: fallbackId }] });
                expect(await getMongoDBQuery(db, user, `-label:${value}`)).to.deep.equal({ user, $and: [{ $nor: [{ labels: fallbackId }] }] });
            }
        });
    }

    for (const status of ['foreign', 'deleting']) {
        it(`does not resolve a ${status} label through either ID or name fallback`, async () => {
            const id = new ObjectId();
            const records = [
                { _id: id, name: 'Unavailable' },
                { _id: new ObjectId(), name: id.toString() }
            ].map(record => ({ ...record, ...(status === 'foreign' ? { user: new ObjectId() } : { deleting: true }) }));
            const { user, db } = createLabelsDb(records);
            for (const value of [id.toString(), 'Unavailable']) {
                expect((await prepareSearchFilter(db, user, { label: value })).filter.labels).to.deep.equal(NO_MATCH);
                expect(await getMongoDBQuery(db, user, `label:${value}`)).to.deep.equal({ user, $and: [{ labels: NO_MATCH }] });
            }
        });
    }

    it('keeps the no-results sentinel when neither id nor name resolves', async () => {
        const labelId = new ObjectId();
        const { user, db } = createLabelsDb([{ _id: labelId, name: 'Projects' }]);
        const byId = await prepareSearchFilter(db, user, { label: new ObjectId().toString() });
        expect(byId.filter.labels).to.deep.equal(NO_MATCH);
        const byName = await prepareSearchFilter(db, user, { label: 'No Such Label' });
        expect(byName.filter.labels).to.deep.equal(NO_MATCH);
    });
});
