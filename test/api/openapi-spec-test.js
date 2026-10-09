/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

// The OpenAPI document generated from the route definitions: it must be
// complete enough to publish, and it must not leak internal schema keywords.

const fs = require('fs');
const Path = require('path');
const chai = require('chai');
const fastify = require('fastify');
const { buildApp } = require('./_inprocess');
const { attachNativeRoutes } = require('../../lib/fastify/routes');

const expect = chai.expect;

describe('API OpenAPI specification', function () {
    this.timeout(30000); // eslint-disable-line no-invalid-this

    let app;
    let spec;
    let operations;

    before(async () => {
        ({ app } = await buildApp());
        spec = app.swagger();
        operations = [];
        for (const [path, methods] of Object.entries(spec.paths)) {
            for (const [method, operation] of Object.entries(methods)) {
                operations.push({ key: `${method.toUpperCase()} ${path}`, operation });
            }
        }
    });

    after(async () => {
        if (app) {
            await app.close();
        }
    });

    it('documents every operation with a summary, a description and a declared tag', () => {
        const declared = new Set(spec.tags.map(tag => tag.name));
        const problems = [];
        for (const { key, operation } of operations) {
            if (!operation.summary) {
                problems.push(`${key}: no summary`);
            }
            if (!operation.description) {
                problems.push(`${key}: no description`);
            }
            for (const tag of operation.tags || []) {
                if (!declared.has(tag)) {
                    problems.push(`${key}: undeclared tag ${tag}`);
                }
            }
        }
        expect(problems).to.deep.equal([]);
        expect(spec.tags.filter(tag => !tag.description).map(tag => tag.name)).to.deep.equal([]);
    });

    it('gives every response a description and the non-JSON responses their content type', () => {
        const generic = [];
        for (const { key, operation } of operations) {
            for (const [status, response] of Object.entries(operation.responses)) {
                if (response.description === 'Default Response') {
                    generic.push(`${key} ${status}`);
                }
            }
        }
        expect(generic).to.deep.equal([]);

        const source = spec.paths['/users/{user}/mailboxes/{mailbox}/messages/{message}/message.eml'].get.responses[200];
        expect(source.content).to.have.property('message/rfc822');
        expect(spec.paths['/users/{user}/updates'].get.responses[200].content).to.have.property('text/event-stream');
    });

    it('does not publish internal wd* keywords', () => {
        const leaked = [];
        const walk = (node, path) => {
            if (!node || typeof node !== 'object') {
                return;
            }
            for (const [key, value] of Object.entries(node)) {
                if (/^wd[A-Z]/.test(key) || key === 'x-response-description') {
                    leaked.push(`${path}/${key}`);
                }
                walk(value, `${path}/${key}`);
            }
        };
        walk(spec, '');
        expect(leaked).to.deep.equal([]);
    });

    it('refuses a request body on a DELETE route, OpenAPI would drop it from the docs', async () => {
        const bare = fastify();
        attachNativeRoutes(bare, {});
        const register = () =>
            bare.route({
                method: 'DELETE',
                url: '/example',
                config: { name: 'deleteExample', validationObjs: { requestBody: { sess: { $ref: 'wd:sess' } }, queryParams: {}, pathParams: {} } },
                handler: async () => ({ success: true })
            });
        expect(register).to.throw('DELETE /example: declare requestBody fields as queryParams');
        await bare.close();
    });

    it('matches the committed docs/api/openapidocs.json', () => {
        // run `npm run generate-api-docs` after changing a route definition
        const committed = JSON.parse(fs.readFileSync(Path.join(__dirname, '..', '..', 'docs', 'api', 'openapidocs.json'), 'utf8'));
        expect(JSON.parse(JSON.stringify(spec))).to.deep.equal(committed);
    });
});
