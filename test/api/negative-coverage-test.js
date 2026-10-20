/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

// Rejection tests for the endpoints that were otherwise only exercised with
// valid input. Request validation runs before the permission check and before
// any database access, so well formed placeholder ids are enough here and no
// fixtures are needed.
//
// Not covered on purpose: GET /health takes no input at all (its route accepts
// unknown query keys and validates nothing), so it has no input driven failure
// mode; its failure paths are database and redis outages.

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;

const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// well formed but nonexistent ids: validation rejects the request before
// these are ever looked up
const USER = '0123456789abcdef01234567';
const MAILBOX = '0123456789abcdef01234568';
const ADDRESS = '0123456789abcdef01234569';

const longString = length => 'a'.repeat(length);

const cases = [
    {
        title: 'GET /users/{user}/mailboxes/{mailbox}/messages expect failure / malformed mailbox id',
        request: () => server.get(`/users/${USER}/mailboxes/zzz/messages`)
    },
    {
        title: 'GET /users/{user}/archived/messages expect failure / malformed user id',
        request: () => server.get('/users/zzz/archived/messages')
    },
    {
        title: 'GET /users/{user}/asps expect failure / malformed user id',
        request: () => server.get('/users/zzz/asps')
    },
    {
        title: 'GET /users/{user}/autoreply expect failure / malformed user id',
        request: () => server.get('/users/zzz/autoreply')
    },
    {
        title: 'DELETE /users/{user}/autoreply expect failure / malformed user id',
        request: () => server.delete('/users/zzz/autoreply')
    },
    {
        title: 'GET /users/{user}/addresses/{address} expect failure / malformed address id',
        request: () => server.get(`/users/${USER}/addresses/zzz`)
    },
    {
        title: 'PUT /users/{user}/addresses/{id} expect failure / malformed address id',
        request: () => server.put(`/users/${USER}/addresses/zzz`).send({ name: 'Test' })
    },
    {
        title: 'POST /users/{user}/addresses expect failure / invalid address',
        request: () => server.post(`/users/${USER}/addresses`).send({ address: 'not an email address' })
    },
    {
        title: 'DELETE /users/{user}/2fa expect failure / malformed user id',
        request: () => server.delete('/users/zzz/2fa')
    },
    {
        title: 'DELETE /users/{user}/2fa/custom expect failure / malformed user id',
        request: () => server.delete('/users/zzz/2fa/custom')
    },
    {
        title: 'DELETE /users/{user}/2fa/totp expect failure / malformed user id',
        request: () => server.delete('/users/zzz/2fa/totp')
    },
    {
        title: 'GET /webhooks expect failure / invalid limit',
        request: () => server.get('/webhooks?limit=notanumber')
    },
    {
        title: 'GET /certs expect failure / invalid limit',
        request: () => server.get('/certs?limit=notanumber')
    },
    {
        title: 'GET /dkim expect failure / invalid limit',
        request: () => server.get('/dkim?limit=notanumber')
    },
    {
        title: 'GET /domainaliases expect failure / invalid limit',
        request: () => server.get('/domainaliases?limit=notanumber')
    },
    {
        title: 'GET /settings expect failure / filter too long',
        request: () => server.get(`/settings?filter=${longString(129)}`)
    },
    {
        title: 'GET /audit/{audit}/export.mbox expect failure / malformed audit id',
        request: () => server.get('/audit/zzz/export.mbox')
    },
    {
        title: 'GET /domainaccess/{tag}/allow expect failure / tag too long',
        request: () => server.get(`/domainaccess/${longString(129)}/allow`)
    },
    {
        title: 'GET /domainaccess/{tag}/block expect failure / tag too long',
        request: () => server.get(`/domainaccess/${longString(129)}/block`)
    },
    {
        title: 'POST /domainaccess/{tag}/block expect failure / missing domain',
        request: () => server.post('/domainaccess/test-tag/block').send({})
    },
    {
        title: 'PUT /users/{user}/mailboxes/{mailbox} expect failure / malformed mailbox id',
        request: () => server.put(`/users/${USER}/mailboxes/zzz`).send({ path: 'Renamed' })
    },
    {
        title: 'DELETE /users/{user}/addresses/{address} expect failure / malformed address id',
        request: () => server.delete(`/users/${USER}/addresses/zzz`)
    },
    {
        title: 'GET /users/{user}/mailboxes expect failure / malformed user id',
        request: () => server.get('/users/zzz/mailboxes')
    },
    {
        title: 'GET /users/{user}/storage expect failure / malformed user id',
        request: () => server.get('/users/zzz/storage')
    },
    {
        title: 'GET /users/{user}/updates expect failure / malformed Last-Event-ID',
        request: () => server.get(`/users/${USER}/updates`).set('Last-Event-ID', 'zzz')
    },
    {
        // recipient addresses use Joi failover semantics (an invalid address
        // silently becomes empty), sendTime is strictly typed
        title: 'POST /users/{user}/submit expect failure / invalid sendTime',
        request: () =>
            server.post(`/users/${USER}/submit`).send({
                subject: 'test',
                text: 'test',
                sendTime: 'not-a-date'
            })
    },
    {
        title: 'GET /users/{user}/mailboxes/{mailbox}/messages/{message}/attachments/{attachment} expect failure / malformed attachment id',
        request: () => server.get(`/users/${USER}/mailboxes/${MAILBOX}/messages/1/attachments/zzz`)
    },
    {
        title: 'GET /addresses/forwarded/{address} expect failure / malformed address id',
        request: () => server.get('/addresses/forwarded/zzz')
    },
    {
        title: 'PUT /users/{user}/addressregister/{id} expect failure / malformed user id',
        request: () => server.put(`/users/zzz/addressregister/${ADDRESS}`).send({ name: 'Test' })
    },
    {
        // length limits count UTF-16 code units, so 65 astral characters are
        // 130 units and exceed the 128 character limit even though they are
        // only 65 code points
        title: 'PUT /users/{user}/autoreply expect failure / name longer than the limit in code units',
        request: () => server.put(`/users/${USER}/autoreply`).send({ name: '😀'.repeat(65) })
    }
];

describe('API input rejection coverage', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    for (const testCase of cases) {
        it(`should ${testCase.title}`, async () => {
            const response = await testCase.request().expect(400);

            expect(response.body.code).to.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
            expect(response.body.details).to.be.an('object');
        });
    }
});
