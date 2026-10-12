/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */

/* globals before: false, after: false */

'use strict';

const crypto = require('crypto');
const supertest = require('supertest');
const chai = require('chai');
// the dump fixtures are serialized with the same bson version the import handler deserializes with
const BSON = require('bson');
const { ObjectId } = BSON;
const db = require('../../lib/db');
const { createRoleToken, binaryParser, readUpdatesStream, buildDump } = require('./_helpers');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

const EXPORT_MAGIC = Buffer.from([0x09, 0x06, 0x82]);

describe('API Users Extra', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const runId = Date.now();

    const userAName = `extrauser${runId}`;
    const userADomain = `extra-a-${runId}.com`;
    const userAAddress = `${userAName}@${userADomain}`;

    const userBName = `renameuser${runId}`;
    const userBDomainOld = `rename-a-${runId}.com`;
    const userBDomainNew = `rename-b-${runId}.com`;

    // valid ObjectId that should not match any user
    const unknownUserId = crypto.randomBytes(12).toString('hex');

    let userA, userB;
    let accessToken, tokenHash;
    let filterId;
    let exportedDump;
    let outboundQueueId;

    before(async () => {
        // export/import endpoints require a special "export" role token
        const tokenInfo = await createRoleToken('export');
        accessToken = tokenInfo.accessToken;
        tokenHash = tokenInfo.tokenHash;

        const responseA = await server
            .post('/users')
            .send({
                username: userAName,
                name: 'Extra Tester',
                address: userAAddress,
                password: 'secretvalue'
            })
            .expect(200);
        expect(responseA.body.success).to.be.true;
        userA = responseA.body.id;

        const responseB = await server
            .post('/users')
            .send({
                username: userBName,
                name: 'Rename Tester',
                address: `${userBName}@${userBDomainOld}`,
                password: 'secretvalue'
            })
            .expect(200);
        expect(responseB.body.success).to.be.true;
        userB = responseB.body.id;
    });

    after(async () => {
        if (outboundQueueId) {
            // remove the queued test message
            await server.delete(`/users/${userA}/outbound/${outboundQueueId}`);
        }

        if (userA) {
            await server.delete(`/users/${userA}`).expect(200);
        }

        if (userB) {
            await server.delete(`/users/${userB}`).expect(200);
        }

        if (tokenHash) {
            await db.redis.del(`tn:token:${tokenHash}`);
        }
    });

    describe('data export and import', () => {
        it('should POST /data/export expect success', async () => {
            // create a filter so the dump contains an entry that can be deleted and re-imported
            const filterResponse = await server
                .post(`/users/${userA}/filters`)
                .send({
                    name: `Export test filter ${runId}`,
                    query: { subject: `export-test-${runId}` },
                    action: { seen: true }
                })
                .expect(200);
            expect(filterResponse.body.success).to.be.true;
            filterId = filterResponse.body.id;

            const response = await server
                .post(`/data/export?accessToken=${accessToken}`)
                .send({ users: [userA] })
                .buffer(true)
                .parse(binaryParser)
                .expect(200);

            expect(response.headers['content-type']).to.include('application/octet-stream');
            expect(Buffer.isBuffer(response.body)).to.be.true;
            // dump starts with the export magic bytes
            expect(response.body.length).to.be.gt(EXPORT_MAGIC.length);
            expect(response.body.subarray(0, EXPORT_MAGIC.length).equals(EXPORT_MAGIC)).to.be.true;

            exportedDump = response.body;
        });

        it('should POST /data/export expect failure / malformed users entry', async () => {
            const response = await server
                .post(`/data/export?accessToken=${accessToken}`)
                .send({ users: ['not-a-valid-id'] })
                .expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        });

        it('should POST /data/import expect success', async () => {
            expect(exportedDump).to.exist;

            // delete the exported filter so the import has something to restore
            const deleteResponse = await server.delete(`/users/${userA}/filters/${filterId}`).expect(200);
            expect(deleteResponse.body.success).to.be.true;

            const response = await server
                .post(`/data/import?accessToken=${accessToken}`)
                .set('Content-Type', 'application/octet-stream')
                .send(exportedDump)
                .expect(200);

            // user + address + default mailboxes + filter
            expect(response.body.result.entries).to.be.gte(3);
            // only the deleted filter gets inserted, everything else already exists
            expect(response.body.result.imported).to.equal(1);
            expect(response.body.result.existing).to.equal(response.body.result.entries - 1);
            expect(response.body.result.failed).to.equal(0);

            // the filter is restored with its original ID
            const filtersResponse = await server.get(`/users/${userA}/filters`).expect(200);
            expect(filtersResponse.body.results.some(entry => entry.id === filterId)).to.be.true;
        });

        it('should POST /data/import expect failure / not an export dump', async () => {
            const response = await server
                .post(`/data/import?accessToken=${accessToken}`)
                .set('Content-Type', 'application/octet-stream')
                .send(Buffer.from('this is not an export dump'))
                .expect(500);

            expect(response.body.code).to.equal('INVALID_SEQUENCE');
        });

        it('should POST /data/import expect failure / wrong dump type', async () => {
            const dump = await buildDump({ type: 'something_else' }, [
                { client: 'database', collection: 'filters', entry: BSON.serialize({ _id: new ObjectId(), user: new ObjectId(userA) }) }
            ]);

            const response = await server
                .post(`/data/import?accessToken=${accessToken}`)
                .set('Content-Type', 'application/octet-stream')
                .send(dump)
                .expect(500);

            expect(response.body.code).to.equal('INVALID_DATA');

            // the failed import leaves the API usable
            await server.get(`/users/${userA}`).expect(200);
        });

        it('should POST /data/import expect success / entries for unknown collections are counted as failed', async () => {
            const filterId = new ObjectId();
            const dump = await buildDump({ type: 'wildduck_data_export' }, [
                { client: 'database', collection: 'secrets', entry: BSON.serialize({ _id: new ObjectId(), user: new ObjectId(userA) }) },
                {
                    client: 'database',
                    collection: 'filters',
                    entry: BSON.serialize({
                        _id: filterId,
                        user: new ObjectId(userA),
                        name: `Imported filter ${runId}`,
                        query: { headers: { subject: `import-test-${runId}` } },
                        action: { seen: true },
                        disabled: false,
                        created: new Date()
                    })
                }
            ]);

            const response = await server
                .post(`/data/import?accessToken=${accessToken}`)
                .set('Content-Type', 'application/octet-stream')
                .send(dump)
                .expect(200);

            expect(response.body.result).to.deep.equal({ entries: 2, imported: 1, failed: 1, existing: 0 });

            // importing the same dump again only finds existing documents
            const repeatResponse = await server
                .post(`/data/import?accessToken=${accessToken}`)
                .set('Content-Type', 'application/octet-stream')
                .send(dump)
                .expect(200);

            expect(repeatResponse.body.result).to.deep.equal({ entries: 2, imported: 0, failed: 1, existing: 1 });

            const filtersResponse = await server.get(`/users/${userA}/filters`).expect(200);
            expect(filtersResponse.body.results.some(entry => entry.id === filterId.toString())).to.be.true;
        });
    });

    describe('updates stream', () => {
        it('should GET /users/{user}/updates expect success', async () => {
            const result = await readUpdatesStream(`/users/${userA}/updates`);

            expect(result.statusCode).to.equal(200);
            expect(result.headers['content-type']).to.include('text/event-stream');
            expect(result.data).to.include(': idling');
        });

        it('should GET /users/{user}/updates expect failure / malformed user id', async () => {
            const response = await server.get('/users/notahexid/updates').expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        });
    });

    describe('address management', () => {
        it('should PUT /addresses/renameDomain expect success', async () => {
            const response = await server
                .put('/addresses/renameDomain')
                .send({
                    oldDomain: userBDomainOld,
                    newDomain: userBDomainNew
                })
                .expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.modifiedAddresses).to.equal(1);
            expect(response.body.modifiedUsers).to.equal(1);

            const addressesResponse = await server.get(`/users/${userB}/addresses`).expect(200);
            expect(addressesResponse.body.success).to.be.true;
            expect(addressesResponse.body.results.length).to.equal(1);
            expect(addressesResponse.body.results[0].address).to.equal(`${userBName}@${userBDomainNew}`);
        });

        it('should PUT /addresses/renameDomain expect failure / missing newDomain', async () => {
            const response = await server
                .put('/addresses/renameDomain')
                .send({
                    oldDomain: userBDomainNew
                })
                .expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        });

        it('should GET /addresses/resolve/{address} expect success', async () => {
            const response = await server.get(`/addresses/resolve/${encodeURIComponent(userAAddress)}`).expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.user).to.equal(userA);
            expect(response.body.address).to.equal(userAAddress);
        });

        it('should GET /addresses/resolve/{address} expect failure / unknown address', async () => {
            const response = await server.get(`/addresses/resolve/${encodeURIComponent(`unknown-${runId}@nonexistent-${runId}.com`)}`).expect(404);
            expect(response.body.code).to.equal('AddressNotFound');
        });
    });

    describe('addressregister', () => {
        const recipient = `friend${runId}@example.com`;
        let registerEntryId;

        it('should PUT /users/{user}/addressregister/{id} expect success', async () => {
            // submitting a message stores its recipients in the addressregister
            const submitResponse = await server
                .post(`/users/${userA}/submit`)
                .send({
                    to: [{ name: 'Friend Tester', address: recipient }],
                    subject: 'Address register test',
                    text: 'Hello friend!',
                    // deferred send time, the message stays in the queue
                    sendTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
                })
                .expect(200);
            expect(submitResponse.body.success).to.be.true;
            outboundQueueId = submitResponse.body.message.queueId;

            const listResponse = await server.get(`/users/${userA}/addressregister?query=friend${runId}`).expect(200);
            expect(listResponse.body.success).to.be.true;
            const entry = listResponse.body.results.find(resultEntry => resultEntry.address === recipient);
            expect(entry).to.exist;
            registerEntryId = entry.id;

            const updateResponse = await server
                .put(`/users/${userA}/addressregister/${registerEntryId}`)
                .send({
                    name: 'Renamed Friend',
                    disabled: false
                })
                .expect(200);
            expect(updateResponse.body.success).to.be.true;

            const verifyResponse = await server.get(`/users/${userA}/addressregister?query=friend${runId}`).expect(200);
            const updatedEntry = verifyResponse.body.results.find(resultEntry => resultEntry.id === registerEntryId);
            expect(updatedEntry).to.exist;
            expect(updatedEntry.name).to.equal('Renamed Friend');
        });

        it('should PUT /users/{user}/addressregister/{id} expect failure / malformed id', async () => {
            const response = await server
                .put(`/users/${userA}/addressregister/notahexid`)
                .send({
                    name: 'Renamed Friend',
                    disabled: false
                })
                .expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        });

        it('should PUT /users/{user}/addressregister/{id} expect failure / unknown id', async () => {
            const response = await server
                .put(`/users/${userA}/addressregister/${'0'.repeat(24)}`)
                .send({ name: 'Nobody', disabled: false })
                .expect(404);

            expect(response.body.code).to.equal('AddressNotFound');
        });
    });

    describe('user endpoint edge cases', () => {
        it('should GET /users expect failure / malformed limit', async () => {
            const response = await server.get('/users?limit=notanumber').expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        });

        it('should PUT /users/{user} expect failure / invalid body', async () => {
            const response = await server
                .put(`/users/${userA}`)
                .send({
                    spamLevel: 'invalid'
                })
                .expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        });

        it('should DELETE /users/{user} expect failure / malformed id', async () => {
            const response = await server.delete('/users/notahexid').expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        });

        it('should POST /users/{user}/password/reset expect failure / malformed user', async () => {
            const response = await server.post('/users/notahexid/password/reset').send({}).expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        });

        it('should PUT /users/{user}/logout expect failure / unknown user', async () => {
            const response = await server.put(`/users/${unknownUserId}/logout`).send({ reason: 'test' }).expect(404);

            expect(response.body.code).to.equal('UserNotFound');
        });

        it('should POST /users/{user}/quota/reset expect failure / unknown user', async () => {
            const response = await server.post(`/users/${unknownUserId}/quota/reset`).send({}).expect(404);
            expect(response.body.code).to.equal('UserNotFound');
        });

        it('should GET /users/{user}/restore expect failure / user not deleted', async () => {
            const response = await server.get(`/users/${userA}/restore`).expect(404);
            expect(response.body.code).to.equal('AccountNotFound');
        });

        it('should POST /users/{user}/restore expect failure / user not deleted', async () => {
            const response = await server.post(`/users/${userA}/restore`).send({}).expect(404);

            expect(response.body.code).to.equal('AccountNotFound');
        });
    });
});
