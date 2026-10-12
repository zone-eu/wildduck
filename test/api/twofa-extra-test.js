/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const speakeasy = require('speakeasy');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API 2FA extras', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const runId = `${Date.now()}${Math.floor(Math.random() * 10000)}`;

    let customUser; // custom 2FA and webauthn edge case tests
    let totpUser; // totp setup, enable, disable flow
    let seed;

    before(async () => {
        const customResponse = await server
            .post('/users')
            .send({
                username: `customextra${runId}`,
                password: 'customextrasecret',
                address: `customextra${runId}@example.com`,
                name: 'custom 2fa extra user'
            })
            .expect(200);
        expect(customResponse.body.success).to.be.true;
        customUser = customResponse.body.id;

        const totpResponse = await server
            .post('/users')
            .send({
                username: `totpextra${runId}`,
                password: 'totpextrasecret',
                address: `totpextra${runId}@example.com`,
                name: 'totp extra user'
            })
            .expect(200);
        expect(totpResponse.body.success).to.be.true;
        totpUser = totpResponse.body.id;
    });

    after(async () => {
        if (customUser) {
            const response = await server.del(`/users/${customUser}`).expect(200);
            expect(response.body.success).to.be.true;
            customUser = false;
        }

        if (totpUser) {
            const response = await server.del(`/users/${totpUser}`).expect(200);
            expect(response.body.success).to.be.true;
            totpUser = false;
        }
    });

    it('should PUT /users/{user}/2fa/custom expect success', async () => {
        const response = await server.put(`/users/${customUser}/2fa/custom`).send({}).expect(200);

        expect(response.body.success).to.be.true;

        const userResponse = await server.get(`/users/${customUser}`).expect(200);
        expect(userResponse.body.enabled2fa).to.include('custom');
    });

    it('should PUT /users/{user}/2fa/custom expect failure / malformed user id', async () => {
        const response = await server.put(`/users/${123}/2fa/custom`).send({}).expect(400);

        expect(response.body.code).to.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;

        const response2 = await server
            .put(`/users/${'-'.repeat(24)}/2fa/custom`)
            .send({})
            .expect(400);

        expect(response2.body.code).to.equal('InputValidationError');
        expect(response2.body.error).to.not.be.empty;
    });

    it('should DELETE /users/{user}/2fa/custom expect success', async () => {
        const response = await server.del(`/users/${customUser}/2fa/custom`).expect(200);

        expect(response.body.success).to.be.true;

        const userResponse = await server.get(`/users/${customUser}`).expect(200);
        expect(userResponse.body.enabled2fa).to.not.include('custom');
    });

    it('should POST /users/{user}/2fa/totp/setup expect failure / malformed user id', async () => {
        const response = await server
            .post(`/users/${123}/2fa/totp/setup`)
            .send({
                issuer: 'WildDuck Test'
            })
            .expect(400);

        expect(response.body.code).to.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /users/{user}/2fa/totp/enable expect failure / wrong token', async () => {
        const setupResponse = await server
            .post(`/users/${totpUser}/2fa/totp/setup`)
            .send({
                issuer: 'WildDuck Test'
            })
            .expect(200);

        expect(setupResponse.body.success).to.be.true;
        expect(setupResponse.body.seed).to.exist;

        seed = setupResponse.body.seed;

        const validToken = speakeasy.totp({
            secret: seed,
            encoding: 'base32'
        });
        const invalidToken = validToken === '000000' ? '000001' : '000000';

        const response = await server
            .post(`/users/${totpUser}/2fa/totp/enable`)
            .send({
                token: invalidToken
            })
            .expect(400);

        expect(response.body.code).to.equal('InvalidToken');
        expect(response.body.error).to.equal('Invalid authentication token');
    });

    it('should DELETE /users/{user}/2fa/totp expect success / after full setup and enable flow', async () => {
        // the seed from the previous setup call is still pending, verify it to enable TOTP
        const enableResponse = await server
            .post(`/users/${totpUser}/2fa/totp/enable`)
            .send({
                token: speakeasy.totp({
                    secret: seed,
                    encoding: 'base32'
                })
            })
            .expect(200);

        expect(enableResponse.body.success).to.be.true;

        const userResponse = await server.get(`/users/${totpUser}`).expect(200);
        expect(userResponse.body.enabled2fa).to.include('totp');

        const response = await server.del(`/users/${totpUser}/2fa/totp`).expect(200);

        expect(response.body.success).to.be.true;

        const updatedUserResponse = await server.get(`/users/${totpUser}`).expect(200);
        expect(updatedUserResponse.body.enabled2fa).to.not.include('totp');
    });

    it('should DELETE /users/{user}/2fa expect success / disables all 2FA', async () => {
        // make sure at least one 2FA mechanism is active before disabling all
        const enableResponse = await server.put(`/users/${totpUser}/2fa/custom`).send({}).expect(200);
        expect(enableResponse.body.success).to.be.true;

        const response = await server.del(`/users/${totpUser}/2fa`).expect(200);

        expect(response.body.success).to.be.true;

        const userResponse = await server.get(`/users/${totpUser}`).expect(200);
        expect(userResponse.body.enabled2fa).to.be.an('array').that.is.empty;
    });

    it('should DELETE /users/{user}/2fa/webauthn/credentials/{credential} expect failure / malformed credential id', async () => {
        const response = await server.del(`/users/${customUser}/2fa/webauthn/credentials/${123}`).expect(400);

        expect(response.body.code).to.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should DELETE /users/{user}/2fa/webauthn/credentials/{credential} expect failure / unknown credential', async () => {
        const response = await server.delete(`/users/${customUser}/2fa/webauthn/credentials/${'0'.repeat(24)}`).expect(404);

        expect(response.body.code).to.equal('CredentialNotFound');
    });

    it('should POST /users/{user}/2fa/webauthn/registration-attestation expect failure / missing challenge', async () => {
        const response = await server
            .post(`/users/${customUser}/2fa/webauthn/registration-attestation`)
            .send({
                rawId: 'abcd',
                clientDataJSON: 'abcd',
                attestationObject: 'abcd'
            })
            .expect(400);

        expect(response.body.code).to.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /users/{user}/2fa/webauthn/registration-attestation expect failure / unknown challenge', async () => {
        const response = await server
            .post(`/users/${customUser}/2fa/webauthn/registration-attestation`)
            .send({
                challenge: 'ab'.repeat(20),
                rawId: 'abcd',
                clientDataJSON: 'abcd',
                attestationObject: 'abcd'
            })
            .expect(404);

        expect(response.body.code).to.equal('ChallengeNotFound');
        expect(response.body.error).to.equal('Unknown challenge');
    });

    it('should POST /users/{user}/2fa/webauthn/registration-challenge expect failure / missing required fields', async () => {
        const response = await server.post(`/users/${customUser}/2fa/webauthn/registration-challenge`).send({}).expect(400);

        expect(response.body.code).to.equal('InputValidationError');
        expect(response.body.error).to.not.be.empty;
    });

    it('should POST /users/{user}/2fa/webauthn/authentication-challenge expect failure / no credentials registered', async () => {
        const response = await server
            .post(`/users/${customUser}/2fa/webauthn/authentication-challenge`)
            .send({
                origin: 'https://example.com'
            })
            .expect(400);

        expect(response.body.code).to.equal('WebAuthnDisabled');
        expect(response.body.error).to.equal('WebAuthn is not enabled for this user');
    });
});
