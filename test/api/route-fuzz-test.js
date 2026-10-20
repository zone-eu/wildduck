/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

// Seeded fuzzing of every documented API route, in-process with app.inject().
//
// For each route a request is generated from its validationObjs (see
// _route-requests.js) and sent once as generated and FUZZ_ITERATIONS times
// with one to three mutations: hostile values, dropped and unknown keys,
// broken path params, bodies that are not objects. Whatever the input, the
// API must answer without a server error, within a time limit, with a JSON
// error body for client errors, and with replies that match the response
// models.
//
// Reproducing a failure: the message names the seed and the case, run
//   FUZZ_SEED=<seed> FUZZ_CASE='<METHOD url#iteration>' npx mocha --exit test/api/route-fuzz-test.js
// A longer run: FUZZ_ITERATIONS=50

const crypto = require('crypto');
const chai = require('chai');
const { buildApp } = require('./_inprocess');
const { createFixtures } = require('./_fixtures');
const { createRandom, buildRequest, toInject, mutateRequest, routeKey, withTimeout } = require('./_route-requests');

const expect = chai.expect;

const SEED = Number(process.env.FUZZ_SEED) || 0x5eed;
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 6;
const CASE = process.env.FUZZ_CASE || '';
const REQUEST_TIMEOUT = 10000;

// Routes left out, with the reason
const SKIPPED = new Map([
    // change state other test suites rely on
    ['POST /settings/:key', 'global settings'],
    ['PUT /addresses/renameDomain', 'renames every address of a domain'],
    ['DELETE /users/:user', 'removes the fixture user'],
    // send events to the webhook URL from the webhook runner
    ['POST /webhooks', 'outbound HTTP'],
    // take over the raw response or request stream, app.inject() does not end them
    ['GET /users/:user/updates', 'server-sent events'],
    ['POST /data/export', 'streamed response'],
    ['POST /data/import', 'streamed request']
]);

// a stable seed per route and iteration, so one case can be replayed alone
const caseSeed = (route, iteration) =>
    crypto
        .createHash('sha256')
        .update(`${SEED} ${routeKey(route)} ${iteration}`)
        .digest()
        .readUInt32LE(0);

// what is wrong with a reply, or null
const checkReply = res => {
    if (res.statusCode >= 500) {
        return `status ${res.statusCode}`;
    }
    if (res.statusCode >= 400) {
        let body;
        try {
            body = res.json();
        } catch {
            return `status ${res.statusCode} without a JSON body`;
        }
        // {error, code} from handlers and validation, {code, message} from infra errors
        if (!body || typeof body.code !== 'string' || !(typeof body.error === 'string' || typeof body.message === 'string')) {
            return `status ${res.statusCode} with an error body that has no code and message`;
        }
    }
    return null;
};

describe('API route fuzzing', function () {
    this.timeout(10 * 60 * 1000); // eslint-disable-line no-invalid-this

    let app;
    let routes;
    let violations;
    let fixtures;

    before(async () => {
        ({ app, routes, violations } = await buildApp());
        fixtures = await createFixtures(app, 'fz');
        // the fixtures are not part of what is checked
        violations.clear();
    });

    after(async () => {
        if (fixtures) {
            await fixtures.cleanup();
        }
        if (app) {
            await app.close();
        }
    });

    it('answers generated and mutated requests without server errors', async () => {
        const failures = [];
        const unhandled = [];
        const onUnhandled = err => unhandled.push(err && err.message);
        process.on('unhandledRejection', onUnhandled);

        let sent = 0;
        try {
            for (const route of routes) {
                if (SKIPPED.has(routeKey(route))) {
                    continue;
                }
                for (let iteration = 0; iteration <= ITERATIONS; iteration++) {
                    const name = `${routeKey(route)}#${iteration}`;
                    if (CASE && CASE !== name) {
                        continue;
                    }

                    const rnd = createRandom(caseSeed(route, iteration));
                    const request = buildRequest(route, { rnd, fixtures });
                    const mutations = iteration ? mutateRequest(request, rnd) : ['none'];

                    let problem;
                    try {
                        const res = await withTimeout(app.inject(toInject(route, request)), REQUEST_TIMEOUT);
                        problem = checkReply(res);
                        if (problem && res.statusCode >= 500) {
                            problem += `: ${res.body.slice(0, 160)}`;
                        }
                    } catch (err) {
                        problem = err.message;
                    }
                    sent++;

                    if (problem) {
                        failures.push(`${name} [${mutations.join(', ')}]: ${problem}`);
                    }
                }
            }
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }

        expect(sent, 'requests sent').to.be.greaterThan(0);
        expect(unhandled, 'unhandled rejections').to.deep.equal([]);
        expect(failures, `FUZZ_SEED=${SEED}, ${failures.length} failing case(s):\n${failures.join('\n')}`).to.deep.equal([]);
    });

    it('answers in line with the response models', () => {
        const found = violations
            .list()
            .map(f => `${f.method} ${f.route} ${f.statusCode} ${f.path}: ${f.kind}${f.expected ? ` (${f.expected} -> ${f.actual})` : ''}`);
        expect(found, found.join('\n')).to.deep.equal([]);
    });
});
