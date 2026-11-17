'use strict';

// A software WebAuthn authenticator (P-256, attestation format none) for tests that register and use
// WebAuthn credentials through the REST API.

const crypto = require('crypto');
const cbor = require('cbor-x');

const cborEncoder = new cbor.Encoder();

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

module.exports = { SoftwareWebAuthnAuthenticator };
