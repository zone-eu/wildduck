/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API Users', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user, user2, forwarded;

    before(async () => {
        // ensure that we have an existing user account
        const response = await server
            .post('/users')
            .send({
                username: 'addressuser',
                password: 'secretvalue',
                address: 'addressuser.addrtest@example.com',
                name: 'address user'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        user = response.body.id;

        const response2 = await server
            .post('/users')
            .send({
                username: 'addressuser2',
                password: 'secretvalue',
                address: 'addressuser2.addrtest@example.com',
                name: 'address user 2'
            })
            .expect(200);
        expect(response2.body.success).to.be.true;
        expect(response2.body.id).to.exist;

        user2 = response2.body.id;
    });

    after(async () => {
        if (!user) {
            return;
        }

        const response = await server.delete(`/users/${user}`).expect(200);
        expect(response.body.success).to.be.true;

        user = false;

        const response2 = await server.delete(`/users/${user2}`).expect(200);
        expect(response2.body.success).to.be.true;

        user2 = false;
    });

    it('should POST /users/{user}/addresses expect success', async () => {
        const response = await server
            .post(`/users/${user}/addresses`)
            .send({
                address: `user1.1.addrtest@example.com`,
                tags: ['TAG1', 'tag2']
            })
            .expect(200);
        expect(response.body.success).to.be.true;

        const response2 = await server
            .post(`/users/${user2}/addresses`)
            .send({
                address: `user2.1.addrtest@example.com`
            })
            .expect(200);
        expect(response2.body.success).to.be.true;

        const response3 = await server
            .post(`/users/${user}/addresses`)
            .send({
                address: `user1.2.addrtest@example.com`,
                tags: ['TAG2', 'tag3']
            })
            .expect(200);

        expect(response3.body.success).to.be.true;
    });

    it('should GET /addresses expect success', async () => {
        const addressListResponse = await server.get(`/addresses`).expect(200);
        expect(addressListResponse.body.success).to.be.true;
        expect(addressListResponse.body.total).to.gt(3);
    });

    it('should GET /addresses expect failure / incorrect query params data', async () => {
        const addressListResponse = await server.get(`/addresses?limit=-1&query=${'a'.repeat(256)}`).expect(400);
        expect(addressListResponse.body.code).to.be.equal('InputValidationError');
    });

    it('should GET /addresses expect success / with tags', async () => {
        const addressListResponse = await server.get(`/addresses?tags=tag2,tag3`).expect(200);
        expect(addressListResponse.body.success).to.be.true;
        expect(addressListResponse.body.total).to.equal(2);
    });

    it('should GET /addresses expect success / with required tags', async () => {
        const addressListResponse = await server.get(`/addresses?requiredTags=tag2,tag3`).expect(200);
        expect(addressListResponse.body.success).to.be.true;
        expect(addressListResponse.body.total).to.equal(1);
    });

    it('should GET /addresses expect success / with a user token', async () => {
        const authResponse = await server
            .post('/authenticate')
            .send({
                username: 'addressuser',
                password: 'secretvalue',
                token: true
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body.token).to.exist;

        let token = authResponse.body.token;

        const userListResponse = await server.get(`/addresses?accessToken=${token}`).expect(200);
        expect(userListResponse.body.success).to.be.true;

        expect(userListResponse.body.total).to.equal(3);
    });

    it('should GET /users/{user}/addresses expect success', async () => {
        const addressListResponse = await server.get(`/users/${user}/addresses`).expect(200);
        expect(addressListResponse.body.success).to.be.true;

        expect(addressListResponse.body.results.length).to.equal(3);
        expect(addressListResponse.body.results.filter(addr => addr.main).length).to.equal(1);
        expect(addressListResponse.body.results.find(addr => addr.main).address).to.equal('addressuser.addrtest@example.com');
    });

    it('should GET /users/{user}/addresses expect failure / incorrect user', async () => {
        const addressListResponse = await server.get(`/users/${123}/addresses`).expect(400);
        expect(addressListResponse.body.code).to.be.equal('InputValidationError');
    });

    it('should GET /users/{user}/addresses expect failure / user missing', async () => {
        const addressListResponse = await server.get(`/users/${'0'.repeat(24)}/addresses`).expect(404);
        expect(addressListResponse.body.code).to.be.equal('UserNotFound');
        expect(addressListResponse.body.error).to.be.equal('This user does not exist');
    });

    it('should PUT /users/{user}/addresses/{id} expect success', async () => {
        let addressListResponse = await server.get(`/users/${user}/addresses`).expect(200);
        expect(addressListResponse.body.success).to.be.true;
        let addresses = addressListResponse.body.results;
        let address = addresses.find(addr => addr.address === 'user1.1.addrtest@example.com').id;

        const response = await server
            .put(`/users/${user}/addresses/${address}`)
            .send({
                main: true
            })
            .expect(200);
        expect(response.body.success).to.be.true;

        addressListResponse = await server.get(`/users/${user}/addresses`).expect(200);
        expect(addressListResponse.body.success).to.be.true;

        expect(addressListResponse.body.results.length).to.equal(3);
        expect(addressListResponse.body.results.filter(addr => addr.main).length).to.equal(1);
        expect(addressListResponse.body.results.find(addr => addr.main).address).to.equal('user1.1.addrtest@example.com');
    });

    it('should DELETE /users/{user}/addresses/{address} expect failure', async () => {
        let addressListResponse = await server.get(`/users/${user}/addresses`).expect(200);
        expect(addressListResponse.body.success).to.be.true;
        let addresses = addressListResponse.body.results;
        let address = addresses.find(addr => addr.main).id;

        // trying to delete a main address should fail
        const response = await server.delete(`/users/${user}/addresses/${address}`).expect(400);
        expect(response.body.code).to.equal('NotPermitted');
    });

    it('should DELETE /users/{user}/addresses/{address} expect success', async () => {
        let addressListResponse = await server.get(`/users/${user}/addresses`).expect(200);
        expect(addressListResponse.body.success).to.be.true;
        let addresses = addressListResponse.body.results;
        let address = addresses.find(addr => addr.address === 'user1.2.addrtest@example.com').id;

        const response = await server.delete(`/users/${user}/addresses/${address}`).expect(200);
        expect(response.body.success).to.be.true;
    });

    it('should POST /addresses/forwarded expect success', async () => {
        const response = await server
            .post(`/addresses/forwarded`)
            .send({
                address: `forwarded.1.addrtest@example.com`,
                targets: ['andris@ethereal.email'],
                tags: ['TAG1', 'tag2']
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        forwarded = response.body.id;
    });

    it('should GET /addresses expect success / with query', async () => {
        const addressListResponse = await server.get(`/addresses?query=forwarded.1.addrtest`).expect(200);
        expect(addressListResponse.body.success).to.be.true;
        expect(addressListResponse.body.total).to.equal(1);
        expect(forwarded).to.exist;
    });

    it('should PUT /addresses/forwarded/{id} expect success', async () => {
        const response = await server
            .put(`/addresses/forwarded/${forwarded}`)
            .send({
                tags: ['tAG2', 'tAg3']
            })
            .expect(200);
        expect(response.body.success).to.be.true;

        const addressListResponse = await server.get(`/addresses?query=forwarded.1.addrtest`).expect(200);
        expect(addressListResponse.body.total).to.equal(1);
    });
});
