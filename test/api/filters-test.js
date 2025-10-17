/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API Filters', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user, user2;

    before(async () => {
        // ensure that we have an existing user account
        const response = await server
            .post('/users')
            .send({
                username: 'filteruser',
                password: 'secretvalue',
                address: 'filteruser.addrtest@example.com',
                name: 'Filter User'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        user = response.body.id;

        const response2 = await server
            .post('/users')
            .send({
                username: 'filteruser2',
                password: 'secretvalue',
                address: 'filteruser2.addrtest@example.com',
                name: 'Filter User 2'
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
    });

    it('should POST /users/{user}/filters expect success', async () => {
        const response = await server
            .post(`/users/${user}/filters`)
            .send({
                name: 'test filter 1',
                query: {
                    from: 'andris1'
                },
                action: {
                    seen: true
                }
            })
            .expect(200);
        expect(response.body.success).to.be.true;

        const response2 = await server
            .post(`/users/${user2}/filters`)
            .send({
                name: 'test filter 2',
                query: {
                    from: 'andris2'
                },
                action: {
                    seen: true
                }
            })
            .expect(200);
        expect(response2.body.success).to.be.true;

        const response3 = await server
            .post(`/users/${user}/filters`)
            .send({
                name: 'test filter 3',
                query: {
                    from: 'andris'
                },
                action: {
                    seen: false
                }
            })
            .expect(200);

        expect(response3.body.success).to.be.true;
    });

    it('should GET /filters expect success', async () => {
        const filterListResponse = await server.get(`/filters`).expect(200);
        expect(filterListResponse.body.success).to.be.true;
        expect(filterListResponse.body.total).to.equal(3);
    });

    it('should GET /filters expect success / with a user token', async () => {
        const authResponse = await server
            .post('/authenticate')
            .send({
                username: 'filteruser',
                password: 'secretvalue',
                token: true
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body.token).to.exist;

        let token = authResponse.body.token;

        const userListResponse = await server.get(`/filters?accessToken=${token}`).expect(200);
        expect(userListResponse.body.success).to.be.true;

        expect(userListResponse.body.total).to.equal(2);
    });

    it('should GET /users/{user}/filters expect success', async () => {
        const filterListResponse = await server.get(`/users/${user}/filters`).expect(200);
        expect(filterListResponse.body.success).to.be.true;

        expect(filterListResponse.body.results.length).to.equal(2);
    });

    it('should PUT /users/{user}/filters/{filter} expect success', async () => {
        let filterListResponse = await server.get(`/users/${user}/filters`).expect(200);
        expect(filterListResponse.body.success).to.be.true;
        let filters = filterListResponse.body.results;
        let filter = filters[0].id;

        expect(filters[0].disabled).to.equal(false);

        const response = await server
            .put(`/users/${user}/filters/${filter}`)
            .send({
                disabled: true
            })
            .expect(200);
        expect(response.body.success).to.be.true;

        filterListResponse = await server.get(`/users/${user}/filters`).expect(200);
        expect(filterListResponse.body.success).to.be.true;

        expect(filterListResponse.body.results.length).to.equal(2);

        expect(filterListResponse.body.results.find(f => f.id === filter).disabled).to.equal(true);
    });

    it('should DELETE /users/{user}/filters/{filter} expect success', async () => {
        let filterListResponse = await server.get(`/users/${user}/filters`).expect(200);
        expect(filterListResponse.body.success).to.be.true;
        let filters = filterListResponse.body.results;
        let filter = filters[0].id;

        const response = await server.delete(`/users/${user}/filters/${filter}`).expect(200);
        expect(response.body.success).to.be.true;

        filterListResponse = await server.get(`/users/${user}/filters`).expect(200);
        expect(filterListResponse.body.success).to.be.true;

        expect(filterListResponse.body.results.length).to.equal(1);
    });

    it('should GET /users/{user}/filters expect success / with mailbox action', async () => {
        // get list of user mailboxes
        const responseMailboxes = await server.get(`/users/${user}/mailboxes`).expect(200);
        expect(responseMailboxes.body.success).to.be.true;

        const inbox = responseMailboxes.body.results.find(entry => entry.path === 'INBOX').id;

        const responsePost = await server
            .post(`/users/${user}/filters`)
            .send({
                name: 'mailbox test filter',
                query: {
                    from: 'andris1'
                },
                action: {
                    mailbox: inbox
                }
            })
            .expect(200);
        expect(responsePost.body.success).to.be.true;

        const filter = responsePost.body.id;

        const responseGet = await server.get(`/users/${user}/filters/${filter}`).expect(200);

        expect(responseGet.body.success).to.be.true;
        expect(responseGet.body.action.mailbox).to.be.equal(inbox);
    });

    describe('Filter metaData', function () {
        let metaDataFilter;

        it('should POST /users/{user}/filters expect success', async () => {
            const response = await server
                .post(`/users/${user}/filters`)
                .send({
                    name: 'test filter 4',
                    query: {
                        from: 'andris'
                    },
                    action: {
                        seen: true
                    },
                    metaData: '{"hello": "world"}'
                })
                .expect(200);
            expect(response.body.success).to.be.true;
            metaDataFilter = response.body.id;

            const filterDataResponse = await server.get(`/users/${user}/filters/${metaDataFilter}`);
            expect(filterDataResponse.body.success).to.be.true;
            expect(filterDataResponse.body.metaData.hello).to.equal('world');
        });

        it('should POST /users/{user}/filters expect success / as object', async () => {
            const response = await server
                .post(`/users/${user}/filters`)
                .send({
                    name: 'test filter 5',
                    query: {
                        from: 'andris'
                    },
                    action: {
                        seen: true
                    },
                    metaData: { hello: 'palderjan' }
                })
                .expect(200);
            expect(response.body.success).to.be.true;

            const filterDataResponse = await server.get(`/users/${user}/filters/${response.body.id}`);
            expect(filterDataResponse.body.success).to.be.true;
            expect(filterDataResponse.body.metaData.hello).to.equal('palderjan');
        });

        it('should PUT /users/{user}/filters/{filter} expect success', async () => {
            const response = await server
                .put(`/users/${user}/filters/${metaDataFilter}`)
                .send({
                    metaData: '{"hello": "torbik"}'
                })
                .expect(200);
            expect(response.body.success).to.be.true;

            const filterDataResponse = await server.get(`/users/${user}/filters/${metaDataFilter}`);
            expect(filterDataResponse.body.success).to.be.true;
            expect(filterDataResponse.body.metaData.hello).to.equal('torbik');
        });

        it('should PUT /users/{user}/filters/{filter} expect success / as object', async () => {
            const response = await server
                .put(`/users/${user}/filters/${metaDataFilter}`)
                .send({
                    metaData: { hello: 'kapsas' }
                })
                .expect(200);
            expect(response.body.success).to.be.true;

            const filterDataResponse = await server.get(`/users/${user}/filters/${metaDataFilter}`);
            expect(filterDataResponse.body.success).to.be.true;
            expect(filterDataResponse.body.metaData.hello).to.equal('kapsas');
        });

        it('should PUT /users/{user}/filters/{filter} expect success', async () => {
            const response = await server
                .put(`/users/${user}/filters/${metaDataFilter}`)
                .send({
                    metaData: '{"hello": "torbik"}'
                })
                .expect(200);
            expect(response.body.success).to.be.true;

            const filterDataResponse = await server.get(`/users/${user}/filters/${metaDataFilter}`);
            expect(filterDataResponse.body.success).to.be.true;
            expect(filterDataResponse.body.metaData.hello).to.equal('torbik');
        });

        it('should GET /filters expect success / without metaData', async () => {
            const filterListResponse = await server.get(`/filters`).expect(200);
            expect(filterListResponse.body.success).to.be.true;
            let filterData = filterListResponse.body.results.find(f => f.id === metaDataFilter);
            expect(filterData).to.exist;
            expect(filterData.metaData).to.not.exist;
        });

        it('should GET /filters expect success / with metaData', async () => {
            const filterListResponse = await server.get(`/filters?metaData=true`).expect(200);
            expect(filterListResponse.body.success).to.be.true;
            let filterData = filterListResponse.body.results.find(f => f.id === metaDataFilter);
            expect(filterData).to.exist;
            expect(filterData.metaData).to.exist;
        });

        it('should GET /users/{user}/filters expect success / without metaData', async () => {
            const filterListResponse = await server.get(`/users/${user}/filters`).expect(200);
            expect(filterListResponse.body.success).to.be.true;
            let filterData = filterListResponse.body.results.find(f => f.id === metaDataFilter);
            expect(filterData).to.exist;
            expect(filterData.metaData).to.not.exist;
        });

        it('should GET /users/{user}/filters expect success / with metaData', async () => {
            const filterListResponse = await server.get(`/users/${user}/filters?metaData=true`).expect(200);
            expect(filterListResponse.body.success).to.be.true;
            let filterData = filterListResponse.body.results.find(f => f.id === metaDataFilter);
            expect(filterData).to.exist;
            expect(filterData.metaData).to.exist;
        });
    });
});
