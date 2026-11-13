/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const crypto = require('crypto');

const expect = chai.expect;
chai.config.includeStack = true;

const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);
const { SoftwareWebAuthnAuthenticator } = require('./_webauthn');

const ORIGIN = 'https://example.com';
const RP_ID = 'example.com';

describe('API WebAuthn', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const password = 'webauthnsecretvalue';
    const suffix = crypto.randomBytes(6).toString('hex');
    const username = `webauthn-${suffix}`;
    const authenticator = new SoftwareWebAuthnAuthenticator(RP_ID);

    let user;
    let twoFactorNonce;
    let authenticationChallenge;
    let registrationResponse;
    let accessToken;
    let credentialId;
    let passwordOnlyToken;

    after(async () => {
        if (!user) {
            return;
        }

        await server.delete(`/users/${user}`).expect(200);
        user = false;
    });

    it('should POST /users expect success / create a user for WebAuthn', async () => {
        const response = await server
            .post('/users')
            .send({
                username,
                name: 'WebAuthn User',
                address: `${username}@example.com`,
                password
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.match(/^[0-9a-f]{24}$/);
        user = response.body.id;
    });

    it('should POST /authenticate expect success / token issued before any second factor', async () => {
        const response = await server.post('/authenticate').send({ username, password, scope: 'master', token: true }).expect(200);
        expect(response.body.token).to.be.a('string');
        passwordOnlyToken = response.body.token;
        await server.get(`/users/me?accessToken=${passwordOnlyToken}`).expect(200);
    });

    it('should POST /users/{user}/2fa/webauthn/registration-challenge expect success', async () => {
        const response = await server
            .post(`/users/${user}/2fa/webauthn/registration-challenge`)
            .send({
                description: 'Software authenticator',
                origin: ORIGIN,
                rpId: RP_ID,
                authenticatorAttachment: 'cross-platform'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.registrationOptions.challenge).to.match(/^[0-9a-f]+$/);
        expect(response.body.registrationOptions.rp.id).to.equal(RP_ID);

        registrationResponse = authenticator.createRegistrationResponse(response.body.registrationOptions.challenge, ORIGIN);
    });

    it('should POST /users/{user}/2fa/webauthn/registration-attestation expect success', async () => {
        const attestationResponse = await server
            .post(`/users/${user}/2fa/webauthn/registration-attestation`)
            .send({
                challenge: registrationResponse.challenge,
                rawId: registrationResponse.rawId,
                clientDataJSON: registrationResponse.clientDataJSON,
                attestationObject: registrationResponse.attestationObject,
                rpId: RP_ID
            })
            .expect(200);

        expect(attestationResponse.body.success).to.be.true;
        expect(attestationResponse.body.response.success).to.be.true;
        expect(attestationResponse.body.response.rawId).to.equal(registrationResponse.rawId);
        expect(attestationResponse.body.response.authenticatorAttachment).to.equal('cross-platform');
    });

    it('should GET /users/me expect failure / the first second factor ends password only sessions', async () => {
        const response = await server.get(`/users/me?accessToken=${passwordOnlyToken}`);
        expect(response.status).to.be.oneOf([401, 403]);
    });

    it('should GET /users/{user}/2fa/webauthn/credentials expect success / expect registered credential', async () => {
        const response = await server.get(`/users/${user}/2fa/webauthn/credentials`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.credentials).to.have.length(1);
        expect(response.body.credentials[0].rawId).to.equal(authenticator.credentialId.toString('hex'));
        expect(response.body.credentials[0].authenticatorAttachment).to.equal('cross-platform');

        credentialId = response.body.credentials[0].id;
    });

    it('should POST /authenticate expect success / return WebAuthn 2FA nonce without token', async () => {
        const response = await server
            .post('/authenticate')
            .send({
                username,
                password,
                token: true
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(user);
        expect(response.body.require2fa).to.deep.equal(['webauthn']);
        expect(response.body.token).to.not.exist;
        expect(response.body.twoFactorNonce).to.match(/^[0-9a-f]{40}$/);

        twoFactorNonce = response.body.twoFactorNonce;
    });

    it('should POST /users/{user}/2fa/webauthn/authentication-challenge expect success', async () => {
        const response = await server
            .post(`/users/${user}/2fa/webauthn/authentication-challenge`)
            .send({
                origin: ORIGIN,
                rpId: RP_ID,
                authenticatorAttachment: 'cross-platform',
                twoFactorNonce
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.authenticationOptions.challenge).to.match(/^[0-9a-f]+$/);
        expect(response.body.authenticationOptions.allowCredentials).to.deep.equal([
            {
                rawId: authenticator.credentialId.toString('hex'),
                type: 'public-key'
            }
        ]);

        authenticationChallenge = response.body.authenticationOptions.challenge;
    });

    it('should POST /users/{user}/2fa/webauthn/authentication-assertion expect success / expect token', async () => {
        const assertionResponse = authenticator.createAssertionResponse(authenticationChallenge, ORIGIN);
        const response = await server
            .post(`/users/${user}/2fa/webauthn/authentication-assertion`)
            .send({
                challenge: assertionResponse.challenge,
                rawId: assertionResponse.rawId,
                clientDataJSON: assertionResponse.clientDataJSON,
                authenticatorData: assertionResponse.authenticatorData,
                signature: assertionResponse.signature,
                rpId: RP_ID,
                twoFactorNonce,
                token: false
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.response.authenticated).to.be.true;
        expect(response.body.response.credential).to.match(/^[0-9a-f]{24}$/);
        expect(response.body.token).to.match(/^[0-9a-f]{40}$/);

        accessToken = response.body.token;
    });

    it('should GET /users/me expect success / use post-WebAuthn auth token', async () => {
        const response = await server.get(`/users/me?accessToken=${accessToken}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(user);
    });

    it('should POST /users/{user}/2fa/webauthn/authentication-assertion expect failure / reject replayed challenge', async () => {
        // replaying the whole assertion: the challenge was consumed by the
        // successful assertion above, so it is no longer known
        const assertionResponse = authenticator.createAssertionResponse(authenticationChallenge, ORIGIN);
        const response = await server
            .post(`/users/${user}/2fa/webauthn/authentication-assertion`)
            .send({
                challenge: assertionResponse.challenge,
                rawId: assertionResponse.rawId,
                clientDataJSON: assertionResponse.clientDataJSON,
                authenticatorData: assertionResponse.authenticatorData,
                signature: assertionResponse.signature,
                rpId: RP_ID,
                twoFactorNonce,
                token: false
            })
            .expect(404);

        expect(response.body.code).to.equal('ChallengeNotFound');
        expect(response.body.token).to.not.exist;
    });

    it('should POST /users/{user}/2fa/webauthn/authentication-assertion expect failure / reject nonce not bound to the challenge', async () => {
        // a live challenge, but asserted with a different 2FA nonce than the
        // one the challenge was issued for
        const authResponse = await server
            .post('/authenticate')
            .send({
                username,
                password,
                token: true
            })
            .expect(200);

        const freshNonce = authResponse.body.twoFactorNonce;
        expect(freshNonce).to.match(/^[0-9a-f]{40}$/);

        const challengeResponse = await server
            .post(`/users/${user}/2fa/webauthn/authentication-challenge`)
            .send({
                origin: ORIGIN,
                rpId: RP_ID,
                authenticatorAttachment: 'cross-platform',
                twoFactorNonce: freshNonce
            })
            .expect(200);

        const assertionResponse = authenticator.createAssertionResponse(challengeResponse.body.authenticationOptions.challenge, ORIGIN);
        const response = await server
            .post(`/users/${user}/2fa/webauthn/authentication-assertion`)
            .send({
                challenge: assertionResponse.challenge,
                rawId: assertionResponse.rawId,
                clientDataJSON: assertionResponse.clientDataJSON,
                authenticatorData: assertionResponse.authenticatorData,
                signature: assertionResponse.signature,
                rpId: RP_ID,
                twoFactorNonce: crypto.randomBytes(20).toString('hex'),
                token: false
            })
            .expect(403);

        expect(response.body.code).to.equal('Invalid2faNonce');
        expect(response.body.token).to.not.exist;
    });

    // runs last: deleting the credential invalidates the authenticator the
    // rest of the suite depends on
    it('should DELETE /users/{user}/2fa/webauthn/credentials/{credential} expect success', async () => {
        const response = await server.delete(`/users/${user}/2fa/webauthn/credentials/${credentialId}`).expect(200);
        expect(response.body.success).to.be.true;

        const emptyResponse = await server.get(`/users/${user}/2fa/webauthn/credentials`).expect(200);
        expect(emptyResponse.body.credentials).to.have.length(0);
    });
});
