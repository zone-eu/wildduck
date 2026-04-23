/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const speakeasy = require('speakeasy');

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

    it('should POST /authenticate expect success / return auth token and totpNonce', async () => {
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
        expect(response.body.token).to.match(/^[0-9a-f]{40}$/);
        expect(response.body.totpNonce).to.match(/^[0-9a-f]{40}$/);

        accessToken = response.body.token;
        totpNonce = response.body.totpNonce;
    });

    it('should POST /users/{user}/2fa/totp/check expect success', async () => {
        const response = await server
            .post(`/users/${user}/2fa/totp/check?accessToken=${accessToken}`)
            .send({
                token: speakeasy.totp({
                    secret: seed,
                    encoding: 'base32'
                }),
                totpNonce
            })
            .expect(200);

        expect(response.body.success).to.be.true;
    });

    it('should POST /users/{user}/2fa/totp/check expect failure / reject reused totpNonce', async () => {
        const response = await server
            .post(`/users/${user}/2fa/totp/check?accessToken=${accessToken}`)
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
});
