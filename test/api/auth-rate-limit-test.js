/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const config = require('@zone-eu/wild-config');
const consts = require('../../lib/consts');
const db = require('../../lib/db');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Authentication rate limits', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const suffix = `${process.pid}-${Date.now()}`;
    const username = `auth-rate-limit-${suffix}`;
    const address = `${username}@example.com`;
    const masterPassword = 'qrstuvwxyzabcdef';
    const appPassword = 'abcdefghijklmnop';

    let userId;
    let rateLimitKey;

    before(async () => {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));

        const createResponse = await server
            .post('/users')
            .send({
                username,
                address,
                password: masterPassword
            })
            .expect(200);

        userId = createResponse.body.id;
        rateLimitKey = `auth_user:${userId}`;

        await server
            .post(`/users/${userId}/asps`)
            .send({
                description: 'rate limit test',
                scopes: ['imap'],
                password: appPassword
            })
            .expect(200);

        await db.redis.set(rateLimitKey, consts.USER_AUTH_FAILURES, 'EX', consts.USER_AUTH_WINDOW);
    });

    after(async () => {
        if (rateLimitKey) {
            await db.redis.del(rateLimitKey);
        }

        if (userId) {
            await server.delete(`/users/${userId}`).expect(200);
        }
    });

    it('should POST /authenticate expect success / using ASP while master password authentication is rate limited', async () => {
        const response = await server
            .post('/authenticate')
            .send({
                username: address,
                password: appPassword,
                scope: 'imap'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(await db.redis.get(rateLimitKey)).to.equal(String(consts.USER_AUTH_FAILURES));
    });

    it('should POST /authenticate expect failure / using master password while account is rate limited', async () => {
        const response = await server
            .post('/authenticate')
            .send({
                username: address,
                password: masterPassword,
                scope: 'imap'
            })
            .expect(403);

        expect(response.body.code).to.equal('RateLimitedError');
    });

    it('should POST /authenticate expect success / using master password after account rate limit is removed', async () => {
        await db.redis.del(rateLimitKey);

        const response = await server
            .post('/authenticate')
            .send({
                username: address,
                password: masterPassword,
                scope: 'imap'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
    });
});
