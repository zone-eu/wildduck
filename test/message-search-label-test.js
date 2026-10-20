/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const Joi = require('joi');
const { ObjectId } = require('mongodb');
const registerMessages = require('../lib/api/messages');
const { prepareSearchFilter } = require('../lib/prepare-search-filter');

describe('Message search label validation', () => {
    const routes = [];
    const server = Object.fromEntries(['get', 'post', 'put', 'del'].map(method => [method, options => routes.push({ method, options })]));
    const database = { collection() { return {}; } };
    registerMessages({ database, senderDb: database }, server, { put() {}, update() {} }, {}, {}, {});
    const createLabel = routes.find(route => route.method === 'post' && route.options.path === '/users/:user/labels');

    for (const method of ['get', 'post']) {
        const route = routes.find(entry => entry.method === method && entry.options.path === '/users/:user/search');
        const schema = method === 'get' ? route.options.validationObjs.queryParams : route.options.validationObjs.requestBody;

        for (const name of [' Projects ', '   ']) {
            it(`${method.toUpperCase()} /users/:user/search preserves the label name ${JSON.stringify(name)}`, async () => {
                const created = createLabel.options.validationObjs.requestBody.name.validate(name);
                expect(created.error).not.to.exist;
                expect(created.value).to.equal(name);
                const validated = Joi.object(schema).validate({ label: name, ...(method === 'post' ? { action: { seen: true } } : {}) });
                expect(validated.error).not.to.exist;
                expect(validated.value.label).to.equal(name);

                const user = new ObjectId();
                const label = new ObjectId();
                const db = {
                    users: { collection() { return { async findOne() { return { _id: user }; } }; } },
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
                const result = Joi.object(schema).validate({ ...input, ...(method === 'post' ? { action: { seen: true } } : {}) });
                expect(result.error).not.to.exist;
                expect(result.value.label).to.equal(undefined);
            }
        });
    }
});
