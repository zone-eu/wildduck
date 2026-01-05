/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const ObjectId = require('mongodb').ObjectId;

const expect = chai.expect;
chai.config.includeStack = true;

const config = require('@zone-eu/wild-config');
const UserHandler = require('../../lib/user-handler');
const db = require('../../lib/db');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe.only('Async Get Deleted User', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const username = 'deleted-user-handler';
    const address = 'deleted-user-handler@example.com';

    let userHandler;
    let deletedUserId;

    before(async () => {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
        userHandler = new UserHandler({
            database: db.database,
            users: db.users,
            redis: db.redis
        });

        const createResponse = await server
            .post('/users')
            .send({
                username,
                address,
                password: 'secretvalue'
            })
            .expect(200);

        expect(createResponse.body.success).to.be.true;
        deletedUserId = createResponse.body.id;

        const deleteAfter = new Date(Date.now() + 3600 * 1000).toISOString();
        const deleteResponse = await server.delete(`/users/${deletedUserId}?deleteAfter=${encodeURIComponent(deleteAfter)}`).expect(200);

        expect(deleteResponse.body.success).to.be.true;
    });

    after(async () => {
        if (!deletedUserId) {
            return;
        }

        const userObjectId = new ObjectId(deletedUserId);
        await db.users.collection('deletedusers').deleteOne({ _id: userObjectId });
        await db.database.collection('tasks').deleteMany({
            task: 'user-delete',
            $or: [{ user: userObjectId }, { 'data.user': userObjectId }]
        });
    });

    it('should get deleted user by id expect success', async () => {
        const deletedUser = await userHandler.asyncGetDeleted(deletedUserId, { username: true, address: true });

        expect(deletedUser).to.exist;
        expect(deletedUser._id.toString()).to.equal(deletedUserId);
        expect(deletedUser.username).to.equal(username);
        expect(deletedUser.address).to.equal(address);
    });

    it('should get deleted user by username expect success', async () => {
        const deletedUser = await userHandler.asyncGetDeleted(username.toUpperCase(), { username: true });

        expect(deletedUser).to.exist;
        expect(deletedUser._id.toString()).to.equal(deletedUserId);
        expect(deletedUser.username).to.equal(username);
    });

    it('should get deleted user by address expect success', async () => {
        const deletedUser = await userHandler.asyncGetDeleted(address.toUpperCase(), { address: true });

        expect(deletedUser).to.exist;
        expect(deletedUser._id.toString()).to.equal(deletedUserId);
        expect(deletedUser.address).to.equal(address);
    });

    it('should get deleted user expect failure for missing account', async () => {
        const deletedUser = await userHandler.asyncGetDeleted('missing-user@example.com');

        expect(deletedUser).to.be.null;
    });
});
