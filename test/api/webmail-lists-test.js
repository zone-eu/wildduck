/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

/* globals before: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const config = require('@zone-eu/wild-config');
const { ObjectId } = require('mongodb');
const { deleteAccountData } = require('../../lib/jmap/account-data');
const db = require('../../lib/db');
const { connect, uniqueName } = require('./_helpers');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

async function createUser(prefix) {
    const username = uniqueName(prefix);
    const response = await server
        .post('/users')
        .send({ username, password: 'secretvalue', address: `${username}@example.com` })
        .expect(200);
    return { id: response.body.id, username };
}

describe('Webmail remote content senders', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;

    before(async () => {
        user = await createUser('wmsenders');
    });

    it('adds senders once, lowercased, and lists them by address', async () => {
        await server.post(`/users/${user.id}/webmail/senders`).send({ address: 'News@Example.org' }).expect(200);
        const again = await server.post(`/users/${user.id}/webmail/senders`).send({ address: 'news@example.org' }).expect(200);
        expect(again.body.address).to.equal('news@example.org');
        await server.post(`/users/${user.id}/webmail/senders`).send({ address: 'alice@example.net' }).expect(200);

        const response = await server.get(`/users/${user.id}/webmail/senders`).expect(200);
        expect(response.body.results.map(entry => entry.address)).to.deep.equal(['alice@example.net', 'news@example.org']);
    });

    it('refuses values that are not addresses', async () => {
        for (const address of ['not an address', '<x@y.z>', 'a@b']) {
            const response = await server.post(`/users/${user.id}/webmail/senders`).send({ address }).expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        }
    });

    it('removes a sender', async () => {
        let response = await server.delete(`/users/${user.id}/webmail/senders/${encodeURIComponent('NEWS@example.org')}`).expect(200);
        expect(response.body.deleted).to.be.true;
        response = await server.delete(`/users/${user.id}/webmail/senders/${encodeURIComponent('news@example.org')}`).expect(200);
        expect(response.body.deleted).to.be.false;
        response = await server.get(`/users/${user.id}/webmail/senders`).expect(200);
        expect(response.body.results.map(entry => entry.address)).to.deep.equal(['alice@example.net']);
    });
});

describe('Webmail recent searches', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;

    before(async () => {
        user = await createUser('wmsearches');
    });

    it('keeps the five newest searches, newest first, without duplicates', async () => {
        for (const query of ['one', 'two', 'three', 'four', 'five', 'six', 'three']) {
            await server.post(`/users/${user.id}/webmail/searches`).send({ query }).expect(200);
        }
        const response = await server.get(`/users/${user.id}/webmail/searches`).expect(200);
        expect(response.body.results.map(entry => entry.query)).to.deep.equal(['three', 'six', 'five', 'four', 'two']);
    });

    it('refuses an empty search and deletes one by id', async () => {
        await server.post(`/users/${user.id}/webmail/searches`).send({ query: '   ' }).expect(400);
        const list = await server.get(`/users/${user.id}/webmail/searches`).expect(200);
        const target = list.body.results[0];
        const response = await server.delete(`/users/${user.id}/webmail/searches/${target.id}`).expect(200);
        expect(response.body.deleted).to.be.true;
        const after = await server.get(`/users/${user.id}/webmail/searches`).expect(200);
        expect(after.body.results.map(entry => entry.id)).to.not.include(target.id);
    });

    it('is removed with the user data', async () => {
        await server.post(`/users/${user.id}/webmail/senders`).send({ address: 'x@example.org' }).expect(200);
        await connect();
        const result = await deleteAccountData(db, new ObjectId(user.id));
        expect(result['webmail.searches'].deleted).to.be.greaterThan(0);
        expect(result['webmail.senders'].deleted).to.equal(1);
    });
});
