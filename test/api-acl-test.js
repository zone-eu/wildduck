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

    describe('shared accounts', function () {
        let team, teamInbox;

        before(async () => {
            let response = await server
                .post('/users')
                .send({
                    username: 'aclteam',
                    password: false,
                    address: 'aclteam@example.com',
                    name: 'acl team',
                    shared: true
                })
                .expect(200);
            expect(response.body.success).to.be.true;
            team = response.body.id;

            response = await server.get(`/users/${team}/mailboxes`).expect(200);
            expect(response.body.success).to.be.true;
            teamInbox = response.body.results.find(mailboxData => mailboxData.path === 'INBOX').id;
        });

        after(async () => {
            if (team) {
                const response = await server.delete(`/users/${team}`).expect(200);
                expect(response.body.success).to.be.true;
            }
        });

        it('should PUT /users/{user}/mailboxes/{mailbox}/acl expect success / shared account as owner', async () => {
            const response = await server
                .put(`/users/${team}/mailboxes/${teamInbox}/acl`)
                .send({
                    identifier: 'aclgrantee',
                    rights: 'lrs'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.id).to.equal(grantee);
        });

        it('should GET /users/{user}/acl/shared expect success / shared namespace path', async () => {
            const response = await server.get(`/users/${grantee}/acl/shared`).expect(200);
            expect(response.body.success).to.be.true;

            const entry = response.body.results.find(entryData => entryData.owner === team);
            expect(entry).to.exist;
            expect(entry.path).to.equal('Shared/aclteam/INBOX');
            expect(entry.ownerName).to.equal('aclteam');
            expect(entry.rights).to.equal('lrs');
        });

        it('should PUT /users/{user}/mailboxes/{mailbox}/acl expect failure / shared account as grantee', async () => {
            const response = await server
                .put(`/users/${owner}/mailboxes/${inbox}/acl`)
                .send({
                    identifier: 'aclteam',
                    rights: 'lrs'
                })
                .expect(404);
            expect(response.body.code).to.equal('UserNotFound');
        });

        it('should DELETE /users/{user} expect success / deleted shared account disappears from shared listings', async () => {
            const response = await server.delete(`/users/${team}`).expect(200);
            expect(response.body.success).to.be.true;

            const sharedResponse = await server.get(`/users/${grantee}/acl/shared`).expect(200);
            expect(sharedResponse.body.success).to.be.true;
            expect(sharedResponse.body.results.find(entryData => entryData.owner === team)).to.not.exist;

            team = false;
        });
    });

    describe('account wide grants', function () {
        let team;

        before(async () => {
            let response = await server
                .post('/users')
                .send({
                    username: 'aclacctteam',
                    password: false,
                    address: 'aclacctteam@example.com',
                    name: 'acl account team',
                    shared: true
                })
                .expect(200);
            expect(response.body.success).to.be.true;
            team = response.body.id;
        });

        after(async () => {
            if (team) {
                const response = await server.delete(`/users/${team}`).expect(200);
                expect(response.body.success).to.be.true;
            }
        });

        it('should PUT /users/{user}/acl/account expect success', async () => {
            const response = await server
                .put(`/users/${team}/acl/account`)
                .send({
                    identifier: 'aclgrantee',
                    rights: 'lrswipkxtea'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.id).to.equal(grantee);
        });

        it('should GET /users/{user}/acl/account expect success', async () => {
            const response = await server.get(`/users/${team}/acl/account`).expect(200);
            expect(response.body.success).to.be.true;
            expect(response.body.results.length).to.equal(1);
            expect(response.body.results[0].user).to.equal(grantee);
            expect(response.body.results[0].username).to.equal('aclgrantee');
            expect(response.body.results[0].rights).to.equal('lrswipkxtea');
            expect(response.body.results[0].subscribed).to.be.true;
        });

        it('should GET /users/{user}/acl/shared expect success / account grant entry', async () => {
            const response = await server.get(`/users/${grantee}/acl/shared`).expect(200);
            expect(response.body.success).to.be.true;

            const entry = response.body.results.find(entryData => entryData.owner === team && entryData.account);
            expect(entry).to.exist;
            expect(entry.mailbox).to.be.null;
            expect(entry.path).to.equal('Shared/aclacctteam');
            expect(entry.ownerName).to.equal('aclacctteam');
            expect(entry.rights).to.equal('lrswipkxtea');
        });

        it('should PUT /users/{user}/acl/account expect success / replace rights', async () => {
            let response = await server.put(`/users/${team}/acl/account`).send({ identifier: 'aclgrantee', rights: 'lrs' }).expect(200);
            expect(response.body.success).to.be.true;

            response = await server.get(`/users/${team}/acl/account`).expect(200);
            expect(response.body.results[0].rights).to.equal('lrs');
        });

        it('should PUT /users/{user}/acl/account expect failure / shared account as grantee', async () => {
            const response = await server.put(`/users/${team}/acl/account`).send({ identifier: 'aclacctteam', rights: 'lrs' }).expect(404);
            expect(response.body.code).to.equal('UserNotFound');
        });

        it('should PUT /users/{user}/acl/account expect failure / unknown identifier', async () => {
            const response = await server.put(`/users/${team}/acl/account`).send({ identifier: 'nosuchuserhere', rights: 'lrs' }).expect(404);
            expect(response.body.code).to.equal('UserNotFound');
        });

        it('should PUT /users/{user}/acl/account expect failure / owner as grantee', async () => {
            // grant on a human account to itself is rejected as an invalid grantee
            const response = await server.put(`/users/${owner}/acl/account`).send({ identifier: 'aclowner', rights: 'lrs' }).expect(400);
            expect(response.body.code).to.equal('InvalidGrantee');
        });

        it('should DELETE /users/{user}/acl/account/{grantee} expect success', async () => {
            let response = await server.delete(`/users/${team}/acl/account/${grantee}`).expect(200);
            expect(response.body.success).to.be.true;

            response = await server.get(`/users/${team}/acl/account`).expect(200);
            expect(response.body.results.length).to.equal(0);

            response = await server.get(`/users/${grantee}/acl/shared`).expect(200);
            expect(response.body.results.find(entryData => entryData.owner === team && entryData.account)).to.not.exist;
        });
    });
});
