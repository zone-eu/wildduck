/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const crypto = require('crypto');
const config = require('@zone-eu/wild-config');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// a 1x1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('Webmail avatars', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;

    before(async () => {
        const username = `avatar-${crypto.randomBytes(6).toString('hex')}`;
        const response = await server
            .post('/users')
            .send({ username, password: 'secretvalue', address: `${username}@example.com` })
            .expect(200);
        user = response.body.id;
    });

    after(async () => {
        await server.delete(`/users/${user}`).expect(200);
    });

    it('stores, serves and removes the user picture', async () => {
        await server.get(`/users/${user}/webmail/avatars/self`).expect(404);
        const saved = await server.put(`/users/${user}/webmail/avatars/self`).send({ contentType: 'image/png', content: PNG }).expect(200);
        expect(saved.body.size).to.equal(Buffer.from(PNG, 'base64').length);
        const image = await server.get(`/users/${user}/webmail/avatars/self`).buffer(true).expect(200);
        expect(image.headers['content-type']).to.equal('image/png');
        expect(Buffer.from(image.body).equals(Buffer.from(PNG, 'base64'))).to.be.true;
        const removed = await server.delete(`/users/${user}/webmail/avatars/self`).expect(200);
        expect(removed.body.deleted).to.be.true;
        await server.get(`/users/${user}/webmail/avatars/self`).expect(404);
    });

    it('refuses content that is not the image it claims to be, and keys that do not exist', async () => {
        const wrong = await server.put(`/users/${user}/webmail/avatars/self`).send({ contentType: 'image/jpeg', content: PNG }).expect(400);
        expect(wrong.body.code).to.equal('InputValidationError');
        await server.put(`/users/${user}/webmail/avatars/other`).send({ contentType: 'image/png', content: PNG }).expect(400);
        const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(270 * 1024)]).toString('base64');
        await server.put(`/users/${user}/webmail/avatars/self`).send({ contentType: 'image/png', content: big }).expect(400);
    });

    it('keeps group pictures apart from the user picture', async () => {
        await server.put(`/users/${user}/webmail/avatars/group:friends`).send({ contentType: 'image/png', content: PNG }).expect(200);
        await server.get(`/users/${user}/webmail/avatars/self`).expect(404);
        await server.get(`/users/${user}/webmail/avatars/group:friends`).expect(200);
    });
});
