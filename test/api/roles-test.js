'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { before, after } = require('mocha');
const { buildApp } = require('./_inprocess');
const { createRoleToken, deleteRoleToken } = require('./_helpers');
const db = require('../../lib/db');

describe('Roles API', function () {
    this.timeout(120000); // eslint-disable-line no-invalid-this

    let app;
    let rootToken;
    const tokens = [];
    const roleNames = [];
    const users = [];

    const request = (method, url, token = rootToken.accessToken, payload) => {
        const options = {
            method,
            url,
            headers: { 'x-access-token': token }
        };
        if (payload) {
            options.payload = payload;
        }
        return app.inject(options);
    };

    const createRole = async (name, permissions, token = rootToken.accessToken) => {
        const response = await request('POST', '/roles', token, { name, permissions });
        expect(response.statusCode).to.equal(200, response.body);
        expect(response.json().id).to.equal(name);
        roleNames.push(name);
        return response.json();
    };

    const createToken = async (role, user) => {
        const token = await createRoleToken(role, user);
        tokens.push(token.tokenHash);
        return token;
    };

    before(async () => {
        ({ app } = await buildApp());
        rootToken = await createToken('root');
    });

    after(async () => {
        if (app) {
            for (const user of users) {
                await request('DELETE', `/users/${user}`);
            }
            await app.close();
        }
        for (const tokenHash of tokens) {
            await deleteRoleToken(tokenHash);
        }
        if (roleNames.length) {
            await db.users.collection('roles').deleteMany({ _id: { $in: roleNames } });
            await db.database.collection('tasks').deleteMany({ task: 'role-delete', 'data.role': { $in: roleNames } });
        }
    });

    it('lists active system roles and prevents changing or deleting them', async () => {
        const listing = await request('GET', '/roles?limit=250');
        expect(listing.statusCode).to.equal(200);
        const roles = listing.json().results;
        expect(roles.some(role => role.name === 'root')).to.equal(true);
        const root = roles.find(role => role.name === 'root');
        expect(root.id).to.equal('root');

        const update = await request('PUT', `/roles/${root.id}`, rootToken.accessToken, { description: 'changed' });
        expect(update.statusCode).to.equal(403);
        expect(update.json().code).to.equal('SystemRoleProtected');
        const deletion = await request('DELETE', `/roles/${root.id}`);
        expect(deletion.statusCode).to.equal(403);
        expect(deletion.json().code).to.equal('SystemRoleProtected');
    });

    it('allows custom role management through persisted grants and hides tombstones', async () => {
        const managerPermissions = {
            roles: {
                'create:any': ['*'],
                'read:any': ['*'],
                'update:any': ['*'],
                'delete:any': ['*']
            }
        };
        const manager = await createRole(`role-manager-${new ObjectId()}`, managerPermissions);
        const managerToken = await createToken(manager.id);
        const customPermissions = { messages: { 'read:any': ['id', 'subject'] } };
        const created = await createRole(`custom-${new ObjectId()}`, customPermissions, managerToken.accessToken);
        expect(created.permissions.messages).to.deep.equal(customPermissions.messages);

        const changed = await request('PUT', `/roles/${created.id}`, managerToken.accessToken, { description: 'Updated' });
        expect(changed.statusCode).to.equal(200);
        expect(changed.json().description).to.equal('Updated');

        const deleted = await request('DELETE', `/roles/${created.id}`, managerToken.accessToken);
        expect(deleted.statusCode).to.equal(200);
        expect(deleted.json().success).to.equal(true);
        const missing = await request('GET', `/roles/${created.id}`, managerToken.accessToken);
        expect(missing.statusCode).to.equal(404);
        expect(missing.json().code).to.equal('RoleNotFound');
        const recreated = await request('POST', '/roles', rootToken.accessToken, { name: created.name, permissions: {} });
        expect(recreated.statusCode).to.equal(409);
        expect(recreated.json().code).to.equal('RoleExists');
    });

    it('paginates roles and rejects immutable and server-managed fields', async () => {
        const first = (await request('GET', '/roles?limit=1')).json();
        expect(first.results).to.have.length(1);
        expect(first.nextCursor).to.be.a('string');
        const nextCursor = encodeURIComponent(first.nextCursor);
        const next = (await request('GET', `/roles?limit=1&next=${nextCursor}`)).json();
        expect(next.page).to.equal(2);
        expect(next.results[0].id).not.to.equal(first.results[0].id);
        const previousCursor = encodeURIComponent(next.previousCursor);
        const previous = (await request('GET', `/roles?limit=1&previous=${previousCursor}`)).json();
        expect(previous.results[0].id).to.equal(first.results[0].id);
        const created = await createRole(`immutable-${new ObjectId()}`, {});
        const invalidUpdates = [
            { name: 'renamed' },
            { isSystem: true },
            { id: new ObjectId().toHexString() },
            { created: new Date().toISOString() }
        ];
        for (const payload of invalidUpdates) {
            const response = await request('PUT', `/roles/${created.id}`, rootToken.accessToken, payload);
            expect(response.statusCode).to.equal(400);
            expect(response.json().code).to.equal('InputValidationError');
            expect(response.json().details).to.have.property(Object.keys(payload)[0]);
        }
        const unauthorized = await createToken('manager');
        expect((await request('GET', '/roles', unauthorized.accessToken)).statusCode).to.equal(403);
    });

    it('ignores unknown-resource grants and validates scope, action, and attributes', async () => {
        const inert = await createRole(`unknown-resource-${new ObjectId()}`, { unknownResource: { 'read:any': ['*'] } });
        const inertToken = await createToken(inert.id);
        const denied = await request('GET', '/roles', inertToken.accessToken);
        expect(denied.statusCode).to.equal(403);
        expect(denied.json().code).to.equal('MissingPrivileges');

        for (const permissions of [
            { roles: { 'read:team': ['*'] } },
            { roles: { 'publish:any': ['*'] } },
            { roles: { 'read:any': [''] } }
        ]) {
            const response = await request('POST', '/roles', rootToken.accessToken, { name: `invalid-${new ObjectId()}`, permissions });
            expect(response.statusCode).to.equal(400);
            expect(response.json().code).to.equal('InputValidationError');
        }
    });

    it('filters role reads and applies edited grants on the next service-token request', async () => {
        const reader = await createRole(`role-reader-${new ObjectId()}`, { roles: { 'read:any': ['id', 'name'] } });
        const readerToken = await createToken(reader.id);

        let response = await request('GET', '/roles', readerToken.accessToken);
        expect(response.statusCode).to.equal(200);
        expect(response.json().results.length).to.be.greaterThan(0);
        for (const role of response.json().results) {
            expect(Object.keys(role).sort()).to.deep.equal(['id', 'name']);
        }

        response = await request('PUT', `/roles/${reader.id}`, rootToken.accessToken, { permissions: {} });
        expect(response.statusCode).to.equal(200);
        response = await request('GET', '/roles', readerToken.accessToken);
        expect(response.statusCode).to.equal(403);
        expect(response.json().code).to.equal('MissingPrivileges');
    });

    it('keeps user restrictions after assigned-role deletion and rejects deleted or unknown explicit role names', async () => {
        const assigned = await createRole(`assigned-${new ObjectId()}`, {
            users: { 'read:any': ['*'] },
            roles: { 'read:any': ['*'] }
        });
        const username = `roles-${crypto.randomBytes(6).toString('hex')}`;
        const userData = {
            username,
            password: false,
            address: `${username}@example.org`,
            name: 'Role fallback test',
            role: assigned.id,
            permissions: { users: { read: false } }
        };
        const createdUser = await request('POST', '/users', rootToken.accessToken, userData);
        expect(createdUser.statusCode).to.equal(200);
        const userId = createdUser.json().id;
        const storedUser = await db.users.collection('users').findOne({ _id: new ObjectId(userId) });
        expect(storedUser.role).to.equal(assigned.id);
        users.push(userId);
        const userToken = await createToken('user', userId);

        let response = await request('GET', '/users/me', userToken.accessToken);
        expect(response.statusCode).to.equal(403);
        expect(response.json().code).to.equal('MissingPrivileges');

        const explicitToken = await createToken(assigned.id);
        response = await request('GET', '/roles', explicitToken.accessToken);
        expect(response.statusCode).to.equal(200);

        response = await request('DELETE', `/roles/${assigned.id}`);
        expect(response.statusCode).to.equal(200);
        response = await request('GET', '/users/me', userToken.accessToken);
        expect(response.statusCode).to.equal(403);
        expect(response.json().code).to.equal('MissingPrivileges');

        response = await request('GET', '/roles', explicitToken.accessToken);
        expect(response.statusCode).to.equal(403);

        const unknownToken = await createToken(`unknown-role-${new ObjectId()}`);
        response = await request('GET', '/roles', unknownToken.accessToken);
        expect(response.statusCode).to.equal(403);
    });
});
