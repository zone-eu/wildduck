/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const { MAX_MAILBOX_NAME_LENGTH, MAX_SUB_MAILBOXES } = require('../../lib/consts');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Mailboxes tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    let mailboxForPut;

    before(async () => {
        // ensure that we have an existing user account
        const response = await server
            .post('/users')
            .send({
                username: 'mailboxesuser',
                password: 'secretvalue',
                address: 'mailboxesuser.addrtest@example.com',
                name: 'mailboxes user'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        user = response.body.id;

        const responseMailboxPutCreate = await server.post(`/users/${user}/mailboxes`).send({ path: '/path/for/put', hidden: false, retention: 0 }).expect(200);
        mailboxForPut = responseMailboxPutCreate.body.id;
    });

    after(async () => {
        if (!user) {
            return;
        }

        const response = await server.delete(`/users/${user}`).expect(200);
        expect(response.body.success).to.be.true;

        user = false;
    });

    it('should POST /users/{user}/mailboxes expect success / all data', async () => {
        const response = await server.post(`/users/${user}/mailboxes`).send({ path: '/coolpath/abcda', hidden: false, retention: 0 }).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.not.be.empty;
    });

    it('should POST /users/{user}/mailboxes expect success / hidden and retention fields missing', async () => {
        const response = await server.post(`/users/${user}/mailboxes`).send({ path: '/coolpath/abcdad' }).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.not.be.empty;
    });

    it('should POST /users/{user}/mailboxes expect success / longer path with number', async () => {
        const response = await server
            .post(`/users/${user}/mailboxes`)
            .send({ path: '/cool2/path2/whatisthis346/cool-drink', hidden: false, retention: 0 })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.not.be.empty;
    });

    it('should POST /users/{user}/mailboxes expect failure / retention negative', async () => {
        const response = await server
            .post(`/users/${user}/mailboxes`)
            .send({ path: '/cool2/path2/whatisthis346/cool-drink', hidden: false, retention: -1 })
            .expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /users/{user}/mailboxes expect failure / retention is string', async () => {
        const response = await server
            .post(`/users/${user}/mailboxes`)
            .send({ path: '/cool2/path2/whatisthis346/cool-drink', hidden: false, retention: 'aaa' })
            .expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /users/{user}/mailboxes expect failure / path contains double slash', async () => {
        const response = await server
            .post(`/users/${user}/mailboxes`)
            .send({ path: '/cool2//path2/whatisthis346///cool-drink', hidden: false, retention: 0 })
            .expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /users/{user}/mailboxes expect failure / user format incorrect', async () => {
        const response = await server
            .post(`/users/${123}/mailboxes`)
            .send({ path: '/cool2/path2/whatisthis346/cool-drink', hidden: false, retention: 0 })
            .expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /users/{user}/mailboxes expect failure / user format not hex', async () => {
        const response = await server
            .post(`/users/${'-'.repeat(24)}/mailboxes`)
            .send({ path: '/cool2/path2/whatisthis346/cool-drink', hidden: false, retention: 0 })
            .expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /users/{user}/mailboxes expect failure / user not found', async () => {
        const response = await server
            .post(`/users/${'0'.repeat(24)}/mailboxes`)
            .send({ path: '/cool2/path2/whatisthis346/cool-drink', hidden: false, retention: 0 })
            .expect(404);

        expect(response.body.error).to.be.equal('This user does not exist');
        expect(response.body.code).to.be.equal('UserNotFound');
    });

    it('should POST /users/{user}/mailboxes expect failure / path is missing', async () => {
        const response = await server.post(`/users/${user}/mailboxes`).send({ path: undefined, hidden: false, retention: 'aaa' }).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should GET /users/{user}/mailboxes expect success', async () => {
        const response = await server.get(`/users/${user}/mailboxes`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results).to.not.be.empty;
        expect(response.body.results.length).to.be.equal(9);
    });

    it('should GET /users/{user}/mailboxes expect success / all params', async () => {
        const response = await server.get(`/users/${user}/mailboxes?specialUse=true&showHidden=true&counters=true&sizes=true`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results).to.not.be.empty;
        expect(response.body.results.length).to.be.equal(5);
    });

    it('should GET /users/{user}/mailboxes expect success / some params', async () => {
        const response = await server.get(`/users/${user}/mailboxes?specialUse=false&counters=true&sizes=true`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results).to.not.be.empty;
        expect(response.body.results.length).to.be.equal(9);
    });

    it('should GET /users/{user}/mailboxes expect failure / params incorrect type', async () => {
        const response = await server.get(`/users/${user}/mailboxes?specialUse=what&showHidden=111&counters=-2&sizes=sizes`).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should GET /users/{user}/mailboxes expect failure / user wrong format', async () => {
        const response = await server.get(`/users/${123}/mailboxes?specialUse=true&showHidden=true&counters=true&sizes=true`).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should GET /users/{user}/mailboxes expect failure / user not found', async () => {
        const response = await server.get(`/users/${'0'.repeat(24)}/mailboxes?specialUse=false&counters=true&sizes=true`).expect(404);

        expect(response.body.error).to.be.equal('This user does not exist');
        expect(response.body.code).to.be.equal('UserNotFound');
    });

    it('should GET /users/{user}/mailboxes/{mailbox} expect success', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server.get(`/users/${user}/mailboxes/${mailboxes.body.results[0].id}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.not.be.empty;
        expect(response.body.name).to.be.equal('INBOX');
    });

    it('should GET /users/{user}/mailboxes/{mailbox} expect success / path specified', async () => {
        // const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server.get(`/users/${user}/mailboxes/${'resolve'}?path=coolpath/abcda`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.not.be.empty;
        expect(response.body.name).to.be.equal('abcda');
        expect(response.body.path).to.be.equal('coolpath/abcda');
    });

    it('should GET /users/{user}/mailboxes/{mailbox} expect success / path inbox specified', async () => {
        const response = await server.get(`/users/${user}/mailboxes/resolve?path=INBOX`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.not.be.empty;
        expect(response.body.name).to.be.equal('INBOX');
        expect(response.body.path).to.be.equal('INBOX');
    });

    it('should GET /users/{user}/mailboxes/{mailbox} expect failure / incorrect params', async () => {
        const response = await server.get(`/users/${user}/mailboxes/resolve?path=//INBOX`).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.be.not.empty;

        const response2 = await server.get(`/users/${user}/mailboxes/resolve?path=`).expect(400);

        expect(response2.body.code).to.be.equal('InputValidationError');
        expect(response2.body.error).to.be.not.empty;

        const response3 = await server.get(`/users/${user}/mailboxes/${123}`).expect(400);

        expect(response3.body.code).to.be.equal('InputValidationError');
        expect(response3.body.error).to.be.not.empty;

        const response4 = await server.get(`/users/${user}/mailboxes/${'-'.repeat(24)}`).expect(400);

        expect(response4.body.code).to.be.equal('InputValidationError');
        expect(response4.body.error).to.be.not.empty;
    });

    it('should GET /users/{user}/mailboxes/{mailbox} expect failure / mailbox not found', async () => {
        const response = await server.get(`/users/${user}/mailboxes/${'0'.repeat(24)}`).expect(404);

        expect(response.body.code).to.be.equal('NoSuchMailbox');
        expect(response.body.error).to.be.equal('This mailbox does not exist');
    });

    it('should GET /users/{user}/mailboxes/{mailbox} expect failure / user not found', async () => {
        const response = await server.get(`/users/${'0'.repeat(24)}/mailboxes`).expect(404);

        expect(response.body.error).to.be.equal('This user does not exist');
        expect(response.body.code).to.be.equal('UserNotFound');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect success', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server.put(`/users/${user}/mailboxes/${mailboxes.body.results[0].id}`).send({ retention: 10 }).expect(200);

        expect(response.body.success).to.be.true;
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect success / path specified', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server.put(`/users/${user}/mailboxes/${mailboxes.body.results[1].id}`).send({ path: 'newPath/folder1' });

        expect(response.body.success).to.be.true;
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect success / all params specified', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server
            .put(`/users/${user}/mailboxes/${mailboxes.body.results.at(-1).id}`)
            .send({ path: 'newPath/folder2', retention: 100, subscribed: true, hidden: true })
            .expect(200);

        expect(response.body.success).to.be.true;
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect failure / incorrect params', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server.put(`/users/${user}/mailboxes/${mailboxes.body.results[0].id}`).send({ path: '//newpath/path2' }).expect(400);

        expect(response.body.code).to.be.equal('InputValidationError');
        expect(response.body.error).to.be.not.empty;

        const response2 = await server.put(`/users/${user}/mailboxes/${mailboxes.body.results[0].id}`).send({ path: 123123 }).expect(400);

        expect(response2.body.code).to.be.equal('InputValidationError');
        expect(response2.body.error).to.be.not.empty;

        const response3 = await server.put(`/users/${user}/mailboxes/${123}`).expect(400);

        expect(response3.body.code).to.be.equal('InputValidationError');
        expect(response3.body.error).to.be.not.empty;

        const response4 = await server
            .put(`/users/${user}/mailboxes/${'-'.repeat(24)}`)

            .expect(400);

        expect(response4.body.code).to.be.equal('InputValidationError');
        expect(response4.body.error).to.be.not.empty;

        const response5 = await server.put(`/users/${user}/mailboxes/${mailboxes.body.results[0].id}`).send({ retention: 'notanumber' }).expect(400);

        expect(response5.body.code).to.be.equal('InputValidationError');
        expect(response5.body.error).to.be.not.empty;

        const response6 = await server.put(`/users/${user}/mailboxes/${mailboxes.body.results[0].id}`).send({ hidden: 'notabool' }).expect(400);

        expect(response6.body.code).to.be.equal('InputValidationError');
        expect(response6.body.error).to.be.not.empty;

        const response7 = await server.put(`/users/${user}/mailboxes/${mailboxes.body.results[0].id}`).send({ subscribed: 12345 }).expect(400);

        expect(response7.body.code).to.be.equal('InputValidationError');
        expect(response7.body.error).to.be.not.empty;

        const response8 = await server.put(`/users/${123}/mailboxes/${mailboxes.body.results[0].id}`).expect(400);

        expect(response8.body.code).to.be.equal('InputValidationError');
        expect(response8.body.error).to.be.not.empty;
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect failure / mailbox not found', async () => {
        const response = await server
            .put(`/users/${user}/mailboxes/${'0'.repeat(24)}`)
            .send({ path: 'newPath' })
            .expect(404);

        expect(response.body.error).to.be.equal('Mailbox update failed with code NoSuchMailbox');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect failure / user not found', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server
            .put(`/users/${'0'.repeat(24)}/mailboxes/${mailboxes.body.results.at(-1).id}`)
            .send({ path: 'newPath' })
            .expect(404);

        expect(response.body.error).to.be.equal('Mailbox update failed with code NoSuchMailbox');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect failure / nothing was changed', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server.put(`/users/${user}/mailboxes/${mailboxes.body.results.at(-1).id}`).expect(400);

        expect(response.body.error).to.be.equal('Nothing was changed');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect failure / cannot update protected path', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const inboxMailbox = mailboxes.body.results.find(el => el.path === 'INBOX');

        const response = await server.put(`/users/${user}/mailboxes/${inboxMailbox.id}`).send({ path: 'newPath/folder123' }).expect(400);

        expect(response.body.error).to.be.equal('Mailbox update failed with code DisallowedMailboxMethod');
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox} expect success', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const validMailbox = mailboxes.body.results.find(el => !el.specialUse && el.path !== 'INBOX');

        const response = await server.del(`/users/${user}/mailboxes/${validMailbox.id}`).expect(200);

        expect(response.body.success).to.be.true;
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox} expect failure / protected path', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server.del(`/users/${user}/mailboxes/${mailboxes.body.results[0].id}`).expect(400);

        expect(response.body.error).to.be.equal('Mailbox deletion failed with code DisallowedMailboxMethod');
        expect(response.body.code).to.be.equal('DisallowedMailboxMethod');
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox} expect failure / incorrect params', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response1 = await server.del(`/users/${user}/mailboxes/${123}`).expect(400);

        expect(response1.body.code).to.be.equal('InputValidationError');
        expect(response1.body.error).to.be.not.empty;

        const response2 = await server
            .del(`/users/${user}/mailboxes/${'-'.repeat(24)}`)

            .expect(400);

        expect(response2.body.code).to.be.equal('InputValidationError');
        expect(response2.body.error).to.be.not.empty;

        const response3 = await server.del(`/users/${123}/mailboxes/${mailboxes.body.results[0].id}`).expect(400);

        expect(response3.body.code).to.be.equal('InputValidationError');
        expect(response3.body.error).to.be.not.empty;

        const response4 = await server
            .del(`/users/${'-'.repeat(24)}/mailboxes/${mailboxes.body.results[0].id}`)

            .expect(400);

        expect(response4.body.code).to.be.equal('InputValidationError');
        expect(response4.body.error).to.be.not.empty;
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox} expect failure / mailbox not found', async () => {
        const response = await server.del(`/users/${user}/mailboxes/${'0'.repeat(24)}`).expect(404);

        expect(response.body.error).to.be.equal('Mailbox deletion failed with code NoSuchMailbox');
        expect(response.body.code).to.be.equal('NoSuchMailbox');
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox} expect failure / user not found', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const response = await server.del(`/users/${'0'.repeat(24)}/mailboxes/${mailboxes.body.results[0].id}`).expect(404);

        expect(response.body.error).to.be.equal('Mailbox deletion failed with code NoSuchMailbox');
    });

    it('should DELETE /users/{user}/mailboxes/{mailbox} expect failure / cannot delete inbox', async () => {
        const mailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);

        const inboxMailbox = mailboxes.body.results.find(el => el.path === 'INBOX');

        const response = await server.del(`/users/${user}/mailboxes/${inboxMailbox.id}`).expect(400);

        expect(response.body.error).to.be.equal('Mailbox deletion failed with code DisallowedMailboxMethod');
        expect(response.body.code).to.be.equal('DisallowedMailboxMethod');
    });

    it('should POST /users/{user}/mailboxes expect failure / too many subpaths in mailbox path', async () => {
        let path = '';

        for (let i = 0; i < MAX_SUB_MAILBOXES + 1; i++) {
            path += `subpath${i}/`;
        }

        path = path.substring(0, path.length - 1);
        const response = await server.post(`/users/${user}/mailboxes`).send({ path, hidden: false }).expect(400);

        expect(response.body.code).to.eq('InputValidationError');
        expect(response.body.error).to.eq(`The mailbox path cannot be more than ${MAX_SUB_MAILBOXES} levels deep`);
    });

    it('should POST /users/{user}/mailboxes expect failure / subpath too long', async () => {
        let path = '';

        for (let i = 0; i < 16; i++) {
            if (i % 5 === 0) {
                // every fifth
                path += `${'a'.repeat(MAX_MAILBOX_NAME_LENGTH + 1)}/`;
            } else {
                path += `subpath${i}/`;
            }
        }

        path = path.substring(0, path.length - 1);
        const response = await server.post(`/users/${user}/mailboxes`).send({ path, hidden: false }).expect(400);

        expect(response.body.code).to.eq('InputValidationError');
        expect(response.body.error).to.eq(`Any part of the mailbox path cannot be longer than ${MAX_MAILBOX_NAME_LENGTH} chars long`);
    });

    it('should POST /users/{user}/mailboxes expect success / edge case for subpath length and subpath count', async () => {
        let path = '';

        for (let i = 0; i < MAX_SUB_MAILBOXES; i++) {
            path += `${'a'.repeat(MAX_MAILBOX_NAME_LENGTH)}/`;
        }

        path = path.substring(0, path.length - 1);
        const response = await server.post(`/users/${user}/mailboxes`).send({ path, hidden: false }).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.not.be.empty;
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect failure / too many subpaths in mailbox path', async () => {
        let path = '';

        for (let i = 0; i < MAX_SUB_MAILBOXES + 1; i++) {
            path += `subpath${i}/`;
        }

        path = path.substring(0, path.length - 1);
        const response = await server.put(`/users/${user}/mailboxes/${mailboxForPut}`).send({ path, hidden: false }).expect(400);

        expect(response.body.code).to.eq('InputValidationError');
        expect(response.body.error).to.eq(`The mailbox path cannot be more than ${MAX_SUB_MAILBOXES} levels deep`);
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect failure / subpath too long', async () => {
        let path = '';

        for (let i = 0; i < 16; i++) {
            if (i % 5 === 0) {
                // every fifth
                path += `${'a'.repeat(MAX_MAILBOX_NAME_LENGTH + 1)}/`;
            } else {
                path += `subpath${i}/`;
            }
        }

        path = path.substring(0, path.length - 1);
        const response = await server.put(`/users/${user}/mailboxes/${mailboxForPut}`).send({ path, hidden: false }).expect(400);

        expect(response.body.code).to.eq('InputValidationError');
        expect(response.body.error).to.eq(`Any part of the mailbox path cannot be longer than ${MAX_MAILBOX_NAME_LENGTH} chars long`);
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect success / edge case for subpath length and subpath count', async () => {
        let path = '';

        for (let i = 0; i < MAX_SUB_MAILBOXES; i++) {
            path += `${`${i % 10}`.repeat(MAX_MAILBOX_NAME_LENGTH)}/`;
        }

        path = path.substring(0, path.length - 1);
        const response = await server.put(`/users/${user}/mailboxes/${mailboxForPut}`).send({ path, hidden: false }).expect(200);

        expect(response.body.success).to.be.true;
    });

    it('should POST /users/{user}/mailboxes expect failure / trailing slash', async () => {
        let path = 'somepath/abc/';

        const response = await server.post(`/users/${user}/mailboxes`).send({ path, hidden: false }).expect(400);

        expect(response.body.code).to.eq('InputValidationError');
        expect(response.body.error).to.eq('"path" with value "somepath/abc/" matches the inverted pattern: /\\/{2,}|\\/$/');
    });

    it('should PUT /users/{user}/mailboxes/{mailbox} expect failure / trailing slash', async () => {
        let path = 'somepath/abc/';

        const response = await server.put(`/users/${user}/mailboxes/${mailboxForPut}`).send({ path, hidden: false }).expect(400);

        expect(response.body.code).to.eq('InputValidationError');
        expect(response.body.error).to.eq('"path" with value "somepath/abc/" matches the inverted pattern: /\\/{2,}|\\/$/');
    });
});
