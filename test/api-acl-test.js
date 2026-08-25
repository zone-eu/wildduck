/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('ACL API tests', function () {
    let owner, grantee, inbox;

    this.timeout(10000); // eslint-disable-line no-invalid-this

    before(async () => {
        let response = await server
            .post('/users')
            .send({
                username: 'aclowner',
                password: 'secretpass',
                address: 'aclowner@example.com',
                name: 'acl owner'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        owner = response.body.id;

        response = await server
            .post('/users')
            .send({
                username: 'aclgrantee',
                password: 'secretpass',
                address: 'aclgrantee@example.com',
                name: 'acl grantee'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        grantee = response.body.id;

        response = await server.get(`/users/${owner}/mailboxes`).expect(200);
        expect(response.body.success).to.be.true;
        inbox = response.body.results.find(mailboxData => mailboxData.path === 'INBOX').id;
    });

    after(async () => {
        for (let user of [owner, grantee]) {
            if (!user) {
                continue;
            }
            const response = await server.delete(`/users/${user}`).expect(200);
            expect(response.body.success).to.be.true;
        }
    });

    it('should PUT /users/{user}/mailboxes/{mailbox}/acl expect success', async () => {
        const response = await server
            .put(`/users/${owner}/mailboxes/${inbox}/acl`)
            .send({
                identifier: 'aclgrantee',
                rights: 'lrs'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(grantee);
    });

    it('should GET /users/{user}/mailboxes/{mailbox}/acl expect success', async () => {
        const response = await server.get(`/users/${owner}/mailboxes/${inbox}/acl`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.results.length).to.equal(1);
        expect(response.body.results[0].user).to.equal(grantee);
        expect(response.body.results[0].username).to.equal('aclgrantee');
        expect(response.body.results[0].rights).to.equal('lrs');
        expect(response.body.results[0].subscribed).to.be.true;
    });

    it('should GET /users/{user}/acl expect success', async () => {
        const response = await server.get(`/users/${owner}/acl`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.results.length).to.equal(1);
        expect(response.body.results[0].mailbox).to.equal(inbox);
        expect(response.body.results[0].path).to.equal('INBOX');
        expect(response.body.results[0].user).to.equal(grantee);
        expect(response.body.results[0].username).to.equal('aclgrantee');
        expect(response.body.results[0].rights).to.equal('lrs');
    });

    it('should GET /users/{user}/acl/shared expect success', async () => {
        const response = await server.get(`/users/${grantee}/acl/shared`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.results.length).to.equal(1);
        expect(response.body.results[0].mailbox).to.equal(inbox);
        expect(response.body.results[0].path).to.equal('Other Users/aclowner/INBOX');
        expect(response.body.results[0].owner).to.equal(owner);
        expect(response.body.results[0].ownerName).to.equal('aclowner');
        expect(response.body.results[0].rights).to.equal('lrs');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox}/acl expect success / replace rights', async () => {
        let response = await server
            .put(`/users/${owner}/mailboxes/${inbox}/acl`)
            .send({
                identifier: 'aclgrantee',
                rights: 'lrswi'
            })
            .expect(200);
        expect(response.body.success).to.be.true;

        response = await server.get(`/users/${owner}/mailboxes/${inbox}/acl`).expect(200);
        expect(response.body.results.length).to.equal(1);
        expect(response.body.results[0].rights).to.equal('lrswi');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox}/acl expect success / normalize obsolete rights', async () => {
        let response = await server
            .put(`/users/${owner}/mailboxes/${inbox}/acl`)
            .send({
                identifier: 'aclgrantee',
                rights: 'cd'
            })
            .expect(200);
        expect(response.body.success).to.be.true;

        response = await server.get(`/users/${owner}/mailboxes/${inbox}/acl`).expect(200);
        expect(response.body.results[0].rights).to.equal('kxte');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox}/acl expect failure / unknown identifier', async () => {
        const response = await server
            .put(`/users/${owner}/mailboxes/${inbox}/acl`)
            .send({
                identifier: 'nosuchuserhere',
                rights: 'lrs'
            })
            .expect(404);
        expect(response.body.code).to.equal('UserNotFound');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox}/acl expect failure / owner as grantee', async () => {
        const response = await server
            .put(`/users/${owner}/mailboxes/${inbox}/acl`)
            .send({
                identifier: 'aclowner',
                rights: 'lrs'
            })
            .expect(400);
        expect(response.body.code).to.equal('InvalidGrantee');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox}/acl expect failure / invalid rights', async () => {
        const response = await server
            .put(`/users/${owner}/mailboxes/${inbox}/acl`)
            .send({
                identifier: 'aclgrantee',
                rights: 'lr9'
            })
            .expect(400);
        expect(response.body.code).to.equal('InputValidationError');
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox}/acl/{grantee} expect success', async () => {
        let response = await server.delete(`/users/${owner}/mailboxes/${inbox}/acl/${grantee}`).expect(200);
        expect(response.body.success).to.be.true;

        response = await server.get(`/users/${owner}/mailboxes/${inbox}/acl`).expect(200);
        expect(response.body.results.length).to.equal(0);
    });
});
