/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

// The response serializer must never enforce `required`: fast-json-stringify
// THROWS on a missing required key, which would turn one incomplete database
// document into a 500 for a whole listing. attachNativeRoutes installs a
// serializer compiler that strips the constraint (the published OpenAPI schemas
// keep it, they are read from a different object).

const expect = require('chai').expect;
const fastJson = require('fast-json-stringify');
const log = require('npmlog');
const { stripResponseRequired, compileResponseSerializer } = require('../../lib/fastify/routes');

describe('Response schema required strip', () => {
    it('should drop required from the top level of a model', () => {
        const stripped = stripResponseRequired({
            type: 'object',
            properties: { success: { type: 'boolean' }, created: { type: 'string' } },
            required: ['success', 'created']
        });

        expect(stripped.required).to.be.undefined;
        expect(Object.keys(stripped.properties)).to.deep.equal(['success', 'created']);
    });

    it('should drop required from nested objects and array items', () => {
        const stripped = stripResponseRequired({
            type: 'object',
            properties: {
                results: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { id: { type: 'string' }, meta: { type: 'object', properties: {}, required: ['x'] } },
                        required: ['id']
                    }
                }
            },
            required: ['results']
        });

        expect(stripped.required).to.be.undefined;
        expect(stripped.properties.results.items.required).to.be.undefined;
        expect(stripped.properties.results.items.properties.meta.required).to.be.undefined;
    });

    it('should keep a response field that is itself named "required"', () => {
        // the keyword is an array, a property of that name holds a schema object
        const stripped = stripResponseRequired({
            type: 'object',
            properties: { required: { type: 'boolean', description: 'Is this entry required' } },
            required: ['required']
        });

        expect(stripped.required).to.be.undefined;
        expect(stripped.properties.required).to.deep.equal({ type: 'boolean', description: 'Is this entry required' });
    });

    it('should not mutate the model the OpenAPI documents are built from', () => {
        const model = {
            type: 'object',
            properties: { success: { type: 'boolean' } },
            required: ['success']
        };

        stripResponseRequired(model);

        expect(model.required).to.deep.equal(['success']);
    });

    it('should serialize a payload missing a declared required key instead of throwing', () => {
        const model = {
            type: 'object',
            properties: { success: { type: 'boolean' }, created: { type: 'string' } },
            required: ['success', 'created']
        };

        // what the route would do without the strip
        expect(() => fastJson(model)({ success: true })).to.throw(/required/);

        const serialize = fastJson(stripResponseRequired(model));
        expect(JSON.parse(serialize({ success: true }))).to.deep.equal({ success: true });
    });

    describe('compileResponseSerializer', () => {
        const route = {
            method: 'GET',
            url: '/example',
            httpStatus: '200',
            schema: {
                type: 'object',
                properties: { success: { type: 'boolean' }, count: { type: 'integer' } },
                required: ['success']
            }
        };
        let originalWarn;
        let warnings;

        beforeEach(() => {
            originalWarn = log.warn;
            warnings = [];
            log.warn = (...args) => warnings.push(args);
        });

        afterEach(() => {
            log.warn = originalWarn;
        });

        it('should serialize through the model when the payload fits', () => {
            const serialize = compileResponseSerializer(route, {});

            expect(JSON.parse(serialize({ success: true, count: 3, extra: 'x' }))).to.deep.equal({ success: true, count: 3 });
            expect(warnings).to.be.empty;
        });

        it('should fall back to plain JSON and log when a value does not fit the model', () => {
            const serialize = compileResponseSerializer(route, {});
            const payload = { success: true, count: 'abc' };

            expect(() => fastJson(stripResponseRequired(route.schema))(payload)).to.throw(/integer/);
            expect(JSON.parse(serialize(payload))).to.deep.equal(payload);
            expect(warnings).to.have.lengthOf(1);
            expect(warnings[0].slice(2, 5)).to.deep.equal(['GET', '/example', '200']);
        });
    });
});
