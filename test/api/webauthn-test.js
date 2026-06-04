/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const crypto = require('crypto');
const cbor = require('cbor-x');

const expect = chai.expect;
chai.config.includeStack = true;

const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);
const cborEncoder = new cbor.Encoder();

const ORIGIN = 'https://example.com';
const RP_ID = 'example.com';

class SoftwareWebAuthnAuthenticator {
    constructor(rpId) {
        this.rpId = rpId;
        this.credentialId = crypto.randomBytes(32);
        this.counter = 0;

        const keyPair = crypto.generateKeyPairSync('ec', {
            namedCurve: 'prime256v1'
        });

        this.publicKey = keyPair.publicKey;
        this.privateKey = keyPair.privateKey;
    }

    createRegistrationResponse(challenge, origin) {
        const clientDataJSON = this.getClientDataJSON('webauthn.create', challenge, origin);
        const counter = Buffer.alloc(4);
        const credentialIdLength = Buffer.alloc(2);
        credentialIdLength.writeUInt16BE(this.credentialId.length);

        const authData = Buffer.concat([
            this.getRpIdHash(),
            Buffer.from([0x41]), // UP + AT
            counter,
            Buffer.alloc(16),
            credentialIdLength,
            this.credentialId,
            this.getCredentialPublicKeyCose()
        ]);

        const attestationObject = cborEncoder.encode({
            fmt: 'none',
            attStmt: {},
            authData
        });

        return {
            challenge,
            rawId: this.credentialId.toString('hex'),
            clientDataJSON: clientDataJSON.toString('hex'),
            attestationObject: attestationObject.toString('hex')
        };
    }

    createAssertionResponse(challenge, origin) {
        const clientDataJSON = this.getClientDataJSON('webauthn.get', challenge, origin);
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(++this.counter);

        const authenticatorData = Buffer.concat([
            this.getRpIdHash(),
            Buffer.from([0x01]), // UP
            counter
        ]);

        const signature = crypto.sign(
            'SHA256',
            Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]),
            this.privateKey
        );

        return {
            challenge,
            rawId: this.credentialId.toString('hex'),
            clientDataJSON: clientDataJSON.toString('hex'),
            authenticatorData: authenticatorData.toString('hex'),
            signature: signature.toString('hex')
        };
    }

    getClientDataJSON(type, challenge, origin) {
        return Buffer.from(
            JSON.stringify({
                type,
                challenge: base64UrlEncode(Buffer.from(challenge, 'hex')),
                origin
            })
        );
    }

    getRpIdHash() {
        return crypto.createHash('sha256').update(this.rpId).digest();
    }

    getCredentialPublicKeyCose() {
        const jwk = this.publicKey.export({ format: 'jwk' });

        return cborEncoder.encode(
            new Map([
                [1, 2],
                [3, -7],
                [-1, 1],
                [-2, base64UrlDecode(jwk.x)],
                [-3, base64UrlDecode(jwk.y)]
            ])
        );
    }
}

function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(new RegExp('=+$'), '');
}

function base64UrlDecode(value) {
    let input = value.replace(/-/g, '+').replace(/_/g, '/');
    while (input.length % 4 !== 0) {
        input += '=';
    }
    return Buffer.from(input, 'base64');
}

describe.only('API WebAuthn', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const password = 'webauthnsecretvalue';
    const suffix = crypto.randomBytes(6).toString('hex');
    const username = `webauthn-${suffix}`;
    const authenticator = new SoftwareWebAuthnAuthenticator(RP_ID);

    let user;
    let twoFactorNonce;
    let authenticationChallenge;
    let accessToken;

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

        const registrationResponse = authenticator.createRegistrationResponse(response.body.registrationOptions.challenge, ORIGIN);

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

    it('should GET /users/{user}/2fa/webauthn/credentials expect registered credential', async () => {
        const response = await server.get(`/users/${user}/2fa/webauthn/credentials`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.credentials).to.have.length(1);
        expect(response.body.credentials[0].rawId).to.equal(authenticator.credentialId.toString('hex'));
        expect(response.body.credentials[0].authenticatorAttachment).to.equal('cross-platform');
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

    it('should POST /users/{user}/2fa/webauthn/authentication-assertion expect token', async () => {
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

    it('should POST /users/{user}/2fa/webauthn/authentication-assertion expect failure / reject reused nonce', async () => {
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
            .expect(403);

        expect(response.body.code).to.equal('Invalid2faNonce');
    });
});
