/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const crypto = require('crypto');
const config = require('@zone-eu/wild-config');
const { SoftwareWebAuthnAuthenticator } = require('./_webauthn');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

const ORIGIN = 'https://example.com';
const RP_ID = 'example.com';

async function createUser(prefix) {
    const username = `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
    const response = await server
        .post('/users')
        .send({ username, name: 'Passkey User', address: `${username}@example.com`, password: 'passkeysecretvalue' })
        .expect(200);
    return { id: response.body.id, username };
}

async function register(user, authenticator, extra = {}) {
    const challenge = await server.post(`/users/${user.id}/2fa/webauthn/registration-challenge`).send({ origin: ORIGIN, rpId: RP_ID }).expect(200);
    const options = challenge.body.registrationOptions;
    const response = authenticator.createRegistrationResponse(options.challenge, ORIGIN);
    await server
        .post(`/users/${user.id}/2fa/webauthn/registration-attestation`)
        .send(Object.assign(response, { rpId: RP_ID }, extra))
        .expect(200);
    return options;
}

async function signIn(authenticator, userHandle, status, extra = {}) {
    const challenge = await server.post('/authenticate/passkey/challenge').send({ origin: ORIGIN, rpId: RP_ID }).expect(200);
    const options = challenge.body.authenticationOptions;
    const assertion = authenticator.createAssertionResponse(options.challenge, ORIGIN, userHandle);
    return server
        .post('/authenticate/passkey')
        .send(Object.assign(assertion, { rpId: RP_ID }, extra))
        .expect(status);
}

describe('API passkeys', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    const passkey = new SoftwareWebAuthnAuthenticator(RP_ID, { userVerification: true, synced: true });

    before(async () => {
        user = await createUser('passkey');
    });

    after(async () => {
        await server.delete(`/users/${user.id}`).expect(200);
    });

    it('asks for a passkey of any kind when registering', async () => {
        const options = await register(user, passkey, { transports: ['internal', 'hybrid'], discoverable: true });
        expect(options.authenticatorSelection).to.deep.equal({
            residentKey: 'preferred',
            requireResidentKey: false,
            userVerification: 'preferred'
        });
        expect(options.extensions.credProps).to.be.true;
    });

    it('lists what is known about the credential', async () => {
        const response = await server.get(`/users/${user.id}/2fa/webauthn/credentials`).expect(200);
        const [credential] = response.body.credentials;
        expect(credential).to.include({
            discoverable: true,
            userVerified: true,
            backupEligible: true,
            backedUp: true,
            aaguid: '00000000000000000000000000000000',
            lastUsed: null,
            description: ''
        });
        expect(credential.transports).to.deep.equal(['internal', 'hybrid']);
        expect(credential.created).to.be.a('string');
    });

    it('signs in with the passkey alone and gets a token that works', async () => {
        const response = await signIn(passkey, user.id, 200, { token: true, protocol: 'Webmail' });
        expect(response.body).to.include({ success: true, id: user.id, require2fa: false, scope: 'master' });
        const me = await supertest(`http://127.0.0.1:${config.api.port}`).get('/users/me').set('X-Access-Token', response.body.token).expect(200);
        expect(me.body.id).to.equal(user.id);

        // a synced passkey keeps a zero counter and still signs in again
        await signIn(passkey, user.id, 200);
        const credentials = await server.get(`/users/${user.id}/2fa/webauthn/credentials`).expect(200);
        expect(credentials.body.credentials[0].lastUsed).to.be.a('string');
    });

    it('logs the sign-in', async () => {
        const response = await server.get(`/users/${user.id}/authlog`).expect(200);
        const entry = response.body.results.find(item => item.source === 'passkey' && item.protocol === 'Webmail');
        expect(entry).to.include({ action: 'authentication', result: 'success', protocol: 'Webmail' });
    });

    it('a used challenge can not be used again', async () => {
        const challenge = await server.post('/authenticate/passkey/challenge').send({ origin: ORIGIN, rpId: RP_ID }).expect(200);
        const assertion = passkey.createAssertionResponse(challenge.body.authenticationOptions.challenge, ORIGIN);
        await server
            .post('/authenticate/passkey')
            .send(Object.assign({ rpId: RP_ID }, assertion))
            .expect(200);
        const again = await server
            .post('/authenticate/passkey')
            .send(Object.assign({ rpId: RP_ID }, assertion))
            .expect(404);
        expect(again.body.code).to.equal('ChallengeNotFound');
    });

    it('refuses a key without user verification, which stays a second step', async () => {
        const securityKey = new SoftwareWebAuthnAuthenticator(RP_ID);
        await register(user, securityKey);
        const refused = await signIn(securityKey, null, 403);
        expect(refused.body.code).to.equal('UserVerificationRequired');

        // as a second step after the password the same key works
        const auth = await server.post('/authenticate').send({ username: user.username, password: 'passkeysecretvalue', token: true }).expect(200);
        expect(auth.body.require2fa).to.include('webauthn');
        const challenge = await server
            .post(`/users/${user.id}/2fa/webauthn/authentication-challenge`)
            .send({ origin: ORIGIN, rpId: RP_ID, twoFactorNonce: auth.body.twoFactorNonce })
            .expect(200);
        // both credentials are offered, whatever kind they are
        expect(challenge.body.authenticationOptions.allowCredentials).to.have.length(2);
        await server
            .post(`/users/${user.id}/2fa/webauthn/authentication-assertion`)
            .send(
                Object.assign(securityKey.createAssertionResponse(challenge.body.authenticationOptions.challenge, ORIGIN), {
                    rpId: RP_ID,
                    twoFactorNonce: auth.body.twoFactorNonce,
                    token: true
                })
            )
            .expect(200);
    });

    it('refuses unknown passkeys and a user handle of someone else', async () => {
        const stranger = new SoftwareWebAuthnAuthenticator(RP_ID, { userVerification: true });
        const unknown = await signIn(stranger, null, 403);
        expect(unknown.body.code).to.equal('PasskeyNotFound');
        const wrongHandle = await signIn(passkey, '000000000000000000000000', 403);
        expect(wrongHandle.body.code).to.equal('PasskeyNotFound');
    });

    it('renames a credential', async () => {
        const list = await server.get(`/users/${user.id}/2fa/webauthn/credentials`).expect(200);
        const id = list.body.credentials[0].id;
        const renamed = await server.put(`/users/${user.id}/2fa/webauthn/credentials/${id}`).send({ description: 'Work laptop' }).expect(200);
        expect(renamed.body.updated).to.be.true;
        const after = await server.get(`/users/${user.id}/2fa/webauthn/credentials`).expect(200);
        expect(after.body.credentials[0].description).to.equal('Work laptop');
    });

    it('does not let a disabled account sign in', async () => {
        await server.put(`/users/${user.id}`).send({ disabled: true }).expect(200);
        const response = await signIn(passkey, user.id, 403);
        expect(response.body.code).to.equal('AuthFailed');
        await server.put(`/users/${user.id}`).send({ disabled: false }).expect(200);
    });
});
