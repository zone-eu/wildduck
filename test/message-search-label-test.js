/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const registerMessages = require('../lib/api/messages');
const { prepareSearchFilter } = require('../lib/prepare-search-filter');
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
