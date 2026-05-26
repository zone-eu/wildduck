/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const speakeasy = require('speakeasy');
const crypto = require('crypto');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API TOTP', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    let seed;
    let accessToken;
    let totpNonce;

    it('should POST /users expect success / create a user with TOTP', async () => {
        const response = await server
            .post('/users')
            .send({
                username: 'totpnonceuser',
                name: 'Totp Nonce User',
                address: 'totpnonce@example.com',
                password: 'totpsecretvalue'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        user = response.body.id;
    });

    it('should POST /users/{user}/2fa/totp/setup expect success', async () => {
        const response = await server
            .post(`/users/${user}/2fa/totp/setup`)
            .send({
                issuer: 'WildDuck Test'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.seed).to.exist;

        seed = response.body.seed;
    });

    it('should POST /users/{user}/2fa/totp/enable expect success', async () => {
        const response = await server
            .post(`/users/${user}/2fa/totp/enable`)
            .send({
                token: speakeasy.totp({
                    secret: seed,
                    encoding: 'base32'
                })
            })
            .expect(200);

        expect(response.body.success).to.be.true;
    });

    it('should POST /authenticate expect success / return totpNonce without auth token', async () => {
        const response = await server
            .post('/authenticate')
            .send({
                username: 'totpnonceuser',
                password: 'totpsecretvalue',
                token: true
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(user);
        expect(response.body.require2fa).to.deep.equal(['totp']);
        expect(response.body.token).to.not.exist;
        expect(response.body.twoFactorNonce).to.match(/^[0-9a-f]{40}$/);
        expect(response.body.totpNonce).to.match(/^[0-9a-f]{40}$/);
        expect(response.body.totpNonce).to.equal(response.body.twoFactorNonce);

        totpNonce = response.body.totpNonce;
    });

    it('should POST /users/{user}/2fa/totp/check expect failure / keep nonce after invalid TOTP', async () => {
        const validToken = speakeasy.totp({
            secret: seed,
            encoding: 'base32'
        });
        const invalidToken = validToken === '000000' ? '000001' : '000000';

        const response = await server
            .post(`/users/${user}/2fa/totp/check`)
            .send({
                token: invalidToken,
                totpNonce
            })
            .expect(403);

        expect(response.body.code).to.equal('InvalidToken');
    });

    it('should POST /users/{user}/2fa/totp/check expect success', async () => {
        const response = await server
            .post(`/users/${user}/2fa/totp/check`)
            .send({
                token: speakeasy.totp({
                    secret: seed,
                    encoding: 'base32'
                }),
                totpNonce
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.token).to.match(/^[0-9a-f]{40}$/);
        accessToken = response.body.token;
    });

    it('should GET /users/{user} expect success / use post-TOTP auth token', async () => {
        const response = await server.get(`/users/me?accessToken=${accessToken}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(user);
    });

    it('should POST /users/{user}/2fa/totp/check expect failure / reject reused totpNonce', async () => {
        const response = await server
            .post(`/users/${user}/2fa/totp/check`)
            .send({
                token: speakeasy.totp({
                    secret: seed,
                    encoding: 'base32'
                }),
                totpNonce
            })
            .expect(403);

        expect(response.body.code).to.equal('InvalidTotpNonce');
    });

    it('should POST /users/{user}/2fa/totp/check expect failure / reject master context without pending 2FA nonce', async () => {
        const response = await server
            .post(`/users/${user}/2fa/totp/check`)
            .send({
                token: speakeasy.totp({
                    secret: seed,
                    encoding: 'base32'
                }),
                totpNonce: crypto.randomBytes(20).toString('hex')
            })
            .expect(403);

        expect(response.body.code).to.equal('InvalidTotpNonce');
    });

    it('should POST /authenticate expect success / custom 2FA returns auth token', async () => {
        const createResponse = await server
            .post('/users')
            .send({
                username: 'custom2fauser',
                name: 'Custom 2FA User',
                address: 'custom2fa@example.com',
                password: 'custom2fasecret'
            })
            .expect(200);

        expect(createResponse.body.success).to.be.true;

        const userId = createResponse.body.id;
        const enableResponse = await server.put(`/users/${userId}/2fa/custom`).send({}).expect(200);
        expect(enableResponse.body.success).to.be.true;

        const authResponse = await server
            .post('/authenticate')
            .send({
                username: 'custom2fauser',
                password: 'custom2fasecret',
                token: true
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body.require2fa).to.deep.equal(['custom']);
        expect(authResponse.body.token).to.match(/^[0-9a-f]{40}$/);
        expect(authResponse.body.twoFactorNonce).to.not.exist;
        expect(authResponse.body.totpNonce).to.not.exist;
    });
});
