/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const ObjectId = require('mongodb').ObjectId;

const expect = chai.expect;
chai.config.includeStack = true;

const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('HIBP', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const pwnedPassword = process.env.HIBP_TEST_PASSWORD || '123123123';
    const safePassword = 'hibp-safe-password';

    const username = 'hibp-user';
    const address = 'hibp-user@example.com';
    let currentPassword = 'secretvalue';
    let userId;
    const createdUsers = [];

    const makeUsername = prefix => `${prefix}-${Date.now()}-${Math.round(Math.random() * 100000)}`;

    const createUser = async payload => {
        const response = await server.post('/users').send(payload).expect(200);
        expect(response.body.success).to.be.true;
        createdUsers.push(response.body.id);
        return response.body.id;
    };

    const setPwnedFields = async (id, opts = {}) => {
        const userObjectId = new ObjectId(id);
        const lastPwnedCheck = opts.lastPwnedCheck || new Date();
        const passwordPwned = typeof opts.passwordPwned === 'boolean' ? opts.passwordPwned : true;
        await db.users.collection('users').updateOne(
            { _id: userObjectId },
            {
                $set: {
                    lastPwnedCheck,
                    passwordPwned
                }
            }
        );
    };

    const fetchUser = async (id, projection) =>
        db.users.collection('users').findOne(
            { _id: new ObjectId(id) },
            {
                projection
            }
        );

    before(async () => {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));

        userId = await createUser({
            username,
            address,
            password: currentPassword
        });
    });

    after(async () => {
        for (const id of createdUsers) {
            const response = await server.delete(`/users/${id}`).expect(200);
            expect(response.body.success).to.be.true;
        }
    });

    it('should include passwordPwned on authenticate when stored', async () => {
        await setPwnedFields(userId, { lastPwnedCheck: new Date() });

        const authResponse = await server
            .post('/authenticate')
            .send({
                username,
                password: currentPassword
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body.passwordPwned).to.equal(true);
    });

    it('should clear pwned fields when updating password', async () => {
        await setPwnedFields(userId);

        const newPassword = 'secretvalue2';
        const response = await server
            .put(`/users/${userId}`)
            .send({
                password: newPassword
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        currentPassword = newPassword;

        const user = await fetchUser(userId, { lastPwnedCheck: 1, passwordPwned: 1 });
        expect(user).to.exist;
        expect(user).to.not.have.property('lastPwnedCheck');
        expect(user).to.not.have.property('passwordPwned');
    });

    it('should clear pwned fields when updating password via /users/me', async () => {
        await setPwnedFields(userId);

        const tokenResponse = await server
            .post('/authenticate')
            .send({
                username,
                password: currentPassword,
                token: true
            })
            .expect(200);

        expect(tokenResponse.body.success).to.be.true;
        expect(tokenResponse.body.token).to.exist;

        const newPassword = 'secretvalue3';
        const response = await server
            .put(`/users/me?accessToken=${tokenResponse.body.token}`)
            .send({
                password: newPassword
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        currentPassword = newPassword;

        const user = await fetchUser(userId, { lastPwnedCheck: 1, passwordPwned: 1 });
        expect(user).to.exist;
        expect(user).to.not.have.property('lastPwnedCheck');
        expect(user).to.not.have.property('passwordPwned');
    });

    it('should clear pwned fields when resetting password', async () => {
        await setPwnedFields(userId);

        const response = await server.post(`/users/${userId}/password/reset`).send({}).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.password).to.exist;

        const user = await fetchUser(userId, { lastPwnedCheck: 1, passwordPwned: 1 });
        expect(user).to.exist;
        expect(user).to.not.have.property('lastPwnedCheck');
        expect(user).to.not.have.property('passwordPwned');
    });

    it('should reject pwned password when creating user with allowUnsafe=false', async () => {
        const response = await server
            .post('/users')
            .send({
                username: makeUsername('hibp-unsafe-create'),
                address: `${makeUsername('hibp-unsafe')}@example.com`,
                password: pwnedPassword,
                allowUnsafe: false
            })
            .expect(403);

        expect(response.body.code).to.equal('InsecurePasswordError');
    });

    it('should allow safe password when creating user with allowUnsafe=false', async () => {
        const safeUserId = await createUser({
            username: makeUsername('hibp-safe-create'),
            address: `${makeUsername('hibp-safe')}@example.com`,
            password: safePassword,
            allowUnsafe: false
        });

        expect(safeUserId).to.exist;
    });

    it('should reject pwned password when updating user with allowUnsafe=false', async () => {
        const updateTargetId = await createUser({
            username: makeUsername('hibp-update-target'),
            address: `${makeUsername('hibp-update')}@example.com`,
            password: safePassword
        });

        const response = await server
            .put(`/users/${updateTargetId}`)
            .send({
                password: pwnedPassword,
                allowUnsafe: false
            })
            .expect(403);

        expect(response.body.code).to.equal('InsecurePasswordError');
    });

    it('should allow safe password when updating user with allowUnsafe=false', async () => {
        const updateTargetId = await createUser({
            username: makeUsername('hibp-update-safe'),
            address: `${makeUsername('hibp-update-safe')}@example.com`,
            password: safePassword
        });

        const response = await server
            .put(`/users/${updateTargetId}`)
            .send({
                password: 'hibp-safe-password-2',
                allowUnsafe: false
            })
            .expect(200);

        expect(response.body.success).to.be.true;
    });

    it('should set lastPwnedCheck and return passwordPwned on login when pwned checks enabled', async () => {
        const pwnedUsername = makeUsername('hibp-pwned');
        const pwnedUserId = await createUser({
            username: pwnedUsername,
            address: `${makeUsername('hibp-pwned')}@example.com`,
            password: pwnedPassword
        });

        const authResponse = await server
            .post('/authenticate')
            .send({
                username: pwnedUsername,
                password: pwnedPassword
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;
        expect(authResponse.body.passwordPwned).to.equal(true);

        const user = await fetchUser(pwnedUserId, { lastPwnedCheck: 1, passwordPwned: 1 });
        expect(user).to.exist;
        expect(user.passwordPwned).to.equal(true);
        expect(user.lastPwnedCheck).to.be.instanceOf(Date);
    });

    it('should not clear pwned fields during password rehash', async () => {
        const rehashPassword = 'test';
        const argonHash = '$argon2i$v=19$m=16,t=2,p=1$SFpGczI1bWV1RVRpYjNYaw$EBE/WnOGeWint3eQ+SQ7Sg';

        const rehashUsername = makeUsername('hibp-rehash');
        const rehashUserId = await createUser({
            username: rehashUsername,
            address: `${makeUsername('hibp-rehash')}@example.com`,
            password: argonHash,
            hashedPassword: true
        });

        const initialPwnedCheck = new Date();
        await setPwnedFields(rehashUserId, { lastPwnedCheck: initialPwnedCheck, passwordPwned: true });

        const authResponse = await server
            .post('/authenticate')
            .send({
                username: rehashUsername,
                password: rehashPassword
            })
            .expect(200);

        expect(authResponse.body.success).to.be.true;

        const user = await fetchUser(rehashUserId, { lastPwnedCheck: 1, passwordPwned: 1, password: 1 });
        expect(user).to.exist;
        expect(user.passwordPwned).to.equal(true);
        expect(user.lastPwnedCheck.toISOString()).to.equal(initialPwnedCheck.toISOString());
        expect(user.password).to.not.equal(argonHash);
    });
});
